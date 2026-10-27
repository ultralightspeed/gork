import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Properties the image must keep whatever its build steps look like. The build itself proves the rest: the ffmpeg
// stage runs docker/check-ffmpeg.sh, which fails the build if the binary lacks a codec or accepts a bad certificate.
const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const dockerfile = read("Dockerfile");
const compose = read("compose.yaml");
/** The Dockerfile with `\` line continuations joined, so a RUN reads as one line. */
const flat = dockerfile.replace(/\\\n\s*/g, " ");
const stages = dockerfile.split(/^(?=FROM )/m).filter((s) => s.startsWith("FROM "));
const finalStage = stages.at(-1) ?? "";
const ignore = read(".dockerignore")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"));

describe("the image's supply chain", () => {
  it("pins every external base image by digest; only scratch and earlier stages go without", () => {
    expect(stages.length).toBeGreaterThan(1);
    const declared = new Set<string>();
    for (const stage of stages) {
      const m = stage.split("\n")[0].match(/^FROM (\S+)(?: AS (\S+))?$/);
      expect(m, stage.split("\n")[0]).not.toBeNull();
      const [, image, alias] = m ?? [];
      if (image !== "scratch" && !declared.has(image)) expect(image, `FROM ${image}`).toMatch(/@sha256:[0-9a-f]{64}$/);
      if (alias) declared.add(alias);
    }
  });

  it("uses the builder's own Dockerfile frontend, or one pinned by digest", () => {
    // A `# syntax=` line makes BuildKit download that frontend image and run it on this Dockerfile.
    for (const [line] of dockerfile.matchAll(/^#\s*syntax\s*=.*$/gim)) {
      expect(line).toMatch(/@sha256:[0-9a-f]{64}$/);
    }
  });

  it("checks every downloaded source archive against a recorded SHA-256 before unpacking it", () => {
    const downloads = flat.match(/\bcurl -/g) ?? [];
    expect(downloads.length).toBeGreaterThanOrEqual(4); // ffmpeg, openssl, lame, dav1d
    expect(flat).not.toMatch(/\|\s*(tar|sh|bash)\b/); // nothing goes from the network straight into tar or an interpreter
    for (const m of flat.matchAll(/ARG ([A-Z0-9]+)_SHA256=(\S*)/g)) expect(m[2], m[1]).toMatch(/^[0-9a-f]{64}$/);
    // Each download reads: curl ... -o FILE URL; echo "$X_SHA256  FILE" | sha256sum -c -; tar -x... FILE
    const verified = [
      ...flat.matchAll(/curl -[^;]*?-o (\S+) [^;]*;\s+echo "\$\w+_SHA256 {2}\1" \| sha256sum -c -;\s+tar -x\w* \1\b/g),
    ];
    expect(verified.length).toBe(downloads.length);
  });

  it("retries a download on any error, a reset connection included (the checksum still guards what arrives)", () => {
    // Plain --retry skips connection resets, and one mirror hiccup failed a whole image build.
    const downloads = flat.match(/\bcurl -[^;]*/g) ?? [];
    expect(downloads.length).toBeGreaterThanOrEqual(4);
    for (const d of downloads) expect(d).toMatch(/--retry \d+ --retry-all-errors\b/);
  });

  it("builds an LGPL ffmpeg: no GPL or nonfree switches", () => {
    expect(flat).not.toMatch(/--enable-(gpl|nonfree)/);
  });
});

describe("the final image", () => {
  it("runs as the non-root user the data volume belongs to, and leaves no secret in the image", () => {
    expect(finalStage).toMatch(/^USER 1000:1000$/m);
    expect(dockerfile).not.toMatch(/^\s*(ENV|ARG)\s+\w*(TOKEN|SECRET|PASSWORD|API_KEY|CF_ADMIN)\w*/im);
  });

  it("reports health by running node on the heartbeat check (the image has no shell or curl)", () => {
    const line = finalStage.match(/^HEALTHCHECK .*$/m)?.[0] ?? "";
    expect(line).toMatch(/--interval=\d+s/);
    expect(line).toMatch(/--start-period=\d+s/); // login takes a while; failures then don't count
    expect(line).toMatch(/CMD \["node", "src\/healthcheck\.ts"\]$/);
    expect(finalStage).not.toMatch(/CMD-SHELL|\/bin\/sh|curl|wget/);
  });

  it("gets ffmpeg only from the stage that proved it, and keeps the build tools out", () => {
    expect(finalStage + dockerfile).toMatch(/COPY --from=ffmpeg \S*ffmpeg /);
    expect(dockerfile).not.toMatch(/--from=ffmpeg-build/);
    expect(dockerfile).toMatch(/FROM ffmpeg-build AS ffmpeg\n(?:COPY[^\n]*\n)*RUN \S*check-ffmpeg\.sh /);
    expect(finalStage).not.toMatch(/apt-get|apk add|npm (ci|install)|curl/);
  });
});

describe("the build context", () => {
  it("leaves every .env file out, in any folder", () => {
    for (const rule of [".env", ".env.*", "**/.env", "**/.env.*"]) expect(ignore).toContain(rule);
    expect(ignore.some((l) => /^!.*\.env/.test(l))).toBe(false);
  });

  it("leaves out agent folders, temp files and every asset but the avatar", () => {
    for (const rule of [".claude", ".superpowers", "**/*.tmp", "assets/*", "!assets/gork.png"])
      expect(ignore).toContain(rule);
  });
});

describe("the hand-built libraries", () => {
  it("are labelled in the final image with the versions the build uses", () => {
    const label = finalStage.match(/^LABEL .*$/m)?.[0] ?? "";
    for (const [arg, key] of [
      ["FFMPEG_VERSION", "ffmpeg"],
      ["OPENSSL_VERSION", "openssl"],
      ["LAME_VERSION", "lame"],
      ["DAV1D_VERSION", "dav1d"],
    ]) {
      const version = dockerfile.match(new RegExp(`^ARG ${arg}=([^\\s]+)$`, "m"))?.[1];
      expect(version).toBeTruthy();
      expect(label).toContain(`org.gork.${key}="${version}"`);
    }
  });
});

describe("the personas in the image", () => {
  // Listed by hand, not read from the folder: a private persona file someone keeps there must never be baked in.
  const SHIPPED = ["default", "hype", "noir", "professor", "witty", "custom.example"];

  it("are the shipped presets only: .dockerignore leaves out the folder and lets each one back in", () => {
    expect(ignore).toContain("personas/*");
    const allowed = ignore.filter((l) => l.startsWith("!personas/"));
    expect(allowed.sort()).toEqual(SHIPPED.map((n) => `!personas/${n}.md`).sort());
    // Nothing after the folder rule widens it again (a later rule wins in .dockerignore).
    const later = ignore.slice(ignore.indexOf("personas/*") + 1);
    expect(later.every((l) => !l.startsWith("!personas") || allowed.includes(l))).toBe(true);
    expect(ignore.some((l) => /^!.*\*/.test(l))).toBe(false);
  });

  it("all exist, so none is silently missing from the image", () => {
    for (const name of SHIPPED) expect(existsSync(new URL(`../personas/${name}.md`, import.meta.url)), name).toBe(true);
  });

  it("are copied as the folder .dockerignore filters, not file by file around it", () => {
    expect(finalStage).toMatch(/^COPY personas \.\/personas$/m);
    expect((dockerfile.match(/^COPY .*personas/gm) ?? []).length).toBe(1);
  });

  it("are replaced at run time by the mounted folder, so your own personas/custom.md still works", () => {
    expect(compose).toMatch(/^ {6}- \.\/personas:\/app\/personas:ro$/m);
  });
});

describe("compose.yaml", () => {
  it("keeps the read-only, capability-free design with ceilings on memory, CPU and processes", () => {
    expect(compose).toMatch(/read_only: true/);
    expect(compose).toMatch(/cap_drop: \[ALL\]/);
    expect(compose).toMatch(/no-new-privileges:true/);
    expect(compose).toContain('tmpfs: ["/tmp:size=16m,mode=1777"]');
    expect(compose).toContain('user: "1000:1000"'); // even an image named in GORK_IMAGE runs as the data volume's user
    expect(compose).toMatch(/^\s+memswap_limit: \d+m$/m);
    expect(compose).toMatch(/^\s+mem_limit: \d+m$/m);
    expect(compose).toMatch(/^\s+cpus: "?\d+(\.\d+)?"?$/m);
    expect(compose).toMatch(/^\s+pids_limit: \d+$/m);
  });

  it("labels the container with the persona file's hash, so a changed persona recreates it", () => {
    // npm run up sets GORK_PERSONA_SHA; other commands leave it empty without a warning.
    expect(compose).toMatch(/^ {4}labels:\n {6}gork\.persona-sha: \$\{GORK_PERSONA_SHA:-\}$/m);
  });
});

describe("the health check", () => {
  // Podman builds OCI images by default, and an OCI image has no HEALTHCHECK. So compose.yaml repeats the Dockerfile's
  // check and the container is checked whichever engine built (or downloaded) the image.
  const fromDockerfile = flat.match(/^HEALTHCHECK (.*) CMD (\[.*\])$/m);
  const block = compose.match(/^ {4}healthcheck:\n((?: {6}.*\n)+)/m)?.[1] ?? "";
  const value = (key: string) => block.match(new RegExp(`^ {6}${key}: (.*)$`, "m"))?.[1];

  it("is declared in compose.yaml too, the same as in the Dockerfile", () => {
    expect(fromDockerfile, "the Dockerfile's HEALTHCHECK").not.toBeNull();
    const opts = Object.fromEntries(
      [...(fromDockerfile?.[1] ?? "").matchAll(/--([\w-]+)=(\S+)/g)].map((m) => [m[1], m[2]]),
    );
    expect(value("test")).toBe(fromDockerfile?.[2].replace(/^\[/, '["CMD", '));
    expect(value("interval")).toBe(opts.interval);
    expect(value("timeout")).toBe(opts.timeout);
    expect(value("start_period")).toBe(opts["start-period"]);
    expect(value("retries")).toBe(opts.retries);
  });
});
