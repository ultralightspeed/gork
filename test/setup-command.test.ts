// `npm run setup` as a command: starts the local server, opens the browser, prints the address, and when asked to start
// gork it runs the same `up` as `npm run up`. The real server and page run here; Discord, Cloudflare, Docker and the
// browser are fakes.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type Deps, main } from "../scripts/gork.ts";
import { SERVICE } from "../scripts/lib/compose.ts";
import { DOCKER, EngineMissingError } from "../scripts/lib/engine.ts";
import { IMAGE_REPO, packageVersion } from "../scripts/lib/image.ts";
import { fakeClock, fakeDocker, tempDir } from "./helpers.ts";
import { ACCT, ALL_SECRETS, BOOT, DISCORD, PERSONAS, type World, world } from "./setup-world.ts";

const READY = "[gork] 2026-10-19T12:00:00.000Z ready as gork#1234 in 1 guild(s); budget today $0.0000/$0.5";
const RELEASED = `${IMAGE_REPO}:${packageVersion()}`;
const CHOICES = { billing: "credits", persona: "default", mentions: "none", timezone: "UTC", budget: "" };
/** What the page posts, in order, from the answers to starting gork. */
const WALK = [
  ["choices", CHOICES],
  ["discord/token", { token: DISCORD }],
  ["discord/refresh", {}],
  ["discord/servers", { ids: ["42"] }],
  ["cloudflare/token", { token: BOOT, keepAdmin: true }],
  ["finish", { revokeOld: true }],
  ["start", {}],
] as const;

