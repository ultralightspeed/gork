// Which program runs gork's container: Docker or Podman. Finds a working one, says exactly what to fix when none
// works, and turns "compose up" and "pull" into its command line. Every program is started through an
// injectable Probe or Run, so the decisions are testable without Docker or Podman installed.
import { spawnSync } from "node:child_process";
import { CliError } from "./errors.ts";

type EngineName = "docker" | "podman";

/**
 * The program that ends up reading compose.yaml. `docker compose` and docker-compose (also what `podman compose` hands
 * over to when both are installed) behave alike; podman-compose is a different program with a narrower command line.
 */
type ComposeFlavor = "docker-compose" | "podman-compose";

export interface Engine {
  name: EngineName;
  /** For messages. */
  label: "Docker" | "Podman";
  /** Runs everything that isn't compose: pull, image inspect, rmi, login. */
  command: EngineName;
  /** The command and leading arguments that run compose: docker compose, podman compose, or podman-compose. */
  compose: string[];
  flavor: ComposeFlavor;
  version: string;
}

export const DOCKER: Engine = {
  name: "docker",
  label: "Docker",
  command: "docker",
  compose: ["docker", "compose"],
  flavor: "docker-compose",
  version: "",
};

export const DOCKER_DESKTOP_URL = "https://www.docker.com/products/docker-desktop/";
export const PODMAN_DESKTOP_URL = "https://podman-desktop.io/";

/** Neither Docker nor Podman is installed or running; the setup page offers a Retry button for this one. */
export class EngineMissingError extends CliError {}

/** Runs one program for its exit status: `found` is false when it isn't installed at all. */
export type Probe = (command: string, args: string[]) => { found: boolean; ok: boolean; out: string };

export const spawnProbe: Probe = (command, args) => {
  const r = spawnSync(command, args, { encoding: "utf8", timeout: 20_000, windowsHide: true });
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return { found: false, ok: false, out: "" };
  return { found: true, ok: r.status === 0, out: String(r.stdout ?? "") };
};

/** An engine that exists on this computer but can't be used, and what to do about it. */
type Problem = { engine: EngineName; installed: boolean; running: boolean; text: string };

const desktop = (platform: NodeJS.Platform) => platform !== "linux";

const notInstalled = (engine: EngineName): Problem => ({ engine, installed: false, running: false, text: "" });
const broken = (engine: EngineName, text: string, running: boolean): Problem => ({
  engine,
  installed: true,
  running,
  text,
});

function tryDocker(probe: Probe, platform: NodeJS.Platform): Engine | Problem {
  const info = probe("docker", ["info", "--format", "{{.ServerVersion}}"]);
  if (!info.found) return notInstalled("docker");
  if (!info.ok) {
    return broken(
      "docker",
      desktop(platform)
        ? "Docker Desktop isn't running. Start it, wait until it says it is running, then retry."
        : "Docker isn't running, or this user isn't allowed to use it. Start Docker (`sudo systemctl start docker`) or run `docker info` to see why, then retry.",
      false,
    );
  }
  if (!probe("docker", ["compose", "version"]).ok) {
    return broken(
      "docker",
      "Docker is running, but `docker compose` isn't available. Install the Compose plugin (https://docs.docker.com/compose/install/), then retry.",
      true,
    );
  }
  return { ...DOCKER, version: info.out.trim() };
}

function tryPodman(probe: Probe, platform: NodeJS.Platform): Engine | Problem {
  const info = probe("podman", ["info", "--format", "json"]);
  if (!info.found) return notInstalled("podman");
  if (!info.ok) {
    return broken(
      "podman",
      desktop(platform)
        ? "Podman machine isn't running. Run `podman machine start`, then retry."
        : "Podman isn't working: `podman info` failed. Run it yourself to see why, then retry.",
      false,
    );
  }
  let version = "";
  let socket: boolean | undefined;
  try {
    const parsed = JSON.parse(info.out);
    version = String(parsed?.version?.Version ?? "");
    socket = parsed?.host?.remoteSocket?.exists;
  } catch {
    /* an unreadable report says nothing about the socket: carry on */
  }
  const engine = (compose: string[], flavor: ComposeFlavor): Engine => ({
    name: "podman",
    label: "Podman",
    command: "podman",
    compose,
    flavor,
    version,
  });
  let socketOff = false;
  const delegated = probe("podman", ["compose", "version"]);
  if (delegated.ok) {
    const flavor = /podman-compose/i.test(delegated.out) ? "podman-compose" : "docker-compose";
    // docker-compose talks to Podman through its API socket; podman-compose runs podman directly.
    if (flavor === "podman-compose" || socket !== false) return engine(["podman", "compose"], flavor);
    socketOff = true;
  }
  if (probe("podman-compose", ["version"]).ok) return engine(["podman-compose"], "podman-compose");
  return broken(
    "podman",
    socketOff
      ? "Podman is running, but docker-compose can't reach its API socket. Start it with `systemctl --user enable --now podman.socket` (on a Mac or Windows PC run `podman machine start` instead), or install podman-compose, then retry."
      : "Podman is running, but it has no compose tool. Install docker-compose or podman-compose (https://docs.docker.com/compose/install/standalone/ or https://github.com/containers/podman-compose), then retry.",
    true,
  );
}

