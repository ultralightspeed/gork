import { describe, expect, it } from "vitest";
import {
  commandStreamer,
  type Exec,
  engineRunner,
  engineStreamer,
  logVerdict,
  parserParity,
  SERVICE,
  serviceState,
  spawnExec,
  waitReady,
} from "../scripts/lib/compose.ts";
import { DOCKER, type Engine } from "../scripts/lib/engine.ts";
import { CliError } from "../scripts/lib/errors.ts";
import { fakeClock, fakeDocker } from "./helpers.ts";

const READY = "[gork] 2026-10-19T12:00:00.000Z ready as gork#1234 in 1 guild(s); budget today $0.0000/$0.5";
const FATAL = "[gork] FATAL config: DAILY_BUDGET_USD must be a non-negative number";

const PODMAN_COMPOSE: Engine = {
  name: "podman",
  label: "Podman",
  command: "podman",
  compose: ["podman-compose"],
  flavor: "podman-compose",
  version: "5.2.1",
};
const PODMAN: Engine = { ...PODMAN_COMPOSE, compose: ["podman", "compose"], flavor: "docker-compose" };

describe("logVerdict", () => {
  it("finds the ready line and the fatal line, and lets the later one win over stale ones", () => {
    expect(logVerdict(`noise\n${READY}\nmore`)).toEqual({ ready: READY });
    expect(logVerdict(`${FATAL}\nnoise`)).toEqual({
      fatal: "config",
      detail: "DAILY_BUDGET_USD must be a non-negative number",
    });
    expect(logVerdict(`${FATAL}\n${READY}`)).toEqual({ ready: READY });
    expect(logVerdict(`${READY}\n${FATAL}`)).toMatchObject({ fatal: "config" });
    // CRLF output and a hyphenated code.
    expect(logVerdict("[gork] FATAL discord-login: bad token\r\n")).toEqual({
      fatal: "discord-login",
      detail: "bad token",
    });
  });

  it("ignores other error text, however alarming", () => {
    expect(
      logVerdict("Missing required settings: X\nTokenInvalid\nAn invalid token was provided\nError: ready as"),
    ).toBeNull();
    expect(logVerdict("someone said [gork] FATAL x: y in chat")).toBeNull();
  });
});

describe("serviceState", () => {
  const row = (service: string, state: string) => ({ Service: service, State: state });

  it("reads both Compose output shapes (a JSON array, one object per line) and Podman's own rows, which name the service by label", () => {
    expect(serviceState(JSON.stringify([row("other", "running"), row(SERVICE, "exited")]))).toBe("exited");
    expect(
      serviceState(`${JSON.stringify(row("other", "running"))}\n${JSON.stringify(row(SERVICE, "restarting"))}\n`),
    ).toBe("restarting");
    const podman = [
      { State: "running", Labels: { "com.docker.compose.service": "other" } },
      { State: "Exited", Labels: { "com.docker.compose.service": SERVICE } },
    ];
    expect(serviceState(JSON.stringify(podman))).toBe("exited");
    expect(serviceState(JSON.stringify([{ State: "Running", Labels: { "io.podman.compose.service": SERVICE } }]))).toBe(
      "running",
    );
  });

  it("is undefined when there is no such container", () => {
    expect(serviceState("[]")).toBeUndefined();
    expect(serviceState(JSON.stringify(row("other", "running")))).toBeUndefined();
    expect(serviceState(JSON.stringify([{ State: "running", Labels: null }]))).toBeUndefined();
  });
});

