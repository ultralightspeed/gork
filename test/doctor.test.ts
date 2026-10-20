import { describe, expect, it } from "vitest";
import { type Deps, main } from "../scripts/gork.ts";
import { DOCKER, type Engine, EngineMissingError } from "../scripts/lib/engine.ts";
import { IMAGE_REPO, packageVersion } from "../scripts/lib/image.ts";
import { type Call, fakeClock, fakeDocker, fakeFetch, json, shippedPersonas } from "./helpers.ts";

const SECRETS = {
  DISCORD_TOKEN: "dtok-SECRET-1",
  CF_RUN_TOKEN: "run-SECRET-2",
  CF_ADMIN_TOKEN: "adm-SECRET-3",
};
const ENV = { ...SECRETS, GUILD_IDS: "1", CF_ACCOUNT_ID: "0123456789abcdef0123456789abcdef" };
const APP_ID = "111222333444555666";
const PERSONAS = shippedPersonas();
const ok = (result: unknown = {}) => json({ success: true, result });

const GATEWAY = {
  id: "gork",
  authentication: true,
  zdr: true,
  workers_ai_billing_mode: "unified",
  spend_limits: { enabled: true },
};
/** The gateway as free mode wants it. */
const STANDARD = { gateway: { ...GATEWAY, workers_ai_billing_mode: "standard" } };

type World = {
  app?: object;
  appStatus?: number;
  guilds?: object[];
  guildsStatus?: number;
  gateway?: object | null;
  gatewayStatus?: number;
  chat?: () => Response;
  search?: () => Response;
  browser?: () => Response;
};

/** Discord and Cloudflare as a healthy account sees them; each test breaks one thing. */
function world(w: World = {}) {
  return fakeFetch((c: Call) => {
    const u = c.url;
    if (u.endsWith("/applications/@me"))
      return json(w.app ?? { id: APP_ID, name: "gork", bot_public: false, flags: 1 << 19 }, w.appStatus ?? 200);
    if (u.endsWith("/users/@me/guilds")) return json(w.guilds ?? [{ id: "1", name: "S" }], w.guildsStatus ?? 200);
    if (u.includes("/ai-gateway/gateways/")) {
      if (w.gatewayStatus) return json({ success: false, errors: [{ code: 10000 }] }, w.gatewayStatus);
      return w.gateway === null ? json({ success: false, errors: [] }, 404) : ok(w.gateway ?? GATEWAY);
    }
    if (u.endsWith("/ai/v1/chat/completions")) return w.chat?.() ?? json({ choices: [{ message: { content: "hi" } }] });
    if (u.endsWith("/ai/websearch")) return w.search?.() ?? ok({ items: [] });
    if (u.endsWith("/browser-rendering/markdown")) return w.browser?.() ?? ok("# x");
    return json({}, 500);
  });
}

function run(env: Record<string, string> = ENV, w: World = {}, args: string[] = [], engine?: Deps["engine"]) {
  const net = world(w);
  const docker = fakeDocker();
  const out: string[] = [];
  const errors: string[] = [];
  const deps: Deps = {
    env,
    run: docker.run,
    engine,
    fetch: net.f,
    ...fakeClock(),
    confirm: async () => "",
    log: (l) => out.push(l),
    warn: (l) => errors.push(l),
    personasDir: PERSONAS,
  };
  const go = async () => {
    const code = await main(["doctor", ...args], deps);
    const all = [...out, ...errors].join("\n");
    // Whatever happens, no secret value is ever printed.
    for (const v of [...Object.values(SECRETS), ...Object.values(env)].filter((x) => /SECRET/.test(x))) {
      expect(all).not.toContain(v);
    }
    return { code, text: all, out: out.join("\n") };
  };
  return { go, calls: net.calls, docker: docker.calls };
}

const search = (t: ReturnType<typeof run>) => t.calls.filter((c) => c.url.endsWith("/ai/websearch"));

