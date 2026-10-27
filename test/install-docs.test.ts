import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// What the install and update docs tell people to run. A release is a fixed, checked version (its image is built and
// attested by .github/workflows/image.yml), so new installs and updates take a release, never the main branch.
const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const version: string = JSON.parse(read("package.json")).version;

describe("the install docs", () => {
  it("clone the release package.json names, so each release has to update them", () => {
    for (const file of ["README.md", "AGENTS.md"]) {
      const clones = read(file).match(/git clone [^\n`]*/g) ?? [];
      expect(clones.length, file).toBeGreaterThan(0);
      for (const clone of clones)
        expect(clone, file).toBe(`git clone --branch v${version} https://github.com/ultralightspeed/gork.git`);
    }
  });

  it("send the ZIP download to the latest release, not to the main branch", () => {
    const readme = read("README.md");
    expect(readme).toContain("https://github.com/ultralightspeed/gork/releases/latest");
    expect(readme).not.toMatch(/Download ZIP|gork-main/);
  });

  it("say to paste tokens only into the local setup page", () => {
    expect(read("README.md")).toContain("Paste tokens only into this page");
  });

  it("update to a release too, by its tag", () => {
    const updating = read("docs/setup.md").split("## Updating gork")[1]?.split("\n## ")[0] ?? "";
    expect(updating).toContain("git fetch --tags");
    expect(updating).toMatch(/git checkout v<new version>/);
    expect(updating).not.toContain("git pull");
  });
});

describe("checking the image", () => {
  const verify = (text: string) => text.match(/gh attestation verify [^\n`]*/g) ?? [];

  it("is documented with a pinned digest and the same signer the release workflow names", () => {
    const setup = read("docs/setup.md");
    expect(setup).toContain("### Checking the image");
    expect(setup).toContain("GORK_IMAGE=ghcr.io/ultralightspeed/gork@sha256:");
    for (const file of ["docs/setup.md", "docs/audit.md"]) {
      const commands = verify(read(file));
      expect(commands.length, file).toBeGreaterThan(0);
      for (const c of commands) {
        expect(c, file).toContain("oci://ghcr.io/ultralightspeed/gork@sha256:<");
        expect(c, file).toContain("--repo ultralightspeed/gork");
        expect(c, file).toContain("--signer-workflow ultralightspeed/gork/.github/workflows/image.yml");
        expect(c, file).toContain("--source-ref refs/tags/v<version>");
      }
    }
  });
});
