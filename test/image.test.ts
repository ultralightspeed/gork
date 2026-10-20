import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { chooseImage, IMAGE_FILE, IMAGE_REPO, packageVersion } from "../scripts/lib/image.ts";

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

describe("chooseImage", () => {
  it("downloads the release for this version by default, builds for GORK_IMAGE=build or --build (which beats a named image), and runs a named image as the custom choice it is", () => {
    const named = "ghcr.io/me/gork:dev";
    const build = { mode: "build" };
    const cases: [string, ReturnType<typeof chooseImage>][] = [
      ["default", chooseImage("", false, "1.2.3")],
      ["GORK_IMAGE=build", chooseImage("build", false, "1.2.3")],
      ["--build", chooseImage("", true, "1.2.3")],
      ["--build beats a named image", chooseImage(named, true, "1.2.3")],
      ["a named image", chooseImage(named, false, "1.2.3")],
    ];
    expect(Object.fromEntries(cases)).toEqual({
      default: { mode: "pull", ref: `${IMAGE_REPO}:1.2.3`, custom: false },
      "GORK_IMAGE=build": build,
      "--build": build,
      "--build beats a named image": build,
      "a named image": { mode: "pull", ref: named, custom: true },
    });
  });

  it("uses this checkout's own version, so the image matches the settings and compose.yaml next to it", () => {
    expect(packageVersion()).toBe(JSON.parse(read("package.json")).version);
  });
});

describe("where the released image lives", () => {
  it("is a fully qualified, lowercase GHCR name (Podman has no default registry, and GHCR refuses capitals)", () => {
    expect(IMAGE_REPO).toMatch(/^ghcr\.io\/[a-z0-9._-]+\/[a-z0-9._-]+$/);
  });

  it("is what the release workflow publishes, under the version tag chooseImage pulls and under latest", () => {
    const workflow = read(".github/workflows/image.yml");
    expect(workflow).toMatch(/^ {2}IMAGE: ghcr\.io\/\$\{\{ github\.repository_owner \}\}\/gork$/m);
    expect(workflow).toContain("type=semver,pattern={{version}}");
    // `latest` is added for stable semver tags by the action's default (latest=auto); it must not be switched off.
    expect(workflow).not.toMatch(/latest=false/);
    expect(workflow).toMatch(/tags: \["v\*"\]/);
  });
});

describe("compose.image.yaml", () => {
  it("only names the image, from a variable that is not the GORK_IMAGE setting, with no default tag that could disagree with chooseImage", () => {
    const lines = read(IMAGE_FILE)
      .split("\n")
      .filter((l) => l.trim() && !l.trim().startsWith("#"));
    expect(lines).toHaveLength(3);
    expect(lines.slice(0, 2)).toEqual(["services:", "  gork:"]);
    expect(lines[2]).toMatch(/^ {4}image: \$\{GORK_IMAGE_REF:\?/);
    expect(lines[2]).not.toMatch(/:latest|\$\{GORK_IMAGE[:}]/);
  });

  it("leaves compose.yaml without an image name, so a local build is named for its own folder and never collides", () => {
    const base = read("compose.yaml");
    expect(base).not.toMatch(/^\s*image:/m);
    expect(base).toMatch(/^ {4}build: \.$/m);
  });
});
