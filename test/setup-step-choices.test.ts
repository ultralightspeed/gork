// Step 1 of setup: the answers, the custom personality editor, MENTIONS, and never overwriting .env.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadPersona } from "../src/persona.ts";
import { shippedPersonas } from "./helpers.ts";
import { CHOICES, deleted, failure, harness, type Over, readEnv, toCloudflare, toGateway } from "./setup-harness.ts";
import { BOOT, DISCORD, type World } from "./setup-world.ts";

describe("setup: choices", () => {
  it("accepts a personality by name, and refuses one that doesn't exist", async () => {
    const h = harness();
    await h.s.saveChoices({ ...CHOICES, persona: "noir" });
    expect(h.session.view().choices?.persona).toBe("noir");
    expect(await failure(h.s.saveChoices({ ...CHOICES, persona: "../../etc/passwd" }))).toMatch(/personality/i);
  });

  it("checks the time zone on the server, refuses one that isn't real, and writes the one chosen", async () => {
    const h = harness();
    expect(await failure(h.s.saveChoices({ ...CHOICES, timezone: "Mars/Olympus" }))).toMatch(/time zone/i);
    await toCloudflare(h, { choices: { timezone: "America/New_York" } });
    await h.s.cloudflareToken(BOOT, true);
    await h.s.finish({ revokeOld: true });
    expect(readEnv(h.path).TIMEZONE).toBe("America/New_York");
  });

  it("refuses a budget that isn't a number, and defaults a blank one", async () => {
    const h = harness();
    expect(await failure(h.s.saveChoices({ ...CHOICES, budget: "lots" }))).toMatch(/budget/i);
    const v = await h.s.saveChoices({ ...CHOICES, budget: "" });
    expect(v.choices?.budget).toBe("0.50");
  });

  it("refuses a billing mode that isn't one of the two, and answers that aren't text", async () => {
    const h = harness();
    expect(await failure(h.s.saveChoices({ ...CHOICES, billing: "gold" }))).toMatch(/pay/i);
    expect(await failure(h.s.saveChoices({ ...CHOICES, persona: 7 as unknown as string }))).toMatch(/personality/i);
  });

  it("cannot be changed once the Cloudflare tokens exist", async () => {
    const h = harness();
    await toGateway(h);
    expect(await failure(h.s.saveChoices({ ...CHOICES, billing: "free" }))).toMatch(/locked|already/i);
  });
});

