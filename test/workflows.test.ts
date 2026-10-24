import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Properties every GitHub Actions workflow must keep. Read as text: the checks are simple enough not to need a YAML
// parser, and a dependency for it would be one more thing to trust.
const dir = join(import.meta.dirname, "..", ".github", "workflows");
const workflows = readdirSync(dir)
  .filter((f) => /\.ya?ml$/.test(f))
  .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }));
const read = (name: string) => workflows.find((w) => w.name === name)?.text ?? "";
/** The `with:` block of each step that uses `action` (the indented lines after it). */
const withBlocks = (text: string, action: string) =>
  [...text.matchAll(new RegExp(`- uses: ${action}@\\S+.*\\n {8}with:\\n((?: {10}.*\\n)+)`, "g"))].map((m) => m[1]);
const indent = (line: string) => line.length - line.trimStart().length;
/** Every step's whole text (from its `- ` line to the next line indented no further), whatever key comes first. */
const steps = (text: string) => {
  const lines = text.split("\n");
  const out: string[] = [];
  lines.forEach((line, i) => {
    if (!/^ {6}- /.test(line)) return;
    let end = i + 1;
    while (end < lines.length && (lines[end].trim() === "" || indent(lines[end]) > indent(line))) end++;
    out.push(lines.slice(i, end).join("\n"));
  });
  return out;
};
const stepsUsing = (text: string, action: string) => steps(text).filter((s) => new RegExp(`uses: ${action}@`).test(s));
const count = (text: string, re: RegExp) => (text.match(re) ?? []).length;
/** The script of every `run:` key: the rest of its line and every line indented further below it. */
const runScripts = (text: string) => {
  const lines = text.split("\n");
  const out: string[] = [];
  lines.forEach((line, i) => {
    const m = /^(\s*)(?:- )?run:(.*)$/.exec(line);
    if (!m) return;
    const own = indent(line) + (line.trimStart().startsWith("- ") ? 2 : 0);
    let end = i + 1;
    while (end < lines.length && (lines[end].trim() === "" || indent(lines[end]) > own)) end++;
    out.push([m[2], ...lines.slice(i + 1, end)].join("\n"));
  });
  return out;
};
/** BuildKit, pinned to a version and its multi-arch index digest. */
const BUILDKIT_PIN = /^ {10}driver-opts: image=moby\/buildkit:v\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/m;

describe("every workflow", () => {
  it("found the workflows", () => {
    expect(workflows.map((w) => w.name)).toEqual(expect.arrayContaining(["ci.yml", "secret-scan.yml"]));
  });

  it.each(workflows)("$name pins each action to a full commit SHA, with the version in a comment", ({ text }) => {
    const uses = [...text.matchAll(/^\s*-?\s*uses: (\S+)(.*)$/gm)];
    for (const [, ref, rest] of uses) {
      if (ref.startsWith("./")) continue;
      expect(ref, ref).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
      expect(rest, ref).toMatch(/^ # v\d+(\.\d+)*$/);
    }
  });

  it.each(workflows)("$name runs on a pinned runner image, never a moving -latest label", ({ text }) => {
    expect(text).not.toMatch(/-latest\b/);
  });

  it.each(workflows)("$name defaults to a read-only token", ({ text }) => {
    expect(text).toMatch(/^permissions:\n {2}contents: read\n(?! )/m);
  });

  it.each(workflows)("$name checks out without keeping the token in the git config", ({ text }) => {
    const blocks = withBlocks(text, "actions/checkout");
    expect(blocks.length).toBe((text.match(/uses: actions\/checkout@/g) ?? []).length);
    for (const block of blocks) expect(block).toMatch(/^ {10}persist-credentials: false$/m);
  });

  it.each(workflows)("$name turns off BuildKit provenance, which embeds the whole GitHub event", ({ text }) => {
    // The event includes the pusher's email. Provenance comes from actions/attest-build-provenance instead.
    expect(text).not.toMatch(/provenance: (mode=|true)/);
    expect(text).not.toMatch(/sbom: true/);
    const builds = stepsUsing(text, "docker/build-push-action");
    expect(builds.length).toBe(count(text, /uses: docker\/build-push-action@/g));
    for (const step of builds) expect(step).toMatch(/^ {10}provenance: false$/m);
  });

  it.each(workflows)("$name keeps build records and summaries off GitHub", ({ text }) => {
    // Both are uploaded by build-push-action by default, and hold the build's inputs and logs.
    const builds = stepsUsing(text, "docker/build-push-action");
    expect(builds.length).toBe(count(text, /uses: docker\/build-push-action@/g));
    for (const step of builds) {
      expect(step).toMatch(/^ {8}env:\n(?: {10}.*\n)*? {10}DOCKER_BUILD_RECORD_UPLOAD: false$/m);
      expect(step).toMatch(/^ {8}env:\n(?: {10}.*\n)*? {10}DOCKER_BUILD_SUMMARY: false$/m);
    }
  });

  it.each(workflows)("$name runs a BuildKit pinned by digest, the same one everywhere", ({ text }) => {
    const buildx = stepsUsing(text, "docker/setup-buildx-action");
    expect(buildx.length).toBe(count(text, /uses: docker\/setup-buildx-action@/g));
    for (const step of buildx) expect(step).toMatch(BUILDKIT_PIN);
    const pins = new Set(workflows.flatMap((w) => w.text.match(new RegExp(BUILDKIT_PIN.source, "gm")) ?? []));
    expect(pins.size).toBeLessThanOrEqual(1);
  });

  it.each(workflows)("$name never runs on pull_request_target", ({ text }) => {
    expect(text).not.toMatch(/pull_request_target/);
  });

  it.each(workflows)("$name passes expressions to scripts through env, never inline", ({ text }) => {
    // ${{ }} is pasted into the script before the shell runs it, so a value could become code.
    const scripts = runScripts(text);
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) expect(script).not.toContain("${{");
  });
});

