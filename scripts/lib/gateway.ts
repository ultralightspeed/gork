// The AI Gateway gork runs behind: its settings and the calls that manage it. Throws CliError, never exits and
// never prints, so the CLI, the setup page and doctor can all use it (and tests can fake `fetch`).
import { CliError } from "./errors.ts";
import { jsonWithout, printable } from "./text.ts";

type ApiResult = { status: number; json: { success?: boolean; errors?: unknown; result?: unknown } };
/** One Cloudflare account API call: `api("GET", "/ai-gateway/gateways/gork")`. */
export type Api = (method: string, path: string, body?: unknown) => Promise<ApiResult>;

export function cloudflareApi(accountId: string, token: string, fetchFn: typeof fetch = fetch): Api {
  return async (method, path, body) => {
    const res = await fetchFn(`https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: (await jsonWithout(res, token)) as ApiResult["json"] };
  };
}

export function assertOk(r: ApiResult, what: string): void {
  if (r.status >= 200 && r.status < 300 && r.json?.success !== false) return;
  throw new CliError(`${what} failed: HTTP ${r.status} ${JSON.stringify(r.json?.errors ?? r.json).slice(0, 300)}`);
}

/**
 * Gateway settings: auth on, zero data retention, a daily spend limit above the bot's own cap, and Workers AI billed
 * to credits ("unified") or, in free mode, to the free allowance ("standard").
 */
export function gatewaySpec({ budgetUsd, billing = "credits" }: { budgetUsd: number; billing?: "credits" | "free" }) {
  const limit = Math.round(Math.max(budgetUsd * 1.2, budgetUsd + 0.05) * 100) / 100;
  return {
    rate_limiting_interval: 60,
    rate_limiting_limit: 30,
    rate_limiting_technique: "fixed",
    collect_logs: true,
    cache_ttl: 0,
    cache_invalidate_on_update: false,
    authentication: true,
    workers_ai_billing_mode: billing === "free" ? "standard" : "unified",
    zdr: true,
    spend_limits: {
      enabled: true,
      rules: [{ id: "daily", limitType: "cost", limit, window: 86400, technique: "fixed" }],
    },
  };
}

type GatewaySettings = Record<string, unknown>;

/** The gateway's current settings, or null when there is no gateway with that id. */
export async function readGateway(api: Api, id: string): Promise<GatewaySettings | null> {
  const got = await api("GET", `/ai-gateway/gateways/${id}`);
  if (got.status === 404) return null;
  assertOk(got, "read AI Gateway");
  const result = got.json?.result;
  return result && typeof result === "object" ? (result as GatewaySettings) : {};
}

/**
 * Whether `got` has every field of `want` with the same value (key order doesn't matter). Extra object fields in
 * `got` are fine: Cloudflare reports fields it fills in itself (e.g. `enabled` on each spend rule). Arrays must
 * have the same length, so a missing or extra rule still counts as different.
 */
function covers(want: unknown, got: unknown): boolean {
  if (want === got) return true;
  if (typeof want !== "object" || typeof got !== "object" || want === null || got === null) return false;
  if (Array.isArray(want) !== Array.isArray(got)) return false;
  if (Array.isArray(want) && want.length !== (got as unknown[]).length) return false;
  return Object.keys(want).every(
    (k) => Object.hasOwn(got, k) && covers((want as Record<string, unknown>)[k], (got as Record<string, unknown>)[k]),
  );
}

/**
 * Creates the gateway, or brings an existing one to gatewaySpec. "unchanged" only when every field of the spec is
 * already exactly as wanted (nothing is written then); any doubt means a PUT and "updated".
 */
export async function ensureGateway(
  api: Api,
  id: string,
  budgetUsd: number,
  billing: "credits" | "free" = "credits",
): Promise<"created" | "updated" | "unchanged"> {
  const spec = gatewaySpec({ budgetUsd, billing });
  const existing = await readGateway(api, id);
  if (existing === null) {
    assertOk(await api("POST", "/ai-gateway/gateways", { id, ...spec }), "create AI Gateway");
    return "created";
  }
  if (Object.entries(spec).every(([key, want]) => covers(want, existing[key]))) return "unchanged";
  assertOk(await api("PUT", `/ai-gateway/gateways/${id}`, spec), "update AI Gateway");
  return "updated";
}

const onOff = (v: unknown) => (v === true ? "on" : v === false ? "off" : "unknown");

/** The settings of an existing gateway that matter to a person deciding whether to overwrite it, one per line. */
export function gatewaySummary(g: GatewaySettings): string[] {
  const billing = typeof g.workers_ai_billing_mode === "string" ? printable(g.workers_ai_billing_mode, 30) : "unknown";
  const limits = (g.spend_limits ?? {}) as { enabled?: unknown; rules?: unknown };
  const rule = Array.isArray(limits.rules) ? (limits.rules[0] as { limit?: unknown } | undefined) : undefined;
  const limit = typeof rule?.limit === "number" && limits.enabled === true ? `$${rule.limit} per day` : "none";
  return [
    `billing: ${billing}`,
    `authentication: ${onOff(g.authentication)}`,
    `zero data retention: ${onOff(g.zdr)}`,
    `request logging: ${onOff(g.collect_logs)}`,
    `spend limit: ${limit}`,
  ];
}

export async function deleteGateway(api: Api, id: string): Promise<"deleted" | "missing"> {
  const r = await api("DELETE", `/ai-gateway/gateways/${id}`);
  if (r.status === 404) return "missing";
  assertOk(r, "delete AI Gateway");
  return "deleted";
}

/** Prepaid credit balance in USD, or null when it can't be read (the endpoint is undocumented, so it is only a hint). */
export async function creditBalance(api: Api): Promise<number | null> {
  const r = await api("GET", "/ai-gateway/billing/credit-balance").catch(() => null);
  const balance = r?.status === 200 ? (r.json?.result as { balance?: unknown } | undefined)?.balance : undefined;
  if (typeof balance !== "number" && typeof balance !== "string") return null;
  return Number.isFinite(Number(balance)) ? Number(balance) : null;
}
