// Host-side CLI: npm run up | down | destroy | logs | status | gateway. Needs Node 24+ (runs this file as TypeScript).
// Settings are read and validated through src/config.ts, the same table the bot uses. Never prints secret values:
// errors name keys, not their contents.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig, readSettings, SETTING_KEYS, SettingsError } from "../src/config.ts";
import { distrustRoots, OLD_NODE_WARNING } from "../src/distrust.ts";
import { TOKENS_URL } from "./lib/cloudflare-setup.ts";
import {
  engineRunner,
  engineStreamer,
  LEDGER_PATH,
  parserParity,
  type Run,
  SERVICE,
  type Stream,
  waitReady,
} from "./lib/compose.ts";
import { diagnose } from "./lib/doctor.ts";
import { type ComposeScope, DOCKER, type Engine, engineResolver, spawnProbe } from "./lib/engine.ts";
import type { HostOps } from "./lib/env-file.ts";
import { CliError } from "./lib/errors.ts";
import { cloudflareApi, creditBalance, deleteGateway, ensureGateway } from "./lib/gateway.ts";
import { chooseImage, IMAGE_FILE, type ImagePlan, packageVersion } from "./lib/image.ts";
import { openBrowser } from "./lib/open-browser.ts";
import { askLine } from "./lib/prompt.ts";
import { acquireSetupLock } from "./lib/setup-lock.ts";
import { startSetupServer } from "./lib/setup-server.ts";
import { SetupSession } from "./lib/setup-session.ts";
import { printable } from "./lib/text.ts";

type Env = Record<string, string | undefined>;

// What the commands touch outside this process, so tests can replace it. Each command takes only the parts it uses;
// `main` takes them all.

interface Log {
  log: (line: string) => void;
}
interface Warn {
  warn: (line: string) => void;
}
/** Runs compose and engine commands (docker or podman; see lib/engine.ts for the vocabulary). */
interface Runs {
  run: Run;
}
interface Cloudflare {
  env: Env;
  fetch: typeof fetch;
}
interface FindsEngine {
  /**
   * Finds the container engine for these settings (CONTAINER_ENGINE included) or throws EngineMissingError saying what
   * to fix. Absent (tests): Docker, with `run` standing in for it.
   */
  engine?: (env: Env) => Engine;
}
interface Personas {
  /** Folder holding the persona presets and your own. Default: ../personas. */
  personasDir?: string;
}

type ComposeDeps = Runs & Log;
type GatewayDeps = Cloudflare & Log;
type DestroyDeps = Cloudflare &
  Runs &
  Log & {
    /** Asks a question on the terminal and returns the answer. */
    confirm: (question: string) => Promise<string>;
  };
type DoctorDeps = Cloudflare & FindsEngine & Personas & Log;
type UpDeps = Cloudflare &
  Runs &
  FindsEngine &
  Personas &
  Log &
  Warn & {
    sleep: (ms: number) => Promise<void>;
    now: () => number;
    /** Runs an engine command without blocking, line by line. Absent: the blocking runner above is used. */
    stream?: Stream;
    /** Told each stage as it starts (the setup page shows them). */
    step?: (text: string) => void;
    /** Each line of the download or build's output (the setup page shows the tail). */
    output?: (line: string) => void;
  };
type SetupDeps = UpDeps & {
  /** Where .env goes. */
  envPath?: string;
  /** Opens the page in the default browser; false when it couldn't. Absent: nothing is opened. */
  openBrowser?: (url: string) => Promise<boolean>;
  /** Platform, user name and command runner used to lock .env down. Default: the real ones. */
  host?: HostOps;
  /** Registers a Ctrl-C handler (returns the remover) and ends the process after its cleanup. */
  onInterrupt?: (handler: () => void | Promise<void>) => () => void;
  exit?: (code: number) => void;
};
export type Deps = SetupDeps & DestroyDeps & DoctorDeps & GatewayDeps & ComposeDeps;