describe("the helpers above", () => {
  it("find a step's script and env whichever key the step starts with", () => {
    const expr = "$".concat("{{ github.ref }}");
    const text = `jobs:\n  a:\n    steps:\n      - id: x\n        uses: docker/build-push-action@abc # v1\n        env:\n          A: 1\n      - name: y\n        run: |\n          echo ${expr}\n`;
    expect(stepsUsing(text, "docker/build-push-action")).toHaveLength(1);
    expect(runScripts(text)).toEqual([` |\n          echo ${expr}\n`]);
  });
});

describe("CI and the image check", () => {
  it("run on pushes to main only: a pull request is checked by its pull_request run, and a release tag by image.yml", () => {
    for (const name of ["ci.yml", "image-check.yml"])
      expect(read(name), name).toMatch(/^ {2}push:\n {4}branches: \[main\]\n/m);
  });
});

describe("the secret scan", () => {
  const scan = read("secret-scan.yml");

  it("runs on every push and pull request, and is never cancelled by a newer run", () => {
    expect(scan).toMatch(/^on:\n {2}push:\n {2}pull_request:\n/m);
    expect(scan).not.toMatch(/concurrency:|cancel-in-progress/);
  });

  it("scans the whole history, not just the pushed range", () => {
    expect(withBlocks(scan, "actions/checkout")[0]).toMatch(/^ {10}fetch-depth: 0\b/m);
    expect(scan).toMatch(/gitleaks" git --redact /);
    expect(scan).not.toMatch(/--log-opts|uses: gitleaks\/gitleaks-action/);
  });

  it("checks the gitleaks download against a recorded SHA-256 before unpacking it", () => {
    expect(scan).toMatch(/GITLEAKS_SHA256: [0-9a-f]{64}\n/);
    expect(scan).toMatch(
      /echo "\$GITLEAKS_SHA256 {2}gitleaks\.tar\.gz" \| sha256sum -c -\n\s+tar -xzf gitleaks\.tar\.gz/,
    );
  });

  it("is not part of CI, whose runs a newer push cancels", () => {
    expect(read("ci.yml")).not.toMatch(/gitleaks/);
  });
});

describe("the release image", () => {
  const image = read("image.yml");

  it("is attested by GitHub, with the attestation permissions only in the jobs that attest", () => {
    const attests = image.match(/uses: actions\/attest-build-provenance@/g) ?? [];
    expect(attests.length).toBe(2); // each architecture's image, and the multi-arch manifest list
    expect(image.match(/^ {6}id-token: write\b/gm)?.length).toBe(2);
    expect(image.match(/^ {6}attestations: write\b/gm)?.length).toBe(2);
    expect(image).not.toMatch(/^ {2}(id-token|attestations): write/m);
  });

  it("documents a verify command that checks the signing workflow and the release tag", () => {
    expect(image).toContain(
      "gh attestation verify oci://ghcr.io/ultralightspeed/gork:<version> --repo ultralightspeed/gork --signer-workflow ultralightspeed/gork/.github/workflows/image.yml --source-ref refs/tags/v<version>",
    );
  });

  it("refuses a release tag that doesn't match package.json's version (npm run up pulls that version)", () => {
    const check = image.slice(image.indexOf("  check:"), image.indexOf("  build:"));
    expect(check).toContain(`run: test "v$(node -p "require('./package.json').version")" = "$TAG"`);
    expect(check).toMatch(/TAG: \$\{\{ github\.ref_name \}\}/);
  });

  it("publishes from version tags only", () => {
    expect(image).toMatch(/^on:\n {2}push:\n {4}tags: \["v\*"\]\n\n/m);
    expect(image).not.toMatch(/workflow_dispatch|pull_request|schedule/);
    // Each job that can push or attest checks the ref itself too.
    const jobs = image.split(/^ {2}(?=[\w-]+:\n)/m).filter((j) => /packages: write/.test(j));
    expect(jobs.length).toBe(2);
    for (const job of jobs) expect(job).toMatch(/^ {4}if: startsWith\(github\.ref, 'refs\/tags\/v'\)$/m);
  });

  it("builds the release without restoring a cache other runs could have written", () => {
    expect(image).not.toMatch(/cache-from/);
  });

  it("attests the manifest list digest the create step reported, without reading a tag back", () => {
    const create = steps(image).find((s) => /imagetools create/.test(s)) ?? "";
    expect(create).toMatch(/^ {8}id: create$/m);
    expect(create).toMatch(/--metadata-file /);
    expect(image).not.toMatch(/imagetools inspect/);
    const attest = stepsUsing(image, "actions/attest-build-provenance").at(-1) ?? "";
    expect(attest).toMatch(/subject-digest: \$\{\{ steps\.create\.outputs\.digest \}\}/);
  });
});

describe("the paid private copy", () => {
  // The private history repository runs the same workflow files; Actions minutes are free only on the public one.
  it.each(["ci.yml", "secret-scan.yml", "image-check.yml", "dependabot-auto-merge.yml"])(
    "%s runs none of its jobs in a private repository",
    (name) => {
      const text = read(name);
      const jobs = count(text, /^ {2}[\w-]+:\n {4}name:/gm);
      expect(jobs).toBeGreaterThan(0);
      expect(count(text, /^ {4}if: \$\{\{ !github\.event\.repository\.private( && .*)? \}\}$/gm)).toBe(jobs);
    },
  );
});

describe("installing dependencies in CI", () => {
  it.each(["ci.yml", "image.yml"])(
    "%s installs without running packages' install scripts, then checks registry signatures",
    (name) => {
      const text = read(name);
      expect(text).not.toMatch(/npm ci(?! --ignore-scripts)/);
      expect(text).toMatch(/- run: npm ci --ignore-scripts --no-fund --no-audit\n {6}- run: npm audit signatures\n/);
    },
  );
});

describe("Dependabot", () => {
  const config = readFileSync(join(import.meta.dirname, "..", ".github", "dependabot.yml"), "utf8");
  const ecosystems = config.split(/\n(?= {2}- package-ecosystem:)/).slice(1);

  it("waits a few days after a release before proposing it, longer for a major one, for every ecosystem", () => {
    expect(ecosystems.map((e) => /package-ecosystem: (\S+)/.exec(e)?.[1])).toEqual(["npm", "github-actions", "docker"]);
    for (const e of ecosystems) expect(e).toMatch(/ {4}cooldown:\n {6}default-days: 3\n/);
    // Dependabot accepts semver-major-days only for ecosystems with semantic versions: npm here, not Actions or Docker.
    expect(ecosystems[0]).toMatch(/ {6}semver-major-days: 7\n/);
    for (const e of ecosystems.slice(1)) expect(e).not.toMatch(/semver-(major|minor|patch)-days/);
  });

  it("keeps @types/node on the runtime's major version (Node 24, as .nvmrc says), like the base image", () => {
    expect(ecosystems[0]).toMatch(
      / {6}- dependency-name: "@types\/node"\n {8}update-types: \["version-update:semver-major"\]\n/,
    );
  });

  it("skips Biome 2.6.0 and 2.6.1, whose platform binaries were never published, so npm can't install them", () => {
    expect(ecosystems[0]).toMatch(
      / {6}- dependency-name: "@biomejs\/biome"\n {8}versions: \[">= 2\.6\.0, < 2\.6\.2"\](\n|$)/,
    );
  });
});

describe("Dependabot auto-merge", () => {
  const text = read("dependabot-auto-merge.yml");

  it("acts only on pull requests Dependabot opened", () => {
    expect(text).toMatch(/^on:\n {2}pull_request:\n(?! )/m);
    expect(text).toContain("github.event.pull_request.user.login == 'dependabot[bot]'");
  });

  it("asks GitHub to merge only after the required checks pass, never merging directly", () => {
    const scripts = runScripts(text).join("\n");
    expect(scripts).toMatch(/gh pr merge --auto --squash "\$PR_URL"/);
    expect(scripts).not.toMatch(/gh pr merge(?! --auto)/);
  });

  it("leaves major updates, base-image updates and a change of maintainers for a person", () => {
    const merge = steps(text).find((s) => s.includes("gh pr merge")) ?? "";
    const gate = /^ {8}if: (.+)$/m.exec(merge)?.[1] ?? "";
    expect(gate).toContain("steps.meta.outputs.update-type != 'version-update:semver-major'");
    expect(gate).toContain("steps.meta.outputs.maintainer-changes != 'true'");
    expect(gate).toMatch(
      /package-ecosystem == 'npm_and_yarn' \|\| steps\.meta\.outputs\.package-ecosystem == 'github_actions'/,
    );
    expect(gate).not.toContain("docker");
  });
});
