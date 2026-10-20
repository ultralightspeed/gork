import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  enableMessageContent,
  getApplication,
  INVITE_PERMISSIONS,
  inviteUrl,
  listGuilds,
  looksLikeBotToken,
  MESSAGE_CONTENT,
  MESSAGE_CONTENT_LIMITED,
  messageContentOn,
  pollGuilds,
} from "../scripts/lib/discord-setup.ts";
import { CliError } from "../scripts/lib/errors.ts";
import { fakeFetch, json } from "./helpers.ts";

const TOKEN = "super-secret-bot-token";
const APP = "https://discord.com/api/v10/applications/@me";
const app = (over: object = {}) => ({ id: "123456789012345678", name: "gork", bot_public: false, flags: 0, ...over });
const noSleep = async () => {};

/** Everything a failure message might expose: it must never contain the token. */
const messageOf = async (p: Promise<unknown>) => {
  const err = await p.then(
    () => null,
    (e) => e,
  );
  expect(err).toBeInstanceOf(CliError);
  return (err as Error).message;
};

describe("getApplication", () => {
  it("reads id, name, bot_public and flags, authenticating as the bot", async () => {
    const { f, calls } = fakeFetch(() => json(app({ flags: 4096, bot_public: true, extra: "ignored" })));
    expect(await getApplication(TOKEN, f)).toEqual({
      id: "123456789012345678",
      name: "gork",
      bot_public: true,
      flags: 4096,
    });
    expect(calls[0].url).toBe(APP);
    expect(calls[0].headers.Authorization).toBe(`Bot ${TOKEN}`);
    expect(calls[0].headers["User-Agent"]).toMatch(/^DiscordBot /);
  });

  it("explains a 401 as a wrong token without repeating it", async () => {
    const { f } = fakeFetch(() => json({ message: "401: Unauthorized", code: 0 }, 401));
    const msg = await messageOf(getApplication(TOKEN, f));
    expect(msg).toMatch(/token/i);
    expect(msg).toMatch(/Reset Token/);
    expect(msg).not.toContain(TOKEN);
  });

  it("reports other HTTP failures with the status", async () => {
    const { f } = fakeFetch(() => json({ message: "boom" }, 500));
    expect(await messageOf(getApplication(TOKEN, f))).toMatch(/HTTP 500/);
  });

  it("reports an unreachable Discord, not the raw network error", async () => {
    const f = (async () => {
      throw new TypeError(`fetch failed for ${TOKEN}`);
    }) as unknown as typeof fetch;
    const msg = await messageOf(getApplication(TOKEN, f));
    expect(msg).toMatch(/reach Discord/i);
    expect(msg).not.toContain(TOKEN);
  });

  it("rejects an answer that is not an application, and an id that is not a snowflake since it ends up in the invite link", async () => {
    for (const reply of [{ hello: "world" }, app({ id: "1&permissions=8" })]) {
      const { f } = fakeFetch(() => json(reply));
      expect(await messageOf(getApplication(TOKEN, f))).toMatch(/unexpected/i);
    }
  });
});

describe("messageContentOn", () => {
  it("is on for the limited flag (under 100 servers) or the verified one", () => {
    expect(messageContentOn(0)).toBe(false);
    expect(messageContentOn(MESSAGE_CONTENT_LIMITED)).toBe(true);
    expect(messageContentOn(MESSAGE_CONTENT)).toBe(true);
    expect(messageContentOn(1 << 12)).toBe(false);
    expect(MESSAGE_CONTENT_LIMITED).toBe(524288);
  });
});

