import type { Config } from "./config.ts";
import { readCapped } from "./http.ts";

export class CfError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super(`Cloudflare HTTP ${status}: ${body.slice(0, 200)}`);
    this.status = status;
    this.body = body;
  }
}

/**
 * `text` with every copy of each secret replaced, for error messages and logs. A server that echoes the request's
 * Authorization header back in its error body would otherwise put the token into an excerpt.
 */
export function withoutSecrets(text: string, ...secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s.length >= 8) out = out.split(s).join("[redacted]");
  return out;
}

/** The free Workers AI daily allowance is used up. gork never falls back to paid credits for it. */
export class FreeAllowanceError extends Error {}

const ALLOWANCE_CODE = 3036;

/**
 * Whether a failed Cloudflare call means the free daily allowance is used up: HTTP 429, or error code 3036 in
 * the error body. It only ever sees errors, never a success body (base64 image data can contain any digits).
 */
export function isFreeAllowanceExhausted(err: unknown): boolean {
  if (!(err instanceof CfError)) return false;
  if (err.status === 429) return true;
  try {
    const { errors } = JSON.parse(err.body) as { errors?: Array<{ code?: unknown }> };
    return Array.isArray(errors) && errors.some((e) => Number(e?.code) === ALLOWANCE_CODE);
  } catch {
    return false;
  }
}

/** Cloudflare wraps answers as { result }; its OpenAI-compatible endpoint sometimes does too. Returns what is inside. */
export function unwrapResult<T>(json: unknown): T {
  return ((json as { result?: unknown }).result ?? json) as T;
}

/** Most bytes read of a Cloudflare answer, unless the caller allows more (generated images come back as base64). */
export const CF_MAX_BYTES = 4 * 1024 * 1024;

/** The body as text; throws, giving the limit, when it is larger than `maxBytes`. */
export async function readText(res: Response, maxBytes: number, what: string): Promise<string> {
  const body = await readCapped(res, maxBytes);
  if (!body) throw new Error(`${what} HTTP ${res.status}: the answer is larger than ${maxBytes / (1024 * 1024)} MB`);
  return body.toString("utf8");
}

/** POSTs JSON to the account-scoped Cloudflare API with the runtime token; unwraps `{ result }`. */
export async function cfFetch(
  cfg: Config,
  path: string,
  body: unknown,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 15_000,
  { headers = {}, maxBytes = CF_MAX_BYTES }: { headers?: Record<string, string>; maxBytes?: number } = {},
): Promise<unknown> {
  const res = await fetchFn(`https://api.cloudflare.com/client/v4/accounts/${cfg.cf.accountId}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.cf.runToken}`, "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = withoutSecrets(await readText(res, maxBytes, "Cloudflare"), cfg.cf.runToken);
  if (!res.ok) throw new CfError(res.status, text);
  try {
    return unwrapResult(JSON.parse(text));
  } catch {
    // JSON.parse's own message quotes the start of the body.
    throw new Error(`Cloudflare HTTP ${res.status}: the answer is not valid JSON`);
  }
}
