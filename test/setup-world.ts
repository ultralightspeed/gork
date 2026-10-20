// A fake Discord and Cloudflare for the setup tests: `world(...)` answers like the real services, and remembers which
// tokens were made and deleted, so tests can check what setup did and what it left behind. Nothing here is real.
import { type Call, fakeFetch, json, shippedPersonas } from "./helpers.ts";

export const DISCORD = "DISCORD-SECRET-aaaaaaaa.bbbbbbb.cccccccccccccccccccccc";
export const WRONG = "WRONG-TOKEN-aaaaaaaaaaaaaa.bbbbbbb.cccccccccccccccccccccc";
export const BOOT = "BOOTSTRAP-SECRET-token";
/** A second setup token, for the run after the first one was taken back. */
export const BOOT2 = "BOOTSTRAP-SECRET-token-two";
export const MINTED = (name: string) => `MINTED-${name}-SECRET`;
export const ALL_SECRETS = [DISCORD, BOOT, MINTED("gork-run"), MINTED("gork-admin")];
export const ACCT = "0123456789abcdef0123456789abcdef";
export const APP_ID = "111222333444555666";
/** The shipped presets only, so a local custom.md can't change what the tests see. */
export const PERSONAS = shippedPersonas();
export const ok = (result: unknown = {}) => json({ success: true, result });
export const refused = (status: number) =>
  json({ success: false, errors: [{ code: 10000, message: "denied" }] }, status);

export const GROUPS = [
  "AI Gateway Read",
  "AI Gateway Edit",
  "AI Gateway Run",
  "Workers AI Read",
  "Websearch Run",
  "Browser Rendering - Edit",
].map((name) => ({ id: `g:${name}`, name }));

export type World = {
  app?: object;
  appStatus?: number;
  patchStatus?: number;
  /** Guild lists returned by successive polls; the last one repeats. */
  guilds?: object[][];
  guildsStatus?: number;
  accounts?: object[];
  /** The account the token acts in; the Cloudflare routes answer only for this id. */
  account?: string;
  accountsStatus?: number;
  groups?: object[];
  /** Fails the nth token creation (1-based). */
  failMint?: number;
  /** Runs (and is awaited) when the nth token is being created, before the answer goes back. */
  onMint?: (n: number) => void | Promise<void>;
  /** The setup token is a user token: the account verify endpoint doesn't know it, and only /user/tokens can delete it. */
  userBootstrap?: boolean;
  /** Status DELETE answers with, by token id (404 means "not found" and deletes nothing). */
  deleteStatus?: Record<string, number>;
  /** Token ids for which DELETE says success but the token keeps working. */
  survives?: string[];
  deleteBootstrapStatus?: number;
  verifyStatus?: number;
  gatewayStatus?: number;
  /** Gateways that already exist, by id. */
  gateways?: Record<string, object>;
  deleteGatewayStatus?: number;
  /** Account tokens that already exist (what `GET /accounts/{id}/tokens` lists). */
  existingTokens?: { id: string; name: string; status?: string }[];
  listTokensStatus?: number;
  /** Runs when a token is deleted, with its id. */
  onDelete?: (id: string) => void;
  chat?: () => Response;
  onDeleteBootstrap?: () => void;
};

/**
 * A door a fake service can hold a request at: `wait()` (called by the fake) blocks until `release()`, and `reached`
 * resolves as soon as a request is waiting, so a test can act mid-step without sleeping.
 */
export function gate() {
  let release!: () => void;
  let arrive!: () => void;
  const open = new Promise<void>((r) => {
    release = r;
  });
  const reached = new Promise<void>((r) => {
    arrive = r;
  });
  return {
    release,
    reached,
    wait: async () => {
      arrive();
      await open;
    },
  };
}

export const goodApp = { id: APP_ID, name: "gork", bot_public: false, flags: 0 };