describe("doctor: a healthy setup", () => {
  it("passes, says so, uses no Docker, and has nothing to say about the free plan", async () => {
    const t = run();
    const r = await t.go();
    expect(r.code).toBe(0);
    expect(r.text).not.toMatch(/FAIL/);
    expect(r.text).toMatch(/everything looks good/i);
    expect(r.text).not.toMatch(/Workers Free plan/);
    expect(t.docker).toEqual([]);
  });

  it("reads each credential only to its own host", async () => {
    const t = run();
    await t.go();
    for (const c of t.calls) {
      const auth = c.headers.Authorization;
      if (c.url.startsWith("https://discord.com/")) expect(auth).toBe(`Bot ${SECRETS.DISCORD_TOKEN}`);
      else expect(c.url.startsWith("https://api.cloudflare.com/")).toBe(true);
      expect(auth).not.toContain("undefined");
    }
  });

  it("free mode: passes on a standard-billing gateway, warns that it is only free on the Workers Free plan, never searches, never sends a gateway header", async () => {
    const t = run({ ...ENV, BILLING_MODE: "free" }, STANDARD);
    const r = await t.go();
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/BILLING_MODE=free.*only free on the Workers Free plan/);
    expect(r.out).not.toMatch(/skipped/i);
    expect(search(t)).toEqual([]);
    for (const c of t.calls.filter((x) => x.url.endsWith("/ai/v1/chat/completions"))) {
      expect(Object.keys(c.headers).filter((h) => /^cf-aig-/i.test(h))).toEqual([]);
    }
  });
});

describe("doctor --json", () => {
  type Report = { ok: boolean; checks: { id: string; level: string; message: string }[] };
  const report = (out: string): Report => JSON.parse(out);

  it("prints one JSON document with a stable id for each check, and nothing else", async () => {
    const r = await run(ENV, {}, ["--json"]).go();
    expect(r.code).toBe(0);
    expect(r.text).toBe(r.out);
    const doc = report(r.out);
    expect(doc.ok).toBe(true);
    expect(doc.checks.map((c) => c.id)).toEqual([
      "settings",
      "image",
      "persona",
      "discord.token",
      "discord.intent",
      "discord.servers",
      "cloudflare.gateway",
      "cloudflare.run:chat",
      "cloudflare.run:page-reading",
      "cloudflare.run:web-search",
    ]);
    for (const c of doc.checks) {
      expect(["ok", "warn", "fail"]).toContain(c.level);
      expect(c.message.length).toBeGreaterThan(0);
    }
  });

  it("says ok: false and exits 1 when a check fails, naming a missing setting by its key, with only the JSON on the output", async () => {
    const { CF_RUN_TOKEN: _, ...rest } = ENV;
    const r = await run(rest, { appStatus: 401 }, ["--json"]).go();
    expect(r.code).toBe(1);
    expect(r.text).toBe(r.out);
    const doc = report(r.out);
    expect(doc.ok).toBe(false);
    expect(doc.checks.find((c) => c.id === "discord.token")?.level).toBe("fail");
    expect(doc.checks).toContainEqual(expect.objectContaining({ id: "settings:CF_RUN_TOKEN", level: "fail" }));
  });
});

describe("doctor: secret values never reach a finding", () => {
  it("hides a setting's secret value even when a server repeats it back", async () => {
    const app = { id: APP_ID, name: SECRETS.CF_RUN_TOKEN, bot_public: false, flags: 1 << 19 };
    const human = await run(ENV, { app }).go();
    expect(human.out).toMatch(/application "\[redacted\]"/);
  });
});

describe("doctor: the container engine and image", () => {
  it("says which engine npm run up will use, and how it runs compose", async () => {
    const podman: Engine = {
      ...DOCKER,
      name: "podman",
      label: "Podman",
      command: "podman",
      compose: ["podman", "compose"],
      version: "5.2.1",
    };
    const seen: Array<string | undefined> = [];
    const r = await run({ ...ENV, CONTAINER_ENGINE: "podman" }, {}, [], (env) => {
      seen.push(env.CONTAINER_ENGINE);
      return podman;
    }).go();
    expect(r.code).toBe(0);
    expect(r.out).toContain("ok   container engine: Podman 5.2.1 (podman compose)");
    expect(seen).toEqual(["podman"]);
  });

  it("fails, with what to fix, when there is no working engine", async () => {
    const r = await run(ENV, {}, [], () => {
      throw new EngineMissingError("Docker Desktop isn't running. Start it, then retry.");
    }).go();
    expect(r.code).toBe(1);
    expect(r.out).toContain("FAIL Docker Desktop isn't running. Start it, then retry.");
  });

  it("says which image npm run up will start: the release, a build here, or the one GORK_IMAGE names", async () => {
    const released = `${IMAGE_REPO}:${packageVersion()}`;
    expect((await run(ENV).go()).out).toMatch(new RegExp(`ok   gork image: .*downloads ${released}.*--build`));
    expect((await run({ ...ENV, GORK_IMAGE: "build" }).go()).out).toMatch(/ok {3}gork image: .*builds gork here/);
    expect((await run({ ...ENV, GORK_IMAGE: "ghcr.io/me/gork:dev" }).go()).out).toMatch(
      /ok {3}gork image: .*runs ghcr\.io\/me\/gork:dev/,
    );
  });

  it("reports a GORK_IMAGE that isn't a name once, with the setting's own message", async () => {
    const r = await run({ ...ENV, GORK_IMAGE: "No Spaces" }).go();
    expect(r.code).toBe(1);
    expect(r.out.match(/GORK_IMAGE/g)).toHaveLength(1);
    expect(r.out).not.toMatch(/gork image:/);
  });
});

