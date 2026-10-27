import { ChannelType, type Message } from "discord.js";
import { describe, expect, it } from "vitest";
import type { Msg } from "../src/context.ts";
import {
  eventAccess,
  eventChangeWhyNot,
  eventRefusal,
  pingContext,
  pollRefusal,
  splitImageUrls,
} from "../src/discord-access.ts";

type User = { id: string; bot: boolean; username: string; displayName: string };
const user = (id: string, bot = false): User => ({ id, bot, username: `u${id}`, displayName: `U${id}` });

/** Just enough of a discord.js Message for these readers. */
function message(o: { author?: User; mentions?: User[]; askerPerms?: string[]; botPerms?: string[] } = {}) {
  const perms = (list: string[] = []) => ({ permissions: { has: (p: string) => list.includes(p) } });
  return {
    author: o.author ?? user("1"),
    member: { displayName: "Asker", ...perms(o.askerPerms) },
    mentions: { users: new Map((o.mentions ?? []).map((u) => [u.id, u])), members: new Map() },
    channel: { permissionsFor: () => ({ has: () => false }) },
    guild: { id: "g", roles: { cache: new Map() }, members: { me: perms(o.botPerms) } },
  } as unknown as Message;
}

describe("splitImageUrls", () => {
  const withImages = (...images: string[]): Msg => ({
    authorName: "a",
    isSelf: false,
    content: "",
    attachments: [],
    embeds: [],
    images,
  });

  it("attaches up to 3 images, the asker's own first, keeping the replied-to message's apart", () => {
    expect(splitImageUrls(withImages("q1", "q2"), withImages("r1", "r2"))).toEqual({
      imageUrls: ["q1", "q2"],
      replyImageUrls: ["r1"],
    });
    expect(splitImageUrls(withImages("q1", "q2", "q3", "q4"), withImages("r1"))).toEqual({
      imageUrls: ["q1", "q2", "q3"],
      replyImageUrls: [],
    });
    expect(splitImageUrls(withImages(), null)).toEqual({ imageUrls: [], replyImageUrls: [] });
  });
});

describe("pingContext", () => {
  it("never offers a bot mentioned in the question as someone to ping", () => {
    const ctx = pingContext(message({ mentions: [user("2"), user("3", true)] }), [], {
      botId: "99",
      allowed: new Set(["users"]),
      everyoneRequested: false,
    });
    expect(ctx.people.map((p) => p.id).sort()).toEqual(["1", "2"]);
  });
});

describe("eventRefusal", () => {
  const both = { askerPerms: ["CreateEvents"], botPerms: ["CreateEvents"] };
  it("allows an event whenever the asker and gork both have Create Events, whatever the wording", () => {
    expect(eventRefusal(message(both))).toBeNull();
  });

  it("names the one permission that's missing", () => {
    expect(eventRefusal(message({ botPerms: ["CreateEvents"] }))).toMatch(/person asking doesn't have/);
    expect(eventRefusal(message({ askerPerms: ["CreateEvents"] }))).toMatch(/you don't have/);
  });
});

describe("eventChangeWhyNot", () => {
  const others = { madeBy: "other", stage: false } as const;

  it("is null when neither the asker nor gork is held back", () => {
    expect(eventChangeWhyNot(null, null, others)).toBeNull();
  });

  it("names what the asker lacks first, then what gork lacks and how an admin can give it", () => {
    expect(eventChangeWhyNot("manage", "manage", others)).toMatch(
      /someone else made it.*Manage Events permission, which the person asking doesn't have/,
    );
    expect(eventChangeWhyNot(null, "manage", others)).toMatch(
      /you can change only events you made.*server admin can give your role Manage Events/,
    );
  });

  it("explains that Discord counts an event gork made as gork's, not the asker's", () => {
    expect(eventChangeWhyNot("manage", null, { madeBy: "gork", stage: false })).toMatch(/counts it as yours/);
  });

  it("names Create Events for an event of one's own", () => {
    expect(eventChangeWhyNot("create", null, { madeBy: "asker", stage: false })).toMatch(
      /person asking doesn't have the Create Events or Manage Events permission/,
    );
    expect(eventChangeWhyNot(null, "create", { madeBy: "gork", stage: false })).toMatch(
      /you don't have the Create Events permission/,
    );
  });

  it("names the channel when that is what's missing", () => {
    expect(eventChangeWhyNot("channel", null, others)).toMatch(/voice channel the person asking can't connect to/);
    expect(eventChangeWhyNot(null, "channel", { madeBy: "other", stage: true })).toMatch(
      /Stage channel.*you don't have Manage Channels, Mute Members and Move Members/,
    );
  });
});

describe("eventAccess", () => {
  const asker = { id: "u1", permissions: { has: (p: string) => p === "ManageEvents" } };
  const me = { id: "b1", permissions: { has: (p: string) => p === "CreateEvents" } };
  /** A channel where the asker may only connect and gork may only view. */
  const channel = (id: string, name: string, type: ChannelType) => ({
    id,
    name,
    type,
    isVoiceBased: () => type === ChannelType.GuildVoice || type === ChannelType.GuildStageVoice,
    permissionsFor: (m: unknown) => ({ has: (p: string) => p === (m === asker ? "Connect" : "ViewChannel") }),
  });
  const message = {
    member: asker,
    guild: {
      members: { me },
      channels: {
        cache: new Map([
          ["10", channel("10", "Raid Voice", ChannelType.GuildVoice)],
          ["11", channel("11", "Town Hall", ChannelType.GuildStageVoice)],
          ["12", channel("12", "general", ChannelType.GuildText)],
        ]),
      },
    },
  } as unknown as Message;

  it("reads server-wide permissions for an event at a location, and the channel's own for one in a channel", () => {
    const access = eventAccess(message);
    expect(access).toMatchObject({ askerId: "u1", botId: "b1" });
    expect(access?.has("asker", "ManageEvents", null)).toBe(true);
    expect(access?.has("bot", "ManageEvents", null)).toBe(false);
    expect(access?.has("asker", "Connect", "10")).toBe(true);
    expect(access?.has("asker", "ManageEvents", "10")).toBe(false);
    expect(access?.has("bot", "ViewChannel", "10")).toBe(true);
    expect(access?.has("bot", "ViewChannel", "99")).toBe(false);
  });

  it("lists the voice and Stage channels, and nothing else", () => {
    expect(eventAccess(message)?.voiceChannels()).toEqual([
      { id: "10", name: "Raid Voice", stage: false },
      { id: "11", name: "Town Hall", stage: true },
    ]);
  });

  it("is null outside a server", () => {
    expect(eventAccess({ member: null, guild: null } as unknown as Message)).toBeNull();
  });
});

describe("pollRefusal", () => {
  it("allows a poll when both may post polls here, and otherwise says so", () => {
    expect(pollRefusal({ poll: true })).toBeNull();
    expect(pollRefusal({ poll: false })).toMatch(/may not post polls/);
  });
});
