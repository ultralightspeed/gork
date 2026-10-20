import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, onTestFinished } from "vitest";
import type { Run, RunOpts } from "../scripts/lib/compose.ts";
import { type Config, loadConfig } from "../src/config.ts";
import { newToolState, runTool } from "../src/tools.ts";

/** A valid config with only the required settings; pass env overrides (strings, as in .env) to change more. */
export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    DISCORD_TOKEN: "d",
    CF_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
    CF_RUN_TOKEN: "r",
    GUILD_IDS: "1",
    ...overrides,
  });
}

export type Call = { url: string; method: string; headers: Record<string, string>; body: any };

/** A fetch stand-in that records each call (body already parsed) and answers with `route`. */
export function fakeFetch(route: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    const call: Call = {
      url: String(url),
      method: init.method ?? "GET",
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    return route(call);
  }) as typeof fetch;
  return { f, calls };
}

/** runTool with fresh shared state; pass `state` in deps to keep it across calls (daily caps, read pacing). */
export const callTool = (cfg: Config, name: string, args: unknown, deps: Partial<Parameters<typeof runTool>[3]> = {}) =>
  runTool(cfg, name, args, { state: newToolState(cfg), ...deps });

export const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

/**
 * A container engine stand-in that records each call's arguments (and, in `options`, what it was run with: compose files,
 * extra environment, show) and answers with `route` (default: success, no output).
 */
export function fakeDocker(route: (args: string[]) => { ok?: boolean; out?: string } = () => ({})) {
  const calls: string[][] = [];
  const options: Array<RunOpts | undefined> = [];
  const run: Run = (args, opts) => {
    calls.push(args);
    options.push(opts);
    const r = route(args);
    return { ok: r.ok ?? true, out: r.out ?? "" };
  };
  return { run, calls, options };
}

/** A clock where sleeping just moves time forward, so waits cost nothing. */
export function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

/**
 * Timers that only run when the test moves time on: `schedule` has the shape of the `schedule` option the setup server
 * takes (start a timer, get back its cancel), and `advance(ms)` runs each timer that falls due, in order, letting what
 * it starts settle before the next.
 */
export function fakeTimers() {
  let now = 0;
  const pending = new Set<{ at: number; run: () => void }>();
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  return {
    schedule: (run: () => void, ms: number) => {
      const timer = { at: now + ms, run };
      pending.add(timer);
      return () => {
        pending.delete(timer);
      };
    },
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...pending].filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        pending.delete(due);
        now = due.at;
        due.run();
        await settle();
      }
      now = end;
      await settle();
    },
  };
}

/**
 * The shipped persona presets in a temp folder, without any local personas/custom.md, so tests behave the same in a
 * checkout that has its own custom persona.
 */
export function shippedPersonas(): string {
  const src = join(import.meta.dirname, "..", "personas");
  const dir = tempDir("gork-personas-");
  for (const f of readdirSync(src))
    if (f.endsWith(".md") && f !== "custom.md") copyFileSync(join(src, f), join(dir, f));
  return dir;
}

/** Folders made outside a test (at import time, or while collecting a describe), removed after the file's tests. */
const fileDirs: string[] = [];

function removeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* a file still held open (Windows): the system's temp clean-up gets it later */
  }
}

/**
 * A new folder under the system temp folder, removed once the test that made it has finished, or (when made outside a
 * test) once every test in the file has.
 */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    onTestFinished(() => removeDir(dir));
  } catch {
    if (fileDirs.length === 0) {
      afterAll(() => {
        for (const d of fileDirs.splice(0)) removeDir(d);
      });
    }
    fileDirs.push(dir);
  }
  return dir;
}
