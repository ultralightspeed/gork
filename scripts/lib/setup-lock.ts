// Only one `npm run setup` at a time: two at once would each make Cloudflare tokens, and the second would treat the
// first's as "older" ones to revoke. The lock is a small file next to .env holding the process id; a lock whose process is
// gone (a crash, Ctrl-C) is taken over, so it can never get stuck.
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { CliError } from "./errors.ts";

interface LockDeps {
  pid: number;
  isAlive(pid: number): boolean;
}

const real: LockDeps = {
  pid: process.pid,
  isAlive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // EPERM: the process exists but belongs to someone else, so it is alive.
      return (err as NodeJS.ErrnoException).code === "EPERM";
    }
  },
};

const heldBy = (path: string): number | null => {
  try {
    const pid = Number(readFileSync(path, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
};

/** Takes the lock, or throws CliError if a setup that is still running holds it. Returns the function that gives it back. */
export function acquireSetupLock(path: string, deps: LockDeps = real): () => void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, `${deps.pid}\n`, { flag: "wx" });
      return () => {
        // Only our own: after a takeover the file belongs to someone else.
        if (heldBy(path) !== deps.pid) return;
        try {
          unlinkSync(path);
        } catch {
          /* already gone */
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const holder = heldBy(path);
      if (holder !== null && deps.isAlive(holder)) {
        throw new CliError(
          "another `npm run setup` is already running (find its window and use its page, or press Ctrl+C there to stop it). Two at once would trip over each other's tokens.",
        );
      }
      try {
        unlinkSync(path);
      } catch {
        /* someone else removed it first */
      }
    }
  }
  throw new CliError("couldn't take the setup lock; run `npm run setup` again");
}