function explain(problems: Problem[], choice: string, platform: NodeJS.Platform): string {
  const installed = problems.filter((p) => p.installed);
  if (choice) {
    const only = problems[0];
    if (!only.installed) {
      const [label, url] =
        only.engine === "docker" ? ["Docker Desktop", DOCKER_DESKTOP_URL] : ["Podman Desktop", PODMAN_DESKTOP_URL];
      return `CONTAINER_ENGINE=${choice}, but ${only.engine === "docker" ? "Docker" : "Podman"} isn't installed. Install ${label} (${url}), or remove CONTAINER_ENGINE to let gork pick.`;
    }
    return only.text;
  }
  if (installed.length === 0) {
    return `gork runs in a container, and neither Docker nor Podman was found: install Docker Desktop (${DOCKER_DESKTOP_URL}) or Podman Desktop (${PODMAN_DESKTOP_URL}), start it, then retry.`;
  }
  if (installed.length > 1 && installed.every((p) => !p.running)) {
    return desktop(platform)
      ? "Neither Docker nor Podman is running. Start Docker Desktop, or run `podman machine start`, then retry."
      : "Neither Docker nor Podman is running. Start Docker (`sudo systemctl start docker`), or check why `podman info` fails, then retry.";
  }
  return installed.map((p) => p.text).join(" ");
}

/**
 * Finds the engine to use: CONTAINER_ENGINE when set, otherwise Docker if it works, otherwise Podman. "Works" means the
 * engine answers and a compose command for it is installed. Throws EngineMissingError saying what to fix.
 */
export function detectEngine(
  env: Record<string, string | undefined>,
  probe: Probe,
  platform: NodeJS.Platform = process.platform,
): Engine {
  const wanted = (env.CONTAINER_ENGINE ?? "").trim().toLowerCase();
  const choice = wanted === "docker" || wanted === "podman" ? wanted : "";
  const order: EngineName[] = choice ? [choice] : ["docker", "podman"];
  const problems: Problem[] = [];
  for (const name of order) {
    const found = name === "docker" ? tryDocker(probe, platform) : tryPodman(probe, platform);
    if ("compose" in found) return found;
    problems.push(found);
  }
  throw new EngineMissingError(explain(problems, choice, platform));
}

/**
 * detectEngine that remembers what it found, so a command probes once. A failure is not remembered: the setup page's
 * Retry runs it again after Docker has been started.
 */
export function engineResolver(
  probe: Probe,
  platform: NodeJS.Platform = process.platform,
): (env: Record<string, string | undefined>) => Engine {
  let found: Engine | undefined;
  return (env) => {
    found ??= detectEngine(env, probe, platform);
    return found;
  };
}

/** What a compose command runs against: extra compose files (layered over compose.yaml) and extra environment. */
export type ComposeScope = { files?: string[]; env?: Record<string, string> };

/**
 * The program and arguments for a command written in the engine-neutral form the rest of the CLI uses: `["compose", ...]`
 * for compose and anything else for the engine itself (`["pull", ref]`).
 */
export function engineCommand(
  engine: Engine,
  args: string[],
  scope: ComposeScope = {},
): { command: string; args: string[]; env?: Record<string, string> } {
  const extra: Record<string, string> = {};
  let command: string = engine.command;
  let rest = args;
  if (args[0] === "compose") {
    const [program, ...prefix] = engine.compose;
    command = program;
    rest = [...prefix, ...(scope.files ?? []).flatMap((f) => ["-f", f]), ...args.slice(1)];
    // Without this, `podman compose` prints a banner about the external provider on every call.
    if (engine.name === "podman") extra.PODMAN_COMPOSE_WARNING_LOGS = "false";
    Object.assign(extra, scope.env);
  }
  return { command, args: rest, ...(Object.keys(extra).length ? { env: extra } : {}) };
}

/** `compose ps` listing every container as JSON. podman-compose always lists all of them, and rejects --all. */
export function psArgs(engine: Engine): string[] {
  return engine.flavor === "podman-compose"
    ? ["compose", "ps", "--format", "json"]
    : ["compose", "ps", "--all", "--format", "json"];
}

/** Only `docker compose` and docker-compose can print the merged configuration as JSON. */
export const canPrintConfigJson = (engine: Engine): boolean => engine.flavor === "docker-compose";
