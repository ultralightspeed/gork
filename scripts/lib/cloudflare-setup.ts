// The Cloudflare side of `gork setup` and `gork doctor`: the bootstrap-token link, finding the account, minting the
// two runtime tokens by permission-group name, and probing that each token can do what gork needs.
// Throws CliError, never prints, and never puts a token in a message. Every call takes `fetch`, so tests fake it.

import type { SearchProvider } from "../../src/search-providers.ts";
import { CliError } from "./errors.ts";
import type { Api } from "./gateway.ts";
import { jsonWithout } from "./text.ts";

const API = "https://api.cloudflare.com/client/v4";

/** Name of the one token the human creates; setup deletes it at the end. */
export const BOOTSTRAP_NAME = "gork-setup";
/** Where to top up AI Gateway credits (credits mode only); also where gateways are listed and deleted. */
export const CREDITS_URL = "https://dash.cloudflare.com/?to=/:account/ai/ai-gateway";
export const GATEWAYS_URL = CREDITS_URL;
/** Where API tokens are listed and deleted. */
export const TOKENS_URL = "https://dash.cloudflare.com/?to=/:account/api-tokens";

/**
 * Dashboard link that pre-fills a new account token with "API token management: Edit" (permission key
 * `account_api_tokens`). A token holding only that permission can create the two narrower tokens gork needs. The user
 * still picks the account and clicks Create Token.
 */
export function bootstrapLink(): string {
  const keys = encodeURIComponent(JSON.stringify([{ key: "account_api_tokens", type: "edit" }]));
  return `https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=${keys}&name=${BOOTSTRAP_NAME}`;
}

/** Cloudflare API tokens are one unbroken string with no dots (a dotted one is a Discord token or something else). */
export const looksLikeCloudflareToken = (token: string): boolean => /^[^\s.]+$/.test(token);

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");

type Raw = { status: number; json: Obj };

