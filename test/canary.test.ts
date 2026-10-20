import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { diagnose } from "../scripts/lib/doctor.ts";
import { assertOk, cloudflareApi } from "../scripts/lib/gateway.ts";
// The entry point the setup server and scripts/gork.ts use.
import { SetupSession } from "../scripts/lib/setup-session.ts";
import { cfFetch } from "../src/cf.ts";
import { loadConfig, readSettings, SETTING_KEYS } from "../src/config.ts";
import { describeError } from "../src/errors.ts";
import { answer } from "../src/llm.ts";
import { newToolState, runTool } from "../src/tools.ts";
import { shippedPersonas, testConfig } from "./helpers.ts";

// Credential canaries: values shaped like real secrets, fed through every path that turns an error or a setting into
// text someone sees (a log line, a doctor finding, the setup page). No piece of one may come out the other side. The
// canaries are built here at run time, so no token-shaped string is ever written into the repository.

const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
/** `n` letters and digits from a fixed seed: the same every run, and unlike any word the code prints. */
function mix(seed: number, n: number): string {
  let x = seed;
  let out = "";
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) % 2 ** 31;
    out += ALPHABET[x % ALPHABET.length];
  }
  return out;
}
const DISCORD = `M${mix(1, 25)}.${mix(2, 6)}.${mix(3, 38)}`; // a bot token: three dot-separated parts
const CLOUDFLARE = mix(4, 40); // an API token: 40 characters, no dots
const CF_ADMIN = mix(5, 40);
const SK = `sk-${mix(6, 48)}`; // an OpenAI-style key
const CANARIES = { DISCORD, CLOUDFLARE, CF_ADMIN, SK };
const ACCOUNT = "0123456789abcdef0123456789abcdef";
/** The shipped presets in one temp folder, shared by every doctor and setup run below. */
const PERSONAS = shippedPersonas();
/** Runs `make` the first time it is asked for, then hands back the same result. */
function once<T>(make: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | undefined;
  return () => {
    p ??= make();
    return p;
  };
}

/** Any 8 characters in a row from a canary: a cut-off token is still a leak. */
function leaks(texts: string[]): string[] {
  const found: string[] = [];
  for (const [name, canary] of Object.entries(CANARIES)) {
    for (let i = 0; i + 8 <= canary.length; i++) {
      const piece = canary.slice(i, i + 8);
      const hit = texts.find((t) => t.includes(piece));
      if (hit) {
        found.push(`${name} (${piece}) in: ${hit.slice(0, 120)}`);
        break;
      }
    }
  }
  return found;
}

/**
 * A server that fails and puts the request's credentials in its error body, after `pad` characters, so the secret
 * lands across each place the code cuts an excerpt (160, 200, 220, 300 characters).
 */
function echoFetch(status: number, shape: "text" | "json" | "bare", pad: number): typeof fetch {
  return (async (_url: string | URL | Request, init: RequestInit = {}) => {
    const auth = new Headers(init.headers).get("authorization") ?? "";
    const secret = shape === "bare" ? auth.replace(/^\S+ /, "") : auth;
    const text = `${".".repeat(pad)}${secret}`;
    const body = shape === "json" ? JSON.stringify({ success: false, errors: [{ code: 10000, message: text }] }) : text;
    return new Response(body, { status });
  }) as typeof fetch;
}
const PADS = [0, 120, 150, 180, 200, 280];
const SHAPES = ["text", "json", "bare"] as const;
/** Every echo variant: failing statuses, and a 200 whose body isn't JSON. */
const variants = PADS.flatMap((pad) =>
  SHAPES.flatMap((shape) => [401, 500, 200].map((status) => ({ pad, shape, status }))),
);

/** What a failing call leaves behind for a log: the message and describeError's line. */
async function errorText(run: () => Promise<unknown>): Promise<string[]> {
  try {
    await run();
    return [];
  } catch (err) {
    return [(err as Error).message ?? "", describeError(err)];
  }
}

const cfg = () =>
  testConfig({ DISCORD_TOKEN: DISCORD, CF_RUN_TOKEN: CLOUDFLARE, CF_ACCOUNT_ID: ACCOUNT, BILLING_MODE: "credits" });

describe("settings", () => {
  it("never repeat a value in their error messages, whichever key it was put in", () => {
    const out: string[] = [];
    const base = { DISCORD_TOKEN: DISCORD, CF_RUN_TOKEN: CLOUDFLARE, CF_ACCOUNT_ID: ACCOUNT, GUILD_IDS: "1" };
    for (const key of SETTING_KEYS) {
      for (const canary of Object.values(CANARIES)) {
        const env = { ...base, [key]: canary };
        out.push(
          ...[loadConfig, (e: typeof env) => readSettings(e, SETTING_KEYS)].flatMap((f) => {
            try {
              f(env);
              return [];
            } catch (err) {
              return [(err as Error).message, describeError(err)];
            }
          }),
        );
      }
    }
    expect(out.length).toBeGreaterThan(0);
    expect(leaks(out)).toEqual([]);
  });
});

