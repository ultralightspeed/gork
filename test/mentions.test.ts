import { describe, expect, it } from "vitest";
import {
  addPings,
  buildPingContext,
  defuseEveryone,
  MAX_PINGS,
  type MentionKind,
  mayPingEveryone,
  type PingContext,
  parseMentions,
  pingFirstChunk,
} from "../src/mentions.ts";

const ctx = (allowed: MentionKind[], over: Partial<PingContext> = {}): PingContext => ({
  allowed: new Set(allowed),
  people: [
    { id: "1", names: ["Amy", "amy_99"] },
    { id: "2", names: ["bob"] },
    { id: "3", names: ["Amy Lee"] },
  ],
  roles: [
    { id: "r1", names: ["raiders"], mentionable: true },
    { id: "r2", names: ["mods"], mentionable: false },
  ],
  askerCanMentionEveryone: false,
  everyoneRequested: false,
  ...over,
});
const person = (id: string, ...names: string[]) => ({ id, names });

describe("parseMentions", () => {
  it("is empty by default and for none, reads a comma list case-insensitively, and all means every kind", () => {
    expect(parseMentions("").size).toBe(0);
    expect(parseMentions("none").size).toBe(0);
    expect([...parseMentions("Users, everyone")].sort()).toEqual(["everyone", "users"]);
    expect([...parseMentions("all")].sort()).toEqual(["everyone", "reply", "roles", "users"]);
  });

  it("rejects unknown kinds and names the choices, without echoing what was typed", () => {
    expect(() => parseMentions("users,channels")).toThrow(/unknown kinds.*reply, users, roles, everyone/);
    expect(() => parseMentions("users,channels")).not.toThrow(/channels/);
  });
});

describe("addPings", () => {
  it("pings nothing when mentions are off, and pings the asker through the reply only when reply is on", () => {
    const out = addPings("hey @Amy, look", ctx([]));
    expect(out.text).toBe("hey @Amy, look");
    expect(out.allowedMentions).toEqual({ parse: [], users: [], roles: [], repliedUser: false });
    expect(addPings("hi", ctx(["reply"])).allowedMentions.repliedUser).toBe(true);
  });

  it("turns @Name into a ping for people in the conversation", () => {
    const out = addPings("hey @amy and @bob!", ctx(["users"]));
    expect(out.text).toBe("hey <@1> and <@2>!");
    expect(out.allowedMentions.users).toEqual(["1", "2"]);
    // The same person named twice is listed once, so one person can't use up the cap.
    expect(addPings("@amy @amy @bob", ctx(["users"])).allowedMentions.users).toEqual(["1", "2"]);
  });

  // Text in, text out: each case is a way @Name must NOT (or must) turn into a ping.
  it.each<[string, string, Partial<PingContext>, string]>([
    ["takes the longest name and only whole names", "@Amy Lee and @amyx", {}, "<@3> and @amyx"],
    ["leaves unknown names and email addresses alone", "@zed mail me at x@bob.com", {}, "@zed mail me at x@bob.com"],
    [
      "copes with names made of regex characters instead of throwing",
      "yo @c++ and @(x",
      { people: [person("9", "c++"), person("8", "(x")] },
      "yo <@9> and <@8>",
    ],
    [
      "skips a name two people share rather than guess",
      "@sam",
      { people: [person("1", "sam"), person("2", "Sam")] },
      "@sam",
    ],
    [
      "skips a name that only differs from everyone or here by punctuation, or is everyone itself",
      "@everyone. @Here! @everyone",
      { people: [person("7", "everyone."), person("8", "Here!"), person("9", "everyone")] },
      `everyone. @Here! everyone`, // only the exact lower-case words are Discord's everyone mentions
    ],
    [
      "doesn't let a person take a locked role's name",
      "@Mods help",
      { people: [person("5", "Mods")], allowed: new Set<MentionKind>(["users", "roles"]) },
      "@Mods help",
    ],
    ["ignores a one-character name", "@a b", { people: [person("5", "a")] }, "@a b"],
    [
      "doesn't match a name glued to more text by - or ., but does before 's and a full stop",
      "@Al-Qaeda @Al.com it's @Al's turn, @Al.",
      { people: [person("5", "Al")] },
      "@Al-Qaeda @Al.com it's <@5>'s turn, <@5>.",
    ],
    [
      "matches names the way the model saw them (angle brackets softened)",
      "hi @‹b›",
      { people: [person("5", "<b>")] },
      "hi <@5>",
    ],
  ])("%s", (_what, text, over, expected) => {
    expect(addPings(text, ctx(["users"], over)).text).toBe(expected);
  });

  it("never pings a raw <@id> the model wrote itself", () => {
    expect(addPings("<@999> hi", ctx(["users"])).allowedMentions.users).toEqual([]);
  });

  it(`pings at most ${MAX_PINGS} people and roles per reply`, () => {
    const people = Array.from({ length: 8 }, (_, i) => ({ id: `${i}`, names: [`p${i}`] }));
    const text = people.map((p) => `@${p.names[0]}`).join(" ");
    const out = addPings(text, ctx(["users"], { people }));
    expect(out.allowedMentions.users).toHaveLength(MAX_PINGS);
    expect(out.text).toContain("@p7");
  });

  it("keeps people as text when only roles are on; pings mentionable roles, and locked ones only for an asker who could", () => {
    expect(addPings("@amy", ctx(["roles"])).text).toBe("@amy");
    expect(addPings("@raiders @mods", ctx(["roles"])).text).toBe("<@&r1> @mods");
    const out = addPings("@raiders @mods", ctx(["roles"], { askerCanMentionEveryone: true }));
    expect(out.text).toBe("<@&r1> <@&r2>");
    expect(out.allowedMentions.roles).toEqual(["r1", "r2"]);
  });

  it("pings everyone only when the model asked with the tool and the asker could do it themselves", () => {
    const yes = { askerCanMentionEveryone: true, everyoneRequested: true };
    expect(addPings("@here raid at 8", ctx(["everyone"], yes)).allowedMentions.parse).toEqual(["everyone"]);
    expect(
      addPings("@here raid", ctx(["everyone"], { ...yes, askerCanMentionEveryone: false })).allowedMentions.parse,
    ).toEqual([]);
    expect(
      addPings("@here raid", ctx(["everyone"], { ...yes, everyoneRequested: false })).allowedMentions.parse,
    ).toEqual([]);
    expect(addPings("@here raid", ctx([], yes)).allowedMentions.parse).toEqual([]);
  });

  it("defuses @everyone and @here it isn't sending, so they can't ping even by accident", () => {
    const out = addPings(
      "@everyone pings all; @here pings online",
      ctx(["everyone"], { askerCanMentionEveryone: true }),
    );
    expect(out.text).toBe(`everyone pings all; here pings online`);
    expect(
      addPings("@everyone go", ctx(["everyone"], { askerCanMentionEveryone: true, everyoneRequested: true })).text,
    ).toBe("@everyone go");
  });
});

