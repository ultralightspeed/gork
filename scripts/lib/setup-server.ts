// The small local web server behind `npm run setup`. It handles secrets, on localhost, while the person has other websites
// open, so it treats every other website as hostile:
//   - it listens on 127.0.0.1 only, on a port the system picks;
//   - the address it prints holds a random 32-byte token, which anyone who can list processes may see (it is on the
//     browser's command line). So the token is only good for being swapped, once, for a cookie: the first GET of
//     /s/<token>/ sets a separate random value as an HttpOnly, SameSite=Strict cookie and sends the browser to
//     /setup/<random>/: the page and its API are served there, and it is the only path the cookie is sent to. Both are
//     compared in constant time. Opening the address again sends the browser there without a new cookie: a second tab of the same
//     browser carries the cookie and works; any other browser is told to use the tab that is already open;
//   - the Host header must be 127.0.0.1:<port> or localhost:<port> (a rebinding DNS name is refused);
//   - every POST needs this server's own Origin, a JSON body, and stays under a small size limit;
//   - it sends no CORS headers, so no other page can read an answer or pass a preflight;
//   - a strict CSP (no inline script or style without this response's nonce) and no-store, no-referrer, nosniff;
//   - nothing the session knows as a secret is ever put in a response (the session's view() is a whitelist);
//   - it closes itself when setup is finished, after 30 minutes with nobody using it (taking back whatever it made),
//     or when asked to.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { SettingsError } from "../../src/config.ts";
import { TOKENS_URL } from "./cloudflare-setup.ts";
import { CliError } from "./errors.ts";
import type { SetupSession, View } from "./setup-session.ts";

interface ServerOptions {
  session: SetupSession;
  /**
   * The page, with `{{NONCE}}` wherever a script or style tag needs the CSP nonce, and `/* {{PAGE_LOGIC}} *\/` where its
   * script takes setup-page-logic.js.
   */
  page: string;
  /** A line for the terminal. Never a secret and never the token. */
  log?: (line: string) => void;
  /** Nobody has used the page for this long: setup is taken back and closed. Default 30 minutes. */
  idleMs?: number;
  /** Closed this long after gork is online, so the page has time to show the end. Default 8 seconds. */
  closeAfterDoneMs?: number;
  /** Closing waits this long for the clean-up, then closes anyway and says what to check. Default one minute. */
  shutdownGraceMs?: number;
  /** For tests; otherwise 32 random bytes as hex. */
  token?: string;
  /** Starts the idle, done and clean-up timers and returns the function that cancels one. Default: an unref'd setTimeout. */
  schedule?: (run: () => void, ms: number) => () => void;
  /** Registers a Ctrl-C handler and returns the function that removes it. */
  onInterrupt?: (handler: () => void | Promise<void>) => () => void;
}

export interface RunningSetup {
  /** Where to open the browser: http://127.0.0.1:<port>/s/<token>/ (good for one cookie, see above) */
  url: string;
  address(): { address: string; port: number };
  /** Resolves once the server has closed (and the session has been wound up). */
  closed: Promise<void>;
  close(): Promise<void>;
}

/** Room for the biggest custom personality (8,000 characters of the widest kind, and its fixed replies) in JSON. */
const MAX_BODY = 64 * 1024;
/** Beyond this much of an oversized body the connection is simply dropped. */
const DRAIN_LIMIT = 1024 * 1024;
/** Nobody has used the page for this long: setup is taken back and closed (the page says so in minutes). */
export const IDLE_MS = 30 * 60 * 1000;
/** A day: longer than any setup, whose idle timer pauses while gork builds. */
const COOKIE_MAX_AGE = 24 * 60 * 60;
const LOGIC_MARK = "/* {{PAGE_LOGIC}} */";

/**
 * The page with setup-page-logic.js put into its script where it says {{PAGE_LOGIC}}, the `export` words taken out, so
 * the page stays one self-contained document under its nonce CSP. A page without the mark is returned as it is.
 */
