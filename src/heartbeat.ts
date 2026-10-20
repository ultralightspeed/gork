// The liveness file for the image's HEALTHCHECK: written every 30 s while Discord is connected, and read by
// src/healthcheck.ts, which calls the container unhealthy when the time in it is too old.
import { readFileSync, renameSync, writeFileSync } from "node:fs";

export const HEARTBEAT_FILE = "/tmp/gork-heartbeat";
export const HEARTBEAT_INTERVAL_MS = 30_000;
/** Three beats' worth: one or two may be missed (a long event-loop stall, a slow disk) without a false alarm. */
export const HEARTBEAT_MAX_AGE_MS = 3 * HEARTBEAT_INTERVAL_MS;

/** Whether the file's content (a millisecond timestamp) is no older than `maxAgeMs`. Anything else is stale. */
export function heartbeatFresh(content: string | null, now: number, maxAgeMs = HEARTBEAT_MAX_AGE_MS): boolean {
  const text = content?.trim() ?? "";
  if (!/^\d+$/.test(text)) return false;
  const age = now - Number(text);
  return age >= 0 && age <= maxAgeMs;
}

/** The file's content, or null when it can't be read. */
export function readHeartbeat(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Replaces the file in one step, so a reader never sees it half written. Throws when the directory isn't writable. */
export function writeHeartbeat(file: string, content: string): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

type Heartbeat = { beat(): void; stop(): void; timer: NodeJS.Timeout };

/**
 * Writes the current time every `intervalMs`, but only while `isUp()` says the Discord connection is up. `beat()`
 * writes now (for the moment the connection returns). A failing write is logged once and never thrown: a missing
 * heartbeat only makes the container show as unhealthy, it must not take the bot down.
 */
export function startHeartbeat(o: {
  isUp: () => boolean;
  write: (content: string) => void;
  log?: (message: string) => void;
  intervalMs?: number;
}): Heartbeat {
  let warned = false;
  const beat = () => {
    if (!o.isUp()) return;
    try {
      o.write(String(Date.now()));
    } catch (err) {
      if (warned) return;
      warned = true;
      o.log?.(`heartbeat not written (the container will show as unhealthy): ${(err as Error).message}`);
    }
  };
  const timer = setInterval(beat, o.intervalMs ?? HEARTBEAT_INTERVAL_MS);
  timer.unref();
  return { beat, stop: () => clearInterval(timer), timer };
}
