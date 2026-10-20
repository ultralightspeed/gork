import { CfError } from "./cf.ts";

/** One log-friendly line for any error: name, Discord code or HTTP status when present, then the message (capped). */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err).slice(0, 200);
  const code = (err as { code?: unknown }).code;
  const detail =
    err instanceof CfError
      ? ` (HTTP ${err.status})`
      : typeof code === "number" || typeof code === "string"
        ? ` (code ${code})`
        : "";
  return `${err.name}${detail}: ${err.message}`.slice(0, 220);
}

/** discord.js rejects login with these for an invalid token or intents not enabled in the Developer Portal. */
export function isFatalLoginError(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  return code === "TokenInvalid" || code === "DisallowedIntents";
}

// Gateway close codes discord.js treats as unrecoverable: authentication failed, invalid shard, sharding
// required, invalid API version, invalid intents, disallowed intents.
const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

export function isFatalCloseCode(code: number): boolean {
  return FATAL_CLOSE_CODES.has(code);
}