describe("doctor: Create Events", () => {
  const CREATE_EVENTS = 1n << 44n;
  const ADMINISTRATOR = 1n << 3n;
  const MANAGE_EVENTS = 1n << 33n;
  const inServer = (permissions?: bigint) => ({
    guilds: [
      { id: "1", name: "My Server", ...(permissions === undefined ? {} : { permissions: String(permissions) }) },
    ],
  });

  it("warns, with the invite link, when the bot lacks Create Events (Manage Events alone doesn't do) in a server it will answer in", async () => {
    const r = await run(ENV, inServer(580817017490432n & ~CREATE_EVENTS)).go();
    expect(r.code).toBe(0);
    expect(r.text).toMatch(/warn.*Create Events/);
    expect(r.text).toContain("My Server");
    expect(r.text).toContain("permissions=580817017490432");
    expect((await run(ENV, inServer(MANAGE_EVENTS)).go()).text).toMatch(/warn.*Create Events/);
  });

  it("stays quiet with Create Events or Administrator, when Discord doesn't say, and about a server not in GUILD_IDS", async () => {
    const other = [
      { id: "2", name: "Other Server", permissions: "0" },
      { id: "1", name: "S", permissions: String(CREATE_EVENTS) },
    ];
    const worlds = [inServer(CREATE_EVENTS), inServer(ADMINISTRATOR), inServer(), { guilds: other }];
    for (const w of worlds) expect((await run(ENV, w).go()).text, JSON.stringify(w)).not.toMatch(/Create Events/);
  });
});

describe("doctor: the paid probe is opt-in", () => {
  it("does not spend a web search by default, says it skipped it and how to run it, and still runs the cheap checks", async () => {
    const t = run();
    const r = await t.go();
    expect(search(t)).toEqual([]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/web search: skipped/i);
    expect(r.out).toContain("npm run doctor -- --live");
    expect(t.calls.some((c) => c.url.endsWith("/ai/v1/chat/completions"))).toBe(true);
    expect(t.calls.some((c) => c.url.endsWith("/browser-rendering/markdown"))).toBe(true);
  });

  it("runs the search with --live, then has nothing to say about skipping, and reports it failing", async () => {
    const t = run(ENV, {}, ["--live"]);
    const r = await t.go();
    expect(search(t)).toHaveLength(1);
    expect(r.out).toMatch(/CF_RUN_TOKEN, web search: works/);
    expect(r.out).not.toMatch(/skipped/i);

    const broken = await run(ENV, { search: () => json({}, 403) }, ["--live"]).go();
    expect(broken.code).toBe(1);
    expect(broken.text).toMatch(/FAIL.*web search/);
  });

  it("refuses an option it doesn't know, before any network call", async () => {
    const t = run(ENV, {}, ["--lvie"]);
    const r = await t.go();
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/unknown option/i);
    expect(r.text).toContain("--live");
    expect(t.calls).toEqual([]);
  });
});

describe("doctor: an invalid CF_ACCOUNT_ID", () => {
  it("is reported by key and sends no token anywhere near Cloudflare", async () => {
    const t = run({ ...ENV, CF_ACCOUNT_ID: "../../other" });
    const r = await t.go();
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/CF_ACCOUNT_ID must be 32 hex characters/);
    expect(r.text).not.toContain("other");
    expect(t.calls.filter((c) => c.url.includes("cloudflare.com"))).toEqual([]);
  });
});

