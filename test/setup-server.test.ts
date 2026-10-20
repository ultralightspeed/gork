// The local server behind `npm run setup`: it handles secrets on localhost, so these tests treat every website the person
// visits as hostile. A real listener on 127.0.0.1 and raw HTTP requests, so headers can be set exactly as an attacker's page
// (or a rebinding DNS name) would set them. No real Discord or Cloudflare: the session talks to the shared fakes.

import { readFileSync } from "node:fs";
import { request } from "node:http";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CliError } from "../scripts/lib/errors.ts";
import { type RunningSetup, startSetupServer } from "../scripts/lib/setup-server.ts";
import { SetupSession } from "../scripts/lib/setup-session.ts";
import { fakeTimers, shippedPersonas, tempDir } from "./helpers.ts";
import { ALL_SECRETS, BOOT, DISCORD, gate, MINTED, PERSONAS, type World, world } from "./setup-world.ts";

type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

const CHOICES = { billing: "credits", persona: "default", mentions: "none", timezone: "UTC", budget: "" };
const PAGE = '<!doctype html><title>t</title><script nonce="{{NONCE}}">1</script><style nonce="{{NONCE}}"></style>';

const running: RunningSetup[] = [];
afterEach(async () => {
  for (const r of running.splice(0)) await r.close();
});