const compose = (d: Runs, args: string[]) => d.run(["compose", ...args], { show: true }).ok;

const engineOf = (d: FindsEngine & { env: Env }): Engine => d.engine?.(d.env) ?? DOCKER;

const PERSONAS_DIR = fileURLToPath(new URL("../personas", import.meta.url));

/**
 * The SHA-256 of the persona file PERSONA chooses. compose.yaml puts it in a container label, and compose recreates a
 * container whose labels changed, so an edited persona is read on the next `npm run up`.
 */
function personaSha(dir: string, name: string): string {
  if (!/^[a-z0-9_-]+$/i.test(name)) return "invalid";
  try {
    return createHash("sha256")
      .update(readFileSync(join(dir, `${name}.md`)))
      .digest("hex");
  } catch {
    return "missing";
  }
}

const gatewaySettings = (d: Cloudflare) =>
  readSettings(d.env, ["CF_ACCOUNT_ID", "CF_ADMIN_TOKEN", "AI_GATEWAY_ID", "DAILY_BUDGET_USD", "BILLING_MODE"]);

/** Creates or updates the gateway; returns the API handle for follow-up calls. */
async function syncGateway(d: GatewayDeps, s: ReturnType<typeof gatewaySettings>) {
  const api = cloudflareApi(s.CF_ACCOUNT_ID, s.CF_ADMIN_TOKEN, d.fetch);
  const did = await ensureGateway(api, s.AI_GATEWAY_ID, s.DAILY_BUDGET_USD, s.BILLING_MODE).catch((err) => {
    if (err instanceof CliError && /HTTP 40[13]/.test(err.message)) {
      throw new CliError(
        `${err.message}. CF_ADMIN_TOKEN may have expired or lack AI Gateway Read + Edit: run \`npm run doctor\``,
      );
    }
    throw err;
  });
  const id = s.AI_GATEWAY_ID;
  d.log(
    did === "created"
      ? `created AI Gateway "${id}"`
      : did === "updated"
        ? `updated AI Gateway "${id}" to gork's settings`
        : `AI Gateway "${id}" is already up to date`,
  );
  return api;
}

async function gateway(d: GatewayDeps): Promise<void> {
  await syncGateway(d, gatewaySettings(d));
}

const UP_USAGE = "the only one is --build (build gork here instead of downloading the released image)";

/**
 * Gets the image `up` will start. Returns how to run compose against it (the downloaded image's compose file and name),
 * or undefined to build one here. Downloads through the engine itself (docker pull or podman pull) and decides on its exit
 * code, so it behaves the same under every compose program.
 */
async function fetchImage(d: UpDeps, engine: Engine, plan: ImagePlan): Promise<ComposeScope | undefined> {
  if (plan.mode === "build") return undefined;
  d.step?.(`Downloading the gork image (${plan.ref})`);
  const pulled = d.stream
    ? await d.stream(["pull", plan.ref], (line) => d.output?.(line))
    : d.run(["pull", plan.ref], { show: true }).ok;
  // Offline, or the registry is unreachable: an image downloaded earlier is as good as a fresh one.
  const have = pulled || d.run(["image", "inspect", plan.ref]).ok;
  if (!have) {
    if (plan.custom) {
      throw new CliError(
        `couldn't get ${plan.ref} (the image GORK_IMAGE names): check the name, your connection, and \`${engine.command} login\` if the registry is private`,
      );
    }
    d.warn(
      `warning: couldn't download ${plan.ref} (you may be offline, or this version may not be published yet); building gork here instead. The first build compiles FFmpeg, which takes roughly 15 to 30 minutes (longer on a Raspberry Pi)`,
    );
    return undefined;
  }
  if (!pulled) d.warn(`warning: couldn't check ${plan.ref} for updates; running the copy already downloaded`);
  return { files: ["compose.yaml", IMAGE_FILE], env: { GORK_IMAGE_REF: plan.ref } };
}

