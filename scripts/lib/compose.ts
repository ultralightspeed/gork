// Compose side of the CLI, for Docker or Podman. Every engine call goes through a Run, so the decision logic is
// testable with a fake.
import { spawn, spawnSync } from "node:child_process";
import { type ComposeScope, canPrintConfigJson, DOCKER, type Engine, engineCommand, psArgs } from "./engine.ts";
import { CliError } from "./errors.ts";

/** The service in compose.yaml. The CLI only addresses the container through it (Compose labels), never by name. */
export const SERVICE = "gork";
/** Where the bot keeps its ledger inside the container (the Dockerfile sets DATA_DIR=/data). */
export const LEDGER_PATH = "/data/ledger.json";
/** Settings that route traffic; Node's --env-file and Compose must read them identically. */
const ROUTING_KEYS = ["GUILD_IDS", "AI_GATEWAY_ID", "CF_ACCOUNT_ID"];

/**
 * Runs an engine command. Arguments are engine-neutral: `["compose", ...]` is compose (docker compose, podman compose or
 * podman-compose, whichever the engine uses) and anything else, such as `["pull", ref]`, goes to the engine itself.
 * With `show`, output goes straight to the terminal and `out` is empty. `files` are compose files layered over
 * compose.yaml; `env` is extra environment for compose.
 */
export type RunOpts = ComposeScope & { show?: boolean };
export type Run = (args: string[], opts?: RunOpts) => { ok: boolean; out: string };

/** Starts one program and waits for it. */
export type Exec = (
  command: string,
  args: string[],
  opts: { show: boolean; env?: Record<string, string> },
) => { ok: boolean; out: string };

export const spawnExec: Exec = (command, args, { show, env }) => {
  const r = spawnSync(command, args, {
    ...(show ? { stdio: "inherit" as const } : { encoding: "utf8" as const }),
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
  return { ok: r.status === 0, out: show ? "" : String(r.stdout ?? "") };
};

export const engineRunner =
  (engine: Engine, exec: Exec = spawnExec): Run =>
  (args, opts = {}) => {
    const c = engineCommand(engine, args, opts);
    return exec(c.command, c.args, { show: opts.show ?? false, env: c.env });
  };

/**
 * Runs an engine command without blocking the event loop, handing each line of output and errors to `onLine` as it
 * arrives. True only for exit code 0; a program that isn't installed is false, not a crash. The setup page uses this for
 * the long download or build, so it can keep answering the browser while the engine works.
 */
export type Stream = (args: string[], onLine: (line: string) => void, scope?: ComposeScope) => Promise<boolean>;

type StreamProgram = (
  command: string,
  args: string[],
  onLine: (line: string) => void,
  env?: Record<string, string>,
) => Promise<boolean>;

const streamProgram: StreamProgram = (command, args, onLine, env) =>
  new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });
    const pending = { out: "", err: "" };
    const feed = (key: "out" | "err") => (chunk: Buffer) => {
      const parts = (pending[key] + chunk.toString("utf8")).split(/\r?\n/);
      pending[key] = parts.pop() ?? "";
      for (const line of parts) onLine(line);
    };
    child.stdout.on("data", feed("out"));
    child.stderr.on("data", feed("err"));
    child.on("error", () => resolve(false));
    child.on("close", (code) => {
      for (const rest of [pending.out, pending.err]) if (rest) onLine(rest);
      resolve(code === 0);
    });
  });

/** A Stream that runs `command` itself with the arguments as given (the engine-neutral form is for engineStreamer). */
export const commandStreamer =
  (command: string): Stream =>
  (args, onLine, scope) =>
    streamProgram(command, args, onLine, scope?.env);

export const engineStreamer =
  (engine: Engine, stream: StreamProgram = streamProgram): Stream =>
  (args, onLine, scope) => {
    const c = engineCommand(engine, args, scope);
    return stream(c.command, c.args, onLine, c.env);
  };