describe("enableMessageContent", () => {
  it("is a no-op, with no request, when the intent is already on", async () => {
    for (const flags of [MESSAGE_CONTENT_LIMITED, MESSAGE_CONTENT, MESSAGE_CONTENT | 4096]) {
      const { f, calls } = fakeFetch(() => json({}));
      expect(await enableMessageContent(TOKEN, app({ flags }), f)).toBe("already on");
      expect(calls).toEqual([]);
    }
  });

  it("ORs the flag into the existing ones, keeping the rest", async () => {
    const { f, calls } = fakeFetch(() => json(app({ flags: 4096 | MESSAGE_CONTENT_LIMITED })));
    expect(await enableMessageContent(TOKEN, app({ flags: 4096 }), f)).toBe("turned on");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "PATCH", url: APP, body: { flags: 4096 | MESSAGE_CONTENT_LIMITED } });
    expect(calls[0].headers.Authorization).toBe(`Bot ${TOKEN}`);
  });

  it("tells the user the manual fix when Discord refuses", async () => {
    const { f } = fakeFetch(() => json({ message: "Missing Access" }, 403));
    const msg = await messageOf(enableMessageContent(TOKEN, app(), f));
    expect(msg).toMatch(/Message Content Intent/);
    expect(msg).toMatch(/Bot page/);
    expect(msg).not.toContain(TOKEN);
  });

  it("does not trust a 200 that left the flag off", async () => {
    const { f } = fakeFetch(() => json(app({ flags: 0 })));
    expect(await messageOf(enableMessageContent(TOKEN, app(), f))).toMatch(/Message Content Intent/);
  });
});

describe("inviteUrl", () => {
  const bits = (url: string) => {
    const p = new URL(url).searchParams.get("permissions") as string;
    const n = BigInt(p);
    return [...Array(64).keys()].filter((i) => (n >> BigInt(i)) & 1n);
  };

  it("builds the exact least-privilege link: only what gork uses, never Administrator, and Create Events but not Manage Events", () => {
    expect(inviteUrl("123456789012345678", { mentionEveryone: false })).toBe(
      "https://discord.com/oauth2/authorize?client_id=123456789012345678&scope=bot&permissions=580817017490432",
    );
    expect(INVITE_PERMISSIONS).toBe(580817017490432n);
    // View Channels, Send Messages, Embed Links, Attach Files, Read Message History, Send Messages in Threads,
    // Create Events, Send Polls.
    const set = bits(inviteUrl("1", { mentionEveryone: false }));
    expect(set).toEqual([10, 11, 14, 15, 16, 38, 44, 49]);
    // Create Events lets gork edit or delete only its own events; Manage Events would reach everyone's.
    expect(set).not.toContain(33);
    expect(set).not.toContain(3);
  });

  it("adds Mention Everyone (bit 17) only when asked, and still never Administrator or Manage Events", () => {
    const url = inviteUrl("1", { mentionEveryone: true });
    const set = bits(url);
    expect(set).toEqual([10, 11, 14, 15, 16, 17, 38, 44, 49]);
    expect(set).not.toContain(3);
    expect(set).not.toContain(33);
    expect(new URL(url).searchParams.get("permissions")).toBe(String(580817017490432n | (1n << 17n)));
  });

  it("refuses an application id that is not digits", () => {
    expect(() => inviteUrl("1&permissions=8", { mentionEveryone: false })).toThrow(CliError);
    expect(() => inviteUrl("", { mentionEveryone: false })).toThrow(CliError);
  });
});

describe("docs/setup.md", () => {
  it("states the same permission integers the invite link carries", () => {
    const setup = readFileSync(new URL("../docs/setup.md", import.meta.url), "utf8");
    expect(setup).toContain(`permissions=${INVITE_PERMISSIONS}`);
    expect(setup).toContain(`permissions=${INVITE_PERMISSIONS | (1n << 17n)}`);
  });
});

