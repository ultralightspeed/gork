import { describe, expect, it } from "vitest";
import { json } from "./helpers.ts";
import { CHOICES, failure, type H, harness, readEnv, toCloudflare } from "./setup-harness.ts";
import { BOOT, DISCORD, type World, WRONG } from "./setup-world.ts";

describe("setup: Discord", () => {
  it("redacts a token that a Discord or Cloudflare message quotes back", async () => {
    const h = harness();
    await h.s.saveChoices({ ...CHOICES });
    await h.s.discordToken(DISCORD);
    const core = (
      h.session as unknown as { core: { discord: { problem: string | null; guildsProblem: string | null } } }
    ).core;
    core.discord.problem = `Discord said: bad token ${DISCORD}`;
    core.discord.guildsProblem = `no servers for ${DISCORD}`;
    const view = JSON.stringify(h.session.view());
    expect(view).toContain("Discord said");
    expect(view).not.toContain(DISCORD);
  });

  it("refuses a rejected token with the fix, and accepts the right one after", async () => {
    const h = harness();
    await h.s.saveChoices({ ...CHOICES });
    const real = h.session.deps.fetch;
    h.session.deps.fetch = (async (url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";
      if (String(url).endsWith("/applications/@me") && auth === `Bot ${WRONG}`) return json({}, 401);
      return real(url, init);
    }) as typeof fetch;
    expect(await failure(h.s.discordToken(WRONG))).toMatch(/rejected that bot token/);
    expect((await h.s.discordToken(DISCORD)).discord.app).toEqual({ name: "gork" });
  });

  it("refuses a token that is not three dot-separated parts, or empty, without sending it anywhere, and takes one with spaces around it after trimming", async () => {
    const NO_DOTS = "CFtokenWithoutAnyDots1234567890";
    const h = harness();
    await h.s.saveChoices({ ...CHOICES });
    expect(await failure(h.s.discordToken(NO_DOTS))).toMatch(/doesn't look like a Discord bot token/);
    expect(await failure(h.s.discordToken("   "))).toMatch(/paste/i);
    expect(h.calls).toEqual([]);
    expect(h.text()).not.toContain(NO_DOTS);
    expect((await h.s.discordToken(`  ${DISCORD}\n`)).discord.app).not.toBeNull();
  });

  it("shows an app name and a server name with control and bidi characters removed", async () => {
    const h = harness({ app: { name: "Evil‮\u009bBot" }, guilds: [[{ id: "42", name: "Evil‮\u009bServer" }]] });
    await h.s.saveChoices({ ...CHOICES });
    expect((await h.s.discordToken(DISCORD)).discord.app).toEqual({ name: "EvilBot" });
    expect((await h.s.discordRefresh()).discord.guilds).toEqual([{ id: "42", name: "EvilServer" }]);
  });

  describe("a public bot", () => {
    it("is flagged, with the invite link offered straight away", async () => {
      const h = harness({ app: { bot_public: true } });
      await h.s.saveChoices({ ...CHOICES });
      const v = await h.s.discordToken(DISCORD);
      expect(v.discord.publicBot).toBe("on");
      expect(v.discord.inviteUrl).toContain("client_id=");
    });

    it("doesn't hold up choosing the server while it stays on", async () => {
      const h = harness({ app: { bot_public: true } });
      await h.s.saveChoices({ ...CHOICES });
      await h.s.discordToken(DISCORD);
      const v = await h.s.discordRefresh();
      expect(v.discord.publicBot).toBe("on");
      expect(v.discord.guilds).toEqual([{ id: "42", name: "My Server" }]);
      expect((await h.s.confirmServers(["42"])).discord.selected).toEqual([{ id: "42", name: "My Server" }]);
    });

    it("is seen once it is turned off", async () => {
      const w: World = { app: { bot_public: true } };
      const h = harness(w);
      await h.s.saveChoices({ ...CHOICES });
      await h.s.discordToken(DISCORD);
      w.app = { bot_public: false };
      expect((await h.s.discordRefresh()).discord.publicBot).toBe("off");
    });
  });

  describe("confirming the server", () => {
    it("offers the one server it found and uses it only after you confirm", async () => {
      const h = harness();
      await h.s.saveChoices({ ...CHOICES });
      await h.s.discordToken(DISCORD);
      const v = await h.s.discordRefresh();
      expect(v.discord.guilds).toEqual([{ id: "42", name: "My Server" }]);
      expect(v.discord.selected).toBeNull();
      expect((await h.s.confirmServers(["42"])).discord.selected).toEqual([{ id: "42", name: "My Server" }]);
    });

    it("refuses a server it didn't see the bot in", async () => {
      const h = harness();
      await h.s.saveChoices({ ...CHOICES });
      await h.s.discordToken(DISCORD);
      await h.s.discordRefresh();
      expect(await failure(h.s.confirmServers(["999"]))).toMatch(/server/i);
      expect(await failure(h.s.confirmServers([]))).toMatch(/pick/i);
    });

    it("lets you pick among several servers", async () => {
      const guilds = [
        [
          { id: "1", name: "One" },
          { id: "2", name: "Two" },
          { id: "3", name: "Three" },
        ],
      ];
      const h = harness({ guilds });
      await h.s.saveChoices({ ...CHOICES });
      await h.s.discordToken(DISCORD);
      await h.s.discordRefresh();
      await h.s.confirmServers(["1", "3", "1"]);
      await h.s.cloudflareToken(BOOT, true);
      await h.s.finish({ revokeOld: true });
      expect(readEnv(h.path).GUILD_IDS).toBe("1,3");
    });
  });

  it("explains the manual fix if Discord refuses the intent, and carries on", async () => {
    const h = harness({ patchStatus: 403 });
    await h.s.saveChoices({ ...CHOICES });
    const v = await h.s.discordToken(DISCORD);
    expect(v.discord.intent?.ok).toBe(false);
    expect(v.discord.intent?.message).toMatch(/Message Content Intent/);
    expect(v.discord.intent?.message).toMatch(/Bot page/);
    expect(v.discord.app).not.toBeNull();
  });

  it("does not ask Discord again within a couple of seconds, however often the page asks", async () => {
    const h = harness();
    let t = 0;
    h.session.deps.now = () => t;
    await h.s.saveChoices({ ...CHOICES });
    await h.s.discordToken(DISCORD);
    await h.s.discordRefresh();
    await h.s.discordRefresh();
    t += 1000;
    await h.s.discordRefresh();
    expect(h.calls.filter((c) => c.url.endsWith("/users/@me/guilds"))).toHaveLength(1);
    t += 3000;
    await h.s.discordRefresh();
    expect(h.calls.filter((c) => c.url.endsWith("/users/@me/guilds"))).toHaveLength(2);
  });

  it("when Discord won't list servers, says so once, stops asking, and takes a pasted server ID, but only digits", async () => {
    const h = harness({ guildsStatus: 403 });
    await h.s.saveChoices({ ...CHOICES });
    await h.s.discordToken(DISCORD);
    const v = await h.s.discordRefresh();
    expect(v.discord.guildsProblem).toMatch(/server's ID|Server ID/i);
    await h.s.discordRefresh();
    await h.s.discordRefresh();
    expect(h.calls.filter((c) => c.url.endsWith("/users/@me/guilds"))).toHaveLength(1);
    expect(await failure(h.s.confirmServers([], "abc"))).toMatch(/digits/i);
    expect(await failure(h.s.confirmServers([], "../1"))).toMatch(/digits/i);
    await h.s.confirmServers([], "556");
    await h.s.cloudflareToken(BOOT, true);
    await h.s.finish({ revokeOld: true });
    expect(readEnv(h.path).GUILD_IDS).toBe("556");
  });
});

describe("setup: the Discord answers once Cloudflare has started", () => {
  it("cannot be replaced by another token, which would leave the server and the keys out of step", async () => {
    const h = harness();
    await toCloudflare(h);
    await h.s.cloudflareToken(BOOT, true);
    expect(await failure(h.s.discordToken(DISCORD))).toMatch(/Cloudflare setup has already started/);
    expect(h.session.view().discord.selected).toEqual([{ id: "42", name: "My Server" }]);
  });
});

describe("setup: a hiccup while waiting for Discord", () => {
  const slowDown = (h: H, fail: () => Response | null) => {
    const real = h.session.deps.fetch;
    h.session.deps.fetch = (async (url: string, init?: RequestInit) => {
      const bad = String(url).endsWith("/users/@me/guilds") ? fail() : null;
      return bad ?? real(url, init);
    }) as typeof fetch;
  };
  const guildCalls = (h: H) => h.calls.filter((c) => c.url.endsWith("/users/@me/guilds")).length;

  it("on a 429 says it is waiting, asks again only after the time Discord named, and carries on", async () => {
    const h = harness();
    let t = 0;
    h.session.deps.now = () => t;
    let limited = true;
    slowDown(h, () => (limited ? json({ retry_after: 7 }, 429) : null));
    await h.s.saveChoices({ ...CHOICES });
    await h.s.discordToken(DISCORD);
    const first = await h.s.discordRefresh();
    expect(first.discord.problem).toMatch(/slow down/i);
    expect(first.discord.guilds).toBeNull();
    expect(first.discord.guildsProblem).toBeNull();
    limited = false;
    t = 4000;
    await h.s.discordRefresh();
    expect(guildCalls(h)).toBe(0);
    t = 8000;
    const later = await h.s.discordRefresh();
    expect(guildCalls(h)).toBe(1);
    expect(later.discord.problem).toBeNull();
    expect(later.discord.guilds).toEqual([{ id: "42", name: "My Server" }]);
  });

  it("on a server error or no network shows the problem and tries again at the next look", async () => {
    const h = harness();
    let broken = true;
    slowDown(h, () => {
      if (!broken) return null;
      throw new Error("offline");
    });
    await h.s.saveChoices({ ...CHOICES });
    await h.s.discordToken(DISCORD);
    const first = await h.s.discordRefresh();
    expect(first.discord.problem).toMatch(/couldn't reach Discord/);
    broken = false;
    const next = await h.s.discordRefresh();
    expect(next.discord.problem).toBeNull();
    expect(next.discord.guilds).toHaveLength(1);
  });

  it("when Discord stops accepting the token, brings the token box back with the reason, and a new token works", async () => {
    const w: World = { app: { bot_public: true } };
    const h = harness(w);
    await h.s.saveChoices({ ...CHOICES });
    await h.s.discordToken(DISCORD);
    w.appStatus = 401;
    const v = await h.s.discordRefresh();
    expect(v.discord.app).toBeNull();
    expect(v.discord.problem).toMatch(/rejected that bot token/);
    w.appStatus = undefined;
    w.app = { bot_public: false };
    const again = await h.s.discordToken(DISCORD);
    expect(again.discord.app).toEqual({ name: "gork" });
    expect(again.discord.problem).toBeNull();
  });
});