async function up(d: UpDeps, args: string[] = []): Promise<void> {
  const unknown = args.filter((a) => a !== "--build");
  if (unknown.length) throw new CliError(`unknown option ${printable(unknown.join(" "), 40)}; ${UP_USAGE}`);
  // Check every setting before touching the engine or Cloudflare; loadConfig adds the bot's cross-setting rules.
  d.step?.("Checking the settings");
  const s = readSettings(d.env, SETTING_KEYS);
  loadConfig(d.env);
  d.step?.("Checking that Docker or Podman is running");
  const engine = engineOf(d);
  parserParity(d.run, d.env, engine);
  d.step?.("Updating the AI Gateway");
  const api = await syncGateway(d, s);
  const balance = s.BILLING_MODE === "free" ? null : await creditBalance(api);
  if (balance !== null && balance <= 0) {
    d.warn("warning: AI Gateway credit balance is $0; the model and search will fail until you add credits");
  }
  const scope = await fetchImage(d, engine, chooseImage(s.GORK_IMAGE, args.includes("--build"), packageVersion()));
  d.step?.(scope ? "Starting gork" : "Building and starting gork");
  const upArgs = ["up", "-d", scope ? "--no-build" : "--build", "--remove-orphans"];
  const upScope: ComposeScope = {
    ...scope,
    env: { ...scope?.env, GORK_PERSONA_SHA: personaSha(d.personasDir ?? PERSONAS_DIR, s.PERSONA) },
  };
  const started = d.stream
    ? await d.stream(["compose", ...upArgs], (line) => d.output?.(line), upScope)
    : d.run(["compose", ...upArgs], { show: true, ...upScope }).ok;
  if (!started) throw new CliError(`${engine.compose.join(" ")} up failed`);
  d.step?.("Waiting for gork to come online");
  const run: Run = (a, o) => d.run(a, { ...o, ...scope });
  d.log(await waitReady(run, { sleep: d.sleep, now: d.now, engine }));
}

async function down(d: ComposeDeps): Promise<void> {
  if (!compose(d, ["down"])) throw new CliError("compose down failed");
}

async function logs(d: ComposeDeps): Promise<void> {
  compose(d, ["logs", "-f", "--tail", "100"]);
}

async function status(d: ComposeDeps): Promise<void> {
  compose(d, ["ps"]);
  // The image has no shell, cat or ls, so node itself prints the file.
  const cat = "process.stdout.write(process.getBuiltinModule('node:fs').readFileSync(process.argv[1]))";
  compose(d, ["exec", "-T", SERVICE, "node", "-e", cat, LEDGER_PATH]);
  d.log("");
}

async function destroy(d: DestroyDeps): Promise<void> {
  const s = readSettings(d.env, ["CF_ACCOUNT_ID", "CF_ADMIN_TOKEN", "AI_GATEWAY_ID", "GORK_IMAGE"]);
  const answer = await d.confirm(
    'This stops gork, deletes its data volume and image, and deletes the AI Gateway. Type "gork" to confirm: ',
  );
  if (answer.trim() !== "gork") throw new CliError("aborted");
  if (!compose(d, ["down", "-v", "--rmi", "local"])) {
    throw new CliError("compose down failed; the AI Gateway was NOT deleted");
  }
  // `--rmi local` removes an image built here. The released image `up` downloaded has a name of its own, so it goes by
  // name: but only that one, never an image GORK_IMAGE names, and without minding if something else still uses it.
  const plan = chooseImage(s.GORK_IMAGE, false, packageVersion());
  if (plan.mode === "pull" && !plan.custom) d.run(["rmi", plan.ref]);
  await deleteGateway(cloudflareApi(s.CF_ACCOUNT_ID, s.CF_ADMIN_TOKEN, d.fetch), s.AI_GATEWAY_ID);
  d.log("destroyed: the container, its data volume and image, and the AI Gateway are gone.");
  d.log("These still exist, because only you can remove them:");
  d.log(
    `  - your Cloudflare API tokens (gork-run and gork-admin, including the ones in .env): revoke them at ${TOKENS_URL}`,
  );
  d.log("  - the Discord app (the bot and its token): delete it at https://discord.com/developers/applications");
}

