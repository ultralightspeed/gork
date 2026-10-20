import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFatal, createWatchdog } from "../src/lifecycle.ts";

const MIN = 60_000;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("watchdog", () => {
  it("fires when the connection stays down past the limit", () => {
    const onExpire = vi.fn();
    createWatchdog({ limitMs: 5 * MIN, onExpire, checkMs: 30_000 }).start();
    vi.advanceTimersByTime(4 * MIN);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2 * MIN);
    expect(onExpire).toHaveBeenCalledOnce();
  });

  it("stays quiet while the connection is up, and starts counting again once it drops", () => {
    const onExpire = vi.fn();
    const dog = createWatchdog({ limitMs: 5 * MIN, onExpire, checkMs: 30_000 });
    dog.start();
    dog.markUp();
    vi.advanceTimersByTime(30 * MIN);
    expect(onExpire).not.toHaveBeenCalled();
    dog.markDown();
    vi.advanceTimersByTime(4 * MIN);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2 * MIN);
    expect(onExpire).toHaveBeenCalledOnce();
  });

  it("keeps the first drop time when marked down repeatedly", () => {
    const onExpire = vi.fn();
    const dog = createWatchdog({ limitMs: 5 * MIN, onExpire, checkMs: 30_000 });
    dog.start();
    dog.markUp();
    dog.markDown();
    vi.advanceTimersByTime(4 * MIN);
    dog.markDown();
    vi.advanceTimersByTime(2 * MIN);
    expect(onExpire).toHaveBeenCalledOnce();
  });

  it("does nothing once stopped", () => {
    const onExpire = vi.fn();
    const dog = createWatchdog({ limitMs: 5 * MIN, onExpire, checkMs: 30_000 });
    dog.start();
    dog.stop();
    vi.advanceTimersByTime(60 * MIN);
    expect(onExpire).not.toHaveBeenCalled();
  });
});

describe("fatal", () => {
  it("prints one FATAL line and stops the watchdog so it can't restart into the same error", () => {
    const onExpire = vi.fn();
    const dog = createWatchdog({ limitMs: 5 * MIN, onExpire, checkMs: 30_000 });
    dog.start();
    const error = vi.fn();
    const idle = vi.fn();
    createFatal(dog, { error, idle })("discord-login", "bad token");
    expect(error).toHaveBeenCalledWith("[gork] FATAL discord-login: bad token");
    expect(idle).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(60 * MIN);
    expect(onExpire).not.toHaveBeenCalled();
  });
});
