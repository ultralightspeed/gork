import { describe, expect, it } from "vitest";
import { ADMIN_NEEDS, runNeeds } from "../scripts/lib/cloudflare-setup.ts";
import {
  CREDITS_MODEL,
  FREE_MODEL,
  guardNotice,
  loadConfig,
  readSettings,
  SETTING_KEYS,
  SETTINGS,
  SettingsError,
} from "../src/config.ts";
import { GUARD_CATEGORIES } from "../src/guard.ts";

const base = {
  DISCORD_TOKEN: "d",
  CF_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  CF_RUN_TOKEN: "r",
  GUILD_IDS: "1, 2",
};

/** What loadConfig throws for these settings (the message), or "" when it doesn't. */
const failure = (overrides: Record<string, string>) => {
  try {
    loadConfig({ ...base, ...overrides });
  } catch (e) {
    return (e as Error).message;
  }
  return "";
};

describe("the settings table", () => {
  it("has a default that parses for every optional setting, none for a secret or required one, and one-line help", () => {
    for (const key of SETTING_KEYS) {
      const s = SETTINGS[key];
      expect(s.help, key).not.toContain("\n"); // it is printed as a comment line in .env.example
      if (s.required || s.secret) expect(s.default, key).toBe("");
      else expect(() => s.parse(s.default), key).not.toThrow();
    }
  });
});

