import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// What `npm ci` may run and install. A package that runs code at install time, a new runtime dependency or a package
// from anywhere but the npm registry should be a decision someone made, so each one has to be listed here.
type LockEntry = {
  hasInstallScript?: boolean;
  dev?: boolean;
  optional?: boolean;
  os?: string[];
  resolved?: string;
  integrity?: string;
  link?: boolean;
};
type Lock = {
  lockfileVersion: number;
  packages: Record<string, LockEntry & { dependencies?: Record<string, string> }>;
};

const read = (file: string) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));
const lock: Lock = read("package-lock.json");
const pkg: { scripts?: Record<string, string>; dependencies?: Record<string, string> } = read("package.json");

/** Packages allowed to run an install script, and why. */
const INSTALL_SCRIPTS: Record<string, string> = {
  // vite's optional file watcher (vite comes with vitest): macOS only, a dev dependency, and never part of the image (npm ci --omit=dev).
  "node_modules/fsevents": "optional, dev-only, macOS-only",
};

/** What the bot needs at run time, and nothing else. */
const RUNTIME_DEPENDENCIES = ["discord.js"];

/** The lock entries that would run code during `npm ci`. */
function installScripts(l: Lock): string[] {
  return Object.entries(l.packages)
    .filter(([, v]) => v.hasInstallScript)
    .map(([k]) => k)
    .sort();
}

describe("package-lock.json", () => {
  it("is a v3 lockfile, which records hasInstallScript", () => {
    expect(lock.lockfileVersion).toBe(3);
  });

  it("finds an install script when there is one", () => {
    const fake: Lock = { lockfileVersion: 3, packages: { "": {}, "node_modules/x": { hasInstallScript: true } } };
    expect(installScripts(fake)).toEqual(["node_modules/x"]);
  });

  it("has no package with an install script except the listed ones", () => {
    const unlisted = installScripts(lock).filter((k) => !(k in INSTALL_SCRIPTS));
    expect(
      unlisted,
      "a package now runs an install script: check what it does, then list it in INSTALL_SCRIPTS with the reason",
    ).toEqual([]);
  });

  it("still has the listed install-script packages as described (optional, dev-only, macOS-only)", () => {
    const fsevents = lock.packages["node_modules/fsevents"];
    expect(fsevents).toMatchObject({ dev: true, optional: true, os: ["darwin"] });
  });

  it("fetches every package from the npm registry, with a sha512 integrity hash", () => {
    for (const [name, entry] of Object.entries(lock.packages)) {
      if (name === "") continue;
      expect(entry.link, name).toBeUndefined();
      expect(entry.resolved, name).toMatch(/^https:\/\/registry\.npmjs\.org\//);
      expect(entry.integrity, name).toMatch(/^sha512-/);
    }
  });

  it("matches package.json's runtime dependencies", () => {
    expect(lock.packages[""].dependencies).toEqual(pkg.dependencies);
  });
});

describe("package.json", () => {
  it("runs nothing of its own at install time", () => {
    for (const hook of ["preinstall", "install", "postinstall", "prepare", "prepublish", "preprepare", "postprepare"])
      expect(pkg.scripts?.[hook], hook).toBeUndefined();
  });

  it("has exactly the expected runtime dependencies, so adding one is deliberate", () => {
    expect(Object.keys(pkg.dependencies ?? {}).sort(), "update RUNTIME_DEPENDENCIES here if this is intended").toEqual(
      RUNTIME_DEPENDENCIES,
    );
  });
});