function rig(w: World = {}, over: Partial<Deps> = {}) {
  const dir = tempDir("gork-cmd-");
  const envPath = join(dir, ".env");
  const net = world(w);
  const out: string[] = [];
  const errors: string[] = [];
  const opened: string[] = [];
  const docker = fakeDocker((args) => {
    if (args[1] === "config") {
      return {
        out: JSON.stringify({
          services: { [SERVICE]: { environment: { GUILD_IDS: "42", CF_ACCOUNT_ID: ACCT, AI_GATEWAY_ID: "gork" } } },
        }),
      };
    }
    if (args[1] === "logs") return { out: READY };
    return {};
  });
  const streamed: string[][] = [];
  const handlers = new Set<() => void | Promise<void>>();
  const exits: number[] = [];
  const deps: Deps = {
    env: {},
    run: docker.run,
    fetch: net.f,
    ...fakeClock(),
    confirm: async () => "",
    log: (l) => out.push(l),
    warn: (l) => errors.push(l),
    envPath,
    personasDir: PERSONAS,
    host: { platform: "linux", username: "alice", runCommand: () => ({ ok: true }) },
    openBrowser: async (url) => {
      opened.push(url);
      return true;
    },
    stream: async (args, onLine) => {
      streamed.push(args);
      onLine("#1 building gork");
      return true;
    },
    onInterrupt: (h) => {
      handlers.add(h);
      return () => handlers.delete(h);
    },
    exit: (c) => exits.push(c),
    ...over,
  };
  const url = () => out.join("\n").match(/http:\/\/127\.0\.0\.1:\d+\/s\/[0-9a-f]+\//)?.[0] ?? "";
  const waitForUrl = async () => {
    for (let i = 0; i < 200 && !url(); i++) await new Promise((r) => setTimeout(r, 10));
    expect(url()).not.toBe("");
    return url();
  };
  let cookie = "";
  let app = "";
  /** A request as the page makes it, from the browser that opened the printed address (and got its cookie). */
  const api = async (path: string, data?: unknown) => {
    const base = await waitForUrl();
    if (!cookie) {
      const opened = await fetch(base, { redirect: "manual" });
      cookie = (opened.headers.get("set-cookie") ?? "").split(";")[0];
      app = opened.headers.get("location") ?? "";
    }
    const { origin } = new URL(base);
    const res = await fetch(`${origin}${app}api/${path}`, {
      method: data === undefined ? "GET" : "POST",
      headers: data === undefined ? { cookie } : { cookie, "content-type": "application/json", origin },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    return { status: res.status, body: await res.json() };
  };
  /** Posts the page's steps in order (all of them by default, up to starting gork), each of which must succeed. */
  const walk = async (steps = WALK.length) => {
    for (const [path, data] of WALK.slice(0, steps)) expect((await api(path, data)).status, path).toBe(200);
  };
  /** Waits until gork is no longer starting, and returns the page's view. */
  const started = async () => {
    let view = (await api("state")).body.view;
    for (let i = 0; i < 200 && view.start.status === "running"; i++) {
      await new Promise((res) => setTimeout(res, 10));
      view = (await api("state")).body.view;
    }
    return view;
  };
  return {
    deps,
    envPath,
    net,
    out,
    errors,
    opened,
    docker,
    streamed,
    handlers,
    exits,
    url,
    waitForUrl,
    api,
    walk,
    started,
  };
}

describe("the setup command", () => {
  it("starts the server, opens the browser at its address, prints the address, and ends when asked to close", async () => {
    const r = rig();
    const done = main(["setup"], r.deps);
    const url = await r.waitForUrl();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/s\/[0-9a-f]{64}\/$/);
    expect(r.opened).toEqual([url]);
    expect(r.out.join("\n")).toContain(url);
    expect((await r.api("state")).body.view.step).toBe("choices");
    expect((await r.api("close", {})).status).toBe(200);
    expect(await done).toBe(0);
    expect(existsSync(r.envPath)).toBe(false);
  });

  it("prints the address, and says it couldn't open the browser, when opening fails", async () => {
    const r = rig({}, { openBrowser: async () => false });
    const done = main(["setup"], r.deps);
    const url = await r.waitForUrl();
    expect(r.out.join("\n")).toMatch(/couldn't open (a|your) browser/i);
    expect(r.out.join("\n")).toContain(url);
    await r.api("close", {});
    expect(await done).toBe(0);
  });

  it("stops before opening anything when .env already exists, and leaves it alone", async () => {
    const r = rig();
    writeFileSync(r.envPath, "KEEP=me\n");
    expect(await main(["setup"], r.deps)).toBe(1);
    expect(r.errors.join("\n")).toMatch(/gork: .*already exists/);
    expect(readFileSync(r.envPath, "utf8")).toBe("KEEP=me\n");
    expect(r.opened).toEqual([]);
    expect(r.net.calls).toEqual([]);
    expect(r.out.join("\n")).not.toMatch(/127\.0\.0\.1/);
  });

  it("runs the same startup as npm run up, with what it just wrote, and streams its progress to the page", async () => {
    const r = rig();
    const done = main(["setup"], r.deps);
    await r.walk();
    const view = await r.started();
    expect(view.start.status).toBe("online");
    expect(view.start.steps).toContain(`Downloading the gork image (${RELEASED})`);
    // One line from the download and one from starting it: the fake engine says the same thing to both.
    expect(view.start.tail).toEqual(["#1 building gork", "#1 building gork"]);
    expect(view.start.servers).toEqual(["My Server"]);
    // The download and the start went through the streaming runner, with up's own arguments.
    expect(r.streamed).toEqual([
      ["pull", RELEASED],
      ["compose", "up", "-d", "--no-build", "--remove-orphans"],
    ]);
    expect(r.docker.calls.some((a) => a[1] === "up")).toBe(false);
    // The settings it ran with are the ones on disk, not anything from this process's environment (which is empty here).
    expect(r.deps.env).toEqual({});
    expect(readFileSync(r.envPath, "utf8")).toContain("GUILD_IDS=42");
    // Everything it says on the terminal is free of secrets.
    for (const secret of ALL_SECRETS) expect(r.out.join("\n")).not.toContain(secret);
    await r.api("close", {});
    expect(await done).toBe(0);
  });

  it("says the engine is missing, so the page can offer Retry, when there is no Docker or Podman to use", async () => {
    let dockerUp = false;
    const r = rig();
    r.deps.engine = () => {
      if (!dockerUp) throw new EngineMissingError("Docker Desktop isn't running. Start it, then retry.");
      return DOCKER;
    };
    const done = main(["setup"], r.deps);
    await r.walk();
    const view = await r.started();
    expect(view.start.status).toBe("docker");
    expect(view.start.message).toMatch(/Docker Desktop isn't running/);
    expect(r.streamed).toEqual([]);
    dockerUp = true;
    await r.api("start", {});
    expect((await r.started()).start.status).toBe("online");
    await r.api("close", {});
    await done;
  });
});

describe("the setup command with --no-open (driven by another program)", () => {
  it("opens no browser, prints the address and what the person must do, one line each, and ends with SETUP_STOPPED when closed early", async () => {
    const r = rig();
    const done = main(["setup", "--no-open"], r.deps);
    const url = await r.waitForUrl();
    expect(r.opened).toEqual([]);
    expect(r.out).toContain(`SETUP_URL=${url}`);
    expect(r.out).toContain(
      "USER_ACTION_REQUIRED: open the URL in your own browser and paste the tokens yourself (it works in one browser only: do not fetch it)",
    );
    await r.api("close", {});
    expect(await done).toBe(0);
    // Stopped before gork was online: never reported as done.
    expect(r.out).not.toContain("SETUP_DONE");
    expect(r.out.at(-1)).toBe("SETUP_STOPPED");
  });

  it("prints SETUP_DONE once gork is online and setup has closed", async () => {
    const r = rig();
    const done = main(["setup", "--no-open"], r.deps);
    await r.walk();
    expect((await r.started()).start.status).toBe("online");
    await r.api("close", {});
    expect(await done).toBe(0);
    expect(r.out.filter((l) => l.startsWith("SETUP_"))).toEqual([expect.stringMatching(/^SETUP_URL=/), "SETUP_DONE"]);
  });

  it("refuses an option it doesn't know, before starting anything", async () => {
    const r = rig();
    expect(await main(["setup", "--open-later"], r.deps)).toBe(1);
    expect(r.errors.join("\n")).toMatch(/unknown option --open-later.*--no-open/);
    expect(r.opened).toEqual([]);
    expect(r.out.join("\n")).not.toMatch(/127\.0\.0\.1/);
  });
});

describe("one setup at a time, and Ctrl-C", () => {
  it("refuses a second setup with a plain message, and frees the lock when the first ends", async () => {
    const first = rig();
    const done = main(["setup"], first.deps);
    await first.waitForUrl();
    const second = rig();
    second.deps.envPath = first.envPath;
    expect(await main(["setup"], second.deps)).toBe(1);
    expect(second.errors.join(" ")).toMatch(/gork: another .*setup.* already running/i);
    expect(second.opened).toEqual([]);
    expect(second.net.calls).toEqual([]);
    expect(existsSync(`${first.envPath}.setup-lock`)).toBe(true);
    await first.api("close", {});
    expect(await done).toBe(0);
    expect(existsSync(`${first.envPath}.setup-lock`)).toBe(false);
    const third = rig();
    third.deps.envPath = first.envPath;
    const again = main(["setup"], third.deps);
    await third.waitForUrl();
    await third.api("close", {});
    expect(await again).toBe(0);
  });

  it("frees the lock when Ctrl-C ends it", async () => {
    const r = rig({}, { openBrowser: async () => false });
    const done = main(["setup"], r.deps);
    await r.waitForUrl();
    await Promise.all([...r.handlers].map((h) => h()));
    expect(r.exits).toEqual([130]);
    expect(existsSync(`${r.envPath}.setup-lock`)).toBe(false);
    await r.api("close", {});
    await done;
  });
});