describe("pollGuilds", () => {
  const opts = { timeoutMs: 600_000, intervalMs: 3000 };

  it("returns the guilds as soon as the bot is in one", async () => {
    const { f, calls } = fakeFetch(() => json([{ id: "42", name: "My Server", owner: false, permissions: "0" }]));
    expect(await pollGuilds(TOKEN, f, { ...opts, sleep: noSleep })).toEqual([
      { id: "42", name: "My Server", permissions: 0n },
    ]);
    expect(calls).toHaveLength(1);
  });

  it("keeps polling at the interval until a guild appears", async () => {
    const slept: number[] = [];
    let n = 0;
    const { f, calls } = fakeFetch(() => json(++n < 4 ? [] : [{ id: "7", name: "S" }]));
    const out = await pollGuilds(TOKEN, f, {
      ...opts,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(out).toEqual([{ id: "7", name: "S" }]);
    expect(calls).toHaveLength(4);
    expect(slept).toEqual([3000, 3000, 3000]);
  });

  it("gives up with an empty list when the timeout passes", async () => {
    const { f, calls } = fakeFetch(() => json([]));
    expect(await pollGuilds(TOKEN, f, { timeoutMs: 10_000, intervalMs: 3000, sleep: noSleep })).toEqual([]);
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(calls.length).toBeLessThanOrEqual(5);
  });

  it("stops at once on 401 or 403 and never retries (Discord restricts IPs after invalid requests)", async () => {
    for (const status of [401, 403]) {
      const { f, calls } = fakeFetch(() => json({ message: "nope" }, status));
      const msg = await messageOf(pollGuilds(TOKEN, f, { ...opts, sleep: noSleep }));
      expect(msg).toContain(String(status));
      expect(msg).toMatch(/GUILD_IDS/);
      expect(msg).not.toContain(TOKEN);
      expect(calls).toHaveLength(1);
    }
  });

  it("waits out a 429 for as long as Discord says, then carries on", async () => {
    const slept: number[] = [];
    let n = 0;
    const { f } = fakeFetch(() => (++n === 1 ? json({ retry_after: 7.5 }, 429) : json([{ id: "1", name: "S" }])));
    const out = await pollGuilds(TOKEN, f, {
      ...opts,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(out).toHaveLength(1);
    expect(slept).toEqual([7500]);
  });

  it("fails on a server error rather than polling forever", async () => {
    const { f } = fakeFetch(() => json({}, 500));
    expect(await messageOf(pollGuilds(TOKEN, f, { ...opts, sleep: noSleep }))).toMatch(/HTTP 500/);
  });
});

describe("looksLikeBotToken", () => {
  it("accepts three dot-separated parts and nothing else", () => {
    expect(looksLikeBotToken("aaaaaaaaaaaaaaaaaaaaaaaa.bbbbbb.cccccccccccccccccccccccccccc")).toBe(true);
    expect(looksLikeBotToken("aaaaaaaaaaaaaaaaaaaaaaaa.bbbbbb")).toBe(false);
    expect(looksLikeBotToken("aaaaaaaaaaaaaaaaaaaaaaaa")).toBe(false);
    expect(looksLikeBotToken("a.b.c")).toBe(false);
    expect(looksLikeBotToken("aaaaaaaaaaaaaaaaaaaaaaaa.bbbbbb.cccccccccccccccccccccccccccc extra")).toBe(false);
    expect(looksLikeBotToken("")).toBe(false);
  });
});

describe("listGuilds", () => {
  it("asks once and returns the servers the bot is in, with no waiting", async () => {
    const { f, calls } = fakeFetch(() => json([{ id: "42", name: "My Server" }, { id: 7 }, { id: "8" }]));
    expect(await listGuilds(TOKEN, f)).toEqual([
      { id: "42", name: "My Server" },
      { id: "8", name: "" },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://discord.com/api/v10/users/@me/guilds");
    expect(calls[0].headers.Authorization).toBe(`Bot ${TOKEN}`);
  });

  it("reads the bot's server-wide permissions when Discord sends them, and ignores anything that isn't a number", async () => {
    const { f } = fakeFetch(() =>
      json([
        { id: "1", name: "A", permissions: "580817017490432" },
        { id: "2", name: "B", permissions: "lots" },
        { id: "3", name: "C", permissions: 5 },
      ]),
    );
    expect(await listGuilds(TOKEN, f)).toEqual([
      { id: "1", name: "A", permissions: 580817017490432n },
      { id: "2", name: "B" },
      { id: "3", name: "C" },
    ]);
  });

  it("returns an empty list, not an error, when the bot is in no server", async () => {
    expect(await listGuilds(TOKEN, fakeFetch(() => json([])).f)).toEqual([]);
  });

  it("says what to do when Discord won't list servers (401 or 403), without echoing the token", async () => {
    for (const status of [401, 403]) {
      const err = await listGuilds(TOKEN, fakeFetch(() => json({}, status)).f).catch((e) => e);
      expect(err).toBeInstanceOf(CliError);
      expect(err.message).toMatch(new RegExp(`HTTP ${status}.*GUILD_IDS`));
      expect(err.message).not.toContain(TOKEN);
    }
  });

  it("reports any other status, including a rate limit, as an error", async () => {
    for (const status of [429, 500]) {
      await expect(listGuilds(TOKEN, fakeFetch(() => json({}, status)).f)).rejects.toThrow(
        new RegExp(`HTTP ${status}`),
      );
    }
  });
});
