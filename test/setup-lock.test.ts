import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { CliError } from "../scripts/lib/errors.ts";
import { acquireSetupLock } from "../scripts/lib/setup-lock.ts";

const lockPath = () => {
  const dir = mkdtempSync(join(tmpdir(), "gork-lock-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, ".env.setup-lock");
};

describe("the one-setup-at-a-time lock", () => {
  it("creates a file holding this process's id, and removes it on release", () => {
    const path = lockPath();
    const release = acquireSetupLock(path, { pid: 4242, isAlive: () => true });
    expect(readFileSync(path, "utf8").trim()).toBe("4242");
    release();
    expect(existsSync(path)).toBe(false);
  });

  it("refuses, in plain words, while the setup that holds it is still running", () => {
    const path = lockPath();
    acquireSetupLock(path, { pid: 1, isAlive: () => true });
    let err: unknown;
    try {
      acquireSetupLock(path, { pid: 2, isAlive: (pid) => pid === 1 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CliError);
    expect((err as Error).message).toMatch(/another .*setup.* is already running/i);
    expect((err as Error).message).toMatch(/Ctrl\+C|close/);
    expect(readFileSync(path, "utf8").trim()).toBe("1");
  });

  it("takes the lock over when the process that held it is gone, or the file is junk", () => {
    const stale = lockPath();
    writeFileSync(stale, "999999\n");
    const release = acquireSetupLock(stale, { pid: 7, isAlive: () => false });
    expect(readFileSync(stale, "utf8").trim()).toBe("7");
    release();
    const junk = lockPath();
    writeFileSync(junk, "not a pid");
    acquireSetupLock(junk, { pid: 8, isAlive: () => true });
    expect(readFileSync(junk, "utf8").trim()).toBe("8");
  });

  it("releasing never removes a lock that now belongs to someone else, and releasing twice is harmless", () => {
    const path = lockPath();
    const release = acquireSetupLock(path, { pid: 10, isAlive: () => true });
    writeFileSync(path, "11\n");
    release();
    expect(readFileSync(path, "utf8").trim()).toBe("11");
    release();
  });

  it("works with the real process id by default, and sees a running process as alive", () => {
    const path = lockPath();
    const release = acquireSetupLock(path);
    expect(readFileSync(path, "utf8").trim()).toBe(String(process.pid));
    expect(() => acquireSetupLock(path)).toThrow(/already running/);
    release();
  });
});