describe("doctor: settings", () => {
  it("names every missing key with where to get it, and makes no network call", async () => {
    const t = run({});
    const r = await t.go();
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/DISCORD_TOKEN is missing: .*Reset Token/);
    expect(r.text).toMatch(/GUILD_IDS is missing/);
    expect(r.text).toMatch(/CF_ACCOUNT_ID is missing: .*dash\.cloudflare\.com/);
    expect(r.text).toMatch(/CF_RUN_TOKEN is missing:.*AI Gateway Run.*Websearch Run/);
    expect(r.text).toMatch(/CF_ADMIN_TOKEN is missing:.*AI Gateway Write/);
    expect(t.calls).toEqual([]);
  });

  it("free mode tells you the free run token needs no gateway or search group", async () => {
    const r = await run({ BILLING_MODE: "free" }).go();
    expect(r.text).toMatch(/CF_RUN_TOKEN is missing:.*Workers AI Read/);
    expect(r.text).not.toMatch(/CF_RUN_TOKEN is missing:[^\n]*(Websearch|AI Gateway Run)/);
  });

  it("reports an invalid value against its key, and still runs the checks that don't depend on it", async () => {
    const t = run({ ...ENV, DAILY_BUDGET_USD: "lots", BILLING_MODE: "cheap" });
    const r = await t.go();
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/DAILY_BUDGET_USD must be a non-negative number/);
    expect(r.text).toMatch(/BILLING_MODE must be one of credits, free/);
    // The bot's own probes wait until the settings parse.
    expect(t.calls.some((c) => c.url.endsWith("/applications/@me"))).toBe(true);
    expect(t.calls.some((c) => c.url.endsWith("/ai/v1/chat/completions"))).toBe(false);
  });

  it("reports the cross-setting rules the bot enforces", async () => {
    const r = await run({
      ...ENV,
      BILLING_MODE: "free",
      LLM_BASE_URL: "https://openrouter.ai/api/v1",
      LLM_API_KEY: "k",
    }).go();
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/BILLING_MODE=free needs LLM_BASE_URL empty/);
  });

  it("warns that a GLM 5.x model fails on the free plan", async () => {
    const r = await run({ ...ENV, BILLING_MODE: "free", LLM_MODEL: "@cf/zai-org/glm-5.3-flash" }, STANDARD).go();
    expect(r.code).toBe(0);
    expect(r.text).toMatch(/warn.*glm-5.*(Workers Paid|free plan)/i);
  });
});

describe("doctor: persona", () => {
  it("lists the choices when the persona isn't found, and explains PERSONA=custom without a custom.md", async () => {
    const missing = await run({ ...ENV, PERSONA: "pirate" }).go();
    expect(missing.code).toBe(1);
    expect(missing.text).toMatch(/PERSONA "pirate" not found, choices: .*default.*witty/);
    const custom = await run({ ...ENV, PERSONA: "custom" }).go();
    expect(custom.code).toBe(1);
    expect(custom.text).toMatch(/personas\/custom\.example\.md/);
  });
});