describe("loadConfig", () => {
  it("applies defaults, splits ID lists and derives the endpoint and key from the account and run token", () => {
    const c = loadConfig(base);
    expect([...c.guildIds]).toEqual(["1", "2"]);
    expect(c.allowedChannelIds.size).toBe(0);
    expect(c.llm.baseUrl).toBe("https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/v1");
    expect(c.llm.apiKey).toBe("r");
    expect(c.mentions.size).toBe(0); // pings nobody until asked
  });

  it("treats blank values as defaults (Compose passes unset vars as empty strings)", () => {
    const c = loadConfig({ ...base, LLM_REASONING_EFFORT: "", DAILY_BUDGET_USD: "", LLM_MODEL: " " });
    expect(c.llm.reasoningEffort).toBe(SETTINGS.LLM_REASONING_EFFORT.default);
    expect(c.limits.dailyBudgetUsd).toBe(Number(SETTINGS.DAILY_BUDGET_USD.default));
    expect(c.llm.model).toBe(CREDITS_MODEL);
  });

  it("trims a trailing carriage return from Windows .env files", () => {
    expect(loadConfig({ ...base, CF_RUN_TOKEN: "r\r" }).cf.runToken).toBe("r");
  });

  it("names every missing required key, and does not need the host-only admin token", () => {
    expect(() => loadConfig({})).toThrow(/DISCORD_TOKEN.*GUILD_IDS.*CF_ACCOUNT_ID.*CF_RUN_TOKEN/);
    expect(() => loadConfig({})).not.toThrow(/CF_ADMIN_TOKEN/);
    expect(() => loadConfig({})).not.toThrow(/32 hex/); // a missing key isn't also reported as a malformed one
    expect(() => loadConfig(base)).not.toThrow();
  });

  it("reports every invalid value at once, naming the key", () => {
    let err: unknown;
    try {
      loadConfig({ ...base, DAILY_BUDGET_USD: "lots", CONTEXT_MESSAGES: "0" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SettingsError);
    expect((err as Error).message).toMatch(/DAILY_BUDGET_USD/);
    expect((err as Error).message).toMatch(/CONTEXT_MESSAGES/);
  });

  it("never sends the Cloudflare token to a non-Cloudflare model endpoint", () => {
    expect(() => loadConfig({ ...base, LLM_BASE_URL: "https://openrouter.ai/api/v1" })).toThrow(/LLM_API_KEY/);
    expect(loadConfig({ ...base, LLM_BASE_URL: "https://openrouter.ai/api/v1", LLM_API_KEY: "sk-or" }).llm.apiKey).toBe(
      "sk-or",
    );
    expect(loadConfig({ ...base, LLM_BASE_URL: "https://gateway.ai.cloudflare.com/v1/a/gork/compat" }).llm.apiKey).toBe(
      "r",
    );
  });

  it("normalizes guard categories and refuses typos instead of silently disabling the screen", () => {
    expect([...loadConfig({ ...base, GUARD_BLOCK: "s1, s11" }).guard.block].sort()).toEqual(["S1", "S11", "S4"]);
    expect(() => loadConfig({ ...base, GUARD_BLOCK: "S1,S99" })).toThrow(/GUARD_BLOCK/);
  });

  it("always screens S4 (sexual content involving minors), whatever GUARD_BLOCK says, and says so at startup", () => {
    for (const GUARD_BLOCK of ["none", "NONE", "S1", "S9,S11", "S4"])
      expect([...loadConfig({ ...base, GUARD_BLOCK }).guard.block], GUARD_BLOCK).toContain("S4");
    const none = loadConfig({ ...base, GUARD_BLOCK: "none" }).guard.block;
    expect([...none]).toEqual(["S4"]);
    expect(guardNotice(none)).toMatch(/S4.*always on/);
    expect([...loadConfig(base).guard.block].sort()).toEqual([...GUARD_CATEGORIES].sort());
  });

  it("ignores keys that aren't settings, so an .env shared with other tools or older versions still works", () => {
    expect(() => loadConfig({ ...base, OTHER_APP_VAR: "1", BOT_NAME: "x", VIDEO: "off" })).not.toThrow();
    expect(readSettings({ OTHER_APP_VAR: "1" }, ["DAILY_BUDGET_USD"])).toEqual({ DAILY_BUDGET_USD: 0.5 });
  });
});

describe("validation", () => {
  // [key, bad value, extra settings the value needs to get as far as its own check]
  const bad: [string, string, Record<string, string>?][] = [
    ["DAILY_BUDGET_USD", "lots"],
    ["DAILY_BUDGET_USD", "-7771"],
    ["MAX_TOOL_CALLS", "7771.5"],
    ["STRIKE_LIMIT", "-7771"],
    ["FETCH_MAX_CHARS", "0"],
    ["TRANSCRIPT_MAX_CHARS", "0"],
    ["VIDEOS_PER_DAY", "-7771"],
    ["CONTEXT_MESSAGES", "many"],
    ["CONTEXT_MESSAGES", "0"],
    ["CONTEXT_MESSAGES", "7771"], // Discord's limit is 100 per fetch: refused, not quietly clamped
    ["GUARD_THRESHOLD", "7771"],
    ["GUARD_THRESHOLD", "1.5"],
    ["LLM_REASONING_EFFORT", "extreme"],
    ["SEARCH_PROVIDER", "google"],
    ["MENTIONS", "channels7771"],
    ["MENTIONS", "users,channels7771"],
    ["BILLING_MODE", "cheap7771"],
    ["TIMEZONE", "Mars/Olympus_Mons"],
    ["TIMEZONE", "EST5EDT; DROP"],
    ["LLM_BASE_URL", "http://api.example.com/v1", { LLM_API_KEY: "k" }], // a key is never sent in the clear
    ["LLM_BASE_URL", "not a url", { LLM_API_KEY: "k" }],
    ["CF_ACCOUNT_ID", "acct"],
    ["CF_ACCOUNT_ID", `${"a".repeat(31)}g`],
    ["CF_ACCOUNT_ID", "a".repeat(33)],
    ["CF_ACCOUNT_ID", "../../other"], // it goes into URL paths
    ["AI_GATEWAY_ID", "../tokens"],
    ["AI_GATEWAY_ID", "my gateway"],
    ["AI_GATEWAY_ID", "-leading"],
    ["AI_GATEWAY_ID", "a".repeat(65)],
  ];

  it("rejects each bad value, naming the key and never echoing what was typed", () => {
    for (const [key, value, extra] of bad) {
      const message = failure({ [key]: value, ...extra });
      expect(message, `${key}=${value}`).toContain(key);
      if (value.length > 4) expect(message, `${key}=${value}`).not.toContain(value);
    }
  });

  it("never echoes a secret-looking value, whichever setting it is typed into", () => {
    const SECRET = "sk-live-SUPERSECRETVALUE.x";
    for (const key of [...new Set(bad.map(([k]) => k)), "GUARD_BLOCK"]) {
      const message = failure({ [key]: SECRET });
      expect(message, key).toContain(key);
      expect(message.toLowerCase(), key).not.toContain("supersecret");
    }
  });

  it("keeps 0 meaning off where it means something", () => {
    const c = loadConfig({
      ...base,
      STRIKE_LIMIT: "0",
      IMAGES_PER_DAY: "0",
      VIDEOS_PER_DAY: "0",
      MAX_TOOL_CALLS: "0",
      COOLDOWN_SECONDS: "0",
    });
    expect([c.guard.strikeLimit, c.tools.imagesPerDay, c.tools.videosPerDay, c.tools.maxCalls]).toEqual([0, 0, 0, 0]);
    expect(c.limits.cooldownSeconds).toBe(0);
  });

  it("accepts the documented values", () => {
    expect(loadConfig({ ...base, GUARD_THRESHOLD: "1" }).guard.threshold).toBe(1);
    expect(loadConfig({ ...base, GUARD_THRESHOLD: "0" }).guard.threshold).toBe(0);
    for (const effort of ["off", "low", "medium", "high", "max"])
      expect(loadConfig({ ...base, LLM_REASONING_EFFORT: effort }).llm.reasoningEffort).toBe(effort);
    for (const provider of ["ceramic", "exa", "linkup"])
      expect(loadConfig({ ...base, SEARCH_PROVIDER: provider }).tools.searchProvider).toBe(provider);
    expect([...loadConfig({ ...base, MENTIONS: "reply,users" }).mentions]).toEqual(["reply", "users"]);
    expect(loadConfig({ ...base, TIMEZONE: "America/New_York" }).timeZone).toBe("America/New_York");
    expect(loadConfig({ ...base, TIMEZONE: "  " }).timeZone).toBe("UTC");
    expect(loadConfig({ ...base, CONTEXT_MESSAGES: "100" }).limits.contextMessages).toBe(100);
    expect(loadConfig({ ...base, LLM_BASE_URL: "https://openrouter.ai/api/v1", LLM_API_KEY: "k" }).llm.baseUrl).toBe(
      "https://openrouter.ai/api/v1",
    );
    expect(loadConfig({ ...base, CF_ACCOUNT_ID: "ABCDEF0123456789abcdef0123456789" }).cf.accountId).toBe(
      "ABCDEF0123456789abcdef0123456789",
    );
    expect(loadConfig({ ...base, AI_GATEWAY_ID: "My-Gateway-2" }).cf.gatewayId).toBe("My-Gateway-2");
  });
});

describe("readSettings", () => {
  it("parses only the keys asked for, and enforces required only for those", () => {
    const s = readSettings(
      { CF_ACCOUNT_ID: "0123456789abcdef0123456789abcdef", CF_ADMIN_TOKEN: "t", DAILY_BUDGET_USD: "2" },
      ["CF_ACCOUNT_ID", "CF_ADMIN_TOKEN", "AI_GATEWAY_ID", "DAILY_BUDGET_USD"],
    );
    expect(s).toEqual({
      CF_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
      CF_ADMIN_TOKEN: "t",
      AI_GATEWAY_ID: "gork",
      DAILY_BUDGET_USD: 2,
    });
    expect(() => readSettings({}, ["CF_ADMIN_TOKEN", "DAILY_BUDGET_USD"])).toThrow(/CF_ADMIN_TOKEN/);
    expect(readSettings({}, ["DAILY_BUDGET_USD"])).toEqual({ DAILY_BUDGET_USD: 0.5 });
  });
});

describe("BILLING_MODE and the model", () => {
  it("free picks the free model unless LLM_MODEL is set, and only the free model can't see images", () => {
    const free = { ...base, BILLING_MODE: "free" };
    expect(loadConfig(free).llm.model).toBe(FREE_MODEL);
    expect(loadConfig({ ...free, LLM_MODEL: " " }).llm.model).toBe(FREE_MODEL);
    expect(loadConfig({ ...free, LLM_MODEL: "@cf/x/y" }).llm.model).toBe("@cf/x/y");
    expect(loadConfig(base).llm.vision).toBe(true);
    expect(loadConfig(free).llm.vision).toBe(false);
    expect(loadConfig({ ...free, LLM_MODEL: "@cf/x/y" }).llm.vision).toBe(true);
    expect(loadConfig({ ...base, LLM_MODEL: FREE_MODEL }).llm.vision).toBe(false);
  });

  it("free refuses an endpoint that isn't Workers AI direct, so nothing can be billed by accident", () => {
    const free = { ...base, BILLING_MODE: "free" };
    expect(() => loadConfig({ ...free, LLM_BASE_URL: "https://openrouter.ai/api/v1", LLM_API_KEY: "k" })).toThrow(
      /BILLING_MODE=free/,
    );
    expect(() =>
      loadConfig({ ...free, LLM_BASE_URL: "https://gateway.ai.cloudflare.com/v1/a/gork/workers-ai/v1" }),
    ).toThrow(/BILLING_MODE=free/);
    expect(() =>
      loadConfig({ ...free, LLM_BASE_URL: "https://api.cloudflare.com/client/v4/accounts/a/ai/v1" }),
    ).not.toThrow();
  });
});

describe("help text that makes a promise about tokens or billing", () => {
  it("lists exactly the admin permissions setup mints and doctor checks (Read and Write)", () => {
    const help = SETTINGS.CF_ADMIN_TOKEN.help;
    for (const need of ADMIN_NEEDS) expect(help).toContain(need.names[0].replace("AI Gateway ", ""));
    expect(help).toContain("AI Gateway Read + Write");
  });

  it("says what the runtime token needs in free mode too", () => {
    const help = SETTINGS.CF_RUN_TOKEN.help;
    expect(help).toMatch(/free mode/i);
    expect(help).toContain("Workers AI Read");
    expect(runNeeds("free").map((n) => n.capability)).toEqual(["Workers AI", "page reading"]);
  });

  it("says free mode is only free on the Workers Free plan, and that its model can't see images", () => {
    const help = SETTINGS.BILLING_MODE.help;
    expect(help).toMatch(/Workers Free plan/);
    expect(help).toMatch(/Workers Paid/);
    expect(help).toMatch(/can't see images/);
    expect(help).toMatch(/generating images still works/);
  });

  it("says video transcription is billed by the minute only on Workers Paid", () => {
    const help = SETTINGS.VIDEOS_PER_DAY.help;
    expect(help).toMatch(/free daily allowance on Workers Free/);
    expect(help).toMatch(/billed by the minute on Workers Paid/);
  });
});

describe("the settings that say how gork runs on this computer", () => {
  it("CONTAINER_ENGINE is blank (pick one), docker or podman, and never stops the bot", () => {
    const s = SETTINGS.CONTAINER_ENGINE;
    expect(s.parse("")).toBe("");
    expect(s.parse("docker")).toBe("docker");
    expect(s.parse("Podman")).toBe("podman");
    expect(() => s.parse("lxc")).toThrow(/docker, podman/);
    // Host settings are left out of the bot's own config, so a bad one can't stop the bot.
    expect(() => loadConfig({ ...base, CONTAINER_ENGINE: "lxc" })).not.toThrow();
    expect(() => readSettings({ CONTAINER_ENGINE: "lxc" }, ["CONTAINER_ENGINE"])).toThrow(/CONTAINER_ENGINE/);
  });

  it("GORK_IMAGE is blank (the released image), build, or a lowercase image name that can't pass for a flag", () => {
    const s = SETTINGS.GORK_IMAGE;
    for (const ok of ["", "build", "ghcr.io/me/gork:1.2.3", `localhost:5000/gork@sha256:${"a".repeat(64)}`, "gork:dev"])
      expect(s.parse(ok), ok).toBe(ok);
    for (const bad of ["Build", "-v", "has space", "gork;rm", "UPPER/gork:1", "a".repeat(300)])
      expect(() => s.parse(bad), bad).toThrow(/build|image name/);
  });
});