export function withPageLogic(page: string, logic?: string): string {
  if (!page.includes(LOGIC_MARK)) return page;
  const code = (logic ?? readFileSync(new URL("./setup-page-logic.js", import.meta.url), "utf8")).replace(
    /^export /gm,
    "",
  );
  // A function, not a string, so `$&` or `$'` in the code is not read as a replacement pattern.
  return page.replace(LOGIC_MARK, () => code.trim());
}

type Body = Record<string, unknown>;
type Route = {
  method: "GET" | "POST";
  /** The page asks on a timer; those calls say nothing about whether a person is still there. */
  poll?: true;
  run(body: Body): Promise<View>;
};

const ALREADY_USED =
  "This setup address has already been opened in a browser. If setup is open in another tab, go back to it: it keeps working. If you closed that browser, or it wasn't you, press Ctrl+C in the terminal and run npm run setup again.";

const sha = (s: string) => createHash("sha256").update(s).digest();
/** Constant-time equality, whatever the lengths. */
const same = (a: string, b: string) => timingSafeEqual(sha(a), sha(b));

/** A timer that never keeps the process alive by itself. */
const realSchedule = (run: () => void, ms: number): (() => void) => {
  const timer = setTimeout(run, ms);
  timer.unref();
  return () => clearTimeout(timer);
};

const BASE_CSP = ["base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"];

function headers(type: string, nonce?: string): Record<string, string> {
  const csp = nonce
    ? [
        "default-src 'none'",
        `script-src 'nonce-${nonce}'`,
        `style-src 'nonce-${nonce}'`,
        "connect-src 'self'",
        ...BASE_CSP,
      ]
    : ["default-src 'none'", ...BASE_CSP];
  return {
    "Content-Type": type,
    "Content-Security-Policy": csp.join("; "),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
    "X-Frame-Options": "DENY",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Cross-Origin-Opener-Policy": "same-origin",
  };
}

function send(
  res: ServerResponse,
  status: number,
  type: string,
  body: string,
  { nonce, extra }: { nonce?: string; extra?: Record<string, string> } = {},
) {
  res.writeHead(status, { ...headers(type, nonce), ...extra });
  res.end(body);
}
const plain = (res: ServerResponse, status: number, text: string, extra?: Record<string, string>) =>
  send(res, status, "text/plain; charset=utf-8", text, { extra });

/** True when the Cookie header holds `name` with exactly `value` (compared in constant time). */
function hasCookie(header: string | undefined, name: string, value: string): boolean {
  let found = false;
  for (const part of (header ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name && same(part.slice(at + 1).trim(), value)) found = true;
  }
  return found;
}

/** Reads a body of at most MAX_BODY bytes. `tooBig` means it was drained, not stored. */
function readBody(req: IncomingMessage): Promise<{ text: string; tooBig: boolean }> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    let tooBig = Number.isFinite(declared) && declared > MAX_BODY;
    let seen = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      seen += chunk.length;
      if (seen > DRAIN_LIMIT) req.destroy();
      if (seen > MAX_BODY) tooBig = true;
      if (!tooBig) chunks.push(chunk);
    });
    req.on("end", () => resolve({ text: tooBig ? "" : Buffer.concat(chunks).toString("utf8"), tooBig }));
    req.on("error", reject);
    req.on("close", () => resolve({ text: "", tooBig: true }));
  });
}