describe("doctor: Discord", () => {
  it("explains a rejected token and skips the checks that need it", async () => {
    const t = run(ENV, { appStatus: 401 });
    const r = await t.go();
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/DISCORD_TOKEN.*rejected|Reset Token/);
    expect(t.calls.some((c) => c.url.endsWith("/users/@me/guilds"))).toBe(false);
  });

  it("flags the Message Content intent being off, with the fix", async () => {
    const r = await run(ENV, { app: { id: APP_ID, name: "gork", bot_public: false, flags: 0 } }).go();
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/Message Content intent is off: .*Bot page/);
  });

  it("only warns when the app is public", async () => {
    const r = await run(ENV, { app: { id: APP_ID, name: "gork", bot_public: true, flags: 1 << 19 } }).go();
    expect(r.code).toBe(0);
    expect(r.text).toMatch(/warn.*Public Bot/);
  });

  it("gives the invite link when the bot isn't in any server in GUILD_IDS, asking for Mention Everyone only when MENTIONS allows it", async () => {
    const r = await run({ ...ENV, GUILD_IDS: "999" }).go();
    expect(r.code).toBe(1);
    expect(r.text).toContain("bot isn't in any server in GUILD_IDS");
    expect(r.text).toContain(
      `https://discord.com/oauth2/authorize?client_id=${APP_ID}&scope=bot&permissions=580817017490432`,
    );
    const withEveryone = `permissions=${580817017490432n | (1n << 17n)}`;
    for (const MENTIONS of ["everyone", "all"]) {
      expect((await run({ ...ENV, GUILD_IDS: "999", MENTIONS }).go()).text, MENTIONS).toContain(withEveryone);
    }
    const none = await run({ ...ENV, GUILD_IDS: "999", MENTIONS: "reply,users" }).go();
    expect(none.text).toContain("permissions=580817017490432");
    expect(none.text).not.toContain(withEveryone);
  });

  it("warns, rather than fails, about a configured server the bot isn't in", async () => {
    const r = await run({ ...ENV, GUILD_IDS: "1,2" }).go();
    expect(r.code).toBe(0);
    expect(r.text).toMatch(/warn.*GUILD_IDS.*\b2\b/);
  });

  it("calls a refused, rate-limited or failing server list a warning, not 'the bot isn't in any server', and asks once", async () => {
    for (const status of [403, 429, 500]) {
      const t = run(ENV, { guildsStatus: status });
      const r = await t.go();
      expect(r.code, String(status)).toBe(0);
      expect(r.text).toMatch(/warn.*couldn't check.*servers/i);
      expect(r.text).not.toMatch(/isn't in any server/);
      expect(t.calls.filter((c) => c.url.endsWith("/users/@me/guilds"))).toHaveLength(1);
    }
  });

  it("still offers the invite link when GUILD_IDS is the only thing missing", async () => {
    const { GUILD_IDS: _drop, ...rest } = ENV;
    const r = await run(rest).go();
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/GUILD_IDS is missing: .*discord\.com\/oauth2\/authorize\?client_id=111222333444555666/);
  });
});

describe("doctor: Cloudflare", () => {
  it("turns a refused capability into 'missing: <groups>'", async () => {
    const r = await run(ENV, {
      chat: () => json({ success: false, errors: [{ code: 10000 }] }, 403),
      browser: () => json({ success: false, errors: [] }, 403),
    }).go();
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/CF_RUN_TOKEN.*chat.*missing: AI Gateway Read, AI Gateway Run, Workers AI Read/);
    expect(r.text).toMatch(/CF_RUN_TOKEN.*page reading.*missing: Browser/);
  });

  it("says when the gateway doesn't exist", async () => {
    const r = await run(ENV, { gateway: null }).go();
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/AI Gateway "gork" doesn't exist: run `npm run up`/);
  });

  it("explains a rejected or expired admin token", async () => {
    const r = await run(ENV, { gatewayStatus: 403 }).go();
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/CF_ADMIN_TOKEN.*missing: AI Gateway Read, AI Gateway Write.*expired/);
  });

  it("catches free mode on a gateway billed to credits, and the reverse", async () => {
    const free = await run({ ...ENV, BILLING_MODE: "free" }).go();
    expect(free.code).toBe(1);
    expect(free.text).toMatch(/BILLING_MODE=free but AI Gateway "gork" bills Workers AI to credits.*npm run gateway/);
    const credits = await run(ENV, STANDARD).go();
    expect(credits.code).toBe(1);
    expect(credits.text).toMatch(/BILLING_MODE=credits but AI Gateway "gork" is on standard billing.*npm run gateway/);
  });

  it("warns about other gateway settings that differ from gork's", async () => {
    const r = await run(ENV, { gateway: { ...GATEWAY, authentication: false, zdr: false } }).go();
    expect(r.code).toBe(0);
    expect(r.text).toMatch(/warn.*AI Gateway "gork".*authentication.*zdr.*npm run gateway/s);
  });

  it("skips Cloudflare checks that lack their token but still runs the others", async () => {
    const { CF_RUN_TOKEN: _r, ...rest } = ENV;
    const t = run(rest);
    const r = await t.go();
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/CF_RUN_TOKEN is missing/);
    expect(t.calls.some((c) => c.url.endsWith("/applications/@me"))).toBe(true);
    expect(t.calls.some((c) => c.url.endsWith("/ai/v1/chat/completions"))).toBe(false);
  });
});