describe("the leak check", () => {
  it("notices a cut-off piece of each canary, so every 'no leak' result below means something", () => {
    for (const [name, canary] of Object.entries(CANARIES))
      expect(leaks([`noise ${canary.slice(7, 17)} noise`]), name).toHaveLength(1);
    expect(leaks(["an ordinary error: HTTP 401"])).toEqual([]);
  });
});

describe("a Cloudflare or model server that echoes the credentials back", () => {
  it("can't get them into the tool results the model sees", async () => {
    const out: string[] = [];
    for (const v of variants) {
      const deps = { state: newToolState(cfg()), fetch: echoFetch(v.status, v.shape, v.pad), log: () => {} };
      for (const [name, args] of [
        ["web_search", { query: "weather" }],
        ["web_fetch", { url: "https://example.org/" }],
        ["generate_image", { prompt: "a cat" }],
      ] as const)
        out.push((await runTool(cfg(), name, args, deps)).content);
    }
    expect(leaks(out)).toEqual([]);
  });

  // Each path's output is collected once, then checked twice: a plain test that the error text is still produced (so
  // the expected failure below can't pass because the call broke some other way), and the leak check itself.
  const cfErrors = once(async () => {
    const out: string[] = [];
    for (const v of variants)
      out.push(...(await errorText(() => cfFetch(cfg(), "/ai/run/x", {}, echoFetch(v.status, v.shape, v.pad)))));
    return out;
  });
  const llmErrors = once(async () => {
    const out: string[] = [];
    const c = testConfig({
      CF_RUN_TOKEN: CLOUDFLARE,
      LLM_BASE_URL: "https://llm.example.org/v1",
      LLM_API_KEY: SK,
      LLM_MODEL: "m",
    });
    for (const v of variants)
      out.push(
        ...(await errorText(() =>
          answer(c, [{ role: "user", content: "hi" }], {
            fetch: echoFetch(v.status, v.shape, v.pad),
            runTool: async () => ({ content: "", costUsd: 0 }),
            reserve: () => true,
          }),
        )),
      );
    return out;
  });
  const apiErrors = once(async () => {
    const out: string[] = [];
    for (const v of variants) {
      const api = cloudflareApi(ACCOUNT, CF_ADMIN, echoFetch(v.status, v.shape, v.pad));
      out.push(...(await errorText(async () => assertOk(await api("GET", "/ai-gateway/gateways/gork"), "reading"))));
    }
    return out;
  });

  it("still produce the error texts checked below", async () => {
    expect((await cfErrors()).some((t) => /^Cloudflare HTTP 401: /.test(t))).toBe(true);
    expect((await cfErrors()).some((t) => /is not valid JSON/.test(t))).toBe(true);
    expect((await llmErrors()).some((t) => /^LLM HTTP 401: /.test(t))).toBe(true);
    expect((await apiErrors()).some((t) => /^reading failed: HTTP 401 /.test(t))).toBe(true);
  });

  // src/cf.ts: CfError's message quotes up to 200 characters of the body, and describeError (every log line) passes it
  // on, so cfFetch removes the token from the body first. A 200 whose body is not JSON must not surface JSON.parse's
  // message, which quotes the body's start.
  it("can't get them into cfFetch's errors or their log lines", async () => {
    expect(leaks(await cfErrors())).toEqual([]);
  });

  // src/llm.ts: LlmError's message quotes up to 160 characters of the body, and respond.ts / index.ts log it through
  // describeError. LLM_BASE_URL can be any provider, so the API key (here an sk- key) is the one at risk.
  it("can't get them into the model call's errors or their log lines", async () => {
    expect(leaks(await llmErrors())).toEqual([]);
  });

  // scripts/lib/gateway.ts: assertOk quotes up to 300 characters of Cloudflare's errors in its CliError, which the CLI
  // prints and doctor turns into a finding. cloudflareApi takes the request's own token out of the answer before
  // anything reads it, so no excerpt can hold a piece of it.
  it("can't get them into the CLI's Cloudflare API errors", async () => {
    expect(leaks(await apiErrors())).toEqual([]);
  });
});