export async function startSetupServer(opts: ServerOptions): Promise<RunningSetup> {
  const { session } = opts;
  const page = withPageLogic(opts.page);
  const log = opts.log ?? (() => {});
  const idleMs = opts.idleMs ?? IDLE_MS;
  const doneMs = opts.closeAfterDoneMs ?? 8000;
  const token = opts.token ?? randomBytes(32).toString("hex");
  /** The cookie the token is swapped for: never the token itself, so the address seen in a process list opens nothing. */
  const secret = randomBytes(32).toString("hex");
  /**
   * The path the page and its API are served at, and the cookie's Path. Browsers send a cookie to every port of 127.0.0.1, so a
   * path no other local server can know keeps the cookie from them. Only the 303 that sets the cookie gives it out.
   */
  const app = `/setup/${randomBytes(16).toString("hex")}/`;
  let cookieIssued = false;
  let cookieName = "";
  const schedule = opts.schedule ?? realSchedule;

  let hosts = new Set<string>();
  let origins = new Set<string>();
  let cancelIdle = () => {};
  let cancelDone: (() => void) | null = null;
  let closing: Promise<void> | null = null;
  let stopInterrupt: () => void = () => {};
  let resolveClosed!: () => void;
  const closed = new Promise<void>((r) => {
    resolveClosed = r;
  });

  const routes = new Map<string, Route>([
    ["state", { method: "GET", poll: true, run: async () => session.view() }],
    ["choices", { method: "POST", run: (b) => session.saveChoices(b) }],
    ["discord/token", { method: "POST", run: (b) => session.discordToken(b.token) }],
    ["discord/refresh", { method: "POST", poll: true, run: () => session.discordRefresh() }],
    ["discord/servers", { method: "POST", run: (b) => session.confirmServers(b.ids, b.manual) }],
    ["cloudflare/token", { method: "POST", run: (b) => session.cloudflareToken(b.token, b.keepAdmin) }],
    ["cloudflare/account", { method: "POST", run: (b) => session.cloudflareAccount(b.account) }],
    ["cloudflare/gateway", { method: "POST", run: (b) => session.gatewayChoice(b) }],
    ["cloudflare/credits", { method: "POST", poll: true, run: () => session.creditsRecheck() }],
    ["cloudflare/reset", { method: "POST", run: () => session.cloudflareReset() }],
    ["finish", { method: "POST", run: (b) => session.finish(b) }],
    ["start", { method: "POST", run: () => session.startBot() }],
  ]);

  const touch = () => {
    cancelIdle();
    cancelIdle = schedule(() => {
      // gork is being built: that can take a while, and it is not "nobody using it".
      if (session.view().start.status === "running") return touch();
      log(
        `Setup closed after ${Math.max(1, Math.round(idleMs / 60000))} minutes with nobody using it. Anything it had made and not kept was taken back.`,
      );
      void shutdown();
    }, idleMs);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      // Name and place only: a message can hold anything, and a secret must never reach the terminal or the page.
      const where = /\(?([^()\s]+:\d+:\d+)\)?\s*$/m.exec(String((err as Error).stack ?? "").split("\n")[1] ?? "")?.[1];
      log(`Setup hit an unexpected error (${(err as Error).name}${where ? ` at ${where}` : ""}).`);
      if (!res.headersSent) plain(res, 500, "Something went wrong inside setup. Look at the terminal.");
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!hosts.has((req.headers.host ?? "").toLowerCase())) return plain(res, 403, "Forbidden");
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "", "http://localhost").pathname;
    } catch {
      return plain(res, 404, "Not found");
    }
    const method = req.method ?? "";

    const m = /^\/s\/([0-9a-f]{64})\/?$/.exec(pathname);
    if (m) {
      if (!same(m[1], token)) return plain(res, 404, "Not found");
      if (method !== "GET") return plain(res, 405, "Method not allowed", { Allow: "GET" });
      const extra: Record<string, string> = { Location: app };
      if (!cookieIssued) {
        cookieIssued = true;
        extra["Set-Cookie"] =
          `${cookieName}=${secret}; Path=${app}; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; SameSite=Strict`;
      }
      return plain(res, 303, "", extra);
    }

    if (pathname !== app && !pathname.startsWith(`${app}api/`)) return plain(res, 404, "Not found");
    const signedIn = hasCookie(req.headers.cookie, cookieName, secret);
    const rest = pathname.slice(app.length - 1);

    if (rest === "/") {
      if (!signedIn) return plain(res, 403, ALREADY_USED);
      if (method !== "GET") return plain(res, 405, "Method not allowed", { Allow: "GET" });
      touch();
      const nonce = randomBytes(16).toString("base64");
      return send(res, 200, "text/html; charset=utf-8", page.replaceAll("{{NONCE}}", nonce), { nonce });
    }

    // The page treats a 404 from its API as "setup has closed", which is what a missing or stale cookie means.
    if (!signedIn) return plain(res, 404, "Not found");
    const route = rest.startsWith("/api/") ? routes.get(rest.slice(5)) : undefined;
    const isClose = rest === "/api/close";
    if (!route && !isClose) return plain(res, 404, "Not found");
    const wantedMethod = route?.method ?? "POST";
    if (method !== wantedMethod) return plain(res, 405, "Method not allowed", { Allow: wantedMethod });

    // What a browser says about who is asking. Absent for tools like curl, which hold the token anyway.
    const site = req.headers["sec-fetch-site"];
    if (site !== undefined && site !== "same-origin" && !(site === "none" && method === "GET")) {
      return plain(res, 403, "Forbidden");
    }

    let body: Body = {};
    if (method === "POST") {
      const origin = req.headers.origin;
      if (typeof origin !== "string" || !origins.has(origin.toLowerCase())) return plain(res, 403, "Forbidden");
      if (!/^application\/json\s*(;|$)/i.test(String(req.headers["content-type"] ?? ""))) {
        return plain(res, 415, "Send JSON");
      }
      const got = await readBody(req);
      if (got.tooBig) return plain(res, 413, "Too much data");
      try {
        const parsed: unknown = JSON.parse(got.text);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
        body = parsed as Body;
      } catch {
        return plain(res, 400, "Send a JSON object");
      }
    }
    if (!route?.poll) touch();

    if (isClose) {
      send(res, 200, "application/json; charset=utf-8", JSON.stringify({ ok: true, view: session.view() }));
      setImmediate(() => void shutdown());
      return;
    }

    let status = 200;
    let payload: object;
    try {
      payload = { ok: true, view: await (route as Route).run(body) };
    } catch (err) {
      if (!(err instanceof CliError || err instanceof SettingsError)) throw err;
      status = 400;
      payload = { ok: false, error: session.redact(err.message), view: session.view() };
    }
    send(res, status, "application/json; charset=utf-8", JSON.stringify(payload));
    if (session.isDone() && !cancelDone) cancelDone = schedule(() => void shutdown(), doneMs);
  }

  function shutdown(): Promise<void> {
    closing ??= (async () => {
      cancelIdle();
      cancelDone?.();
      stopInterrupt();
      let cleaned = false;
      const grace = new Promise<void>((resolve) => {
        schedule(resolve, opts.shutdownGraceMs ?? 60_000);
      });
      await Promise.race([
        session.dispose().then(
          () => {
            cleaned = true;
          },
          () => {
            cleaned = true;
          },
        ),
        grace,
      ]);
      if (!cleaned) {
        log(
          `Setup couldn't finish cleaning up (Cloudflare or Discord didn't answer in time). Check your Cloudflare account for gork tokens and an AI Gateway you don't want: ${TOKENS_URL}`,
        );
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
        // A connection still open after a moment is the page's own keep-alive; it must not hold the process.
        setTimeout(() => server.closeAllConnections(), 500).unref();
      });
      resolveClosed();
    })();
    return closing;
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new CliError("couldn't start the local setup server");
  const port = addr.port;
  // Cookies ignore the port, so the name carries it: another setup on another port never reads or replaces this one.
  cookieName = `gork-setup-${port}`;
  hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  stopInterrupt = opts.onInterrupt?.(() => session.interrupt()) ?? (() => {});
  touch();

  return {
    url: `http://127.0.0.1:${port}/s/${token}/`,
    address: () => ({ address: "127.0.0.1", port }),
    closed,
    close: shutdown,
  };
}