const MARKS = { ok: "ok  ", warn: "warn", fail: "FAIL" };

/**
 * Checks every setting and account; exits 1 when something needs fixing. --json prints one JSON document instead,
 * `{ ok, checks: [{ id, level, message }] }`, and nothing else; the exit code is the same. npm prints its own
 * "> gork@... doctor" banner on stdout first, so a program parsing the output runs `npm run -s doctor -- --json`.
 */
async function doctor(d: DoctorDeps, args: string[] = []): Promise<number | undefined> {
  const unknown = args.filter((a) => a !== "--live" && a !== "--json");
  if (unknown.length) {
    throw new CliError(
      `unknown option ${printable(unknown.join(" "), 40)}; the options are --live (also run the checks that cost money) and --json (print the results as JSON)`,
    );
  }
  const findings = await diagnose({
    env: d.env,
    fetch: d.fetch,
    personasDir: d.personasDir ?? PERSONAS_DIR,
    live: args.includes("--live"),
    engine: d.engine ? () => engineOf(d) : undefined,
  });
  const failed = findings.filter((f) => f.level === "fail").length;
  if (args.includes("--json")) {
    const checks = findings.map((f) => ({ id: f.id, level: f.level, message: f.text }));
    d.log(JSON.stringify({ ok: failed === 0, checks }));
    return failed ? 1 : 0;
  }
  for (const f of findings) d.log(`${MARKS[f.level]} ${f.text}`);
  if (failed)
    throw new CliError(
      `${failed} problem${failed === 1 ? "" : "s"} found; fix the FAIL lines above and run \`npm run doctor\` again`,
    );
  d.log("everything looks good");
  return undefined;
}

const PAGE_PATH = new URL("./lib/setup-page.html", import.meta.url);

/**
 * Starts gork for the setup page: the same `up` as `npm run up`, run on the settings setup just wrote (the page's own
 * process has no .env loaded, so they are passed in), with the long Docker build streamed so the page stays responsive.
 * Resolves with the line gork printed when it was ready.
 */
async function startFromSetup(
  d: SetupDeps,
  env: Record<string, string>,
  hooks: { step(text: string): void; output(line: string): void; warn(line: string): void },
): Promise<string> {
  const said: string[] = [];
  await up({
    ...d,
    env,
    stream: d.stream ?? ((args, onLine, scope) => engineStreamer(engineOf({ ...d, env }))(args, onLine, scope)),
    step: hooks.step,
    output: hooks.output,
    log: (line) => said.push(line),
    warn: (line) => hooks.warn(line.replace(/^warning: /, "")),
  });
  return said.at(-1) ?? "";
}

/**
 * Opens a local page in your browser that walks you through Discord and Cloudflare, and writes .env.
 * With --no-open (for a person driving setup through another program, such as a coding agent) no browser is opened;
 * stdout gets one `SETUP_URL=<url>` line, one `USER_ACTION_REQUIRED: ...` line, and at the end `SETUP_DONE` (gork is
 * online) or `SETUP_STOPPED` (setup closed before that). Exit code: 0 when setup closes, 1 when it can't start (an
 * unknown option, .env already exists, another setup is running), 130 after Ctrl-C.
 */
async function setup(d: SetupDeps, args: string[] = []): Promise<void> {
  const unknown = args.filter((a) => a !== "--no-open");
  if (unknown.length) {
    throw new CliError(
      `unknown option ${printable(unknown.join(" "), 40)}; the only one is --no-open (print the address instead of opening a browser)`,
    );
  }
  const envPath = d.envPath ?? resolve(".env");
  if (existsSync(envPath)) {
    const name = basename(envPath);
    throw new CliError(
      `${name} already exists, and setup never overwrites it. Move it aside (for example rename it to ${name}.old) and run setup again, or run \`npm run doctor\` to check the one you have.`,
    );
  }
  let page: string;
  try {
    page = readFileSync(PAGE_PATH, "utf8");
  } catch {
    throw new CliError("couldn't read the setup page (scripts/lib/setup-page.html). Is the download complete?");
  }
  // One setup at a time. Ctrl-C ends the process without returning here, so the exit hook frees the lock too.
  const release = acquireSetupLock(`${envPath}.setup-lock`);
  try {
    await serveSetup(d, envPath, page, args.includes("--no-open"), (code) => {
      release();
      d.exit?.(code);
    });
  } finally {
    release();
  }
}

