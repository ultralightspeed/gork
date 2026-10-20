import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COMMANDS, type Deps, main, USAGE } from "../scripts/gork.ts";
import { LEDGER_PATH, SERVICE } from "../scripts/lib/compose.ts";
import { type Engine, EngineMissingError } from "../scripts/lib/engine.ts";
import { gatewaySpec } from "../scripts/lib/gateway.ts";
import { IMAGE_FILE, IMAGE_REPO, packageVersion } from "../scripts/lib/image.ts";
import { fakeClock, fakeDocker, fakeFetch, json, tempDir } from "./helpers.ts";

const ENV = {
  DISCORD_TOKEN: "d",
  GUILD_IDS: "1",
  CF_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  CF_RUN_TOKEN: "r",
  CF_ADMIN_TOKEN: "admin",
};
const READY = "[gork] 2026-10-19T12:00:00.000Z ready as gork#1234 in 1 guild(s); budget today $0.0000/$0.5";
const ok = (result: unknown = {}) => json({ success: true, result });

/** A CLI wired to fakes. Docker answers like a healthy machine unless `docker` or `cf` say otherwise. */
function cli(
  opts: {
    env?: Record<string, string>;
    docker?: (args: string[]) => { ok?: boolean; out?: string } | undefined;
    cf?: Parameters<typeof fakeFetch>[0];
    typed?: string;
    engine?: Deps["engine"];
  } = {},
) {
  const docker = fakeDocker((args) => {
    const custom = opts.docker?.(args);
    if (custom) return custom;
    if (args[1] === "config")
      return {
        out: JSON.stringify({
          services: {
            [SERVICE]: { environment: { GUILD_IDS: "1", CF_ACCOUNT_ID: "0123456789abcdef0123456789abcdef" } },
          },
        }),
      };
    if (args[1] === "logs" && !args.includes("-f")) return { out: READY };
    return {};
  });
  const cf = fakeFetch(
    opts.cf ??
      ((c) => (c.url.includes("credit-balance") ? ok({ balance: 5 }) : c.method === "GET" ? json({}, 404) : ok())),
  );
  const out: string[] = [];
  const errors: string[] = [];
  const clock = fakeClock();
  const personasDir = tempDir("gork-cli-personas-");
  writeFileSync(join(personasDir, "default.md"), "You are gork.\n");
  const deps: Deps = {
    env: opts.env ?? ENV,
    run: docker.run,
    engine: opts.engine,
    fetch: cf.f,
    ...clock,
    confirm: async () => opts.typed ?? "",
    log: (l) => out.push(l),
    warn: (l) => errors.push(l),
    personasDir,
  };
  return { deps, docker: docker.calls, options: docker.options, cf: cf.calls, out, errors, personasDir };
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
/** The environment the `compose up` call ran with. */
const upEnv = (c: ReturnType<typeof cli>) => c.options[c.docker.findIndex((a) => a[1] === "up")]?.env;

const cfCalls = (c: { cf: unknown[] }) => c.cf.length;

const PODMAN: Engine = {
  name: "podman",
  label: "Podman",
  command: "podman",
  compose: ["podman", "compose"],
  flavor: "docker-compose",
  version: "5.2.1",
};
const PODMAN_COMPOSE: Engine = { ...PODMAN, compose: ["podman-compose"], flavor: "podman-compose" };

describe("up", () => {
  it("checks Docker, then the gateway, then downloads the released image and starts it without building, and reports the ready line", async () => {
    const c = cli();
    expect(await main(["up"], c.deps)).toBe(0);
    expect(c.docker.map(word)).toEqual(["compose config", `pull ${RELEASED}`, "compose up", "compose logs"]);
    expect(c.docker.find((a) => a[1] === "up")).toEqual(["compose", "up", "-d", "--no-build", "--remove-orphans"]);
    // The compose calls that follow run on the image's compose file and know which image; the .env check does not.
    const scope = { files: FILES, env: { GORK_IMAGE_REF: RELEASED } };
    expect(c.options[c.docker.findIndex((a) => a[1] === "up")]).toMatchObject(scope);
    expect(c.options[c.docker.findIndex((a) => a[1] === "logs")]).toMatchObject(scope);
    expect(c.options[c.docker.findIndex((a) => a[1] === "config")]?.files).toBeUndefined();
    expect(c.cf.map((x) => x.method)).toEqual(["GET", "POST", "GET"]);
    expect(c.out).toEqual(['created AI Gateway "gork"', READY]);
    expect(c.errors).toEqual([]);
  });

  it("starts with keys in .env it doesn't know, without an error or a warning", async () => {
    const c = cli({ env: { ...ENV, VIDEO: "off", MAX_OUTPUT_TOKENS: "4000", SOMETHING_ELSE: "1" } });
    expect(await main(["up"], c.deps)).toBe(0);
    expect(c.errors).toEqual([]);
  });

  it("reaches the container only through compose (never by its name), and reads the ledger with node: the image has no shell, cat or ls", async () => {
    const c = cli();
    await main(["up"], c.deps);
    await main(["status"], c.deps);
    await main(["down"], c.deps);
    expect(c.docker.length).toBeGreaterThan(0);
    // Compose for the container; the engine itself only for the image (download, look for it, remove it).
    for (const args of c.docker) expect(["compose", "pull", "image", "rmi"]).toContain(args[0]);
    for (const args of c.docker.filter((a) => a[0] !== "compose")) expect(args).not.toContain(SERVICE);
    const exec = c.docker.find((a) => a.includes("exec")) ?? [];
    expect(exec.slice(0, 3)).toEqual(["compose", "exec", "-T"]);
    expect(exec).toContain("node");
    expect(exec).not.toContain("cat");
    expect(exec.at(-1)).toBe(LEDGER_PATH);
  });

  it("checks the settings, as the bot reads them, before any Cloudflare or Docker call", async () => {
    const acct = "0123456789abcdef0123456789abcdef";
    const cases: [Record<string, string>, RegExp][] = [
      [{ ...ENV, DAILY_BUDGET_USD: "lots" }, /DAILY_BUDGET_USD/],
      [{ CF_ACCOUNT_ID: acct }, /DISCORD_TOKEN.*GUILD_IDS.*CF_RUN_TOKEN.*CF_ADMIN_TOKEN/],
      [{ ...ENV, LLM_BASE_URL: "https://openrouter.ai/api/v1" }, /LLM_API_KEY/],
    ];
    for (const [env, message] of cases) {
      const c = cli({ env });
      expect(await main(["up"], c.deps), message.source).toBe(1);
      expect(c.errors.join(), message.source).toMatch(message);
      expect(cfCalls(c)).toBe(0);
      expect(c.docker).toEqual([]);
    }
  });

  it("stops before Cloudflare, and says what to start, when there is no working container engine", async () => {
    const c = cli({
      engine: () => {
        throw new EngineMissingError("Podman machine isn't running. Run `podman machine start`, then retry.");
      },
    });
    expect(await main(["up"], c.deps)).toBe(1);
    expect(c.errors.join()).toMatch(/Podman machine isn't running.*podman machine start/);
    expect(cfCalls(c)).toBe(0);
    expect(c.docker).toEqual([]);
  });

  it("looks for the engine with the settings it was given, CONTAINER_ENGINE included", async () => {
    const seen: Array<string | undefined> = [];
    const c = cli({
      env: { ...ENV, CONTAINER_ENGINE: "podman" },
      engine: (env) => {
        seen.push(env.CONTAINER_ENGINE);
        return PODMAN;
      },
    });
    expect(await main(["up"], c.deps)).toBe(0);
    expect(seen).toEqual(["podman"]);
  });

  it("under podman-compose skips the .env parity check and lists containers the way podman-compose can", async () => {
    const c = cli({ engine: () => PODMAN_COMPOSE });
    expect(await main(["up"], c.deps)).toBe(0);
    expect(c.docker.map((a) => a.slice(0, 2).join(" "))).toEqual([`pull ${RELEASED}`, "compose up", "compose logs"]);
    const failing = cli({
      engine: () => PODMAN_COMPOSE,
      docker: (a) => (a[1] === "up" ? { ok: false } : undefined),
    });
    expect(await main(["up"], failing.deps)).toBe(1);
    expect(failing.errors.join()).toMatch(/podman-compose up failed/);
  });

  it("does not start the container when the gateway can't be set up, and suggests an expired or under-permissioned admin token when it is refused", async () => {
    for (const status of [401, 403]) {
      const c = cli({ cf: () => json({ success: false, errors: ["denied"] }, status) });
      expect(await main(["up"], c.deps)).toBe(1);
      expect(c.errors.join()).toMatch(
        new RegExp(`AI Gateway failed: HTTP ${status}.*CF_ADMIN_TOKEN.*expired.*npm run doctor`),
      );
      expect(c.docker.some((a) => a[1] === "up")).toBe(false);
    }
    const other = cli({ cf: () => json({ success: false, errors: ["boom"] }, 500) });
    expect(await main(["up"], other.deps)).toBe(1);
    expect(other.errors.join()).not.toMatch(/CF_ADMIN_TOKEN/);
    expect(other.docker.some((a) => a[1] === "up")).toBe(false);
  });

  it("warns about an empty credit balance but carries on", async () => {
    const c = cli({
      cf: (x) => (x.url.includes("credit-balance") ? ok({ balance: 0 }) : x.method === "GET" ? json({}, 404) : ok()),
    });
    expect(await main(["up"], c.deps)).toBe(0);
    expect(c.errors.join()).toMatch(/credit balance is \$0/);
  });

  it("in free mode creates the gateway with standard billing and never looks at credits", async () => {
    const c = cli({ env: { ...ENV, BILLING_MODE: "free" } });
    expect(await main(["up"], c.deps)).toBe(0);
    expect(c.cf.map((x) => x.method)).toEqual(["GET", "POST"]);
    expect(c.cf[1].body.workers_ai_billing_mode).toBe("standard");
    expect(c.cf.some((x) => x.url.includes("credit-balance"))).toBe(false);
    expect(c.errors).toEqual([]);
  });

  it("the gateway command follows BILLING_MODE too", async () => {
    const c = cli({
      env: { CF_ACCOUNT_ID: "0123456789abcdef0123456789abcdef", CF_ADMIN_TOKEN: "admin", BILLING_MODE: "free" },
    });
    expect(await main(["gateway"], c.deps)).toBe(0);
    expect(c.cf[1].body.workers_ai_billing_mode).toBe("standard");
  });

  it("does not wait for the bot when compose up fails", async () => {
    const c = cli({ docker: (a) => (a[1] === "up" ? { ok: false } : undefined) });
    expect(await main(["up"], c.deps)).toBe(1);
    expect(c.errors.join()).toMatch(/compose up failed/);
    expect(c.docker.some((a) => a[1] === "logs")).toBe(false);
  });

  it("reports the bot's FATAL code and detail", async () => {
    const c = cli({
      docker: (a) => (a[1] === "logs" ? { out: "[gork] FATAL discord-login: invalid token" } : undefined),
    });
    expect(await main(["up"], c.deps)).toBe(1);
    expect(c.errors.join()).toMatch(/discord-login.*invalid token/);
  });
});

const RELEASED = `${IMAGE_REPO}:${packageVersion()}`;
const FILES = ["compose.yaml", IMAGE_FILE];
const word = (a: string[]) => a.slice(0, 2).join(" ");
const refuses = (a: string[]) => (a[0] === "pull" || a[0] === "image" ? { ok: false } : undefined);

describe("up: the released image, or a build here", () => {
  it("reports the stages the setup page shows: a download then a start, or a build with no download", async () => {
    const stepsOf = async (args: string[]) => {
      const c = cli();
      const steps: string[] = [];
      c.deps.step = (t) => steps.push(t);
      await main(args, c.deps);
      return steps;
    };
    const first = ["Checking the settings", "Checking that Docker or Podman is running", "Updating the AI Gateway"];
    const released = await stepsOf(["up"]);
    expect(released).toEqual([
      ...first,
      `Downloading the gork image (${RELEASED})`,
      "Starting gork",
      "Waiting for gork to come online",
    ]);
    const built = await stepsOf(["up", "--build"]);
    expect(built.slice(0, 3)).toEqual(first);
    // The build time is said once: in the warning after a failed download, or on the page before Start.
    expect(built[3]).toBe("Building and starting gork");
    expect(built).toHaveLength(5);
  });

  it("builds here, naming why, when the download fails (offline or unpublished)", async () => {
    const c = cli({ docker: refuses });
    expect(await main(["up"], c.deps)).toBe(0);
    expect(c.errors).toHaveLength(1);
    expect(c.errors[0]).toContain(RELEASED);
    expect(c.errors[0]).toMatch(/offline.*building gork here/s);
    expect(c.docker.find((a) => a[1] === "up")).toEqual(["compose", "up", "-d", "--build", "--remove-orphans"]);
    expect(c.options[c.docker.findIndex((a) => a[1] === "up")]?.files).toBeUndefined();
  });

  it("runs the copy it already has when only the check for a newer one fails", async () => {
    const c = cli({ docker: (a) => (a[0] === "pull" ? { ok: false } : undefined) });
    expect(await main(["up"], c.deps)).toBe(0);
    expect(c.docker.some((a) => a[0] === "image" && a[1] === "inspect" && a[2] === RELEASED)).toBe(true);
    expect(c.errors.join()).toMatch(/couldn't check .* for updates.*already downloaded/);
    expect(c.docker.find((a) => a[1] === "up")).toContain("--no-build");
  });

  it("--build and GORK_IMAGE=build build here and download nothing", async () => {
    for (const [args, env] of [
      [["up", "--build"], ENV],
      [["up"], { ...ENV, GORK_IMAGE: "build" }],
    ] as const) {
      const c = cli({ env });
      expect(await main([...args], c.deps)).toBe(0);
      expect(c.docker.some((a) => a[0] === "pull")).toBe(false);
      expect(c.docker.find((a) => a[1] === "up")).toEqual(["compose", "up", "-d", "--build", "--remove-orphans"]);
      expect(c.errors).toEqual([]);
    }
  });

  it("runs the image GORK_IMAGE names, and fails rather than build something else when it can't get it", async () => {
    const env = { ...ENV, GORK_IMAGE: "ghcr.io/me/gork:dev" };
    const ok = cli({ env });
    expect(await main(["up"], ok.deps)).toBe(0);
    expect(ok.docker.find((a) => a[0] === "pull")).toEqual(["pull", "ghcr.io/me/gork:dev"]);
    expect(ok.options[ok.docker.findIndex((a) => a[1] === "up")]?.env).toMatchObject({
      GORK_IMAGE_REF: "ghcr.io/me/gork:dev",
    });
    const bad = cli({ env, docker: refuses });
    expect(await main(["up"], bad.deps)).toBe(1);
    expect(bad.errors.join()).toMatch(/couldn't get ghcr\.io\/me\/gork:dev.*GORK_IMAGE/);
    expect(bad.docker.some((a) => a[1] === "up")).toBe(false);
  });

  it("rejects an option it doesn't know, before touching anything", async () => {
    const c = cli();
    expect(await main(["up", "--rebuild"], c.deps)).toBe(1);
    expect(c.errors.join()).toMatch(/unknown option --rebuild; the only one is --build/);
    expect(c.docker).toEqual([]);
    expect(cfCalls(c)).toBe(0);
  });

  it("downloads through the stream when there is one, so the setup page can show the progress", async () => {
    const c = cli();
    const calls: Array<{ args: string[]; scope?: unknown }> = [];
    const lines: string[] = [];
    c.deps.output = (l) => lines.push(l);
    c.deps.stream = async (args, onLine, scope) => {
      calls.push({ args, scope });
      onLine(`layer ${args[0]}`);
      return true;
    };
    expect(await main(["up"], c.deps)).toBe(0);
    expect(calls).toEqual([
      { args: ["pull", RELEASED], scope: undefined },
      {
        args: ["compose", "up", "-d", "--no-build", "--remove-orphans"],
        scope: { files: FILES, env: { GORK_IMAGE_REF: RELEASED, GORK_PERSONA_SHA: expect.any(String) } },
      },
    ]);
    expect(lines).toEqual(["layer pull", "layer compose"]);
    expect(c.docker.some((a) => a[0] === "pull" || a[1] === "up")).toBe(false);
  });
});

describe("up with a streaming docker", () => {
  const streamed = (ok = true) => {
    const calls: string[][] = [];
    const stream = async (args: string[], onLine: (line: string) => void) => {
      calls.push(args);
      onLine("#1 building");
      onLine("#2 done");
      return ok;
    };
    return { calls, stream };
  };

  it("runs the long compose step through the stream, not the blocking runner, and passes on its lines", async () => {
    const c = cli();
    const s = streamed();
    const lines: string[] = [];
    c.deps.stream = s.stream;
    c.deps.output = (l) => lines.push(l);
    expect(await main(["up", "--build"], c.deps)).toBe(0);
    expect(s.calls).toEqual([["compose", "up", "-d", "--build", "--remove-orphans"]]);
    expect(c.docker.some((a) => a[1] === "up")).toBe(false);
    expect(lines).toEqual(["#1 building", "#2 done"]);
  });

  it("fails like the blocking path when the stream says the compose step failed", async () => {
    const c = cli();
    c.deps.stream = streamed(false).stream;
    expect(await main(["up"], c.deps)).toBe(1);
    expect(c.errors.join()).toMatch(/compose up failed/);
    expect(c.docker.some((a) => a[1] === "logs")).toBe(false);
  });
});

describe("up after a persona edit", () => {
  // compose.yaml puts GORK_PERSONA_SHA in a label; compose recreates a container whose labels changed.
  it("starts compose with the SHA-256 of the chosen persona file", async () => {
    const c = cli();
    expect(await main(["up"], c.deps)).toBe(0);
    expect(upEnv(c)).toMatchObject({ GORK_PERSONA_SHA: sha256("You are gork.\n"), GORK_IMAGE_REF: RELEASED });
  });

  it("gives a different SHA once the persona file changes", async () => {
    const c = cli();
    await main(["up"], c.deps);
    writeFileSync(join(c.personasDir, "default.md"), "You are gork, but louder.\n");
    const again = cli();
    again.deps.personasDir = c.personasDir;
    await main(["up"], again.deps);
    expect(upEnv(again)?.GORK_PERSONA_SHA).toBe(sha256("You are gork, but louder.\n"));
    expect(upEnv(again)?.GORK_PERSONA_SHA).not.toBe(upEnv(c)?.GORK_PERSONA_SHA);
  });

  it("hashes the persona PERSONA names, on the build path too", async () => {
    const c = cli({ env: { ...ENV, PERSONA: "witty" } });
    writeFileSync(join(c.personasDir, "witty.md"), "Be witty.\n");
    expect(await main(["up", "--build"], c.deps)).toBe(0);
    expect(upEnv(c)).toEqual({ GORK_PERSONA_SHA: sha256("Be witty.\n") });
  });

  it("starts anyway when the persona file is missing, leaving the error to the bot", async () => {
    const c = cli({ env: { ...ENV, PERSONA: "nobody" } });
    expect(await main(["up"], c.deps)).toBe(0);
    expect(upEnv(c)?.GORK_PERSONA_SHA).toBe("missing");
  });

  it("passes the SHA through the stream too", async () => {
    const c = cli();
    const scopes: unknown[] = [];
    c.deps.stream = async (args, _onLine, scope) => {
      if (args[1] === "up") scopes.push(scope);
      return true;
    };
    await main(["up"], c.deps);
    expect(scopes).toEqual([{ files: FILES, env: { GORK_IMAGE_REF: RELEASED, GORK_PERSONA_SHA: expect.any(String) } }]);
  });
});

describe("each command takes only what it uses", () => {
  it("down, logs and status need only the engine runner and a log", async () => {
    const c = cli();
    const log = () => {};
    await COMMANDS.down({ run: c.deps.run, log });
    await COMMANDS.logs({ run: c.deps.run, log });
    await COMMANDS.status({ run: c.deps.run, log });
    expect(c.docker.map(word)).toEqual(["compose down", "compose logs", "compose ps", "compose exec"]);
  });

  it("gateway needs only the settings, fetch and a log", async () => {
    const c = cli();
    await COMMANDS.gateway({ env: ENV, fetch: c.deps.fetch, log: () => {} });
    expect(c.cf.length).toBeGreaterThan(0);
  });
});

describe("gateway", () => {
  it("needs only the Cloudflare settings, not the Discord ones", async () => {
    const c = cli({
      env: { CF_ACCOUNT_ID: "0123456789abcdef0123456789abcdef", CF_ADMIN_TOKEN: "admin", AI_GATEWAY_ID: "mine" },
    });
    expect(await main(["gateway"], c.deps)).toBe(0);
    expect(c.out).toEqual(['created AI Gateway "mine"']);
    expect(c.docker).toEqual([]);
  });

  it("sizes the spend limit from the same parsed budget the bot uses", async () => {
    const c = cli({
      env: { CF_ACCOUNT_ID: "0123456789abcdef0123456789abcdef", CF_ADMIN_TOKEN: "admin", DAILY_BUDGET_USD: " 2 " },
    });
    await main(["gateway"], c.deps);
    expect(c.cf[1].body.spend_limits.rules[0].limit).toBe(2.4);
  });
});

describe("destroy", () => {
  it("does nothing unless gork is typed", async () => {
    const c = cli({ typed: "yes" });
    expect(await main(["destroy"], c.deps)).toBe(1);
    expect(c.errors.join()).toMatch(/aborted/);
    expect(c.docker).toEqual([]);
    expect(cfCalls(c)).toBe(0);
  });

  it("keeps the gateway when the container can't be removed", async () => {
    const c = cli({ typed: "gork", docker: () => ({ ok: false }) });
    expect(await main(["destroy"], c.deps)).toBe(1);
    expect(c.errors.join()).toMatch(/NOT deleted/);
    expect(cfCalls(c)).toBe(0);
  });

  it("removes the container, its volume and image, then the gateway, and says the API tokens and the Discord app still exist and where to revoke them", async () => {
    const c = cli({ typed: " gork ", cf: () => ok() });
    expect(await main(["destroy"], c.deps)).toBe(0);
    expect(c.docker).toEqual([
      ["compose", "down", "-v", "--rmi", "local"],
      ["rmi", RELEASED],
    ]);
    expect(c.cf.map((x) => x.method)).toEqual(["DELETE"]);
    const text = c.out.join("\n");
    expect(text).toMatch(/still exist/i);
    expect(text).toContain("https://dash.cloudflare.com/?to=/:account/api-tokens");
    expect(text).toContain("https://discord.com/developers/applications");
  });

  it("removes only the image it downloaded, never one GORK_IMAGE named or one it never pulled", async () => {
    for (const GORK_IMAGE of ["build", "ghcr.io/me/gork:dev"]) {
      const c = cli({ typed: "gork", env: { ...ENV, GORK_IMAGE }, cf: () => ok() });
      expect(await main(["destroy"], c.deps)).toBe(0);
      expect(c.docker, GORK_IMAGE).toEqual([["compose", "down", "-v", "--rmi", "local"]]);
    }
  });

  it("doesn't mind when the downloaded image can't be removed (another project may still use it)", async () => {
    const c = cli({ typed: "gork", cf: () => ok(), docker: (a) => (a[0] === "rmi" ? { ok: false } : undefined) });
    expect(await main(["destroy"], c.deps)).toBe(0);
    expect(c.errors).toEqual([]);
  });
});

describe("main", () => {
  it("prints usage for an unknown or missing command, naming every command, and touches nothing", async () => {
    for (const argv of [[], ["restart"], ["toString"]]) {
      const c = cli();
      expect(await main(argv, c.deps)).toBe(1);
      for (const name of Object.keys(COMMANDS)) expect(c.errors.join()).toContain(name);
      expect(c.docker).toEqual([]);
      expect(cfCalls(c)).toBe(0);
    }
  });

  it("has an npm script for every command", () => {
    const scripts = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).scripts;
    for (const name of Object.keys(COMMANDS))
      expect(scripts[name], name).toMatch(new RegExp(`scripts/gork\\.ts ${name}$`));
    expect(USAGE).toContain("gateway");
  });

  it("lets unexpected errors through instead of hiding them", async () => {
    const c = cli({
      docker: () => {
        throw new TypeError("bug");
      },
    });
    await expect(main(["down"], c.deps)).rejects.toThrow(TypeError);
  });
});

describe("gateway: what it says it did", () => {
  const env = { CF_ACCOUNT_ID: "0123456789abcdef0123456789abcdef", CF_ADMIN_TOKEN: "admin", AI_GATEWAY_ID: "mine" };
  // The gateway as `gork gateway` would write it, so reading it back finds nothing to change.
  const wanted = gatewaySpec({ budgetUsd: 0.5, billing: "credits" });
  const route =
    (existing: object | null): Parameters<typeof fakeFetch>[0] =>
    (c) =>
      c.method === "GET" ? (existing ? ok(existing) : json({}, 404)) : ok();

  it("says created when it made the gateway, updated when it had to change it, and up to date (writing nothing) only when nothing needed changing", async () => {
    const created = cli({ env, cf: route(null) });
    expect(await main(["gateway"], created.deps)).toBe(0);
    expect(created.out).toEqual(['created AI Gateway "mine"']);

    const updated = cli({ env, cf: route({ ...wanted, zdr: false }) });
    expect(await main(["gateway"], updated.deps)).toBe(0);
    expect(updated.cf.map((x) => x.method)).toEqual(["GET", "PUT"]);
    expect(updated.out).toEqual(['updated AI Gateway "mine" to gork\'s settings']);

    const same = cli({ env, cf: route(wanted) });
    expect(await main(["gateway"], same.deps)).toBe(0);
    expect(same.cf.map((x) => x.method)).toEqual(["GET"]);
    expect(same.out).toEqual(['AI Gateway "mine" is already up to date']);
  });
});
