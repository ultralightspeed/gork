// Step 3 of setup: the setup token, gork's two tokens, the AI Gateway, credits, and taking it all back.
import { existsSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { gatewaySpec } from "../scripts/lib/gateway.ts";
import { suggestGatewayName } from "../scripts/lib/setup-session.ts";
import { SETTINGS } from "../src/config.ts";
import { json } from "./helpers.ts";
import {
  deleted,
  failure,
  GATEWAYS_LINK,
  gatewayCalls,
  type H,
  harness,
  readEnv,
  TOKENS_LINK,
  toCloudflare,
  toGateway,
  verifyCalls,
  whole,
} from "./setup-harness.ts";
import { ACCT, ALL_SECRETS, BOOT, BOOT2, DISCORD, GROUPS, MINTED, refused, type World } from "./setup-world.ts";

describe("setup: pasted Cloudflare secrets are shape-checked before they are sent", () => {
  it("refuses a Cloudflare token with dots (a Discord token pasted on the wrong line), or an empty one, without sending it", async () => {
    const h = harness();
    await toCloudflare(h);
    const before = h.calls.length;
    expect(await failure(h.s.cloudflareToken(DISCORD, true))).toMatch(/doesn't look like a Cloudflare API token/);
    expect(await failure(h.s.cloudflareToken("  ", true))).toMatch(/paste/i);
    expect(h.calls.length).toBe(before);
    expect(h.text()).not.toContain(DISCORD);
    await h.s.cloudflareToken(BOOT, true);
  });
});

describe("setup: Cloudflare", () => {
  it("asks which account when the token sees several, and refuses one it didn't list", async () => {
    const work = "fedcba9876543210fedcba9876543210";
    const accounts = [
      { id: ACCT, name: "Me" },
      { id: work, name: "Work" },
    ];
    const h = harness({ accounts, account: work });
    await toCloudflare(h);
    const v = await h.s.cloudflareToken(BOOT, true);
    expect(v.cloudflare.phase).toBe("account");
    expect(v.cloudflare.accounts).toEqual(accounts);
    expect(await failure(h.s.cloudflareAccount("0".repeat(32)))).toMatch(/account/i);
    await h.s.cloudflareAccount(work);
    await h.s.finish({ revokeOld: true });
    expect(readEnv(h.path).CF_ACCOUNT_ID).toBe(work);
  });

  it("takes the account from a pasted dashboard URL when the token can't list accounts", async () => {
    const h = harness({ accountsStatus: 403 });
    await toCloudflare(h);
    const v = await h.s.cloudflareToken(BOOT, true);
    expect(v.cloudflare.phase).toBe("account");
    expect(v.cloudflare.accountProblem).toMatch(/account ID/i);
    expect(await failure(h.s.cloudflareAccount("nonsense"))).toMatch(/32-character/);
    await h.s.cloudflareAccount(`https://dash.cloudflare.com/${ACCT}/api-tokens`);
    await h.s.finish({ revokeOld: true });
    expect(readEnv(h.path).CF_ACCOUNT_ID).toBe(ACCT);
  });

  it("asks again after a rejected setup token, without having made anything", async () => {
    const h = harness();
    await toCloudflare(h);
    const real = h.session.deps.fetch;
    h.session.deps.fetch = (async (url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";
      if (auth === "Bearer badtoken") return refused(401);
      return real(url, init);
    }) as typeof fetch;
    expect(await failure(h.s.cloudflareToken("badtoken", true))).toMatch(/rejected that token/);
    expect(h.calls.some((c) => c.method === "POST" || c.method === "DELETE")).toBe(false);
    await h.s.cloudflareToken(BOOT, true);
    await h.s.finish({ revokeOld: true });
    expect(existsSync(h.path)).toBe(true);
  });

  it("names every missing permission group, creates nothing, and says to make a new setup token", async () => {
    const h = harness({ groups: GROUPS.filter((g) => !/Run|Websearch/.test(g.name)) });
    await toCloudflare(h);
    const msg = await failure(h.s.cloudflareToken(BOOT, true));
    expect(msg).toMatch(/AI Gateway run/);
    expect(msg).toMatch(/web search/);
    expect(h.calls.some((c) => c.method === "POST" && c.url.endsWith("/tokens"))).toBe(false);
    expect(existsSync(h.path)).toBe(false);
    const v = h.session.view();
    expect(v.cloudflare.needNewToken).toBe(true);
    expect(v.cloudflare.failure).toMatch(/AI Gateway run/);
    expect(deleted(h)).toEqual(["boot-id"]);
  });

  it("takes back what it made, setup token included, when the admin token can't be made or the gateway can't be created, and writes nothing", async () => {
    const noAdmin = harness({ failMint: 2 });
    await toCloudflare(noAdmin);
    expect(await failure(noAdmin.s.cloudflareToken(BOOT, true))).toMatch(/gork-admin/);
    const del = noAdmin.calls.filter((c) => c.method === "DELETE");
    expect(del.map((c) => c.url.split("/").pop())).toEqual(["tok-1", "boot-id"]);
    expect(del[0].headers.Authorization).toBe(`Bearer ${BOOT}`);
    for (const secret of ALL_SECRETS) expect(noAdmin.text()).not.toContain(secret);

    const noGateway = harness({ gatewayStatus: 403 });
    await toCloudflare(noGateway);
    await failure(noGateway.s.cloudflareToken(BOOT, true));
    expect(deleted(noGateway)).toEqual(["tok-1", "tok-2", "boot-id"]);

    for (const h of [noAdmin, noGateway]) expect(existsSync(h.path)).toBe(false);
  });

  it("won't take a second setup token while the first one's step is under way, so a repeat can't make two sets of keys", async () => {
    const h = harness();
    await toGateway(h);
    const posts = () => h.calls.filter((c) => c.method === "POST" && c.url.endsWith("/tokens")).length;
    expect(posts()).toBe(2);
    expect(await failure(h.s.cloudflareToken(BOOT2, true))).toMatch(/already under way/);
    expect(posts()).toBe(2);
  });

  it("after a failure, a new setup token starts the Cloudflare step cleanly", async () => {
    const w: World = { failMint: 2 };
    const h = harness(w);
    await toCloudflare(h);
    await failure(h.s.cloudflareToken(BOOT, true));
    w.failMint = undefined;
    const v = await h.s.cloudflareToken(BOOT2, true);
    expect(v.cloudflare.phase).toBe("ready");
    expect(v.cloudflare.failure).toBeNull();
  });

  it("warns, rather than failing, if the setup token can't be deleted after .env is written, or its id can't be found", async () => {
    const refused = harness({ deleteBootstrapStatus: 403 });
    const v = await whole(refused);
    expect(existsSync(refused.path)).toBe(true);
    expect(v.finish.setupToken).toBe("still-active");
    expect(v.finish.notes.join("\n")).toMatch(/couldn't delete the setup token/i);
    expect(v.finish.notes.join("\n")).toContain(TOKENS_LINK);

    const noId = harness({ verifyStatus: 403 });
    const w = await whole(noId);
    expect(existsSync(noId.path)).toBe(true);
    expect(noId.calls.some((c) => c.method === "DELETE" && c.url.endsWith("/boot-id"))).toBe(false);
    expect(w.finish.setupToken).toBe("still-active");
  });

  it("still lets you finish when a probe fails, and shows what is missing", async () => {
    const h = harness({ chat: () => refused(403) });
    const v = await toGateway(h);
    expect(v.cloudflare.probes.some((p) => !p.ok)).toBe(true);
    expect(JSON.stringify(v.cloudflare.probes)).toMatch(/missing: AI Gateway Read, AI Gateway Run, Workers AI Read/);
    await h.s.finish({ revokeOld: true });
    expect(existsSync(h.path)).toBe(true);
  });
});

describe("setup: starting the Cloudflare step over", () => {
  it("takes back the tokens, the gateway it made and the setup token, then asks for a new setup token", async () => {
    const h = harness();
    await toGateway(h);
    const v = await h.s.cloudflareReset();
    expect(deleted(h)).toEqual(["tok-1", "tok-2", "boot-id"]);
    expect(h.calls.filter((c) => c.method === "DELETE" && c.url.includes("/ai-gateway/gateways/gork"))).toHaveLength(1);
    expect(v.cloudflare.phase).toBe("token");
    expect(v.cloudflare.needNewToken).toBe(true);
    expect((await h.s.cloudflareToken(BOOT2, true)).cloudflare.phase).toBe("ready");
  });

  it("does nothing when there is nothing to take back, and refuses once setup is finished", async () => {
    const h = harness();
    await toCloudflare(h);
    await h.s.cloudflareReset();
    expect(h.calls.filter((c) => c.method === "DELETE")).toEqual([]);
    await h.s.cloudflareToken(BOOT, true);
    await h.s.finish({ revokeOld: true });
    expect(await failure(h.s.cloudflareReset())).toMatch(/finished/i);
  });
});

describe("setup: credits that aren't there yet", () => {
  const noCredits = () => json({ success: false, errors: [{ code: 1, message: "insufficient credit balance" }] }, 402);

  it("notices when the probes say there are no credits, offers the link, and still lets you finish with .env written", async () => {
    const h = harness({ chat: noCredits });
    const v = await toGateway(h);
    expect(v.cloudflare.needsCredits).toBe(true);
    expect(v.links.credits).toBe(GATEWAYS_LINK);
    await h.s.finish({ revokeOld: true });
    expect(existsSync(h.path)).toBe(true);
  });

  it("keeps checking, free of charge, and clears itself once credits appear", async () => {
    let has = false;
    const w: World = { chat: () => (has ? json({ choices: [{ message: { content: "hi" } }] }) : noCredits()) };
    const h = harness(w);
    await toGateway(h);
    const searches = () => h.calls.filter((c) => c.url.endsWith("/ai/websearch")).length;
    expect(searches()).toBe(1);
    const still = await h.s.creditsRecheck();
    expect(still.cloudflare.needsCredits).toBe(true);
    expect(searches()).toBe(1);
    has = true;
    const now = await h.s.creditsRecheck();
    expect(now.cloudflare.needsCredits).toBe(false);
    expect(now.cloudflare.probes.every((p) => p.ok)).toBe(true);
  });

  it("doesn't hit Cloudflare more often than every few seconds", async () => {
    const h = harness({ chat: noCredits });
    await toGateway(h);
    let t = 0;
    h.session.deps.now = () => t;
    await h.s.creditsRecheck();
    const n = h.calls.length;
    t += 1000;
    await h.s.creditsRecheck();
    expect(h.calls.length).toBe(n);
  });
});

describe("setup: deleting the setup token", () => {
  it("says it is deleted only after Cloudflare has stopped accepting the token", async () => {
    const h = harness();
    const v = await whole(h);
    const del = h.calls.findIndex((c) => c.method === "DELETE" && c.url.endsWith("/boot-id"));
    const after = h.calls.findIndex((c, i) => i > del && c.url.endsWith("/tokens/verify"));
    expect(del).toBeGreaterThan(-1);
    expect(after).toBeGreaterThan(del);
    expect(h.calls[after].headers.Authorization).toBe(`Bearer ${BOOT}`);
    expect(v.finish.setupToken).toBe("deleted");
  });

  it("does not say deleted when the delete went through, or Cloudflare answered 404, but the token still works", async () => {
    const survives = harness({ survives: ["boot-id"] });
    const v = await whole(survives);
    expect(v.finish.setupToken).toBe("still-active");
    expect(v.finish.notes.join("\n")).toMatch(/still works|still active/i);
    expect(existsSync(survives.path)).toBe(true);

    const notFound = harness({ deleteStatus: { "boot-id": 404 } });
    const w = await whole(notFound);
    expect(w.finish.setupToken).toBe("still-active");

    for (const notes of [v.finish.notes, w.finish.notes]) expect(notes.join("\n")).toContain(TOKENS_LINK);
  });

  it("deletes a user-owned setup token at /user/tokens, the endpoint that matches the one that verified it", async () => {
    const h = harness({ userBootstrap: true });
    const v = await whole(h);
    const del = h.calls.filter((c) => c.method === "DELETE");
    expect(del.map((c) => c.url)).toEqual([`https://api.cloudflare.com/client/v4/user/tokens/boot-id`]);
    expect(v.finish.setupToken).toBe("deleted");
  });
});

describe("setup: cleaning up the tokens it just made", () => {
  it("confirms each one is dead before saying it removed it", async () => {
    const h = harness({ gatewayStatus: 403 });
    await toCloudflare(h);
    await failure(h.s.cloudflareToken(BOOT, true));
    expect(deleted(h)).toEqual(["tok-1", "tok-2", "boot-id"]);
    expect(verifyCalls(h, MINTED("gork-run")).length).toBeGreaterThan(0);
    expect(verifyCalls(h, MINTED("gork-admin")).length).toBeGreaterThan(0);
    expect(h.text()).toMatch(/Removed the tokens setup created \(gork-run, gork-admin\)/);
    expect(h.text()).not.toMatch(/still active/i);
  });

  it("names exactly the tokens that remain, with the dashboard link, when a delete fails or succeeds while the token still works", async () => {
    const refused = harness({ gatewayStatus: 403, deleteStatus: { "tok-1": 403 } });
    await toCloudflare(refused);
    await failure(refused.s.cloudflareToken(BOOT, true));
    expect(refused.text()).toMatch(/still active.*gork-run|gork-run.*still active/i);
    expect(refused.text()).toContain("tok-1");
    expect(refused.text()).toContain(TOKENS_LINK);
    expect(refused.text()).toMatch(/Removed the tokens setup created \(gork-admin\)/);
    expect(refused.text()).not.toMatch(/Removed the tokens setup created \(gork-run/);
    for (const secret of ALL_SECRETS) expect(refused.text()).not.toContain(secret);

    // A delete Cloudflare accepted is not trusted until the token stops working.
    const survives = harness({ gatewayStatus: 403, survives: ["tok-2"] });
    await toCloudflare(survives);
    await failure(survives.s.cloudflareToken(BOOT, true));
    expect(survives.text()).toMatch(/still active.*gork-admin|gork-admin.*still active/i);
    expect(survives.text()).toContain(TOKENS_LINK);
  });

  it("says, with the link, when the setup token can't be deleted after a failure", async () => {
    const h = harness({ groups: GROUPS.filter((g) => !/Run|Websearch/.test(g.name)), deleteBootstrapStatus: 403 });
    await toCloudflare(h);
    await failure(h.s.cloudflareToken(BOOT, true));
    expect(h.text()).toMatch(/couldn't delete the setup token/i);
    expect(h.text()).toContain(TOKENS_LINK);
  });
});

describe("setup: the gateway it created", () => {
  it("is deleted again, before the tokens, when setup fails after creating it", async () => {
    const h = harness();
    await toGateway(h);
    writeFileSync(h.path, "RACE=1\n");
    await failure(h.s.finish({ revokeOld: true }));
    const order = h.calls
      .filter((c) => c.method === "DELETE")
      .map((c) => (c.url.includes("/ai-gateway/") ? "gateway" : (c.url.split("/").pop() as string)));
    expect(order).toEqual(["gateway", "tok-1", "tok-2", "boot-id"]);
    const del = h.calls.find((c) => c.method === "DELETE" && c.url.includes("/ai-gateway/gateways/gork"));
    expect(del?.headers.Authorization).toBe(`Bearer ${MINTED("gork-admin")}`);
    expect(h.text()).toMatch(/Deleted the AI Gateway "gork" that setup created/);
  });

  it("is reported honestly, with the dashboard link, when it can't be deleted", async () => {
    const h = harness({ deleteGatewayStatus: 403 });
    await toGateway(h);
    writeFileSync(h.path, "RACE=1\n");
    await failure(h.s.finish({ revokeOld: true }));
    expect(h.text()).toMatch(/couldn't delete the AI Gateway "gork"/i);
    expect(h.text()).toContain(GATEWAYS_LINK);
    expect(deleted(h)).toEqual(["tok-1", "tok-2", "boot-id"]);
  });
});

describe("setup: a gateway that already exists", () => {
  const theirs = { workers_ai_billing_mode: "standard", authentication: false, zdr: false, collect_logs: true };
  const conflict = () => harness({ gateways: { gork: theirs } });

  it("shows its current settings and waits, instead of overwriting it silently", async () => {
    const h = conflict();
    const v = await toGateway(h);
    expect(v.cloudflare.phase).toBe("gateway");
    expect(v.cloudflare.gateway?.id).toBe("gork");
    const lines = (v.cloudflare.gateway?.summary ?? []).join("\n");
    expect(lines).toMatch(/billing: standard/);
    expect(lines).toMatch(/authentication: off/);
    expect(lines).toMatch(/zero data retention: off/);
    expect(gatewayCalls(h, "PUT")).toEqual([]);
    expect(gatewayCalls(h, "POST")).toEqual([]);
    expect(v.cloudflare.probes).toEqual([]);
  });

  it("cancel takes back the tokens and the setup token, and never touches the gateway", async () => {
    const h = conflict();
    await toGateway(h);
    const v = await h.s.gatewayChoice({ action: "cancel" });
    expect(deleted(h)).toEqual(["tok-1", "tok-2", "boot-id"]);
    expect(h.calls.some((c) => c.method === "DELETE" && c.url.includes("/ai-gateway/"))).toBe(false);
    expect(gatewayCalls(h, "PUT")).toEqual([]);
    expect(v.cloudflare.needNewToken).toBe(true);
    expect(v.cloudflare.failure).toMatch(/nothing of yours was changed/i);
    expect(v.cloudflare.failureNotes.join(" ")).toMatch(/Deleted the setup token/);
    expect(existsSync(h.path)).toBe(false);
  });

  it("overwrites it only when you say overwrite", async () => {
    const h = conflict();
    await toGateway(h);
    const v = await h.s.gatewayChoice({ action: "overwrite" });
    const put = gatewayCalls(h, "PUT");
    expect(put).toHaveLength(1);
    expect(put[0].body.authentication).toBe(true);
    expect(put[0].headers.Authorization).toBe(`Bearer ${MINTED("gork-admin")}`);
    expect(v.cloudflare.phase).toBe("ready");
    await h.s.finish({ revokeOld: true });
    expect(readEnv(h.path).AI_GATEWAY_ID).toBe("gork");
  });

  it("can use a different id (trimmed) instead, leaving the existing gateway alone, and writes it to .env", async () => {
    const h = conflict();
    await toGateway(h);
    await h.s.gatewayChoice({ action: "new", newId: "  gork-two  " });
    expect(gatewayCalls(h, "PUT")).toEqual([]);
    const post = gatewayCalls(h, "POST");
    expect(post).toHaveLength(1);
    expect(post[0].body.id).toBe("gork-two");
    await h.s.finish({ revokeOld: true });
    expect(readEnv(h.path).AI_GATEWAY_ID).toBe("gork-two");
    const chat = h.calls.find((c) => c.url.endsWith("/ai/v1/chat/completions"));
    expect(chat?.headers["cf-aig-gateway-id"]).toBe("gork-two");
  });

  it("refuses an id that isn't a safe slug, and stays on the question", async () => {
    const h = conflict();
    await toGateway(h);
    for (const bad of ["../tokens", "has space", "", "-x"]) {
      expect(await failure(h.s.gatewayChoice({ action: "new", newId: bad }))).toMatch(/letters, digits and hyphens/);
    }
    expect(h.calls.some((c) => c.url.includes(".."))).toBe(false);
    expect(h.session.view().cloudflare.phase).toBe("gateway");
    expect(deleted(h)).toEqual([]);
  });

  it("asks again when the new id exists too", async () => {
    const h = harness({ gateways: { gork: theirs, "gork-two": theirs } });
    await toGateway(h);
    const v = await h.s.gatewayChoice({ action: "new", newId: "gork-two" });
    expect(v.cloudflare.phase).toBe("gateway");
    expect(v.cloudflare.gateway?.id).toBe("gork-two");
    await h.s.gatewayChoice({ action: "overwrite" });
    expect(gatewayCalls(h, "PUT").map((c) => c.url.split("/").pop())).toEqual(["gork-two"]);
  });

  it("refuses an action it doesn't know, and one that comes when nothing is waiting", async () => {
    const h = conflict();
    await toGateway(h);
    expect(await failure(h.s.gatewayChoice({ action: "yolo" as "cancel" }))).toMatch(/overwrite|different|cancel/i);
    const calm = harness();
    await toGateway(calm);
    expect(await failure(calm.s.gatewayChoice({ action: "overwrite" }))).toMatch(/first|nothing/i);
  });

  it("never deletes a gateway that existed before, even if setup fails later", async () => {
    const h = conflict();
    await toGateway(h);
    await h.s.gatewayChoice({ action: "overwrite" });
    writeFileSync(h.path, "RACE=1\n");
    await failure(h.s.finish({ revokeOld: true }));
    expect(h.calls.some((c) => c.method === "DELETE" && c.url.includes("/ai-gateway/"))).toBe(false);
    expect(deleted(h)).toEqual(["tok-1", "tok-2", "boot-id"]);
  });

  it("deletes only the new gateway it made when it used a different id and then failed", async () => {
    const h = conflict();
    await toGateway(h);
    await h.s.gatewayChoice({ action: "new", newId: "gork-two" });
    writeFileSync(h.path, "RACE=1\n");
    await failure(h.s.finish({ revokeOld: true }));
    const gw = h.calls.filter((c) => c.method === "DELETE" && c.url.includes("/ai-gateway/"));
    expect(gw.map((c) => c.url.split("/").pop())).toEqual(["gork-two"]);
  });

  it("leaves the gateway as it was when it already had gork's settings", async () => {
    const h = harness({ gateways: { gork: gatewaySpec({ budgetUsd: 0.5 }) } });
    await toGateway(h);
    await h.s.gatewayChoice({ action: "overwrite" });
    expect(gatewayCalls(h, "PUT")).toEqual([]);
    expect(h.text()).toMatch(/already had gork's settings/);
  });
});

describe("setup: gork tokens left over from earlier runs", () => {
  const old = [
    { id: "old-run", name: "gork-run", status: "active" },
    { id: "old-admin", name: "gork-admin", status: "active" },
    { id: "other", name: "my-other-token", status: "active" },
    { id: "boot-id", name: "gork-setup", status: "active" },
  ];
  const oldDeletes = (h: H) =>
    h.calls.filter((c) => c.method === "DELETE" && /old-/.test(c.url)).map((c) => c.url.split("/").pop());

  it("lists only the gork-run and gork-admin ones, found with the setup token before new ones are made", async () => {
    const h = harness({ existingTokens: old });
    const v = await toGateway(h);
    expect(v.cloudflare.older).toEqual([
      { id: "old-run", name: "gork-run" },
      { id: "old-admin", name: "gork-admin" },
    ]);
    const list = h.calls.findIndex((c) => c.method === "GET" && c.url.includes(`/accounts/${ACCT}/tokens?`));
    const mint = h.calls.findIndex((c) => c.method === "POST" && c.url.endsWith("/tokens"));
    expect(list).toBeGreaterThan(-1);
    expect(list).toBeLessThan(mint);
    expect(h.calls[list].headers.Authorization).toBe(`Bearer ${BOOT}`);
  });

  it("revokes them when asked, after .env is written and before the setup token (which it needs to do so) is deleted, never the ones it just made, and reports what happened", async () => {
    const w: World = { existingTokens: old };
    let envExisted: boolean | null = null;
    const h = harness(w);
    w.onDelete = (id) => {
      if (id === "old-run") envExisted ??= existsSync(h.path);
    };
    const v = await whole(h, { revokeOld: true });
    expect(envExisted).toBe(true);
    expect(v.finish.oldTokens).toEqual({ revoked: 2, left: [] });
    expect(h.calls.filter((c) => c.method === "DELETE").map((c) => c.url.split("/").pop())).toEqual([
      "old-run",
      "old-admin",
      "boot-id",
    ]);
    const del = h.calls.filter((c) => c.method === "DELETE" && /old-/.test(c.url));
    for (const c of del) expect(c.headers.Authorization).toBe(`Bearer ${BOOT}`);
  });

  it("leaves them alone when you say no, and says where to delete them", async () => {
    const h = harness({ existingTokens: old });
    const v = await whole(h, { revokeOld: false });
    expect(oldDeletes(h)).toEqual([]);
    expect(v.finish.oldTokens).toBeNull();
  });

  it("names the ones it could not revoke instead of claiming success", async () => {
    const h = harness({ existingTokens: old, deleteStatus: { "old-admin": 403 } });
    const v = await whole(h);
    expect(v.finish.oldTokens?.revoked).toBe(1);
    expect(v.finish.oldTokens?.left.join("\n")).toMatch(/"gork-admin" \(id old-admin\)/);
    expect(existsSync(h.path)).toBe(true);
  });

  it("does not revoke anything when setup fails, so nothing old is touched", async () => {
    const h = harness({ existingTokens: old, gatewayStatus: 403 });
    await toCloudflare(h);
    await failure(h.s.cloudflareToken(BOOT, true));
    expect(oldDeletes(h)).toEqual([]);
  });

  it("carries on, saying so, when the list can't be read", async () => {
    const h = harness({ listTokensStatus: 403 });
    const v = await toGateway(h);
    expect(v.cloudflare.olderProblem).toMatch(/couldn't check for older gork tokens/i);
    await h.s.finish({ revokeOld: true });
    expect(existsSync(h.path)).toBe(true);
  });
});

describe("setup: the name for a different gateway", () => {
  const theirs = { authentication: false };

  it("suggests the next free-looking name: -2, or one more than a trailing number", () => {
    expect(suggestGatewayName("gork")).toBe("gork-2");
    expect(suggestGatewayName("gork-2")).toBe("gork-3");
    expect(suggestGatewayName("gork-9")).toBe("gork-10");
    expect(suggestGatewayName("my-bot")).toBe("my-bot-2");
    expect(suggestGatewayName("bot7")).toBe("bot7-2");
    // Always a name the server would accept, even for the longest id.
    const long = suggestGatewayName("a".repeat(64));
    expect(long.length).toBeLessThanOrEqual(64);
    expect(() => SETTINGS.AI_GATEWAY_ID.parse(long)).not.toThrow();
    expect(suggestGatewayName(`${"a".repeat(61)}-99`)).toMatch(/^a+-100$/);
  });

  it("tells the page the suggestion for the gateway that is in the way, and for the next one after it", async () => {
    const h = harness({ gateways: { gork: theirs, "gork-2": theirs } });
    await toGateway(h);
    expect(h.session.view().cloudflare.gateway).toMatchObject({ id: "gork", suggestion: "gork-2" });
    const v = await h.s.gatewayChoice({ action: "new", newId: "gork-2" });
    expect(v.cloudflare.gateway).toMatchObject({ id: "gork-2", suggestion: "gork-3" });
  });

  it("refuses the name of the gateway that is already in the way, saying what to do, and changes nothing", async () => {
    const h = harness({ gateways: { gork: theirs } });
    await toGateway(h);
    for (const same of ["gork", "  gork  ", "GORK"]) {
      expect(await failure(h.s.gatewayChoice({ action: "new", newId: same })), same).toMatch(/already|same/i);
    }
    expect(h.session.view().cloudflare.phase).toBe("gateway");
    expect(gatewayCalls(h, "POST")).toEqual([]);
    expect(gatewayCalls(h, "PUT")).toEqual([]);
  });
});