describe("npm run doctor", () => {
  const doctorText = once(async () => {
    const out: string[] = [];
    for (const v of variants) {
      const found = await diagnose({
        env: {
          DISCORD_TOKEN: DISCORD,
          GUILD_IDS: "1",
          CF_ACCOUNT_ID: ACCOUNT,
          CF_RUN_TOKEN: CLOUDFLARE,
          CF_ADMIN_TOKEN: CF_ADMIN,
        },
        fetch: echoFetch(v.status, v.shape, v.pad),
        personasDir: PERSONAS,
      });
      out.push(...found.map((f) => f.text));
    }
    return out;
  });

  it("still reports the Cloudflare check's failure in its findings", async () => {
    expect((await doctorText()).some((t) => /^CF_RUN_TOKEN, .*failed: HTTP \d+ /.test(t))).toBe(true);
  });

  // Doctor prints what the Discord and Cloudflare checks say, and those quote server error bodies. Every Discord and
  // Cloudflare call takes its own token out of the answer before it is read (see the gateway case above).
  it("keeps every token out of its findings when the servers echo them", async () => {
    expect(leaks(await doctorText())).toEqual([]);
  });
});

describe("the setup page", () => {
  /** What the page would get: each view, and each error as the server sends it (through session.redact). */
  async function run(fetchFn: typeof fetch, throughDiscord: boolean): Promise<string[]> {
    const dir = mkdtempSync(join(tmpdir(), "gork-canary-"));
    const printed: string[] = [];
    let t = 0;
    const session = new SetupSession({
      fetch: fetchFn,
      now: () => (t += 5000),
      envPath: join(dir, ".env"),
      personasDir: PERSONAS,
      host: { platform: "linux", username: "alice", runCommand: () => ({ ok: true }) },
      print: (line) => printed.push(line),
      exit: () => {},
      startBot: async () => "ready",
    });
    const out: string[] = [];
    const step = async (work: () => Promise<unknown>) => {
      try {
        out.push(JSON.stringify(await work()));
      } catch (err) {
        out.push(session.redact((err as Error).message));
      }
      out.push(JSON.stringify(session.view()));
    };
    await step(() =>
      session.saveChoices({ billing: "credits", persona: "default", mentions: "none", timezone: "UTC", budget: "" }),
    );
    await step(() => session.discordToken(DISCORD));
    if (throughDiscord) {
      await step(() => session.discordRefresh());
      await step(() => session.confirmServers(["42"]));
      await step(() => session.cloudflareToken(CLOUDFLARE, true));
    }
    await session.dispose();
    rmSync(dir, { recursive: true, force: true });
    return [...out, ...printed];
  }

  /** A Discord that accepts the bot, and a Cloudflare that finds the account and then echoes on every other call. */
  function cloudflareEchoes(status: number, shape: (typeof SHAPES)[number], pad: number): typeof fetch {
    const echo = echoFetch(status, shape, pad);
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
    const app = { id: "111222333444555666", name: "gork", bot_public: false, flags: 0 };
    return (async (url: string | URL | Request, init: RequestInit = {}) => {
      const u = String(url);
      if (u.endsWith("/applications/@me"))
        return json(init.method === "PATCH" ? { ...app, flags: JSON.parse(String(init.body)).flags } : app);
      if (u.endsWith("/users/@me/guilds")) return json([{ id: "42", name: "My Server" }]);
      if (u.includes("/accounts?")) return json({ success: true, result: [{ id: ACCOUNT, name: "Me" }] });
      if (u.endsWith("/tokens/verify")) return json({ success: true, result: { id: "boot-id", status: "active" } });
      return echo(url, init);
    }) as typeof fetch;
  }

  it("keeps the Discord token out of what it shows when Discord echoes it back", async () => {
    const out: string[] = [];
    for (const v of variants) out.push(...(await run(echoFetch(v.status, v.shape, v.pad), false)));
    expect(out.some((t) => t.includes('"step"'))).toBe(true);
    expect(leaks(out)).toEqual([]);
  });

  const cloudflareRuns = once(async () => {
    const out: string[] = [];
    for (const v of variants) out.push(...(await run(cloudflareEchoes(v.status, v.shape, v.pad), true)));
    return out;
  });

  it("hides the whole Cloudflare setup token when Cloudflare echoes it back", async () => {
    const out = await cloudflareRuns();
    expect(out.some((t) => t.includes('"step":"cloudflare"'))).toBe(true);
    expect(out.some((t) => t.includes("couldn't list Cloudflare permission groups"))).toBe(true);
    expect(out.filter((t) => t.includes(CLOUDFLARE))).toEqual([]);
  });

  // scripts/lib/setup-session.ts: redact() replaces only a whole secret, and scripts/lib/cloudflare-setup.ts cuts
  // Cloudflare's error JSON at 200 characters (errorDetail). The token is taken out of the answer as it arrives, before
  // that cut, so a token cut in two can't slip past redact() to the page.
  it("keeps every piece of the Cloudflare setup token out of what it shows", async () => {
    expect(leaks(await cloudflareRuns())).toEqual([]);
  });
});