async function serveSetup(
  d: SetupDeps,
  envPath: string,
  page: string,
  noOpen: boolean,
  exit: (code: number) => void,
): Promise<void> {
  const session = new SetupSession({
    fetch: d.fetch,
    now: d.now,
    envPath,
    personasDir: d.personasDir ?? PERSONAS_DIR,
    host: d.host,
    print: d.log,
    exit,
    startBot: (env, hooks) => startFromSetup(d, env, hooks),
  });
  const server = await startSetupServer({ session, page, log: d.log, onInterrupt: d.onInterrupt });
  if (noOpen) {
    d.log("gork setup is running on this computer. Leave it running until it says SETUP_DONE.");
    d.log(`SETUP_URL=${server.url}`);
    d.log(
      "USER_ACTION_REQUIRED: open the URL in your own browser and paste the tokens yourself (it works in one browser only: do not fetch it)",
    );
  } else {
    d.log(
      "gork setup is running on this computer. It opens in your browser; leave this window open until it says gork is online.",
    );
    d.log("");
    d.log(`  ${server.url}`);
    d.log("");
    if (!(await d.openBrowser?.(server.url))) {
      d.log("Couldn't open a browser. Copy the address above into your browser.");
    }
    d.log("Press Ctrl+C here to stop setup; anything it made is taken back.");
  }
  await server.closed;
  if (noOpen) d.log(session.isDone() ? "SETUP_DONE" : "SETUP_STOPPED");
}

export const COMMANDS = { up, down, destroy, logs, status, gateway, doctor, setup };
export const USAGE = `usage: npm run ${Object.keys(COMMANDS).join(" | ")}`;

/** Runs one command and returns the exit code. */
export async function main(argv: string[], d: Deps): Promise<number> {
  const name = argv[0] as keyof typeof COMMANDS;
  if (!Object.hasOwn(COMMANDS, name)) {
    d.warn(`gork: ${USAGE}`);
    return 1;
  }
  try {
    // A command that reports its own outcome (doctor --json) returns its exit code; the others throw on failure.
    return (await COMMANDS[name](d, argv.slice(1))) ?? 0;
  } catch (err) {
    if (!(err instanceof CliError || err instanceof SettingsError)) throw err;
    d.warn(`gork: ${err.message}`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  // Before anything connects: setup and up send the Discord and Cloudflare tokens over TLS checked against this store.
  if (distrustRoots() === null) console.warn(`gork: ${OLD_NODE_WARNING}`);
  // The engine is looked for the first time a command needs it, then remembered.
  const resolveEngine = engineResolver(spawnProbe);
  process.exitCode = await main(process.argv.slice(2), {
    env: process.env,
    run: (args, opts) => engineRunner(resolveEngine(process.env))(args, opts),
    engine: resolveEngine,
    fetch,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
    confirm: askLine,
    openBrowser,
    // Registered here only, never inside the commands, so tests don't pile up process listeners. A SIGINT listener
    // stops Node exiting on Ctrl-C by itself, so the setup handler ends the process once its cleanup is done.
    onInterrupt: (handler) => {
      const listener = () => {
        void Promise.resolve(handler()).catch(() => process.exit(130));
      };
      process.on("SIGINT", listener);
      return () => process.off("SIGINT", listener);
    },
    exit: (code) => process.exit(code),
    log: console.log,
    warn: console.error,
  });
}
