import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { findProblems } from "../scripts/check-secrets.ts";
import { type FileOps, type HostOps, writeEnvFile } from "../scripts/lib/env-file.ts";
import { tempDir } from "./helpers.ts";

const dir = () => tempDir("gork-envfile-");

function host(over: Partial<HostOps> = {}, ran: { cmd: string; args: string[]; envExisted: boolean }[] = []) {
  const h: HostOps = {
    platform: "linux",
    username: "alice",
    runCommand: (cmd, args) => {
      ran.push({ cmd, args, envExisted: false });
      return { ok: true };
    },
    ...over,
  };
  return { host: h, ran };
}

const realOps = async (): Promise<FileOps> => {
  const fs = await import("node:fs");
  return { writeFileSync: fs.writeFileSync, linkSync: fs.linkSync, unlinkSync: fs.unlinkSync };
};

describe("writeEnvFile", () => {
  it("writes the text, leaves no temp file behind, keeps it to the owner (POSIX), and runs no command off Windows", () => {
    const d = dir();
    const path = join(d, ".env");
    const h = host();
    expect(writeEnvFile(path, "A=1\n", h.host)).toBe("owner-only");
    expect(readFileSync(path, "utf8")).toBe("A=1\n");
    expect(readdirSync(d)).toEqual([".env"]);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(h.ran).toEqual([]);
  });

  it("refuses to overwrite a file that exists, leaving it and the folder as they were", () => {
    const d = dir();
    const path = join(d, ".env");
    writeFileSync(path, "KEEP=me\n");
    expect(() => writeEnvFile(path, "A=1\n", host().host)).toThrowError(expect.objectContaining({ code: "EEXIST" }));
    expect(readFileSync(path, "utf8")).toBe("KEEP=me\n");
    expect(readdirSync(d)).toEqual([".env"]);
  });

  it("does not clobber a file that appears between the temp write and the final step", async () => {
    const d = dir();
    const path = join(d, ".env");
    const ops = await realOps();
    const racing: FileOps = {
      ...ops,
      linkSync: (from, to) => {
        writeFileSync(path, "RACE=1\n");
        return ops.linkSync(from, to);
      },
    };
    expect(() => writeEnvFile(path, "A=1\n", host().host, racing)).toThrowError(
      expect.objectContaining({ code: "EEXIST" }),
    );
    expect(readFileSync(path, "utf8")).toBe("RACE=1\n");
    expect(readdirSync(d)).toEqual([".env"]);
  });

  it("removes its temp file and writes no .env when the write fails midway or the final step fails", async () => {
    const ops = await realOps();
    const full: FileOps = {
      ...ops,
      writeFileSync: ((file: string, data: string, options: object) => {
        ops.writeFileSync(file, String(data).slice(0, 3), options);
        throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
      }) as FileOps["writeFileSync"],
    };
    const noLink: FileOps = {
      ...ops,
      linkSync: () => {
        throw Object.assign(new Error("not permitted"), { code: "EPERM" });
      },
    };
    for (const [failing, message] of [
      [full, /no space/],
      [noLink, /not permitted/],
    ] as const) {
      const d = dir();
      expect(() => writeEnvFile(join(d, ".env"), "A=1\nB=2\n", host().host, failing)).toThrow(message);
      expect(readdirSync(d)).toEqual([]);
    }
  });

  it("creates its temp file private (mode 0600, exclusive) and named so .gitignore's .env.* and check-secrets cover it, should one ever be left behind", async () => {
    const d = dir();
    const ops = await realOps();
    const temps: { file: string; options: object }[] = [];
    const watching: FileOps = {
      ...ops,
      writeFileSync: ((file: string, data: string, options: object) => {
        temps.push({ file, options });
        return ops.writeFileSync(file, data, options);
      }) as FileOps["writeFileSync"],
    };
    writeEnvFile(join(d, ".env"), "A=1\n", host().host, watching);
    expect(temps).toHaveLength(1);
    // The mode is what keeps the secrets from other users on POSIX, and the file test above can't see it on Windows.
    expect(temps[0].options).toMatchObject({ mode: 0o600, flag: "wx" });
    const name = basename(temps[0].file);
    expect(name).toMatch(/^\.env\.\d+\.[0-9a-f]+\.tmp$/);
    expect(findProblems([{ path: name, text: "A=1\n" }], [])).toEqual([`${name}: env file is tracked`]);
  });

  describe("on Windows", () => {
    it("drops inherited permissions and grants only the current user, before the file gets its final name", () => {
      const d = dir();
      const path = join(d, ".env");
      const ran: { cmd: string; args: string[]; envExisted: boolean }[] = [];
      const h = host(
        {
          platform: "win32",
          username: "alice",
          runCommand: (cmd, args) => {
            ran.push({ cmd, args, envExisted: existsSync(path) });
            return { ok: true };
          },
        },
        ran,
      );
      expect(writeEnvFile(path, "A=1\n", h.host)).toBe("owner-only");
      expect(ran).toHaveLength(1);
      const [{ cmd, args, envExisted }] = ran;
      expect(cmd).toBe("icacls");
      expect(args.slice(1)).toEqual(["/inheritance:r", "/grant:r", "alice:F"]);
      expect(args[0].startsWith(d)).toBe(true);
      expect(args[0]).not.toBe(path);
      expect(envExisted).toBe(false);
      expect(readFileSync(path, "utf8")).toBe("A=1\n");
    });

    it("reports the permissions as unknown, but still writes the file, when icacls fails or there is no user name to grant", () => {
      for (const over of [{ runCommand: () => ({ ok: false }) }, { username: undefined }]) {
        const d = dir();
        const h = host({ platform: "win32", ...over });
        expect(writeEnvFile(join(d, ".env"), "A=1\n", h.host)).toBe("unknown");
        expect(readdirSync(d)).toEqual([".env"]);
      }
    });
  });
});