async function boot(
  w: World = {},
  opts: {
    idleMs?: number;
    closeAfterDoneMs?: number;
    shutdownGraceMs?: number;
    startBot?: () => Promise<string>;
    personasDir?: string;
    /** Leave the printed address unopened (no cookie yet). */
    unopened?: boolean;
  } = {},
) {
  const net = world(w);
  const dir = tempDir("gork-server-");
  const logged: string[] = [];
  const session = new SetupSession({
    fetch: net.f,
    now: Date.now,
    envPath: join(dir, ".env"),
    personasDir: opts.personasDir ?? PERSONAS,
    host: { platform: "linux", username: "alice", runCommand: () => ({ ok: true }) },
    startBot: opts.startBot ?? (async () => "ready"),
    print: (l) => logged.push(l),
  });
  const handlers = new Set<() => void | Promise<void>>();
  // Every timer the server sets (idle, done, clean-up grace) waits for the test to move time on.
  const timers = fakeTimers();
  const server = await startSetupServer({
    session,
    page: PAGE,
    log: (l) => logged.push(l),
    idleMs: opts.idleMs,
    closeAfterDoneMs: opts.closeAfterDoneMs,
    shutdownGraceMs: opts.shutdownGraceMs,
    schedule: timers.schedule,
    onInterrupt: (h) => {
      handlers.add(h);
      return () => handlers.delete(h);
    },
  });
  running.push(server);
  const base = new URL(server.url);
  const port = Number(base.port);
  const token = base.pathname.split("/")[2];
  /** Where the page and its API live: the secret path the opened address redirects to. */
  let app = "";
  const path = (rest = "") => `${app}${rest}`;
  const origin = `http://127.0.0.1:${port}`;
  let cookie = "";

  /** A raw request, carrying this browser's cookie unless `headers` says otherwise. */
  const send = (
    method: string,
    p: string,
    headers: Record<string, string> = {},
    body?: string | Buffer,
  ): Promise<Reply> =>
    new Promise((resolve, reject) => {
      const all = { host: `127.0.0.1:${port}`, ...(cookie ? { cookie } : {}), ...headers };
      const req = request(
        {
          host: "127.0.0.1",
          port,
          method,
          path: p,
          headers: Object.fromEntries(Object.entries(all).filter(([, v]) => v)),
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
        },
      );
      req.on("error", reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  const all: Reply[] = [];
  const post = async (rest: string, data: unknown, headers: Record<string, string> = {}) => {
    const r = await send(
      "POST",
      path(rest),
      { origin, "content-type": "application/json", ...headers },
      JSON.stringify(data),
    );
    all.push(r);
    return r;
  };
  const get = async (rest: string, headers: Record<string, string> = {}) => {
    const r = await send("GET", path(rest), headers);
    all.push(r);
    return r;
  };
  // Opening the address from the terminal, as the browser does: it swaps the token for this browser's cookie.
  const opened = opts.unopened ? { status: 0, headers: {}, body: "" } : await send("GET", base.pathname);
  cookie = String(opened.headers["set-cookie"]?.[0] ?? "").split(";")[0];
  app = String(opened.headers.location ?? "");
  return {
    server,
    session,
    net,
    logged,
    handlers,
    port,
    origin,
    token,
    cookie,
    opened,
    path,
    send,
    post,
    get,
    all,
    dir,
    timers,
  };
}

const json = (r: Reply) => JSON.parse(r.body);

/** The answers, a Discord token and server, and the Cloudflare token: from here tokens and a gateway exist at Cloudflare. */
async function toCloudflare(b: Awaited<ReturnType<typeof boot>>) {
  await b.session.saveChoices(CHOICES);
  await b.session.discordToken(DISCORD);
  await b.session.discordRefresh();
  await b.session.confirmServers(["42"]);
  await b.session.cloudflareToken(BOOT, true);
}

describe("the server's address", () => {
  it("listens on 127.0.0.1 only, on a port the system picks, with a long random token in the path", async () => {
    const b = await boot();
    expect(b.server.address().port).toBeGreaterThan(0);
    expect(b.server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/s\/[0-9a-f]{64}\/$/);
    const other = await boot();
    expect(other.server.url).not.toBe(b.server.url);
    // address() only reports what was asked for. The socket itself must refuse the computer's other addresses (the
    // local network): connect to this machine's LAN address, if it has one, and expect to be turned away.
    const lan = Object.values(networkInterfaces())
      .flat()
      .find((i) => i?.family === "IPv4" && !i.internal)?.address;
    if (lan) {
      // What matters is that nothing answers, not how the machine says no: a firewall may drop the attempt silently.
      const outcome = await new Promise<string>((resolve) => {
        const sock = connect(b.port, lan);
        sock.setTimeout(1000, () => {
          sock.destroy();
          resolve("turned away");
        });
        sock.once("connect", () => {
          sock.destroy();
          resolve("connected");
        });
        sock.once("error", () => resolve("turned away"));
      });
      expect(outcome).toBe("turned away");
    }
  });
});

describe("the page and its headers", () => {
  it("serves the page with a strict CSP whose nonce matches the page's", async () => {
    const b = await boot();
    const r = await b.get("");
    expect(r.status).toBe(200);
    expect(String(r.headers["content-type"])).toMatch(/^text\/html/);
    const csp = String(r.headers["content-security-policy"]);
    const nonce = /script-src 'nonce-([A-Za-z0-9+/=_-]+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain(`style-src 'nonce-${nonce}'`);
    expect(csp).toContain("connect-src 'self'");
    // Nothing is loaded from anywhere else, images included: default-src 'none' covers every kind not listed.
    expect(csp).not.toMatch(/img-src|font-src|frame-src|object-src|media-src/);
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
    expect(r.body).toContain(`<script nonce="${nonce}">`);
    expect(r.body).not.toContain("{{NONCE}}");
    // A new nonce for every response, so one seen once can't be replayed into another page.
    const again = String((await b.get("")).headers["content-security-policy"]);
    expect(/script-src 'nonce-([^']+)'/.exec(again)?.[1]).not.toBe(nonce);
  });

  it("sends the hardening headers on every kind of response: page, API, errors", async () => {
    const b = await boot();
    const replies = [
      await b.get(""),
      await b.get("api/state"),
      await b.post("api/choices", { billing: "nope" }),
      await b.send("GET", "/nothing-here", {}),
      await b.send("GET", b.path(""), { host: "evil.example" }),
      await b.send("DELETE", b.path("api/state")),
    ];
    for (const r of replies) {
      expect(r.headers["x-content-type-options"]).toBe("nosniff");
      expect(r.headers["referrer-policy"]).toBe("no-referrer");
      expect(String(r.headers["cache-control"])).toMatch(/no-store/);
      expect(String(r.headers["content-security-policy"])).toContain("default-src 'none'");
      expect(r.headers["x-frame-options"]).toBe("DENY");
      expect(r.headers["cross-origin-resource-policy"]).toBe("same-origin");
    }
  });

  it("never sends a CORS header, and answers a preflight with nothing useful", async () => {
    const b = await boot();
    const pre = await b.send("OPTIONS", b.path("api/choices"), {
      origin: "https://evil.example",
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type",
    });
    expect(pre.status).toBeGreaterThanOrEqual(400);
    for (const r of [pre, await b.get("api/state"), await b.post("api/choices", CHOICES)]) {
      expect(Object.keys(r.headers).filter((k) => k.startsWith("access-control-"))).toEqual([]);
    }
  });
});

describe("the address in the terminal is used once, then a cookie", () => {
  it("swaps the token for an HttpOnly, SameSite=Strict cookie, redirecting to a secret path", async () => {
    const b = await boot();
    expect(b.opened.status).toBe(303);
    const app = String(b.opened.headers.location);
    expect(app).toMatch(/^\/setup\/[0-9a-f]{32}\/$/);
    const set = String(b.opened.headers["set-cookie"]?.[0] ?? "");
    const [pair, ...attrs] = set.split(";").map((p) => p.trim());
    const [name, value] = pair.split("=");
    expect(name).toBe(`gork-setup-${b.port}`);
    expect(value).toMatch(/^[0-9a-f]{64}$/);
    expect(value).not.toBe(b.token);
    expect(attrs).toEqual(expect.arrayContaining(["HttpOnly", "SameSite=Strict", `Path=${app}`]));
    expect(attrs.some((a) => /^(Domain|Expires)=/i.test(a))).toBe(false);
  });

  it("lets the cookie outlive any session, so it never expires while setup is open", async () => {
    const b = await boot();
    const set = String(b.opened.headers["set-cookie"]?.[0] ?? "");
    const maxAge = Number(/;\s*Max-Age=(\d+)/i.exec(set)?.[1]);
    // The idle timer pauses while gork builds, which can take half an hour or more.
    expect(maxAge).toBeGreaterThanOrEqual(12 * 3600);
    expect(maxAge).toBeLessThanOrEqual(2 * 24 * 3600);
  });

  it("gives each run its own secret path, which it never prints", async () => {
    const one = await boot();
    const two = await boot();
    const app = String(one.opened.headers.location);
    expect(app).not.toBe(two.opened.headers.location);
    const secret = app.split("/")[2];
    expect(one.server.url).not.toContain(secret);
    for (const line of one.logged) expect(line).not.toContain(secret);
  });

  it("refuses the cookie at any path but its own secret one", async () => {
    // Browsers send a cookie to every port of 127.0.0.1, so only the secret path keeps it from other local servers.
    const b = await boot();
    for (const p of ["/setup/", "/setup/api/state", `${b.path("")}x`, `/setup/${"0".repeat(32)}/api/state`]) {
      expect((await b.send("GET", p)).status, p).toBe(404);
    }
  });

  it("sends a second tab of the same browser to the open page, without a new cookie", async () => {
    const b = await boot();
    const again = await b.send("GET", `/s/${b.token}/`);
    expect(again.status).toBe(303);
    expect(again.headers.location).toBe(b.path());
    expect(again.headers["set-cookie"]).toBeUndefined();
    expect((await b.get("")).status).toBe(200);
  });

  it("tells another browser that opens the address afterwards to use the open tab", async () => {
    const b = await boot();
    const again = await b.send("GET", `/s/${b.token}/`, { cookie: "" });
    expect(again.headers["set-cookie"]).toBeUndefined();
    const page = await b.send("GET", String(again.headers.location), { cookie: "" });
    expect(page.status).toBe(403);
    expect(page.body).toMatch(/already been opened in a browser.*another tab/);
    expect(page.body).not.toContain("<script");
  });

  it("has no page before the printed address is opened, and opening it then still works", async () => {
    const early = await boot({}, { unopened: true });
    expect((await early.send("GET", "/setup/")).status).toBe(404);
    expect((await early.send("GET", `/s/${early.token}/`)).headers["set-cookie"]).toBeDefined();
  });

  it("answers every wrong token, and the token used for the API, with the same 404", async () => {
    const b = await boot();
    const paths = [
      `/s/${"0".repeat(64)}/`,
      `/s/${b.token.slice(0, 63)}/`,
      `/s/${b.token}0/`,
      `/s//`,
      `/s/`,
      `/`,
      `/api/state`,
      `/setup`,
      `/setup/`,
      `/setup/x`,
      `/setup/api/state`,
      b.path("api/state"),
      `/s/${"0".repeat(64)}/api/state`,
      `/s/${b.token}/api/state`,
      `/s/${b.token}/../x`,
    ];
    const bodies = new Set<string>();
    for (const p of paths) {
      const r = await b.send("GET", p, { cookie: "" });
      expect(r.status, p).toBe(404);
      expect(r.headers["set-cookie"], p).toBeUndefined();
      bodies.add(r.body);
    }
    expect(bodies.size).toBe(1);
    const post = await b.send(
      "POST",
      `/s/${b.token}/api/choices`,
      { origin: b.origin, "content-type": "application/json" },
      JSON.stringify(CHOICES),
    );
    expect(post.status).toBe(404);
    expect(b.session.view().choices).toBeNull();
  });

  it("answers API calls with no cookie or another one with 404, which the page reads as closed", async () => {
    const b = await boot();
    const others = ["", `gork-setup-${b.port}=${"a".repeat(64)}`, `gork-setup-1=${b.cookie.split("=")[1]}`];
    for (const cookie of others) {
      expect((await b.send("GET", b.path("api/state"), { cookie })).status, cookie).toBe(404);
      for (const route of ["choices", "finish", "start", "discord/refresh", "close"]) {
        const r = await b.send(
          "POST",
          b.path(`api/${route}`),
          { cookie, origin: b.origin, "content-type": "application/json" },
          "{}",
        );
        expect(r.status, `${cookie} ${route}`).toBe(404);
      }
    }
    expect(b.session.view().choices).toBeNull();
    expect((await b.get("api/state")).status).toBe(200);
  });

  it("finds its cookie among others the browser sends", async () => {
    const b = await boot();
    const r = await b.send("GET", b.path("api/state"), { cookie: `theme=dark; ${b.cookie}; other=1` });
    expect(r.status).toBe(200);
  });

  it("does not take the token or the cookie from a query string or another header", async () => {
    const b = await boot();
    const value = b.cookie.split("=")[1];
    expect((await b.send("GET", b.path(`api/state?token=${b.token}`), { cookie: "" })).status).toBe(404);
    expect((await b.send("GET", b.path(`api/state?${b.cookie}`), { cookie: "" })).status).toBe(404);
    const headers = { cookie: "", authorization: `Bearer ${value}`, "x-token": b.token };
    expect((await b.send("GET", b.path("api/state"), headers)).status).toBe(404);
  });
});

describe("a name that isn't ours is refused (DNS rebinding)", () => {
  it("accepts 127.0.0.1:port and localhost:port, and nothing else", async () => {
    const b = await boot();
    const ok = (host: string) => b.send("GET", b.path("api/state"), { host });
    expect((await ok(`127.0.0.1:${b.port}`)).status).toBe(200);
    expect((await ok(`localhost:${b.port}`)).status).toBe(200);
    for (const bad of [
      "evil.example",
      `evil.example:${b.port}`,
      `localhost.evil.example:${b.port}`,
      `127.0.0.1.evil.example:${b.port}`,
      "127.0.0.1",
      `127.0.0.1:${b.port + 1}`,
      `LOCALHOST:${b.port}.evil.example`,
    ]) {
      expect((await ok(bad)).status, bad).toBe(403);
    }
    // The page itself is refused too, so a rebinding page can't read it.
    const page = await b.send("GET", b.path(""), { host: `rebind.example:${b.port}` });
    expect(page.status).toBe(403);
    expect(page.body).not.toContain("script");
  });

  it("refuses a request that has no Host header at all", async () => {
    const b = await boot();
    const raw = await new Promise<string>((resolve, reject) => {
      const sock = connect(b.port, "127.0.0.1", () => sock.write(`GET ${b.path("api/state")} HTTP/1.0\r\n\r\n`));
      let got = "";
      sock.on("data", (d) => {
        got += d.toString();
      });
      sock.on("end", () => resolve(got));
      sock.on("error", reject);
    });
    // HTTP/1.0 may omit Host; a page can't send that, but nothing without one gets in.
    expect(raw).toMatch(/^HTTP\/1\.1 403/);
  });
});

describe("requests from other websites are refused", () => {
  const good = { billing: "credits", persona: "default", mentions: "none", timezone: "UTC", budget: "" };

  it("needs an Origin that is this server, on every POST", async () => {
    const b = await boot();
    const attempt = (origin?: string) =>
      b.send(
        "POST",
        b.path("api/choices"),
        { "content-type": "application/json", ...(origin === undefined ? {} : { origin }) },
        JSON.stringify(good),
      );
    expect((await attempt()).status).toBe(403);
    expect((await attempt("https://evil.example")).status).toBe(403);
    expect((await attempt("null")).status).toBe(403);
    expect((await attempt(`http://127.0.0.1:${b.port + 1}`)).status).toBe(403);
    expect((await attempt(`https://127.0.0.1:${b.port}`)).status).toBe(403);
    expect((await attempt(`http://localhost.evil.example:${b.port}`)).status).toBe(403);
    expect(b.session.view().choices).toBeNull();
    expect((await attempt(`http://127.0.0.1:${b.port}`)).status).toBe(200);
    expect((await attempt(`http://localhost:${b.port}`)).status).toBe(200);
  });

  it("refuses a browser that says the request is cross-site, even with a good Origin", async () => {
    const b = await boot();
    const r = await b.post("api/choices", good, { "sec-fetch-site": "cross-site" });
    expect(r.status).toBe(403);
    expect((await b.get("api/state", { "sec-fetch-site": "same-site" })).status).toBe(403);
    expect((await b.get("api/state", { "sec-fetch-site": "same-origin" })).status).toBe(200);
  });

  it("takes only JSON: a form or text body (what a cross-site form can send) is refused", async () => {
    const b = await boot();
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", ""]) {
      const r = await b.send(
        "POST",
        b.path("api/choices"),
        { origin: b.origin, ...(type ? { "content-type": type } : {}) },
        JSON.stringify(good),
      );
      expect(r.status, type).toBe(415);
    }
    expect(b.session.view().choices).toBeNull();
    const charset = await b.send(
      "POST",
      b.path("api/choices"),
      { origin: b.origin, "content-type": "application/json; charset=utf-8" },
      JSON.stringify(good),
    );
    expect(charset.status).toBe(200);
  });

  it("refuses a body that is too big, without reading it all, and a body that isn't a JSON object", async () => {
    const b = await boot();
    const big = await b.send(
      "POST",
      b.path("api/choices"),
      { origin: b.origin, "content-type": "application/json" },
      JSON.stringify({ persona: "x".repeat(100_000) }),
    );
    expect(big.status).toBe(413);
    for (const bad of ["not json", "[1,2]", '"text"', "null", ""]) {
      const r = await b.send(
        "POST",
        b.path("api/choices"),
        { origin: b.origin, "content-type": "application/json" },
        bad,
      );
      expect(r.status, bad).toBe(400);
    }
  });

  it("takes the biggest custom personality there is, in the widest characters, but not much more", async () => {
    const dir = shippedPersonas();
    const b = await boot({}, { personasDir: dir });
    const custom = {
      name: "グ".repeat(32),
      body: "😀".repeat(8000),
      quirk: "グ".repeat(300),
      quirkRate: 50,
      replies: Object.fromEntries(b.session.view().custom.replyFields.map((f) => [f.key, "グ".repeat(300)])),
    };
    const r = await b.post("api/choices", { ...CHOICES, persona: "custom", custom });
    expect(r.status, r.body.slice(0, 200)).toBe(200);
    expect(readFileSync(join(dir, "custom.md"), "utf8")).toContain("😀".repeat(8000));
    const tooBig = await b.post("api/choices", {
      ...CHOICES,
      persona: "custom",
      custom: { ...custom, body: "x".repeat(70_000) },
    });
    expect(tooBig.status).toBe(413);
  });

  it("allows only GET on the state and only POST on the actions, and knows no other routes", async () => {
    const b = await boot();
    expect((await b.post("api/state", {})).status).toBe(405);
    expect((await b.get("api/choices")).status).toBe(405);
    expect((await b.send("PUT", b.path("api/choices"))).status).toBe(405);
    expect((await b.post("api/nothing", {})).status).toBe(404);
    expect((await b.post("api/__proto__", {})).status).toBe(404);
    expect((await b.post("api/constructor", {})).status).toBe(404);
  });
});

describe("what the server says back", () => {
  it("returns a plain-English problem with the current state, and never an internal error message", async () => {
    const b = await boot();
    const r = await b.post("api/choices", { ...CHOICES, billing: "gold" });
    expect(r.status).toBe(400);
    const body = json(r);
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/pay/i);
    expect(body.view.step).toBe("choices");
  });

  it("hides a bug's message from the page and the terminal output stays free of secrets", async () => {
    const b = await boot();
    (b.session as unknown as { saveChoices: () => Promise<never> }).saveChoices = async () => {
      throw new TypeError(`boom with ${DISCORD}`);
    };
    const r = await b.post("api/choices", CHOICES);
    expect(r.status).toBe(500);
    expect(r.body).not.toContain("boom");
    expect(r.body).not.toContain(DISCORD);
    for (const line of b.logged) expect(line).not.toContain(DISCORD);
  });

  it("takes a secret the session holds out of a plain-English problem before sending it", async () => {
    const b = await boot();
    await b.session.saveChoices(CHOICES);
    await b.session.discordToken(DISCORD);
    (b.session as unknown as { discordRefresh: () => Promise<never> }).discordRefresh = async () => {
      throw new CliError(`Discord said no to ${DISCORD}`);
    };
    const r = await b.post("api/discord/refresh", {});
    expect(r.status).toBe(400);
    expect(json(r).error).toContain("Discord said no to");
    expect(r.body).not.toContain(DISCORD);
  });

  it("answers the state while a step is still running, saying what that step is doing", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let reached!: () => void;
    const there = new Promise<void>((r) => {
      reached = r;
    });
    const b = await boot({
      onMint: async (n) => {
        if (n !== 1) return;
        reached();
        await gate;
      },
    });
    for (const [rest, data] of [
      ["api/choices", CHOICES],
      ["api/discord/token", { token: DISCORD }],
      ["api/discord/refresh", {}],
      ["api/discord/servers", { ids: ["42"] }],
    ] as const) {
      expect((await b.post(rest, data)).status, rest).toBe(200);
    }
    const working = b.post("api/cloudflare/token", { token: BOOT, keepAdmin: true });
    await there;
    const mid = await b.get("api/state");
    expect(mid.status).toBe(200);
    const view = json(mid).view;
    expect(view.work.id).toBe("cloudflare");
    expect(view.work.steps.map((s: { state: string }) => s.state)).toEqual(["done", "active", "todo", "todo"]);
    expect(view.cloudflare.phase).toBe("token");
    release();
    const done = json(await working).view;
    expect(done.work).toBeNull();
    expect(done.cloudflare.phase).toBe("ready");
    expect(json(await b.get("api/state")).view.work).toBeNull();
  });

  it("goes through a whole setup over HTTP and never puts a secret in a body, a header or the terminal output", async () => {
    const b = await boot();
    const ok = async (rest: string, data: unknown) => {
      const r = await b.post(rest, data);
      expect(r.status, `${rest}: ${r.body}`).toBe(200);
      return json(r).view;
    };
    await ok("api/choices", CHOICES);
    const d = await ok("api/discord/token", { token: DISCORD });
    expect(d.discord.app).toEqual({ name: "gork" });
    const seen = await ok("api/discord/refresh", {});
    expect(seen.discord.guilds).toEqual([{ id: "42", name: "My Server" }]);
    await ok("api/discord/servers", { ids: ["42"] });
    const cf = await ok("api/cloudflare/token", { token: BOOT, keepAdmin: true });
    expect(cf.cloudflare.phase).toBe("ready");
    const done = await ok("api/finish", { revokeOld: true });
    expect(done.finish.written).toBe(true);
    const started = await ok("api/start", {});
    expect(started.start.status).toBe("running");
    await b.session.running;
    const final = json(await b.get("api/state")).view;
    expect(final.start.status).toBe("online");

    expect(b.all.length).toBeGreaterThan(6);
    for (const r of b.all) {
      const text = `${r.body}\n${JSON.stringify(r.headers)}`;
      for (const secret of [...ALL_SECRETS, MINTED("gork-run"), MINTED("gork-admin")])
        expect(text).not.toContain(secret);
    }
    for (const line of b.logged) for (const secret of ALL_SECRETS) expect(line).not.toContain(secret);
    const terminal = b.logged.join("\n");
    expect(terminal).not.toContain(b.token);
    expect(terminal).not.toContain(b.cookie.split("=")[1]);
  });
});

