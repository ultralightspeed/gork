import { describe, expect, it } from "vitest";
import {
  DOCKER,
  detectEngine,
  type Engine,
  EngineMissingError,
  engineCommand,
  engineResolver,
  type Probe,
  spawnProbe,
} from "../scripts/lib/engine.ts";
import { CliError } from "../scripts/lib/errors.ts";

type Answer = string | false | undefined;
/** What one program answers: a string is success with that output; false or nothing is a failure. */
type Host = {
  docker?: { info?: Answer; compose?: Answer };
  podman?: { info?: Answer; compose?: Answer };
  podmanCompose?: Answer;
};

const PODMAN_INFO = (socket: boolean) =>
  JSON.stringify({ version: { Version: "5.2.1" }, host: { remoteSocket: { exists: socket, path: "/run/x.sock" } } });
const DOCKER_COMPOSE_VERSION = "Docker Compose version v2.29.1";
const PODMAN_COMPOSE_VERSION = "podman-compose version 1.3.0\npodman version 5.2.1";

/** A computer with the given programs installed, and the calls the detection made to them. */
function computer(h: Host) {
  const calls: string[] = [];
  const answer = (a: Answer) => ({ found: true, ok: typeof a === "string", out: typeof a === "string" ? a : "" });
  const probe: Probe = (command, args) => {
    calls.push([command, ...args].join(" "));
    if (command === "docker" && h.docker) return answer(args[0] === "info" ? h.docker.info : h.docker.compose);
    if (command === "podman" && h.podman) return answer(args[0] === "info" ? h.podman.info : h.podman.compose);
    if (command === "podman-compose" && h.podmanCompose !== undefined) return answer(h.podmanCompose);
    return { found: false, ok: false, out: "" };
  };
  return { probe, calls };
}

const detect = (h: Host, env: Record<string, string> = {}, platform: NodeJS.Platform = "win32") =>
  detectEngine(env, computer(h).probe, platform);
const failure = (h: Host, env: Record<string, string> = {}, platform: NodeJS.Platform = "win32"): string => {
  try {
    detectEngine(env, computer(h).probe, platform);
  } catch (err) {
    expect(err).toBeInstanceOf(EngineMissingError);
    expect(err).toBeInstanceOf(CliError);
    return (err as Error).message;
  }
  throw new Error("expected the detection to fail");
};

