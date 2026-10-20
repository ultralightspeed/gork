import { describe, expect, it } from "vitest";
import { cloudflareApi } from "../scripts/lib/gateway.ts";
import { Ledger } from "../scripts/lib/setup-cleanup.ts";
import { type Call, fakeFetch, json } from "./helpers.ts";

const ACCT = "0123456789abcdef0123456789abcdef";
const ok = (result: unknown = {}) => json({ success: true, result });

/** Cloudflare as the cleanup sees it: DELETEs succeed and the deleted token then verifies as 401, unless listed. */
function cf(over: { survives?: string[]; failDelete?: Record<string, number>; failGateway?: boolean } = {}) {
  const secrets = new Map([
    ["BOOT", "boot-id"],
    ["RUN", "run-id"],
    ["ADMIN", "admin-id"],
  ]);
  const dead = new Set<string>();
  const printed: string[] = [];
  const net = fakeFetch((c: Call) => {
    const token = (c.headers.Authorization ?? "").replace(/^Bearer /, "");
    if (c.url.endsWith("/tokens/verify")) {
      const id = secrets.get(token);
      return !id || dead.has(id) ? json({}, 401) : ok({ id, status: "active" });
    }
    if (c.method === "DELETE" && c.url.includes("/ai-gateway/")) {
      return over.failGateway ? json({}, 403) : ok();
    }
    if (c.method === "DELETE") {
      const id = c.url.split("/").pop() as string;
      const status = over.failDelete?.[id];
      if (status) return json({ success: false, errors: [] }, status);
      if (!over.survives?.includes(id)) dead.add(id);
      return ok({ id });
    }
    return json({}, 500);
  });
  const io = { print: (l: string) => printed.push(l), fetch: net.f };
  const order = () =>
    net.calls
      .filter((c) => c.method === "DELETE")
      .map((c) => (c.url.includes("/ai-gateway/") ? "gateway" : (c.url.split("/").pop() as string)));
  return { io, calls: net.calls, printed, text: () => printed.join("\n"), order };
}

function ledgerWith(c: ReturnType<typeof cf>, o: { bootstrapId?: string; gateway?: boolean } = {}) {
  const l = new Ledger();
  l.setBootstrap({ token: "BOOT", accountId: ACCT, id: o.bootstrapId ?? "boot-id", kind: "account" });
  l.addMinted({ name: "gork-run", id: "run-id", value: "RUN" });
  l.addMinted({ name: "gork-admin", id: "admin-id", value: "ADMIN" });
  if (o.gateway) l.setGateway(cloudflareApi(ACCT, "ADMIN", c.io.fetch), "gork");
  return l;
}

describe("Ledger.unwind", () => {
  it("removes the gateway it created, then the minted tokens, then the setup token", async () => {
    const c = cf();
    await ledgerWith(c, { gateway: true }).unwind(c.io);
    expect(c.order()).toEqual(["gateway", "run-id", "admin-id", "boot-id"]);
    expect(c.text()).toMatch(/Deleted the AI Gateway "gork" that setup created/);
    expect(c.text()).toMatch(/Removed the tokens setup created \(gork-run, gork-admin\)/);
    expect(c.text()).toMatch(/Deleted the setup token \(gork-setup\)/);
  });

  it("after commit (the .env is written) removes only the setup token", async () => {
    const c = cf();
    const l = ledgerWith(c, { gateway: true });
    l.commit();
    await l.unwind(c.io);
    expect(c.order()).toEqual(["boot-id"]);
  });

  it("does nothing the second time", async () => {
    const c = cf();
    const l = ledgerWith(c, { gateway: true });
    await l.unwind(c.io);
    const before = c.calls.length;
    await l.unwind(c.io);
    expect(c.calls.length).toBe(before);
  });

  it("waits for a creation still in flight, so what it makes is removed too and the setup token goes last", async () => {
    const c = cf();
    const l = new Ledger();
    l.setBootstrap({ token: "BOOT", accountId: ACCT, id: "boot-id", kind: "account" });
    let finish!: () => void;
    const slow = l.track(
      () =>
        new Promise<void>((resolve) => {
          finish = () => {
            l.addMinted({ name: "gork-run", id: "run-id", value: "RUN" });
            resolve();
          };
        }),
    );
    const unwinding = l.unwind(c.io);
    // Let every step that is not waiting on the creation run: it must have done nothing yet.
    await new Promise((resolve) => setImmediate(resolve));
    expect(c.calls).toEqual([]);
    finish();
    await slow;
    await unwinding;
    expect(c.order()).toEqual(["run-id", "boot-id"]);
  });

  it("carries on to the tokens when the gateway can't be deleted, and says where to delete it", async () => {
    const c = cf({ failGateway: true });
    await ledgerWith(c, { gateway: true }).unwind(c.io);
    expect(c.order()).toEqual(["gateway", "run-id", "admin-id", "boot-id"]);
    expect(c.text()).toMatch(/couldn't delete the AI Gateway "gork"/i);
    expect(c.text()).toContain("https://dash.cloudflare.com/?to=/:account/ai/ai-gateway");
  });

  it("names the setup token and the dashboard when its id is unknown, instead of guessing", async () => {
    const c = cf();
    await ledgerWith(c, { bootstrapId: "" }).unwind(c.io);
    expect(c.order()).toEqual(["run-id", "admin-id"]);
    expect(c.text()).toMatch(/gork-setup/);
    expect(c.text()).toMatch(/still active/i);
  });

  it("does not call a token removed when it still works afterwards", async () => {
    const c = cf({ survives: ["admin-id"] });
    await ledgerWith(c).unwind(c.io);
    expect(c.text()).toMatch(/still active/i);
    expect(c.text()).toContain("gork-admin");
    expect(c.text()).not.toMatch(/Removed the tokens setup created \(gork-run, gork-admin\)/);
  });
});

describe("Ledger.interrupt", () => {
  it("the first Ctrl-C waits for what is being made, takes it back and exits 130; a second one exits at once", async () => {
    const c = cf();
    const l = new Ledger();
    l.setBootstrap({ token: "BOOT", accountId: ACCT, id: "boot-id", kind: "account" });
    let release!: () => void;
    void l.track(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const exits: number[] = [];
    const io = { ...c.io, exit: (code: number) => exits.push(code) };
    const first = l.interrupt(io);
    await l.interrupt(io);
    expect(exits).toEqual([130]);
    expect(c.calls).toEqual([]);
    release();
    await first;
    expect(exits).toEqual([130, 130]);
    expect(c.order()).toEqual(["boot-id"]);
  });
});