describe("shutting down", () => {
  it("takes back everything and closes after thirty minutes with nothing asked, or when Stop setup is pressed", async () => {
    const idle = await boot();
    await toCloudflare(idle);
    await idle.timers.advance(30 * 60 * 1000 - 1);
    expect((await idle.get("api/state")).status).toBe(200);
    await idle.timers.advance(1);
    await idle.server.closed;
    expect(idle.logged.join("\n")).toMatch(/closed|stopped|timed out|no one/i);
    await expect(idle.get("api/state")).rejects.toThrow();

    const stopped = await boot();
    await toCloudflare(stopped);
    expect((await stopped.post("api/close", {})).status).toBe(200);
    await stopped.server.closed;

    for (const b of [idle, stopped]) {
      const deletes = b.net.calls.filter((c) => c.method === "DELETE").map((c) => c.url.split("/").pop());
      expect(deletes).toEqual(["gork", "tok-1", "tok-2", "boot-id"]);
    }
  });

  it("is kept awake by what the person does, but not by the page quietly polling", async () => {
    // A page left open polls every few seconds; that alone must not hold setup (and its tokens) open forever.
    const b = await boot({}, { idleMs: 1000 });
    for (let i = 0; i < 3; i++) {
      expect((await b.get("api/state")).status).toBe(200);
      await b.timers.advance(300);
    }
    await b.timers.advance(100);
    await b.server.closed;

    // What the person does (here: saving the answers) starts the wait again each time.
    const c = await boot({}, { idleMs: 1000 });
    for (let i = 0; i < 3; i++) {
      expect((await c.post("api/choices", CHOICES)).status).toBe(200);
      await c.timers.advance(900);
    }
    expect((await c.get("api/state")).status).toBe(200);
    await c.timers.advance(100);
    await c.server.closed;
  });

  it("does not time out while gork is being built", async () => {
    const door = gate();
    const b = await boot(
      {},
      {
        idleMs: 1000,
        startBot: async () => {
          await door.wait();
          return "ready";
        },
      },
    );
    await toCloudflare(b);
    await b.session.finish({ revokeOld: true });
    await b.session.startBot();
    await door.reached;
    await b.timers.advance(5000);
    expect((await b.get("api/state")).status).toBe(200);
    door.release();
    await b.session.running;
  });

  it("closes itself shortly after gork is online", async () => {
    const b = await boot({}, { closeAfterDoneMs: 8000 });
    await toCloudflare(b);
    await b.session.finish({ revokeOld: true });
    await b.post("api/start", {});
    await b.session.running;
    await b.get("api/state");
    await b.timers.advance(7999);
    expect((await b.get("api/state")).status).toBe(200);
    await b.timers.advance(1);
    await b.server.closed;
    // Finished setup keeps the tokens and the gateway.
    expect(b.net.calls.filter((c) => c.method === "DELETE" && c.url.includes("/ai-gateway/"))).toEqual([]);
  });

  it("Ctrl-C reaches the session's cleanup while the server is up, and the hook is removed on close", async () => {
    const b = await boot();
    expect(b.handlers.size).toBe(1);
    await toCloudflare(b);
    const exits: number[] = [];
    b.session.deps.exit = (c) => exits.push(c);
    await Promise.all([...b.handlers].map((h) => h()));
    expect(exits).toEqual([130]);
    expect(b.net.calls.filter((c) => c.method === "DELETE").length).toBe(4);
    await b.server.close();
    expect(b.handlers.size).toBe(0);
  });

  it("still closes, and says what to check, when the clean-up can't finish (Cloudflare never answers)", async () => {
    const b = await boot({}, { shutdownGraceMs: 60_000 });
    (b.session as unknown as { dispose: () => Promise<void> }).dispose = () => new Promise(() => {});
    const closing = b.server.close();
    await b.timers.advance(60_000);
    await closing;
    expect(b.logged.join(" ")).toMatch(/couldn't finish cleaning up/i);
    expect(b.logged.join(" ")).toContain("https://dash.cloudflare.com/?to=/:account/api-tokens");
  });
});
