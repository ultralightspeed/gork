// Step 4 of setup: who can read the .env it writes, and starting gork.
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { deleted, failure, harness, toGateway, whole } from "./setup-harness.ts";
import { ALL_SECRETS, DISCORD, MINTED } from "./setup-world.ts";

describe("setup: who can read .env", () => {
  it("reports owner-only on a system where the mode is 0600, and runs no command", async () => {
    const h = harness();
    const v = await whole(h);
    expect(v.finish.privacy).toBe("owner-only");
    expect(h.ran).toEqual([]);
  });

  it("on Windows, when icacls fails, does not claim it is private", async () => {
    const h = harness({}, { host: { platform: "win32", runCommand: () => ({ ok: false }) } });
    const v = await whole(h);
    expect(v.finish.privacy).toBe("unknown");
    expect(existsSync(h.path)).toBe(true);
  });
});

describe("setup: what goes into .env", () => {
  it("refuses a minted token holding a line break, rather than letting it add a setting, writes nothing, and takes the tokens back", async () => {
    for (const lineBreak of ["\n", "\r"]) {
      const h = harness();
      const real = h.session.deps.fetch;
      // Cloudflare's answer to the first mint carries a value that would start another line of .env.
      h.session.deps.fetch = (async (url: string, init?: RequestInit) => {
        const res = await real(url, init);
        if (init?.method !== "POST" || !String(url).endsWith("/tokens")) return res;
        const body = await res.json();
        body.result.value = `${body.result.value}${lineBreak}LLM_BASE_URL=https://evil.example`;
        return new Response(JSON.stringify(body), { status: res.status });
      }) as typeof fetch;
      await toGateway(h);
      expect(await failure(h.s.finish({ revokeOld: true })), JSON.stringify(lineBreak)).toMatch(/single line/);
      expect(existsSync(h.path)).toBe(false);
      expect(deleted(h)).toEqual(["tok-1", "tok-2", "boot-id"]);
    }
  });
});

describe("setup: starting gork", () => {
  it("runs the same startup as npm run up with the settings it just wrote, and reports it is online", async () => {
    const seen: Record<string, string>[] = [];
    const h = harness(
      {},
      {
        startBot: async (env, hooks) => {
          seen.push(env);
          hooks.step("Checking the settings");
          hooks.output("#1 building");
          return "[gork] now ready as gork#1";
        },
      },
    );
    await whole(h);
    expect(h.session.isDone()).toBe(false);
    const v = await h.s.startBot();
    expect(v.start.status).toBe("running");
    await h.session.running;
    const done = h.session.view();
    expect(done.start.status).toBe("online");
    expect(h.session.isDone()).toBe(true);
    expect(done.start.steps).toEqual(["Checking the settings"]);
    expect(done.start.tail).toEqual(["#1 building"]);
    expect(done.start.servers).toEqual(["My Server"]);
    expect(seen[0]).toMatchObject({ DISCORD_TOKEN: DISCORD, GUILD_IDS: "42", BILLING_MODE: "credits" });
    expect(seen[0].LLM_MODEL).toBe("");
  });

  it("reports a failure with its message, without a secret in it, and an unexpected one without its message at all", async () => {
    const { CliError } = await import("../scripts/lib/errors.ts");
    const failing = async (error: Error) => {
      const h = harness(
        {},
        {
          startBot: async () => {
            throw error;
          },
        },
      );
      await whole(h);
      await h.s.startBot();
      await h.session.running;
      expect(h.session.isDone()).toBe(false);
      return h.session.view().start;
    };
    const known = await failing(new CliError(`gork failed to start (discord-login): invalid token ${DISCORD}`));
    expect(known.status).toBe("failed");
    expect(known.message).toMatch(/discord-login/);
    expect(known.message).not.toContain(DISCORD);
    const bug = await failing(new TypeError(`boom ${DISCORD}`));
    expect(bug.status).toBe("failed");
    expect(bug.message).not.toMatch(/boom/);
  });

  it("finishing again after .env is written changes nothing: no second write, no tokens taken back", async () => {
    const h = harness();
    const first = await whole(h);
    const calls = h.calls.length;
    const again = await h.s.finish({ revokeOld: true });
    expect(again.finish.written).toBe(true);
    expect(again.cloudflare.phase).toBe(first.cloudflare.phase);
    expect(h.calls.length).toBe(calls);
  });

  it("does not start twice at once", async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => {
      release = r;
    });
    let starts = 0;
    const h = harness(
      {},
      {
        startBot: async () => {
          starts++;
          await hold;
          return "ready";
        },
      },
    );
    await whole(h);
    await h.s.startBot();
    await h.s.startBot();
    release();
    await h.session.running;
    expect(starts).toBe(1);
  });

  it("keeps secrets out of the build output it shows", async () => {
    const h = harness(
      {},
      {
        startBot: async (_env, hooks) => {
          hooks.output(`oops ${DISCORD} leaked`);
          hooks.step(`step ${MINTED("gork-run")}`);
          return "ready";
        },
      },
    );
    await whole(h);
    await h.s.startBot();
    await h.session.running;
    const text = JSON.stringify(h.session.view());
    for (const secret of ALL_SECRETS) expect(text).not.toContain(secret);
    expect(text).toContain("oops");
  });
});