/** One call outside the account-scoped API (or with custom headers); the token goes only to api.cloudflare.com. */
async function raw(
  token: string,
  method: string,
  path: string,
  fetchFn: typeof fetch,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Raw> {
  let res: Response;
  try {
    res = await fetchFn(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new CliError("couldn't reach Cloudflare (api.cloudflare.com). Check your internet connection and try again.");
  }
  return { status: res.status, json: obj(await jsonWithout(res, token)) };
}

const isOk = (status: number) => status >= 200 && status < 300;

/** Error messages and codes from a Cloudflare error body, lower-cased for matching. */
function errorsOf(json: Obj): { text: string; codes: number[] } {
  const errors = Array.isArray(json.errors) ? json.errors.map(obj) : [];
  return {
    text: errors
      .map((e) => str(e.message))
      .join(" ")
      .toLowerCase(),
    codes: errors.map((e) => Number(e.code)),
  };
}

const errorDetail = (json: Obj) => JSON.stringify(json.errors ?? "").slice(0, 200);

/** Cloudflare says the token is invalid, expired or deleted. The caller can ask for it again. */
export class TokenRejectedError extends CliError {}
/** The token works but can't list accounts; the caller can ask for the dashboard URL instead. */
export class AccountsUnlistedError extends CliError {}

const rejected = (status: number) =>
  new TokenRejectedError(
    `Cloudflare rejected that token (HTTP ${status}). Check you copied the whole secret, and that it has not been deleted or expired.`,
  );

/** Which kind of token it is decides where it can be verified and deleted: account-owned or user-owned. */
export type TokenKind = "account" | "user";
export type TokenInfo = { id: string; status: string; expiresOn?: string; kind: TokenKind };

const verifyPath = (kind: TokenKind, accountId: string | undefined) =>
  kind === "user" || !accountId ? "/user/tokens/verify" : `/accounts/${accountId}/tokens/verify`;

/**
 * Checks a token is valid and returns its id (needed to delete it later) and which endpoint answered, so the caller
 * deletes it at the matching place. With an account id it asks the account endpoint first (GET
 * /accounts/{id}/tokens/verify is in the API reference). The reference doesn't say what that endpoint answers to a
 * user-owned token, so any 4xx (400, 401, 403, 404, 405) falls back to /user/tokens/verify; only if both refuse is
 * the token called rejected.
 */
export async function verifyToken(token: string, fetchFn: typeof fetch, accountId?: string): Promise<TokenInfo> {
  let kind: TokenKind = "user";
  let r = accountId ? await raw(token, "GET", verifyPath("account", accountId), fetchFn) : null;
  if (r && isOk(r.status)) kind = "account";
  else {
    const first = r;
    if (first && !(first.status >= 400 && first.status < 500)) {
      throw new CliError(`couldn't verify the token: Cloudflare returned HTTP ${first.status}`);
    }
    r = await raw(token, "GET", verifyPath("user", accountId), fetchFn);
    if (!isOk(r.status)) {
      const refusal = [first?.status, r.status].find((st) => st === 401 || st === 403);
      if (refusal) throw rejected(refusal);
    }
  }
  if (!isOk(r.status)) throw new CliError(`couldn't verify the token: Cloudflare returned HTTP ${r.status}`);
  const result = obj(r.json.result);
  const status = str(result.status);
  if (status && status !== "active") throw new CliError(`that token is ${status}; create a new one and paste it`);
  return { id: str(result.id), status: status || "active", expiresOn: str(result.expires_on) || undefined, kind };
}

export type Account = { id: string; name: string };

const PASTE_URL =
  "Open the Cloudflare dashboard, copy the page address (it contains your 32-character account ID), and paste the URL here.";

/** Accounts the token can see. When the token can't list them (403), the caller asks for the account ID instead. */
export async function listAccounts(token: string, fetchFn: typeof fetch): Promise<Account[]> {
  const r = await raw(token, "GET", "/accounts?per_page=50", fetchFn);
  if (r.status === 401) throw rejected(401);
  if (r.status === 403) throw new AccountsUnlistedError(`This token can't list accounts. ${PASTE_URL}`);
  if (!isOk(r.status)) throw new CliError(`couldn't list accounts: Cloudflare returned HTTP ${r.status}`);
  const accounts = (Array.isArray(r.json.result) ? r.json.result : [])
    .map(obj)
    .filter((a) => typeof a.id === "string")
    .map((a) => ({ id: a.id as string, name: str(a.name) }));
  if (accounts.length === 0) throw new AccountsUnlistedError(`This token can't see any account. ${PASTE_URL}`);
  return accounts;
}

/** Pulls a 32-hex account id out of a pasted dashboard URL (or a bare id); null if there isn't one. */
export function parseAccountId(text: string): string | null {
  const m = /\b[0-9a-f]{32}\b/i.exec(text.trim());
  return m ? m[0].toLowerCase() : null;
}

export type PermissionGroup = { id: string; name: string };

/** Every permission group the account can put on a token. */
export async function listPermissionGroups(api: Api): Promise<PermissionGroup[]> {
  const r = await api("GET", "/tokens/permission_groups");
  if (!isOk(r.status)) {
    throw new CliError(`couldn't list Cloudflare permission groups (HTTP ${r.status}): ${errorDetail(obj(r.json))}`);
  }
  return (Array.isArray(r.json.result) ? r.json.result : [])
    .map(obj)
    .filter((g) => typeof g.id === "string" && typeof g.name === "string" && g.is_selectable !== false)
    .map((g) => ({ id: g.id as string, name: g.name as string }));
}

/** One thing a token must be able to do, and the permission-group names that grant it (first match wins). */
export type Need = {
  capability: string;
  names: string[];
  /** Which probe reports on it (see probeRunToken). */
  probe?: "chat" | "web search" | "page reading";
};

/**
 * Permission-group names for the runtime token. Cloudflare has renamed some groups, so each need lists the current
 * name first and older names after it. Cloudflare's API names the groups "Browser Run Write", "AI Gateway Write" and
 * "Websearch Run"; "Browser Rendering - Edit", "AI Gateway Edit" and "Web Search Run" are accepted as synonyms, and
 * normalize() treats Write and Edit as the same level. AI Gateway Run is its own group, needed to send requests through
 * the gateway.
 */
export function runNeeds(billing: "credits" | "free"): Need[] {
  const workersAi: Need = { capability: "Workers AI", names: ["Workers AI Read"], probe: "chat" };
  const browser: Need = {
    capability: "page reading",
    names: ["Browser Run Write", "Browser Rendering - Edit"],
    probe: "page reading",
  };
  if (billing === "free") return [workersAi, browser];
  return [
    { capability: "AI Gateway read", names: ["AI Gateway Read"], probe: "chat" },
    { capability: "AI Gateway run", names: ["AI Gateway Run"], probe: "chat" },
    workersAi,
    { capability: "web search", names: ["Websearch Run", "Web Search Run"], probe: "web search" },
    browser,
  ];
}

/** The admin token (host only): create and update the gateway. Gateway Read is added because Edit alone can't read it. */
export const ADMIN_NEEDS: Need[] = [
  { capability: "AI Gateway read", names: ["AI Gateway Read"] },
  { capability: "AI Gateway edit", names: ["AI Gateway Write", "AI Gateway Edit"] },
];

/**
 * Case, spacing and hyphens don't matter, and neither do Cloudflare's renames: Write and Edit are the same access
 * level, and Browser Rendering became Browser Run. So "Browser Rendering - Edit" and "Browser Run Write" both read
 * "browser run edit".
 */
const normalize = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\brendering\b/g, "run")
    .replace(/\bwrite\b/g, "edit");

/** The product part of a group name ("browser run" from "Browser Run Write"), for listing near misses. */
const product = (name: string) => normalize(name).split(" ").slice(0, -1).join(" ");

export type ResolvedGroup = { id: string; name: string; capability: string };

/**
 * Finds a group id for each need, by name. Throws one CliError listing every need that has none (with the names
 * tried) and the groups on this account that look related, so the fix can be read straight from the message.
 */
export function resolvePermissionGroups(groups: PermissionGroup[], needs: Need[]): ResolvedGroup[] {
  const found: ResolvedGroup[] = [];
  const missing: string[] = [];
  for (const need of needs) {
    const wanted = need.names.map(normalize);
    const hit = wanted.map((w) => groups.find((g) => normalize(g.name) === w)).find(Boolean);
    if (hit) {
      if (!found.some((f) => f.id === hit.id)) found.push({ id: hit.id, name: hit.name, capability: need.capability });
    } else {
      // Near misses: groups for the same product at another access level (e.g. Browser Run Read for Browser Run Write).
      const products = new Set(need.names.map(product));
      const near = groups.map((g) => g.name).filter((n) => products.has(product(n)));
      missing.push(
        `"${need.capability}" (looked for ${need.names.join(", ")}; this account has ${near.join(", ") || "nothing similar"})`,
      );
    }
  }
  if (missing.length) {
    throw new CliError(
      `no Cloudflare permission group for ${missing.join("; ")}. ` +
        "Cloudflare renames groups from time to time; report this so the names can be updated.",
    );
  }
  return found;
}

/** An RFC 3339 time `ms` from `nowMs`, without milliseconds (what expires_on accepts). */
export const expiresIn = (ms: number, nowMs: number): string =>
  new Date(nowMs + ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * Creates an account-owned token limited to this account and the given permission groups, and returns its secret.
 * The secret is shown by Cloudflare only once: the caller must keep it out of logs and output.
 */
export async function mintToken(
  api: Api,
  accountId: string,
  name: string,
  groupIds: string[],
  { expiresOn }: { expiresOn?: string } = {},
): Promise<{ id: string; value: string }> {
  if (groupIds.length === 0) throw new CliError(`refusing to create "${name}" with no permission groups`);
  const r = await api("POST", "/tokens", {
    name,
    policies: [
      {
        effect: "allow",
        resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
        permission_groups: groupIds.map((id) => ({ id })),
      },
    ],
    ...(expiresOn ? { expires_on: expiresOn } : {}),
  });
  if (!isOk(r.status) || r.json?.success === false) {
    const hint =
      r.status === 401 || r.status === 403
        ? " The setup token may only be able to grant permissions it holds itself. Create a token from My Profile > API Tokens > Create additional tokens (a user token) and paste that instead."
        : "";
    throw new CliError(`couldn't create the "${name}" token: HTTP ${r.status} ${errorDetail(obj(r.json))}.${hint}`);
  }
  const result = obj(r.json.result);
  if (typeof result.id !== "string" || typeof result.value !== "string" || !result.value) {
    throw new CliError(`Cloudflare created "${name}" but sent no secret value; delete it in the dashboard and retry`);
  }
  return { id: result.id, value: result.value };
}

/** The token to delete: its kind (where it lives), the account it was made for, and its id. */
export type TokenRef = { kind: TokenKind; accountId: string; id: string };

/**
 * Deletes a token, authenticating with `authToken` (the token itself, or the setup token for ones it made): account
 * tokens at /accounts/{id}/tokens/{id}, user tokens at /user/tokens/{id} (both are in the API reference).
 * "missing" is a 404, which does not prove the token is gone: confirm with tokenState.
 */
export async function revokeToken(
  authToken: string,
  fetchFn: typeof fetch,
  t: TokenRef,
): Promise<"deleted" | "missing"> {
  const id = encodeURIComponent(t.id);
  const path = t.kind === "user" ? `/user/tokens/${id}` : `/accounts/${t.accountId}/tokens/${id}`;
  const r = await raw(authToken, "DELETE", path, fetchFn);
  if (r.status === 404) return "missing";
  if (!isOk(r.status) || r.json.success === false) {
    throw new CliError(`delete token failed: HTTP ${r.status} ${errorDetail(r.json)}`.trim());
  }
  return "deleted";
}

/**
 * Whether a token still works, by verifying it with itself: "revoked" only on 401, which is how Cloudflare answers for a
 * deleted token; "active" when it is still accepted; anything else (403, 404, 5xx, no network) is "unknown".
 */
export async function tokenState(
  token: string,
  fetchFn: typeof fetch,
  kind: TokenKind,
  accountId: string,
): Promise<"revoked" | "active" | "unknown"> {
  try {
    const r = await raw(token, "GET", verifyPath(kind, accountId), fetchFn);
    if (r.status === 401) return "revoked";
    return isOk(r.status) ? "active" : "unknown";
  } catch {
    return "unknown";
  }
}

export type TokenSummary = { id: string; name: string; status: string };

/** Every account-owned token, page by page (GET /accounts/{id}/tokens takes page and per_page, up to 50). */
export async function listAccountTokens(api: Api): Promise<TokenSummary[]> {
  const out: TokenSummary[] = [];
  for (let page = 1; page <= 20; page++) {
    const r = await api("GET", `/tokens?per_page=50&page=${page}`);
    if (!isOk(r.status) || r.json?.success === false) {
      throw new CliError(`couldn't list the account's tokens (HTTP ${r.status}): ${errorDetail(obj(r.json))}`);
    }
    const rows = (Array.isArray(r.json.result) ? r.json.result : [])
      .map(obj)
      .filter((t) => typeof t.id === "string")
      .map((t) => ({ id: t.id as string, name: str(t.name), status: str(t.status) }));
    out.push(...rows);
    const total = Number(obj(obj(r.json).result_info).total_count);
    if (rows.length === 0 || !Number.isFinite(total) || out.length >= total) break;
  }
  return out;
}

/** `kind: "credits"` marks the one problem a person can fix by topping up, so the setup page can wait for it. */
export type Probe = { capability: string; ok: boolean; message: string; kind?: "credits" };

const names = (needs: Need[], probe: Need["probe"]) =>
  needs
    .filter((n) => n.probe === probe)
    .map((n) => n.names[0])
    .join(", ");

type Context = { capability: string; groups: string; billing: "credits" | "free" };

/** Turns one probe response into a plain-language result with the exact fix. */
function classify(r: Raw, c: Context): Probe {
  const { capability } = c;
  const say = (ok: boolean, message: string, kind?: Probe["kind"]): Probe => ({
    capability,
    ok,
    message,
    ...(kind ? { kind } : {}),
  });
  const { text, codes } = errorsOf(r.json);
  if (isOk(r.status)) return say(true, "works");
  if (r.status === 429) {
    return c.billing === "free" && capability === "chat"
      ? say(true, "the token works, but today's free allowance is used up (it resets at 00:00 UTC)")
      : say(true, "the token works; Cloudflare is rate limiting this call right now");
  }
  if (codes.includes(5035)) {
    return say(
      false,
      "this model needs the Workers Paid plan or AI Gateway credits. Free plan: set BILLING_MODE=free (uses @cf/zai-org/glm-4.7-flash).",
    );
  }
  if (r.status === 402 || /credit|balance|payment|billing/.test(text)) {
    return say(
      false,
      `no AI Gateway credits: top up at ${CREDITS_URL} (Manage > Top-up credits), or use BILLING_MODE=free`,
      "credits",
    );
  }
  if (r.status === 404 && /gateway/.test(text)) {
    return say(false, "the AI Gateway was not found; run `npm run up` to create it");
  }
  if (r.status === 401 || r.status === 403) return say(false, `missing: ${c.groups} (HTTP ${r.status})`);
  return say(false, `failed: HTTP ${r.status} ${errorDetail(r.json)}`.trim());
}

export type ProbeOptions = {
  accountId: string;
  token: string;
  gatewayId: string;
  billing: "credits" | "free";
  model: string;
  searchProvider: SearchProvider;
  /** Also search with this provider (SEARCH_FALLBACK), when web search is tested. */
  fallbackProvider?: SearchProvider | null;
  /** Credits mode only: false leaves out the web search, the one probe that costs money. Default true. */
  search?: boolean;
};

/**
 * One cheap call per capability with the runtime token: a 1-token chat completion (through the gateway in credits
 * mode, direct in free mode), one web search per provider asked for (credits mode only), and one page read. A refusal
 * becomes "missing: <group names>". A search costs its provider's price (src/search-providers.ts); the others are free
 * or a fraction of a neuron.
 */
export async function probeRunToken(o: ProbeOptions, fetchFn: typeof fetch): Promise<Probe[]> {
  const needs = runNeeds(o.billing);
  const acct = `/accounts/${o.accountId}`;
  const out: Probe[] = [];
  const run = async (
    capability: Probe["capability"],
    path: string,
    body: unknown,
    headers: Record<string, string>,
    probe = capability as Need["probe"],
  ) => {
    const ctx: Context = { capability, groups: names(needs, probe), billing: o.billing };
    try {
      out.push(classify(await raw(o.token, "POST", `${acct}${path}`, fetchFn, body, headers), ctx));
    } catch (err) {
      out.push({ capability, ok: false, message: (err as Error).message });
    }
  };
  await run(
    "chat",
    "/ai/v1/chat/completions",
    { model: o.model, max_tokens: 1, messages: [{ role: "user", content: "hi" }] },
    // Free mode is Workers AI direct: no gateway header, so unified billing can never apply.
    o.billing === "free" ? {} : { "cf-aig-gateway-id": o.gatewayId, "cf-aig-collect-log-payload": "false" },
  );
  if (o.billing === "credits" && o.search !== false) {
    await run(
      "web search",
      "/ai/websearch",
      { query: "test", provider: o.searchProvider, limit: 1, options: { gateway: { id: o.gatewayId } } },
      {},
    );
    if (o.fallbackProvider) {
      await run(
        `web search fallback (${o.fallbackProvider})`,
        "/ai/websearch",
        { query: "test", provider: o.fallbackProvider, limit: 1, options: { gateway: { id: o.gatewayId } } },
        {},
        "web search",
      );
    }
  }
  await run("page reading", "/browser-rendering/markdown", { url: "https://example.com" }, {});
  return out;
}

export type AdminProbe = Probe & { exists: boolean; gateway?: Record<string, unknown> };

/**
 * Whether the admin token can reach the gateway: a read, so it can't prove Edit. 200 and 404 both mean access;
 * `gateway` is the gateway's current settings when it exists.
 */
export async function probeAdminToken(api: Api, gatewayId: string): Promise<AdminProbe> {
  const r = await api("GET", `/ai-gateway/gateways/${gatewayId}`);
  const capability = "gateway";
  const reach = (exists: boolean, gateway?: Record<string, unknown>): AdminProbe => ({
    capability,
    ok: true,
    message: "can reach AI Gateway",
    exists,
    gateway,
  });
  if (r.status === 200) return reach(true, obj(r.json?.result));
  if (r.status === 404) return reach(false);
  if (r.status === 401 || r.status === 403) {
    return {
      capability,
      ok: false,
      exists: false,
      message: `missing: ${ADMIN_NEEDS.map((n) => n.names[0]).join(", ")} (HTTP ${r.status}; if the token is right, it may have expired)`,
    };
  }
  return { capability, ok: false, exists: false, message: `failed: HTTP ${r.status}` };
}
