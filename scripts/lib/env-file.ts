// Writing .env without ever leaving a partial or world-readable file, and without overwriting one that appeared.
// The text goes to a private temp file in the same folder first; a hard link then puts it in place, which fails if
// the target exists. Permissions are set on the temp file, so .env never exists with looser ones.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { linkSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** What the host can do that tests replace: the platform, the user's name, and running a program (no shell). */
export interface HostOps {
  platform: NodeJS.Platform;
  username: string | undefined;
  runCommand(command: string, args: string[]): { ok: boolean };
}

export function realHost(): HostOps {
  return {
    platform: process.platform,
    username: process.env.USERNAME,
    runCommand: (command, args) => {
      const r = spawnSync(command, args, { stdio: "ignore", windowsHide: true });
      return { ok: r.status === 0 && !r.error };
    },
  };
}

/** The file calls writeEnvFile makes, replaceable in tests to simulate a full disk or a race. */
export interface FileOps {
  writeFileSync: typeof writeFileSync;
  linkSync: typeof linkSync;
  unlinkSync: typeof unlinkSync;
}

const realOps: FileOps = { writeFileSync, linkSync, unlinkSync };

/**
 * How private the file is: "owner-only" (POSIX mode 0600, or Windows permissions reduced to the current user) or
 * "unknown" (Windows, and the permissions could not be changed).
 */
export type Privacy = "owner-only" | "unknown";

/**
 * Writes `text` to `path`, which must not exist. Throws with code EEXIST when it does (or appears meanwhile). On any
 * failure our own temp file is removed and `path` is left untouched, never partial.
 */
export function writeEnvFile(path: string, text: string, host: HostOps = realHost(), ops: FileOps = realOps): Privacy {
  // `.env.<pid>.<hex>.tmp`: matched by .gitignore's .env.* and refused by check-secrets, should one ever be left behind.
  const temp = join(dirname(path), `${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  let privacy: Privacy = "owner-only";
  try {
    ops.writeFileSync(temp, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
    if (host.platform === "win32") {
      // Drop inherited permissions and grant only the current user, before the file gets its final name.
      const user = host.username?.trim();
      const done = user ? host.runCommand("icacls", [temp, "/inheritance:r", "/grant:r", `${user}:F`]).ok : false;
      if (!done) privacy = "unknown";
    }
    ops.linkSync(temp, path);
    return privacy;
  } finally {
    try {
      ops.unlinkSync(temp);
    } catch {
      /* never created, or already gone */
    }
  }
}