describe("defuseEveryone (what every later chunk of a long reply goes through)", () => {
  it("defuses @everyone and @here but leaves email addresses alone", () => {
    expect(defuseEveryone("@everyone and @here, mail bob@here.com")).toBe(`everyone and here, mail bob@here.com`);
  });
});

describe("buildPingContext", () => {
  const base = {
    botId: "bot",
    allowed: new Set<MentionKind>(["users", "roles"]),
    askerCanMentionEveryone: true,
    everyoneRequested: false,
    guildId: "g1",
  };

  it("merges the names one person is known by across messages, without duplicates or blanks", () => {
    const c = buildPingContext({
      ...base,
      people: [
        { id: "1", names: ["Amy", null, "amy_99"] },
        { id: "1", names: ["amy_99", undefined, "Amy Lee"] },
        { id: "2", names: ["bob"] },
      ],
      roles: [],
    });
    expect(c.people).toEqual([
      { id: "1", names: ["Amy", "amy_99", "Amy Lee"] },
      { id: "2", names: ["bob"] },
    ]);
  });

  it("never lets gork tag itself", () => {
    const c = buildPingContext({ ...base, people: [{ id: "bot", names: ["gork"] }], roles: [] });
    expect(c.people).toEqual([]);
  });

  it("offers real roles only: not @everyone's role and not bot-managed ones", () => {
    const c = buildPingContext({
      ...base,
      people: [],
      roles: [
        { id: "g1", name: "@everyone", managed: false, mentionable: false },
        { id: "r1", name: "raiders", managed: false, mentionable: true },
        { id: "r2", name: "Some Bot", managed: true, mentionable: true },
      ],
    });
    expect(c.roles).toEqual([{ id: "r1", names: ["raiders"], mentionable: true }]);
  });
});

describe("pingFirstChunk", () => {
  const people = ctx(["users"]);

  it("goes out without pings, @everyone defused, when the mention would push it past the limit", () => {
    const chunk = "@bob @everyone yo"; // 16 characters with the ping and @everyone defused to "everyone"
    expect(pingFirstChunk(chunk, people, 16).text).toBe("<@2> everyone yo");
    const out = pingFirstChunk(chunk, people, 15);
    expect(out.text).toBe(defuseEveryone(chunk));
    expect(out.allowedMentions).toEqual({ parse: [], users: [], roles: [], repliedUser: false });
  });

  it("uses Discord's 2000 characters by default", () => {
    const chunk = (filler: number) => `@bob @everyone ${"x".repeat(filler)}`;
    expect(pingFirstChunk(chunk(1986), people).text.startsWith("<@2>")).toBe(true); // 2000 once pinged
    expect(pingFirstChunk(chunk(1987), people).text.startsWith("@bob")).toBe(true); // 2001: no pings
  });
});

describe("mayPingEveryone", () => {
  it("needs the setting, the asker's permission and the asker's own request", () => {
    const on = new Set<MentionKind>(["everyone"]);
    expect(mayPingEveryone(on, true, "ping everyone about the raid")).toBe(true);
    expect(mayPingEveryone(new Set(), true, "ping everyone")).toBe(false);
    expect(mayPingEveryone(on, false, "ping everyone")).toBe(false);
    expect(mayPingEveryone(on, true, "what's the weather")).toBe(false);
  });
});
