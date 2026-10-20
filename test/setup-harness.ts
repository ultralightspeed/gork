// The setup session driven the way the page drives it, against the fake Discord and Cloudflare in setup-world.ts:
// the harness and helpers every setup step test shares.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import type { HostOps } from "../scripts/lib/env-file.ts";
import { parseEnvText, type SetupDeps, SetupSession } from "../scripts/lib/setup-session.ts";
import { tempDir } from "./helpers.ts";
import { BOOT, DISCORD, PERSONAS, type World, world } from "./setup-world.ts";

export const TOKENS_LINK = "https://dash.cloudflare.com/?to=/:account/api-tokens";
export const GATEWAYS_LINK = "https://dash.cloudflare.com/?to=/:account/ai/ai-gateway";

export const CHOICES = { billing: "credits", persona: "default", mentions: "none", timezone: "UTC", budget: "" };
export type Over = Partial<typeof CHOICES>;

export function harness(
  w: World = {},
  over: { host?: Partial<HostOps>; startBot?: SetupDeps["startBot"]; envPath?: string; personasDir?: string } = {},
) {
  const dir = tempDir("gork-setup-");
  const path = over.envPath ?? join(dir, ".env");
  const net = world(w);
  const printed: string[] = [];
  /** Everything the session ever handed back (views, errors), as text: nothing in it may be a secret. */
  const out: string[] = [];
  const ran: { command: string; args: string[] }[] = [];
  const exits: number[] = [];
  let t = 0;
  const host: HostOps = {
    platform: "linux",
    username: "alice",
    runCommand: (command, args) => {
      ran.push({ command, args });
      return { ok: true };
    },
    ...over.host,
  };
  const session = new SetupSession({
    fetch: net.f,
    now: () => (t += 5000),
    envPath: path,
    personasDir: over.personasDir ?? PERSONAS,
    host,
    print: (l) => printed.push(l),
    exit: (code) => exits.push(code),
    startBot: over.startBot ?? (async () => "[gork] ready as gork#1 in 1 guild(s)"),
  });
  // The page sees only what these return, so record all of it.
  const s = new Proxy(session, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== "function") return v;
      return async (...args: unknown[]) => {
        try {
          const r = await v.apply(target, args);
          out.push(JSON.stringify(r) ?? "");
          return r;
        } catch (err) {
          out.push((err as Error).message);
          throw err;
        }
      };
    },
  }) as SetupSession;
  return {
    s,
    session,
    path,
    calls: net.calls,
    printed,
    out,
    ran,
    exits,
    text: () => [...printed, ...out].join("\n"),
  };
}
export type H = ReturnType<typeof harness>;

/** Steps 1 and 2: choices, then a Discord token, the public-bot check and the confirmed server. */
export async function toCloudflare(h: H, o: { choices?: Over; discord?: string } = {}) {
  await h.s.saveChoices({ ...CHOICES, ...o.choices });
  await h.s.discordToken(o.discord ?? DISCORD);
  await h.s.discordRefresh();
  await h.s.confirmServers(["42"]);
}
/** Through the Cloudflare card, up to its gateway question or the probes. */
export async function toGateway(h: H, o: { choices?: Over; keepAdmin?: boolean; boot?: string } = {}) {
  await toCloudflare(h, o);
  return h.s.cloudflareToken(o.boot ?? BOOT, o.keepAdmin ?? true);
}
export async function whole(h: H, o: { choices?: Over; keepAdmin?: boolean; revokeOld?: boolean } = {}) {
  await toGateway(h, o);
  return h.s.finish({ revokeOld: o.revokeOld ?? true });
}

export const readEnv = (path: string) => parseEnvText(readFileSync(path, "utf8"));

export const failure = async (p: Promise<unknown>) => {
  const err = await p.then(
    () => null,
    (e) => e,
  );
  expect(err).toBeInstanceOf(Error);
  return (err as Error).message;
};
export const deleted = (h: H) =>
  h.calls.filter((c) => c.method === "DELETE" && c.url.includes("/tokens/")).map((c) => c.url.split("/").pop());
export const verifyCalls = (h: H, token: string) =>
  h.calls.filter((c) => c.url.endsWith("/tokens/verify") && c.headers.Authorization === `Bearer ${token}`);
export const gatewayCalls = (h: H, method: string) =>
  h.calls.filter((c) => c.method === method && c.url.includes("/ai-gateway/gateways"));
