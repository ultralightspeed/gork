// The setup steps behind the page as a whole: start to finish, in order, with the page polling, and stopping midway.
import { existsSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { SetupSession } from "../scripts/lib/setup-session.ts";
import { CREDITS_MODEL, FREE_MODEL, loadConfig, SETTING_KEYS, SETTINGS } from "../src/config.ts";
import { type Call, json } from "./helpers.ts";
import {
  CHOICES,
  deleted,
  failure,
  type H,
  harness,
  type Over,
  readEnv,
  toCloudflare,
  toGateway,
  whole,
} from "./setup-harness.ts";
import { ACCT, ALL_SECRETS, APP_ID, BOOT, DISCORD, gate, MINTED, refused, type World } from "./setup-world.ts";

describe("setup: credits mode, start to finish", () => {
  it("writes a .env that loadConfig accepts, holding the pasted and minted secrets", async () => {
    const h = harness();
    await whole(h, { choices: { persona: "witty", budget: "1.25" } });
    const env = readEnv(h.path);
    expect(env).toMatchObject({
      DISCORD_TOKEN: DISCORD,
      GUILD_IDS: "42",
      CF_ACCOUNT_ID: ACCT,
      CF_RUN_TOKEN: MINTED("gork-run"),
      CF_ADMIN_TOKEN: MINTED("gork-admin"),
      BILLING_MODE: "credits",
      MENTIONS: "none",
      PERSONA: "witty",
      TIMEZONE: "UTC",
      DAILY_BUDGET_USD: "1.25",
    });
    const cfg = loadConfig(env);
    expect(cfg.billing).toBe("credits");
    expect(cfg.llm.model).toBe("@cf/zai-org/glm-5.3-flash");
    // The one-time setup token is not one of the settings, and appears nowhere in the file.
    expect(readFileSync(h.path, "utf8")).not.toContain(BOOT);
  });

  it("documents every key, as UTF-8 with LF line endings, no BOM, readable only by its owner", async () => {
    const h = harness();
    await whole(h);
    const bytes = readFileSync(h.path);
    expect(bytes[0]).not.toBe(0xef);
    const text = bytes.toString("utf8");
    expect(text).not.toContain("\r");
    expect(text.endsWith("\n")).toBe(true);
    for (const key of SETTING_KEYS) {
      const s = SETTINGS[key];
      if (s.scope !== "image") expect(text, key).toContain(`${s.help}\n${key}=`);
    }
    if (process.platform !== "win32") expect(statSync(h.path).mode & 0o777).toBe(0o600);
  });

  it("never hands a secret back: not in any answer, error or line printed, pasted (right or wrong) or minted", async () => {
    const h = harness({ chat: () => refused(403) });
    await h.s.saveChoices({ ...CHOICES });
    await failure(h.s.discordToken("short.token"));
    await failure(h.s.discordToken("no-dots-here-at-all-0123456789"));
    await whole(h);
    for (const secret of [...ALL_SECRETS, "no-dots-here"]) expect(h.text()).not.toContain(secret);
    expect(h.text().length).toBeGreaterThan(500);
  });

  it("sends each secret only to its own host, in a header and never in a URL or body", async () => {
    const h = harness();
    await whole(h);
    for (const c of h.calls) {
      const auth = c.headers.Authorization ?? "";
      const host = new URL(c.url).hostname;
      if (host === "discord.com") {
        expect(auth).toBe(`Bot ${DISCORD}`);
      } else {
        expect(host).toBe("api.cloudflare.com");
        expect(auth).not.toContain(DISCORD);
      }
      const rest = JSON.stringify([c.url, c.body ?? null]);
      for (const secret of ALL_SECRETS) expect(rest).not.toContain(secret);
    }
  });

  it("turns on the Message Content intent itself, and offers the invite link without Mention Everyone", async () => {
    const h = harness();
    await h.s.saveChoices({ ...CHOICES });
    const v = await h.s.discordToken(DISCORD);
    expect(h.calls.find((c) => c.method === "PATCH")?.body).toEqual({ flags: 1 << 19 });
    expect(v.discord.app).toEqual({ name: "gork" });
    expect(v.discord.intent).toMatchObject({ ok: true });
    expect(v.discord.inviteUrl).toBe(
      `https://discord.com/oauth2/authorize?client_id=${APP_ID}&scope=bot&permissions=580817017490432`,
    );
  });

  it("mints gork-run and gork-admin with the setup token, by group id, limited to the account", async () => {
    const h = harness();
    await whole(h);
    const mints = h.calls.filter((c) => c.method === "POST" && c.url.endsWith(`/accounts/${ACCT}/tokens`));
    expect(mints.map((c) => c.body.name)).toEqual(["gork-run", "gork-admin"]);
    for (const m of mints) {
      expect(m.headers.Authorization).toBe(`Bearer ${BOOT}`);
      expect(m.body.policies[0].resources).toEqual({ [`com.cloudflare.api.account.${ACCT}`]: "*" });
    }
    const ids = (c: Call) => c.body.policies[0].permission_groups.map((g: { id: string }) => g.id).sort();
    expect(ids(mints[0])).toEqual(
      ["AI Gateway Read", "AI Gateway Run", "Workers AI Read", "Websearch Run", "Browser Rendering - Edit"]
        .map((n) => `g:${n}`)
        .sort(),
    );
    expect(ids(mints[1])).toEqual(["g:AI Gateway Edit", "g:AI Gateway Read"]);
  });

  it("creates the gateway with the admin token, billed to credits", async () => {
    const h = harness();
    await whole(h);
    const create = h.calls.find((c) => c.method === "POST" && c.url.endsWith("/ai-gateway/gateways"));
    expect(create?.headers.Authorization).toBe(`Bearer ${MINTED("gork-admin")}`);
    expect(create?.body).toMatchObject({ id: "gork", workers_ai_billing_mode: "unified" });
  });

  it("deletes the setup token by its id, but only after .env is written", async () => {
    let existedAtDelete: boolean | null = null;
    const w: World = {};
    const h = harness(w);
    w.onDeleteBootstrap = () => {
      existedAtDelete ??= existsSync(h.path);
    };
    await whole(h);
    const del = h.calls.find((c) => c.method === "DELETE");
    expect(del?.url).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCT}/tokens/boot-id`);
    expect(del?.headers.Authorization).toBe(`Bearer ${BOOT}`);
    expect(existedAtDelete).toBe(true);
    expect(h.text()).toMatch(/deleted the setup token/i);
  });

  it("probes the run token with every capability and shows each result", async () => {
    const h = harness();
    const v = await toGateway(h);
    const probes = h.calls.filter((c) => c.headers.Authorization === `Bearer ${MINTED("gork-run")}`);
    expect(probes.map((c) => c.url.split("/").slice(-1)[0])).toEqual(["completions", "websearch", "markdown"]);
    expect(v.cloudflare.probes.map((p) => p.capability)).toEqual(["chat", "web search", "page reading"]);
    expect(v.cloudflare.probes.every((p) => p.ok)).toBe(true);
    expect(v.cloudflare.phase).toBe("ready");
    // The check runs the model credits mode will use (the free model would pass on an account that can't run it).
    expect(probes[0].body.model).toBe(CREDITS_MODEL);
  });

  it("gives the admin token no expiry by default, and an hour when you decline to keep it", async () => {
    const adminMint = (h: H) => h.calls.find((c) => c.method === "POST" && c.body?.name === "gork-admin") as Call;
    const keep = harness();
    await toGateway(keep);
    expect(adminMint(keep).body.expires_on).toBeUndefined();
    const short = harness();
    await toGateway(short, { keepAdmin: false });
    expect(adminMint(short).body.expires_on).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  });
});

describe("setup: free mode", () => {
  const free: Over = { billing: "free" };

  it("takes no budget, writes BILLING_MODE=free, builds a standard-billing gateway, asks for no gateway or search permission, tests with the free model, and sends no gateway header anywhere", async () => {
    const h = harness();
    await whole(h, { choices: { ...free, budget: "99" } });
    const env = readEnv(h.path);
    expect(env.BILLING_MODE).toBe("free");
    expect(env.DAILY_BUDGET_USD).toBe("0.50");
    expect(loadConfig(env).llm.model).toBe(FREE_MODEL);
    expect(env.LLM_MODEL).toBe("");
    const create = h.calls.find((c) => c.method === "POST" && c.url.endsWith("/ai-gateway/gateways"));
    expect(create?.body.workers_ai_billing_mode).toBe("standard");

    const run = h.calls.find((c) => c.method === "POST" && c.body?.name === "gork-run") as Call;
    const names = run.body.policies[0].permission_groups.map((g: { id: string }) => g.id);
    expect(names).toEqual(["g:Workers AI Read", "g:Browser Rendering - Edit"]);
    expect(h.calls.some((c) => c.url.endsWith("/ai/websearch"))).toBe(false);
    for (const c of h.calls) expect(Object.keys(c.headers).filter((k) => /^cf-aig-/i.test(k))).toEqual([]);
    // The check has to use the model free mode will run: the credits model fails on the free plan.
    const chat = h.calls.find((c) => c.url.endsWith("/ai/v1/chat/completions"));
    expect(chat?.body.model).toBe(FREE_MODEL);
  });

  it("never asks about credits, even when the chat probe is refused for them", async () => {
    const h = harness({ chat: () => json({ success: false, errors: [{ message: "no credit" }] }, 402) });
    const v = await toGateway(h, { choices: free });
    expect(v.cloudflare.needsCredits).toBe(false);
  });
});

describe("setup: steps happen in order", () => {
  it("won't take a Discord token before the choices, nor Cloudflare before the server is confirmed", async () => {
    const h = harness();
    expect(await failure(h.s.discordToken(DISCORD))).toMatch(/first/i);
    await h.s.saveChoices({ ...CHOICES });
    await h.s.discordToken(DISCORD);
    expect(await failure(h.s.cloudflareToken(BOOT, true))).toMatch(/first|server/i);
    expect(h.calls.some((c) => c.url.includes("cloudflare.com"))).toBe(false);
    expect(await failure(h.s.finish({ revokeOld: true }))).toMatch(/first|Cloudflare/i);
    expect(await failure(h.s.startBot())).toMatch(/first|written/i);
  });

  it("refuses a second step while one is still running, so a double click can't make two sets of tokens", async () => {
    const door = gate();
    const w: World = { onMint: async (n) => (n === 1 ? door.wait() : undefined) };
    const h = harness(w);
    await toCloudflare(h);
    const first = h.s.cloudflareToken(BOOT, true);
    await door.reached;
    expect(await failure(h.s.cloudflareToken(BOOT, true))).toMatch(/already working|busy|wait/i);
    door.release();
    await first;
    expect(h.calls.filter((c) => c.method === "POST" && c.url.endsWith("/tokens"))).toHaveLength(2);
  });
});

describe("setup: the page's polling never gets in the way of the person's own clicks", () => {
  const holdGuilds = (h: H) => {
    const door = gate();
    const real = h.session.deps.fetch;
    h.session.deps.fetch = (async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/users/@me/guilds")) await door.wait();
      return real(url, init);
    }) as typeof fetch;
    return door;
  };

  it("a click that arrives while Discord is being checked waits for the check, and works", async () => {
    const h = harness();
    await h.s.saveChoices({ ...CHOICES });
    await h.s.discordToken(DISCORD);
    await h.s.discordRefresh();
    const door = holdGuilds(h);
    const poll = h.s.discordRefresh();
    await door.reached;
    const click = h.s.confirmServers(["42"]);
    door.release();
    expect((await click).discord.selected).toEqual([{ id: "42", name: "My Server" }]);
    await poll;
  });

  it("a check that arrives while a step is running is skipped, and doesn't ask Discord or Cloudflare", async () => {
    const door = gate();
    const w: World = { onMint: async (n) => (n === 1 ? door.wait() : undefined) };
    const h = harness(w);
    await toCloudflare(h);
    const step = h.s.cloudflareToken(BOOT, true);
    await door.reached;
    const before = h.calls.length;
    await h.s.discordRefresh();
    await h.s.creditsRecheck();
    expect(h.calls.length).toBe(before);
    door.release();
    await step;
  });
});

describe("setup: stopping while a step is still running", () => {
  it("stops at the next checkpoint, so nothing more is made after the clean-up, and takes back what exists", async () => {
    const door = gate();
    const h = harness({ onMint: async (n) => (n === 1 ? door.wait() : undefined) });
    await toCloudflare(h);
    const step = h.s.cloudflareToken(BOOT, true);
    await door.reached;
    const stopping = h.session.dispose();
    door.release();
    expect(await failure(step)).toMatch(/interrupted/i);
    await stopping;
    expect(deleted(h)).toEqual(["tok-1", "boot-id"]);
    expect(h.calls.filter((c) => c.method === "POST" && c.url.endsWith("/tokens"))).toHaveLength(1);
    expect(h.calls.some((c) => c.method === "POST" && c.url.endsWith("/ai-gateway/gateways"))).toBe(false);
    expect(existsSync(h.path)).toBe(false);
  });

  it("does not wait forever for a step stuck on a request that never answers", async () => {
    const h = harness();
    h.session.deps.settleMs = 30_000;
    await toCloudflare(h);
    const real = h.session.deps.fetch;
    const door = gate();
    h.session.deps.fetch = (async (url: string, init?: RequestInit) => {
      if (String(url).includes("/accounts?")) await door.wait();
      return real(url, init);
    }) as typeof fetch;
    void h.s.cloudflareToken(BOOT, true).catch(() => {});
    await door.reached;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let stopped = false;
      const stopping = h.session.dispose().then(() => {
        stopped = true;
      });
      await vi.advanceTimersByTimeAsync(29_999);
      expect(stopped).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await stopping;
    } finally {
      vi.useRealTimers();
    }
    expect(h.text()).toMatch(/couldn't delete the setup token/i);
  });
});

describe("setup: stopping the server mid-way never leaves anything behind", () => {
  it("Ctrl-C while the tokens are being made removes them and the setup token, stops, and exits", async () => {
    let h!: H;
    let pressed: Promise<void> | undefined;
    const w: World = {
      onMint: (n) => {
        if (n === 2) pressed = h.session.interrupt();
      },
    };
    h = harness(w);
    await toCloudflare(h);
    const msg = await failure(h.s.cloudflareToken(BOOT, true));
    await pressed;
    expect(msg).toMatch(/interrupted/i);
    expect(deleted(h).sort()).toEqual(["boot-id", "tok-1", "tok-2"]);
    expect(h.exits).toEqual([130]);
    expect(existsSync(h.path)).toBe(false);
    expect(h.calls.some((c) => c.url.endsWith("/ai-gateway/gateways") && c.method === "POST")).toBe(false);
  });

  it("Ctrl-C with the page waiting on the gateway question removes everything too", async () => {
    const h = harness({ gateways: { gork: { authentication: false } } });
    await toGateway(h);
    await h.session.interrupt();
    expect(deleted(h).sort()).toEqual(["boot-id", "tok-1", "tok-2"]);
    expect(h.exits).toEqual([130]);
  });

  it("a second Ctrl-C exits at once instead of waiting for the cleanup", async () => {
    let h!: H;
    let pressed: Promise<void> | undefined;
    const w: World = {
      onMint: (n) => {
        if (n === 2) pressed = Promise.all([h.session.interrupt(), h.session.interrupt()]).then(() => {});
      },
    };
    h = harness(w);
    await toCloudflare(h);
    await failure(h.s.cloudflareToken(BOOT, true));
    await pressed;
    expect(h.exits).toEqual([130, 130]);
    expect(deleted(h).sort()).toEqual(["boot-id", "tok-1", "tok-2"]);
  });

  it("walking away (dispose) before finishing takes back everything it made, the gateway included", async () => {
    const h = harness();
    await toGateway(h);
    await h.session.dispose();
    expect(h.calls.filter((c) => c.method === "DELETE" && c.url.includes("/ai-gateway/gateways/gork"))).toHaveLength(1);
    expect(deleted(h)).toEqual(["tok-1", "tok-2", "boot-id"]);
    expect(existsSync(h.path)).toBe(false);
  });

  it("dispose after .env is written keeps the tokens and the gateway", async () => {
    const h = harness();
    await whole(h);
    const before = h.calls.filter((c) => c.method === "DELETE").length;
    await h.session.dispose();
    expect(h.calls.filter((c) => c.method === "DELETE").length).toBe(before);
    expect(existsSync(h.path)).toBe(true);
  });

  it("a stopped session answers nothing more", async () => {
    const h = harness();
    await h.session.dispose();
    expect(await failure(h.s.saveChoices({ ...CHOICES }))).toMatch(/stopped|closed/i);
  });
});

describe("setup: progress while a step works", () => {
  type Work = ReturnType<SetupSession["view"]>["work"];
  const labels = (w: Work | undefined) => w?.steps.map((s) => s.label);
  const states = (w: Work | undefined) => w?.steps.map((s) => s.state);

  /** What the page would see (view().work) at the moment each request leaves, in order. */
  function watch(h: H) {
    const seen: { url: string; method: string; work: Work }[] = [];
    const inner = h.session.deps.fetch;
    h.session.deps = {
      ...h.session.deps,
      fetch: ((url: string, init?: RequestInit) => {
        seen.push({ url: String(url), method: init?.method ?? "GET", work: h.session.view().work });
        return inner(url, init);
      }) as typeof fetch,
    };
    return seen;
  }
  const at = (seen: ReturnType<typeof watch>, match: (c: { url: string; method: string }) => boolean) =>
    seen.find(match)?.work;

  it("walks the Cloudflare step through finding the account, the keys, the gateway and the tests", async () => {
    const h = harness();
    await toCloudflare(h);
    const seen = watch(h);
    await h.s.cloudflareToken(BOOT, true);
    const first = at(seen, (c) => c.url.includes("/accounts?"));
    expect(labels(first)).toEqual([
      "Finding your account",
      "Making gork's keys",
      "Setting up the AI Gateway",
      "Testing chat, page reading, web search",
    ]);
    expect(states(first)).toEqual(["active", "todo", "todo", "todo"]);
    expect(first?.id).toBe("cloudflare");
    const mint = at(seen, (c) => c.method === "POST" && c.url.endsWith("/tokens"));
    expect(states(mint)).toEqual(["done", "active", "todo", "todo"]);
    const gateway = at(seen, (c) => c.method === "POST" && c.url.endsWith("/ai-gateway/gateways"));
    expect(states(gateway)).toEqual(["done", "done", "active", "todo"]);
    const test = at(seen, (c) => c.url.endsWith("/ai/v1/chat/completions"));
    expect(states(test)).toEqual(["done", "done", "done", "active"]);
    expect(h.session.view().work).toBeNull();
    expect(h.session.view().cloudflare.phase).toBe("ready");
  });

  it("says it is taking things back when a step fails or is cancelled, and is clear afterwards", async () => {
    const h = harness({ failMint: 2 });
    await toCloudflare(h);
    const seen = watch(h);
    await failure(h.s.cloudflareToken(BOOT, true));
    const back = seen.filter((c) => c.method === "DELETE").map((c) => labels(c.work));
    expect(back.length).toBeGreaterThan(0);
    expect(back[0]).toEqual(["Taking back what was made for this setup"]);
    expect(h.session.view().work).toBeNull();
    expect(h.session.view().cloudflare.failure).toBeTruthy();

    const c = harness({ gateways: { gork: { authentication: false } } });
    await toCloudflare(c);
    const seen2 = watch(c);
    await c.s.cloudflareToken(BOOT, true);
    const mark = seen2.length;
    await c.s.gatewayChoice({ action: "cancel" });
    expect(
      seen2
        .slice(mark)
        .filter((x) => x.method === "DELETE")
        .map((x) => labels(x.work))[0],
    ).toEqual(["Taking back what was made for this setup"]);
    expect(c.session.view().work).toBeNull();
  });
});
