import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_MAX_AGE_MS,
  heartbeatFresh,
  readHeartbeat,
  startHeartbeat,
  writeHeartbeat,
} from "../src/heartbeat.ts";

const NOW = 1_800_000_000_000;

describe("heartbeatFresh", () => {
  it("is fresh for a timestamp no older than the maximum age, stale one millisecond past it", () => {
    expect(heartbeatFresh(String(NOW), NOW)).toBe(true);
    expect(heartbeatFresh(String(NOW - HEARTBEAT_MAX_AGE_MS), NOW)).toBe(true);
    expect(heartbeatFresh(`${NOW - 1000}\n`, NOW)).toBe(true);
    expect(heartbeatFresh(String(NOW - HEARTBEAT_MAX_AGE_MS - 1), NOW)).toBe(false);
  });

  it("is stale when nothing was written, or what was written is not a time", () => {
    for (const content of [null, "", "  ", "yesterday", "12ab", "-5", "1.5e12", "NaN", String(NOW + 60_000)])
      expect(heartbeatFresh(content, NOW), String(content)).toBe(false);
  });

  it("allows a few missed beats, or Docker's health check would flap and restart the bot", () => {
    expect(HEARTBEAT_MAX_AGE_MS).toBeGreaterThan(2 * HEARTBEAT_INTERVAL_MS);
  });
});

describe("startHeartbeat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("writes the time every interval while the connection is up, and not while it is down", () => {
    let up = false;
    const written: string[] = [];
    const hb = startHeartbeat({ isUp: () => up, write: (c) => written.push(c) });
    vi.advanceTimersByTime(3 * HEARTBEAT_INTERVAL_MS);
    expect(written).toEqual([]); // down: silent, so the health check goes stale
    up = true;
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(written).toEqual([String(NOW + 4 * HEARTBEAT_INTERVAL_MS)]);
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(written).toHaveLength(2);
    hb.stop();
    vi.advanceTimersByTime(5 * HEARTBEAT_INTERVAL_MS);
    expect(written).toHaveLength(2);
  });

  it("beat() writes at once when up (for the moment the connection comes back), and not when down", () => {
    let up = false;
    const written: string[] = [];
    const hb = startHeartbeat({ isUp: () => up, write: (c) => written.push(c) });
    hb.beat();
    expect(written).toEqual([]);
    up = true;
    hb.beat();
    expect(written).toEqual([String(NOW)]);
    hb.stop();
  });

  it("survives a failing write (a plain --read-only run has no /tmp) and says so once", () => {
    const log = vi.fn();
    const write = vi.fn(() => {
      throw new Error("EROFS");
    });
    const hb = startHeartbeat({ isUp: () => true, write, log });
    vi.advanceTimersByTime(4 * HEARTBEAT_INTERVAL_MS);
    expect(write).toHaveBeenCalledTimes(4);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/EROFS/);
    hb.stop();
  });

  it("does not keep the process alive", () => {
    const hb = startHeartbeat({ isUp: () => true, write: () => {} });
    expect(hb.timer.hasRef()).toBe(false);
    hb.stop();
  });
});

describe("the heartbeat file and the check Docker runs", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "gork-hb-"));
  const check = (file: string) => spawnSync(process.execPath, ["src/healthcheck.ts", file], { encoding: "utf8" });

  it("round-trips through writeHeartbeat and readHeartbeat, leaving no temporary file behind", () => {
    const d = dir();
    const file = join(d, "hb");
    expect(readHeartbeat(file)).toBeNull();
    writeHeartbeat(file, "123");
    writeHeartbeat(file, "456");
    expect(readHeartbeat(file)).toBe("456");
    expect(readdirSync(d)).toEqual(["hb"]);
  });

  it("exits 0 for a fresh heartbeat and 1 for a stale one, a missing one or junk", () => {
    const file = join(dir(), "hb");
    expect(check(file).status).toBe(1); // nothing written yet (still starting, or never connected)
    writeFileSync(file, String(Date.now()));
    expect(check(file).status).toBe(0);
    writeFileSync(file, String(Date.now() - HEARTBEAT_MAX_AGE_MS - 5000));
    const stale = check(file);
    expect(stale.status).toBe(1);
    expect(stale.stdout).toMatch(/stale/);
    writeFileSync(file, "junk");
    expect(check(file).status).toBe(1);
    expect(existsSync(file)).toBe(true); // reading never removes it
  });
});