describe("setup: the custom personality editor", () => {
  const MINE = {
    name: "Captain",
    body: "You are {name}, a pirate.\n\n- Talks like one.",
    quirk: "End with a pirate jab.",
    quirkRate: 30,
    replies: { blocked: "Nay, says {name}." },
  };
  const withCustom = (custom: unknown = MINE, over: Over = {}) => ({ ...CHOICES, persona: "custom", ...over, custom });
  /** A harness with its own copy of the persona folder: these tests write into it. */
  const own = (w: World = {}) => {
    const dir = shippedPersonas();
    return { dir, h: harness(w, { personasDir: dir }) };
  };
  const files = (dir: string) => readdirSync(dir).sort();

  it("offers the example, without its comments, to start from when there is no custom.md, and custom last in the list", () => {
    const { h } = own();
    const v = h.session.view();
    expect(v.custom.exists).toBe(false);
    expect(v.custom.draft.name).toBe("gork");
    expect(v.custom.draft.body).toMatch(/^You are \{name\}\./);
    expect(v.custom.draft.body).not.toMatch(/^#/m);
    expect(v.custom.replyFields.map((f) => f.key)).toContain("out_of_budget");
    expect(v.options.personas.at(-1)?.name).toBe("custom");
  });

  it("starts from the person's own custom.md when there is one", () => {
    const dir = shippedPersonas();
    writeFileSync(join(dir, "custom.md"), "---\nname: Old\nquirk: hm\nquirk_rate: 0.5\n---\nYou are {name}, old.\n");
    const h = harness({}, { personasDir: dir });
    const c = h.session.view().custom;
    expect(c.exists).toBe(true);
    expect(c.draft).toMatchObject({ name: "Old", body: "You are {name}, old.", quirk: "hm", quirkRate: 50 });
  });

  it("writes personas/custom.md when the choices are saved, and gork can load it", async () => {
    const { dir, h } = own();
    const before = files(dir);
    const v = await h.s.saveChoices(withCustom());
    expect(v.choices?.persona).toBe("custom");
    expect(files(dir)).toEqual([...before, "custom.md"].sort());
    const p = loadPersona(dir, "custom");
    expect(p).toMatchObject({ name: "Captain", quirk: "End with a pirate jab.", quirkRate: 0.3, warnings: [] });
    expect(p.body).toBe("You are Captain, a pirate.\n\n- Talks like one.");
    expect(p.replies.blocked).toBe("Nay, says Captain.");
    // The editor now starts from what was saved.
    expect(v.custom.exists).toBe(true);
    expect(v.custom.draft).toMatchObject({ name: "Captain", quirkRate: 30 });
  });

  it("refuses bad answers, or none at all when there is no custom.md yet, with a reason, and writes nothing", async () => {
    const { dir, h } = own();
    const before = files(dir);
    expect(await failure(h.s.saveChoices({ ...CHOICES, persona: "custom" }))).toMatch(/custom personality/i);
    for (const custom of [
      { ...MINE, name: "" },
      { ...MINE, name: "a\nreply.blocked: nope" },
      { ...MINE, body: "  " },
      { ...MINE, body: "x".repeat(8001) },
      { ...MINE, quirkRate: 150 },
      { ...MINE, replies: { colour: "red" } },
      "just text",
    ]) {
      expect(await failure(h.s.saveChoices(withCustom(custom))), JSON.stringify(custom).slice(0, 60)).toMatch(/\w/);
    }
    expect(files(dir)).toEqual(before);
    expect(h.session.view().choices).toBeNull();
  });

  it("checks everything else first: a bad time zone leaves the personality as it was", async () => {
    const dir = shippedPersonas();
    writeFileSync(join(dir, "custom.md"), "---\nname: Old\n---\nold body");
    const h = harness({}, { personasDir: dir });
    expect(await failure(h.s.saveChoices(withCustom(MINE, { timezone: "Mars/Olympus" })))).toMatch(/time zone/i);
    expect(readFileSync(join(dir, "custom.md"), "utf8")).toBe("---\nname: Old\n---\nold body");
  });

  it("keeps an existing custom.md when no editor answers are sent", async () => {
    const dir = shippedPersonas();
    writeFileSync(join(dir, "custom.md"), "---\nname: Old\n---\nold body");
    const h = harness({}, { personasDir: dir });
    await h.s.saveChoices({ ...CHOICES, persona: "custom" });
    expect(readFileSync(join(dir, "custom.md"), "utf8")).toBe("---\nname: Old\n---\nold body");
    expect(h.session.view().custom.warnings).toEqual([]);
  });

  it("writes nothing for any other personality", async () => {
    const { dir, h } = own();
    const before = files(dir);
    await h.s.saveChoices({ ...CHOICES, persona: "noir", custom: MINE });
    expect(files(dir)).toEqual(before);
  });

  it("refuses the example's [bracketed parts] left as they are", async () => {
    const { h } = own();
    const example = h.session.view().custom.draft;
    const msg = await failure(h.s.saveChoices(withCustom({ ...example, name: "Pat" })));
    expect(msg).toMatch(/\[/);
    expect(msg).toMatch(/replace/i);
    // Replaced, it goes through.
    await h.s.saveChoices(withCustom({ ...example, body: "You are {name}, a calm helper." }));
  });

  it("says what went wrong when the file can't be written, and doesn't take the answers", async () => {
    const dir = shippedPersonas();
    mkdirSync(join(dir, "custom.md")); // a folder where the file belongs
    const h = harness({}, { personasDir: dir });
    expect(await failure(h.s.saveChoices(withCustom()))).toMatch(/custom\.md/);
    expect(h.session.view().choices).toBeNull();
    expect(files(dir).filter((f) => f.startsWith("."))).toEqual([]);
  });
});

describe("setup: MENTIONS", () => {
  it("adds Mention Everyone to the invite only for everyone (or all), and keeps the least-privilege link otherwise", async () => {
    const LEAST = 580817017490432n;
    const cases: [string, bigint, string][] = [
      ["none", LEAST, "none"],
      ["everyone", LEAST | (1n << 17n), "everyone"],
      ["all", LEAST | (1n << 17n), "all"],
      ["users,reply", LEAST, "reply,users"],
    ];
    for (const [mentions, permissions, saved] of cases) {
      const h = harness();
      await h.s.saveChoices({ ...CHOICES, mentions });
      const v = await h.s.discordToken(DISCORD);
      expect(v.discord.inviteUrl, mentions).toMatch(new RegExp(`permissions=${permissions}$`));
      expect(v.choices?.mentions, mentions).toBe(saved);
    }
  });

  it("refuses a kind it doesn't know", async () => {
    const h = harness();
    expect(await failure(h.s.saveChoices({ ...CHOICES, mentions: "bogus" }))).toMatch(/unknown kinds/);
  });
});

describe("setup: refuses to overwrite", () => {
  it("stops at the first step when .env exists, before any network call, and leaves it untouched", async () => {
    const h = harness();
    writeFileSync(h.path, "KEEP=me\n");
    expect(h.session.view().envExists).toBe(true);
    const msg = await failure(h.s.saveChoices({ ...CHOICES }));
    expect(msg).toMatch(/already exists/);
    expect(msg).toMatch(/move|rename/i);
    expect(msg).toMatch(/npm run doctor/);
    expect(readFileSync(h.path, "utf8")).toBe("KEEP=me\n");
    expect(h.calls).toEqual([]);
  });

  it("does not clobber a .env that appears while setup runs, and takes back what it made", async () => {
    const w: World = {};
    const h = harness(w);
    const real = h.session.deps.fetch;
    h.session.deps.fetch = (async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/ai-gateway/gateways") && init?.method === "POST") writeFileSync(h.path, "RACE=1\n");
      return real(url, init);
    }) as typeof fetch;
    await toGateway(h);
    const msg = await failure(h.s.finish({ revokeOld: true }));
    expect(msg).toMatch(/already exists|appeared/);
    expect(readFileSync(h.path, "utf8")).toBe("RACE=1\n");
    expect(deleted(h)).toEqual(["tok-1", "tok-2", "boot-id"]);
  });
});