// Node's --env-file and Compose parse .env separately; make sure they agree on the values that route traffic.
// podman-compose can't print its configuration as JSON, so under it this check is skipped (docs/troubleshooting.md says
// to keep .env values unquoted).
export function parserParity(run: Run, env: Record<string, string | undefined>, engine: Engine = DOCKER): void {
  if (!canPrintConfigJson(engine)) return;
  const compose = engine.compose.join(" ");
  const r = run(["compose", "config", "--format", "json"]);
  if (!r.ok) {
    throw new CliError(`${compose} config failed; check .env syntax (no quotes needed, comments on their own lines)`);
  }
  let composed: Record<string, string | undefined>;
  try {
    composed = JSON.parse(r.out).services?.[SERVICE]?.environment ?? {};
  } catch {
    // A JSON error can quote the text around the problem, which holds the .env values.
    throw new CliError(`${compose} config printed something gork couldn't read; run \`${compose} config\` yourself`);
  }
  const differing = ROUTING_KEYS.filter((k) => (composed[k] ?? "").trim() !== (env[k] ?? "").trim());
  if (differing.length) {
    throw new CliError(
      `.env is read differently by Node and Compose for: ${differing.join(", ")}. Remove quotes or inline comments from those lines.`,
    );
  }
}

const READY = /^\[gork\] \S+ ready as /;
const FATAL = /^\[gork\] FATAL ([\w-]+): (.*)$/;

/**
 * What the bot's own log says: the last "ready as" or "[gork] FATAL <code>: <detail>" line decides, because the
 * tail can hold stale ones. Anything else in the log is ignored.
 */
export function logVerdict(logs: string): { ready: string } | { fatal: string; detail: string } | null {
  for (const line of logs.split(/\r?\n/).reverse()) {
    if (READY.test(line)) return { ready: line };
    const m = FATAL.exec(line);
    if (m) return { fatal: m[1], detail: m[2] };
  }
  return null;
}

/**
 * The service's State from `compose ps --format json`. That is one JSON array on older Compose and one object per line on
 * newer. With podman-compose it is `podman ps`'s own JSON, which has no Service field: the compose label names the service.
 */
export function serviceState(psJson: string): string | undefined {
  const trimmed = psJson.trim();
  const rows: Array<{ Service?: string; State?: string; Labels?: Record<string, string> | null }> = trimmed.startsWith(
    "[",
  )
    ? JSON.parse(trimmed)
    : trimmed
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
  const row = rows.find(
    (r) =>
      (r.Service ?? r.Labels?.["com.docker.compose.service"] ?? r.Labels?.["io.podman.compose.service"]) === SERVICE,
  );
  return row?.State?.toLowerCase();
}

/** The service's state, or undefined when the listing is empty or isn't something this can read. */
function stateOf(psJson: string): string | undefined {
  try {
    return serviceState(psJson || "[]");
  } catch {
    return undefined;
  }
}

// A crash under `restart: unless-stopped` shows as "restarting", not "exited".
const STOPPED = new Set(["exited", "dead", "restarting"]);

/**
 * Waits for the bot to say it is ready and returns that log line. Throws with the bot's own FATAL code and detail,
 * or when the container has stopped, or on timeout.
 */
export async function waitReady(
  run: Run,
  {
    seconds = 90,
    sleep,
    now,
    engine = DOCKER,
  }: { seconds?: number; sleep: (ms: number) => Promise<void>; now: () => number; engine?: Engine },
): Promise<string> {
  const until = now() + seconds * 1000;
  for (;;) {
    const logs = run(["compose", "logs", "--no-color", "--no-log-prefix", "--tail", "50", SERVICE]).out;
    const verdict = logVerdict(logs);
    if (verdict && "ready" in verdict) return verdict.ready.trim();
    if (verdict) throw new CliError(`gork failed to start (${verdict.fatal}): ${verdict.detail}`);
    const state = stateOf(run(psArgs(engine)).out);
    if (state && STOPPED.has(state)) {
      throw new CliError(`the gork container is ${state}; recent logs:\n${logs.slice(-800)}`);
    }
    if (now() >= until) throw new CliError(`gork did not report ready within ${seconds}s; run \`npm run logs\``);
    await sleep(3000);
  }
}