describe("parserParity", () => {
  const ID = "0123456789abcdef0123456789abcdef";
  const env = { GUILD_IDS: "1,2", CF_ACCOUNT_ID: ID };
  const composed = (environment: Record<string, string>) =>
    fakeDocker(() => ({ out: JSON.stringify({ services: { [SERVICE]: { environment } } }) })).run;

  it("passes when Node and Compose read the routing keys alike (blank included), and names the keys that differ", () => {
    expect(() => parserParity(composed({ GUILD_IDS: "1,2", AI_GATEWAY_ID: "", CF_ACCOUNT_ID: ID }), env)).not.toThrow();
    expect(() => parserParity(composed({ GUILD_IDS: "1,2 # mine", CF_ACCOUNT_ID: ID }), env)).toThrow(/GUILD_IDS/);
    expect(() => parserParity(composed({ GUILD_IDS: "1,2", CF_ACCOUNT_ID: ID, AI_GATEWAY_ID: "x" }), env)).toThrow(
      /AI_GATEWAY_ID/,
    );
    expect(() => parserParity(composed({ GUILD_IDS: "1,2", CF_ACCOUNT_ID: `"${ID}"` }), env)).toThrow(/CF_ACCOUNT_ID/);
  });

  it("captures docker's output instead of printing it, and never echoes it when it can't be read (a secret on a misplaced line included)", () => {
    const d = fakeDocker(() => ({ out: '{"services": {"gork": {"environment": {"DISCORD_TOKEN": "SECRET-xyz" oops' }));
    const err = (() => {
      try {
        parserParity(d.run, {});
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err).toBeInstanceOf(CliError);
    expect(err?.message).not.toContain("SECRET");
    // `show` would send the whole configuration, secrets and all, straight to the terminal.
    expect(d.options[0]?.show).toBeFalsy();
  });

  it("reports a .env that Compose can't parse, naming the compose command that was used", () => {
    expect(() => parserParity(fakeDocker(() => ({ ok: false })).run, {})).toThrow(/^docker compose config failed/);
    expect(() => parserParity(fakeDocker(() => ({ out: "{" })).run, {}, PODMAN)).toThrow(/run `podman compose config`/);
  });

  it("is skipped under podman-compose, which can't print its configuration as JSON, and runs nothing", () => {
    const d = fakeDocker(() => ({ ok: false }));
    expect(() => parserParity(d.run, { GUILD_IDS: "1" }, PODMAN_COMPOSE)).not.toThrow();
    expect(d.calls).toEqual([]);
  });
});

describe("waitReady", () => {
  /**
   * An engine whose logs and container list behave as the real ones do where it matters: lines carry a container
   * prefix unless asked not to, `ps` hides stopped containers unless given --all, and podman-compose rejects --all.
   * One entry per poll (the last repeats).
   */
  function polls(logs: string[], states: Array<string | undefined> = [], engine: Engine = DOCKER) {
    const podmanCompose = engine.flavor === "podman-compose";
    let n = 0;
    let m = 0;
    return fakeDocker((args) => {
      if (args[1] === "logs") {
        const text = logs[Math.min(n++, logs.length - 1)];
        const prefixed = text
          .split("\n")
          .map((l) => `gork-1  | ${l}`)
          .join("\n");
        return { out: args.includes("--no-log-prefix") ? text : prefixed };
      }
      const state = states.length ? states[Math.min(m++, states.length - 1)] : undefined;
      if (!state) return { out: "" };
      if (podmanCompose && args.includes("--all")) return { ok: false };
      if (!podmanCompose && !args.includes("--all") && (state === "exited" || state === "dead")) return { out: "[]" };
      const row = podmanCompose
        ? { State: state, Labels: { "io.podman.compose.service": SERVICE } }
        : { Service: SERVICE, State: state };
      return { out: JSON.stringify([row]) };
    });
  }

  it("returns the ready line as soon as it appears", async () => {
    const { run, calls } = polls(["starting", `starting\n${READY}\n`]);
    expect(await waitReady(run, fakeClock())).toBe(READY);
    expect(calls.filter((c) => c[1] === "logs")).toHaveLength(2);
  });

  it("fails with the code and detail of a FATAL line", async () => {
    await expect(waitReady(polls([`booting\n${FATAL}`]).run, fakeClock())).rejects.toThrow(
      /failed to start \(config\): DAILY_BUDGET_USD must be a non-negative number/,
    );
  });

  it("fails when the container has stopped, including a crash loop, without waiting for the timeout (Docker and podman-compose)", async () => {
    for (const engine of [DOCKER, PODMAN_COMPOSE]) {
      for (const state of ["exited", "restarting", "dead"]) {
        const c = fakeClock();
        await expect(waitReady(polls(["Error: boom"], [state], engine).run, { ...c, engine })).rejects.toThrow(
          new RegExp(`container is ${state}.*boom`, "s"),
        );
        expect(c.now(), `${engine.compose.join(" ")} ${state}`).toBe(0);
      }
    }
  });

  it("keeps waiting while the container runs quietly, then times out", async () => {
    const c = fakeClock();
    await expect(waitReady(polls(["still starting"], ["running"]).run, { ...c, seconds: 30 })).rejects.toThrow(
      /did not report ready within 30s/,
    );
    expect(c.now()).toBeGreaterThanOrEqual(30_000);
  });

  it("keeps waiting, rather than crashing, when the container listing isn't JSON", async () => {
    const run = fakeDocker((args) => (args[1] === "ps" ? { out: "CONTAINER ID  IMAGE" } : { out: "starting" })).run;
    await expect(waitReady(run, { ...fakeClock(), seconds: 6 })).rejects.toThrow(/did not report ready/);
  });
});

describe("commandStreamer and spawnExec", () => {
  const node = commandStreamer(process.execPath);

  it("hands over each line of output and errors as it comes, passes extra environment, and says the command succeeded", async () => {
    const lines: string[] = [];
    const ok = await node(
      [
        "-e",
        "console.log('one'); console.error('two'); console.log(process.env.GORK_TEST_VAR); process.stdout.write('three\\r\\nfour')",
      ],
      (l) => lines.push(l),
      { env: { GORK_TEST_VAR: "seen" } },
    );
    expect(ok).toBe(true);
    expect(lines.sort()).toEqual(["four", "one", "seen", "three", "two"]);
  });

  it("is false for a non-zero exit, and for a program that isn't there", async () => {
    expect(await node(["-e", "process.exit(3)"], () => {})).toBe(false);
    expect(await commandStreamer("gork-no-such-program")(["x"], () => {})).toBe(false);
  });

  it("passes arguments to the program as they are: no shell reads them, so quotes, $() and & stay text", async () => {
    const hostile = `a & echo pwned; $(echo pwned) | "q" \`x\``;
    const script = "console.log(process.argv[1])";
    const lines: string[] = [];
    await node(["-e", script, hostile], (l) => lines.push(l));
    expect(lines).toEqual([hostile]);
    expect(spawnExec(process.execPath, ["-e", script, hostile], { show: false })).toEqual({
      ok: true,
      out: `${hostile}\n`,
    });
  });
});

describe("engineRunner and engineStreamer", () => {
  const scope = { files: ["compose.yaml", "c.yaml"], env: { GORK_IMAGE_REF: "r" } };

  it("run and stream the engine's own command line, with the compose files and environment given, and show output only when asked", async () => {
    const seen: Array<{ command: string; args: string[]; show: boolean; env?: Record<string, string> }> = [];
    const exec: Exec = (command, args, o) => {
      seen.push({ command, args, ...o });
      return { ok: true, out: "x" };
    };
    const run = engineRunner(PODMAN, exec);
    expect(run(["compose", "up", "-d"], { ...scope, show: true })).toEqual({ ok: true, out: "x" });
    run(["pull", "ghcr.io/x/y:1"], scope);
    expect(seen).toEqual([
      {
        command: "podman",
        args: ["compose", "-f", "compose.yaml", "-f", "c.yaml", "up", "-d"],
        show: true,
        env: { PODMAN_COMPOSE_WARNING_LOGS: "false", GORK_IMAGE_REF: "r" },
      },
      // Compose files and environment belong to compose only; a pull is not given them.
      { command: "podman", args: ["pull", "ghcr.io/x/y:1"], show: false, env: undefined },
    ]);

    const streamed: Array<{ command: string; args: string[]; env?: Record<string, string> }> = [];
    const stream = engineStreamer(PODMAN, async (command, args, onLine, env) => {
      streamed.push({ command, args, env });
      onLine("one");
      return true;
    });
    const lines: string[] = [];
    expect(await stream(["compose", "up"], (l) => lines.push(l), scope)).toBe(true);
    expect(lines).toEqual(["one"]);
    expect(streamed).toEqual([
      {
        command: "podman",
        args: ["compose", "-f", "compose.yaml", "-f", "c.yaml", "up"],
        env: { PODMAN_COMPOSE_WARNING_LOGS: "false", GORK_IMAGE_REF: "r" },
      },
    ]);
  });
});