export function world(w: World) {
  const acct = w.account ?? ACCT;
  let polls = 0;
  let mints = 0;
  /** Token secret to token id, for every secret this world has issued or been given. */
  const ids = new Map<string, string>([
    [BOOT, "boot-id"],
    [BOOT2, "boot2-id"],
  ]);
  const isBoot = (id: string | undefined) => id === "boot-id" || id === "boot2-id";
  const dead = new Set<string>();
  const gateways = new Map<string, object>(Object.entries(w.gateways ?? {}));
  const bearer = (c: Call) => (c.headers.Authorization ?? "").replace(/^Bearer /, "");
  return fakeFetch(async (c: Call) => {
    const u = c.url;
    // Discord
    if (u.endsWith("/applications/@me")) {
      if (w.appStatus) return json({ message: "401: Unauthorized" }, w.appStatus);
      if (c.method === "PATCH") {
        return w.patchStatus ? json({}, w.patchStatus) : json({ ...goodApp, ...w.app, flags: c.body.flags });
      }
      return json({ ...goodApp, ...w.app });
    }
    if (u.endsWith("/users/@me/guilds")) {
      if (w.guildsStatus) return json({ message: "no" }, w.guildsStatus);
      const lists = w.guilds ?? [[{ id: "42", name: "My Server" }]];
      return json(lists[Math.min(polls++, lists.length - 1)]);
    }
    // Cloudflare
    if (u.includes("/accounts?")) {
      if (w.accountsStatus) return refused(w.accountsStatus);
      return ok(w.accounts ?? [{ id: ACCT, name: "Me" }]);
    }
    if (u.endsWith("/tokens/verify")) {
      const id = ids.get(bearer(c));
      if (w.userBootstrap && isBoot(id) && u.includes("/accounts/")) return refused(401);
      if (w.verifyStatus && isBoot(id)) return refused(w.verifyStatus);
      if (!id || dead.has(id)) return refused(401);
      return ok({ id, status: "active" });
    }
    if (u.endsWith("/tokens/permission_groups")) return ok(w.groups ?? GROUPS);
    if (c.method === "POST" && u.endsWith(`/accounts/${acct}/tokens`)) {
      const n = ++mints;
      await w.onMint?.(n);
      if (n === w.failMint) return refused(403);
      ids.set(MINTED(c.body.name), `tok-${n}`);
      return ok({ id: `tok-${n}`, name: c.body.name, value: MINTED(c.body.name) });
    }
    if (c.method === "GET" && u.includes(`/accounts/${acct}/tokens?`)) {
      if (w.listTokensStatus) return refused(w.listTokensStatus);
      const list = w.existingTokens ?? [];
      return json({ success: true, result: list, result_info: { page: 1, per_page: 50, total_count: list.length } });
    }
    if (c.method === "DELETE" && u.includes("/tokens/")) {
      const id = u.split("/").pop() as string;
      const userPath = u.includes("/user/tokens/");
      w.onDelete?.(id);
      if (isBoot(id)) w.onDeleteBootstrap?.();
      // The wrong endpoint for this kind of token answers like Cloudflare would: not allowed.
      if (isBoot(id) && userPath !== !!w.userBootstrap) return refused(403);
      const status = w.deleteStatus?.[id] ?? (isBoot(id) ? w.deleteBootstrapStatus : undefined);
      if (status) return refused(status);
      if (!w.survives?.includes(id)) dead.add(id);
      return ok({ id });
    }
    const gw = /\/ai-gateway\/gateways(?:\/([^/?]+))?$/.exec(u);
    if (gw) {
      if (w.gatewayStatus) return refused(w.gatewayStatus);
      const id = gw[1] ?? c.body?.id;
      if (c.method === "GET") return gateways.has(id) ? ok(gateways.get(id)) : json({}, 404);
      if (c.method === "DELETE") {
        if (w.deleteGatewayStatus) return refused(w.deleteGatewayStatus);
        return gateways.delete(id) ? ok({}) : json({}, 404);
      }
      gateways.set(id, c.body);
      return ok();
    }
    if (u.endsWith("/ai/v1/chat/completions")) return w.chat?.() ?? json({ choices: [{ message: { content: "hi" } }] });
    if (u.endsWith("/ai/websearch") || u.endsWith("/browser-rendering/markdown")) return ok({});
    return json({ unexpected: u }, 500);
  });
}