describe("detectEngine", () => {
  it("prefers a working Docker, and never looks at Podman when Docker is fine", () => {
    const c = computer({
      docker: { info: "27.3.1", compose: DOCKER_COMPOSE_VERSION },
      podman: { info: PODMAN_INFO(true), compose: PODMAN_COMPOSE_VERSION },
    });
    const e = detectEngine({}, c.probe, "linux");
    expect(e).toMatchObject({ name: "docker", label: "Docker", compose: ["docker", "compose"], version: "27.3.1" });
    expect(c.calls.every((call) => call.startsWith("docker "))).toBe(true);
  });

  it("uses Podman when Docker isn't installed, or is installed but not running", () => {
    const podman = { info: PODMAN_INFO(true), compose: DOCKER_COMPOSE_VERSION };
    for (const docker of [undefined, { info: false as const, compose: DOCKER_COMPOSE_VERSION }]) {
      expect(detect({ docker, podman })).toMatchObject({
        name: "podman",
        label: "Podman",
        command: "podman",
        compose: ["podman", "compose"],
        flavor: "docker-compose",
        version: "5.2.1",
      });
    }
  });

  it.each<[string, Host, string[], string]>([
    [
      // podman-compose talks to Podman directly, so the missing API socket doesn't matter to it
      "tells which program `podman compose` hands over to, from its own version text",
      { podman: { info: PODMAN_INFO(false), compose: PODMAN_COMPOSE_VERSION } },
      ["podman", "compose"],
      "podman-compose",
    ],
    [
      "falls back to a standalone podman-compose when `podman compose` has no provider",
      { podman: { info: PODMAN_INFO(true), compose: false }, podmanCompose: PODMAN_COMPOSE_VERSION },
      ["podman-compose"],
      "podman-compose",
    ],
    [
      "falls back to podman-compose when docker-compose can't reach Podman's API socket",
      {
        podman: { info: PODMAN_INFO(false), compose: DOCKER_COMPOSE_VERSION },
        podmanCompose: PODMAN_COMPOSE_VERSION,
      },
      ["podman-compose"],
      "podman-compose",
    ],
  ])("%s", (_what, host, compose, flavor) => {
    expect(detect(host)).toMatchObject({ name: "podman", compose, flavor });
  });

  it("CONTAINER_ENGINE picks one engine and never tries the other", () => {
    const both = {
      docker: { info: "27", compose: DOCKER_COMPOSE_VERSION },
      podman: { info: PODMAN_INFO(true), compose: DOCKER_COMPOSE_VERSION },
    };
    expect(detect(both, { CONTAINER_ENGINE: "podman" }).name).toBe("podman");
    expect(detect(both, { CONTAINER_ENGINE: " Docker " }).name).toBe("docker");
    const stopped = { ...both, docker: { info: false as const, compose: DOCKER_COMPOSE_VERSION } };
    expect(failure(stopped, { CONTAINER_ENGINE: "docker" })).toMatch(/Docker Desktop isn't running/);
    const c = computer(stopped);
    expect(() => detectEngine({ CONTAINER_ENGINE: "docker" }, c.probe, "win32")).toThrow();
    expect(c.calls.every((call) => call.startsWith("docker "))).toBe(true);
  });
});

describe("what detection says when it can't find a working engine", () => {
  const stopped = { info: false as const };
  const podmanNoCompose = { info: PODMAN_INFO(true), compose: false as const };

  // Each row is a different way an engine can be unusable, with what the message must point the person to.
  const cases: Array<[string, Host, Record<string, string>, NodeJS.Platform, RegExp[]]> = [
    [
      "neither installed: both desktop apps, with links",
      {},
      {},
      "win32",
      [
        /Docker Desktop \(https:\/\/www\.docker\.com\/products\/docker-desktop\/\)/,
        /Podman Desktop \(https:\/\/podman-desktop\.io\/\)/,
      ],
    ],
    ["only Docker, stopped, on a desktop", { docker: stopped }, {}, "win32", [/Docker Desktop isn't running/]],
    ["only Podman, stopped, on a desktop", { podman: stopped }, {}, "darwin", [/podman machine start/]],
    ["only Docker, stopped, on Linux", { docker: stopped }, {}, "linux", [/systemctl start docker/]],
    ["only Podman, stopped, on Linux", { podman: stopped }, {}, "linux", [/`podman info`/]],
    [
      "both installed and stopped",
      { docker: stopped, podman: stopped },
      {},
      "win32",
      [/Neither Docker nor Podman is running/, /Docker Desktop/, /podman machine start/],
    ],
    [
      "Podman named with CONTAINER_ENGINE but not installed",
      { docker: { info: "27", compose: "x" } },
      { CONTAINER_ENGINE: "podman" },
      "win32",
      [/CONTAINER_ENGINE=podman.*isn't installed.*podman-desktop\.io.*remove CONTAINER_ENGINE/],
    ],
    [
      "Docker named with CONTAINER_ENGINE but not installed",
      {},
      { CONTAINER_ENGINE: "docker" },
      "win32",
      [/CONTAINER_ENGINE=docker.*isn't installed.*docker-desktop/],
    ],
    [
      "Docker running without the Compose plugin",
      { docker: { info: "27", compose: false } },
      {},
      "win32",
      [/`docker compose` isn't available.*docs\.docker\.com\/compose\/install/],
    ],
    [
      "Podman with no compose tool",
      { podman: podmanNoCompose },
      {},
      "win32",
      [/no compose tool.*docker-compose or podman-compose/],
    ],
    [
      "docker-compose can't reach Podman's API socket",
      { podman: { info: PODMAN_INFO(false), compose: DOCKER_COMPOSE_VERSION } },
      {},
      "linux",
      [/systemctl --user enable --now podman\.socket/],
    ],
    [
      "every installed engine is reported, not just the first",
      { docker: stopped, podman: podmanNoCompose },
      {},
      "win32",
      [/Docker Desktop isn't running/, /no compose tool/],
    ],
  ];

  it("names what is wrong, and what to do about it, for each way an engine can be unusable", () => {
    for (const [label, host, env, platform, patterns] of cases) {
      const message = failure(host, env, platform);
      for (const pattern of patterns) expect(message, label).toMatch(pattern);
    }
  });
});

describe("engineResolver", () => {
  it("remembers the engine it found, and doesn't probe again", () => {
    const c = computer({ docker: { info: "27", compose: DOCKER_COMPOSE_VERSION } });
    const resolve = engineResolver(c.probe, "linux");
    const first = resolve({});
    const n = c.calls.length;
    expect(resolve({})).toBe(first);
    expect(c.calls).toHaveLength(n);
  });

  it("tries again after a failure, so a Retry works once Docker has been started", () => {
    let docker = false;
    const probe: Probe = (command, args) =>
      command === "docker"
        ? { found: true, ok: docker, out: docker && args[0] === "compose" ? DOCKER_COMPOSE_VERSION : "27" }
        : { found: false, ok: false, out: "" };
    const resolve = engineResolver(probe, "win32");
    expect(() => resolve({})).toThrow(EngineMissingError);
    docker = true;
    expect(resolve({}).name).toBe("docker");
  });
});

describe("engineCommand", () => {
  const podman: Engine = {
    name: "podman",
    label: "Podman",
    command: "podman",
    compose: ["podman", "compose"],
    flavor: "docker-compose",
    version: "5",
  };
  const standalone: Engine = { ...podman, compose: ["podman-compose"], flavor: "podman-compose" };

  it("sends compose commands to the compose command, and everything else to the engine itself", () => {
    expect(engineCommand(DOCKER, ["compose", "up", "-d"])).toEqual({
      command: "docker",
      args: ["compose", "up", "-d"],
    });
    expect(engineCommand(DOCKER, ["pull", "ghcr.io/x/y:1"])).toEqual({
      command: "docker",
      args: ["pull", "ghcr.io/x/y:1"],
    });
    expect(engineCommand(standalone, ["compose", "logs", "gork"])).toEqual({
      command: "podman-compose",
      args: ["logs", "gork"],
      env: { PODMAN_COMPOSE_WARNING_LOGS: "false" },
    });
    expect(engineCommand(standalone, ["pull", "x"])).toEqual({ command: "podman", args: ["pull", "x"] });
  });

  it("puts the compose files right after the compose command, and adds the extra environment", () => {
    const c = engineCommand(podman, ["compose", "up", "-d"], {
      files: ["compose.yaml", "compose.image.yaml"],
      env: { GORK_IMAGE_REF: "ghcr.io/x/y:1" },
    });
    expect(c.args).toEqual(["compose", "-f", "compose.yaml", "-f", "compose.image.yaml", "up", "-d"]);
    expect(c.env).toEqual({ PODMAN_COMPOSE_WARNING_LOGS: "false", GORK_IMAGE_REF: "ghcr.io/x/y:1" });
    expect(engineCommand(DOCKER, ["pull", "x"], { files: ["a.yaml"] }).args).toEqual(["pull", "x"]);
  });
});

describe("spawnProbe", () => {
  it("tells a program that isn't installed from one that failed, and returns what it printed", () => {
    expect(spawnProbe("gork-no-such-program", ["x"])).toEqual({ found: false, ok: false, out: "" });
    expect(spawnProbe(process.execPath, ["-e", "process.exit(3)"])).toMatchObject({ found: true, ok: false });
    expect(spawnProbe(process.execPath, ["-e", "console.log('hello')"])).toEqual({
      found: true,
      ok: true,
      out: "hello\n",
    });
  });

  it("passes arguments to the program as they are: no shell reads them", () => {
    const hostile = `a & echo pwned; $(echo pwned) | "q"`;
    const r = spawnProbe(process.execPath, ["-e", "console.log(process.argv[1])", hostile]);
    expect(r.out).toBe(`${hostile}\n`);
  });
});
