import { describe, expect, it } from "vitest";
import {
  AccountsUnlistedError,
  ADMIN_NEEDS,
  bootstrapLink,
  listAccounts,
  listAccountTokens,
  listPermissionGroups,
  mintToken,
  type Need,
  parseAccountId,
  probeAdminToken,
  probeRunToken,
  resolvePermissionGroups,
  revokeToken,
  runNeeds,
  TokenRejectedError,
  tokenState,
  verifyToken,
} from "../scripts/lib/cloudflare-setup.ts";
import { CliError } from "../scripts/lib/errors.ts";
import { cloudflareApi } from "../scripts/lib/gateway.ts";
import { type Call, fakeFetch, json } from "./helpers.ts";

const TOKEN = "cf-secret-token-value";
const ACCT = "0123456789abcdef0123456789abcdef";
const BASE = "https://api.cloudflare.com/client/v4";
const ok = (result: unknown) => json({ success: true, errors: [], result });
const fail = (status: number, errors: unknown[] = [{ code: 10000, message: "Authentication error" }]) =>
  json({ success: false, errors }, status);
/** A fetch that cannot reach anything, and whose error text holds `secret`, as a real network error can. */
const offline = (secret: string) =>
  (async () => {
    throw new TypeError(`fetch failed ${secret}`);
  }) as unknown as typeof fetch;

const failure = async (p: Promise<unknown>) => {
  const err = await p.then(
    () => null,
    (e) => e,
  );
  expect(err).toBeInstanceOf(CliError);
  const msg = (err as Error).message;
  expect(msg).not.toContain(TOKEN);
  return msg;
};

describe("bootstrapLink", () => {
  it("pre-fills a token named gork-setup with the one permission that can make the narrower tokens, and carries no secret", () => {
    const u = new URL(bootstrapLink());
    expect([...u.searchParams.keys()].sort()).toEqual(["name", "permissionGroupKeys", "to"]);
    expect(u.searchParams.get("name")).toBe("gork-setup");
    expect(JSON.parse(u.searchParams.get("permissionGroupKeys") ?? "")).toEqual([
      { key: "account_api_tokens", type: "edit" },
    ]);
  });
});

describe("listAccounts", () => {
  it("tells a rejected token apart from an account list the token can't read", async () => {
    await expect(listAccounts(TOKEN, fakeFetch(() => fail(401)).f)).rejects.toBeInstanceOf(TokenRejectedError);
    await expect(listAccounts(TOKEN, fakeFetch(() => fail(403)).f)).rejects.toBeInstanceOf(AccountsUnlistedError);
    await expect(listAccounts(TOKEN, fakeFetch(() => ok([])).f)).rejects.toBeInstanceOf(AccountsUnlistedError);
    await expect(listAccounts(TOKEN, fakeFetch(() => fail(500)).f)).rejects.not.toBeInstanceOf(AccountsUnlistedError);
  });

  it("reports an unreachable Cloudflare without the token", async () => {
    expect(await failure(listAccounts(TOKEN, offline(TOKEN)))).toMatch(/reach Cloudflare/i);
  });
});

describe("parseAccountId", () => {
  it("pulls the 32-hex id out of a dashboard URL, or accepts a bare id", () => {
    expect(parseAccountId(`https://dash.cloudflare.com/${ACCT}/api-tokens`)).toBe(ACCT);
    expect(parseAccountId(`  ${ACCT.toUpperCase()}  `)).toBe(ACCT);
    expect(parseAccountId("https://dash.cloudflare.com/profile/api-tokens")).toBeNull();
    expect(parseAccountId(`${ACCT}0`)).toBeNull();
  });
});

describe("verifyToken", () => {
  it("reads id and status from the account endpoint once the account is known (an account token), or the user endpoint without one (a user token)", async () => {
    const account = fakeFetch(() => ok({ id: "tok1", status: "active", expires_on: "2026-12-01T00:00:00Z" }));
    expect(await verifyToken(TOKEN, account.f, ACCT)).toEqual({
      id: "tok1",
      status: "active",
      expiresOn: "2026-12-01T00:00:00Z",
      kind: "account",
    });
    expect(account.calls[0].url).toBe(`${BASE}/accounts/${ACCT}/tokens/verify`);

    const user = fakeFetch(() => ok({ id: "u1", status: "active" }));
    expect(await verifyToken(TOKEN, user.f)).toMatchObject({ id: "u1", kind: "user" });
    expect(user.calls[0].url).toBe(`${BASE}/user/tokens/verify`);
  });

  it("falls back to the user endpoint, and reports a user token, when the account one answers 400, 401, 403, 404 or 405", async () => {
    for (const status of [400, 401, 403, 404, 405]) {
      const both = fakeFetch((c) => (c.url.includes("/accounts/") ? fail(status) : ok({ id: "u2", status: "active" })));
      expect(await verifyToken(TOKEN, both.f, ACCT), String(status)).toMatchObject({ id: "u2", kind: "user" });
      expect(both.calls.map((c) => c.url)).toEqual([
        `${BASE}/accounts/${ACCT}/tokens/verify`,
        `${BASE}/user/tokens/verify`,
      ]);
    }
  });

  it("does not fall back on a server error", async () => {
    const { f, calls } = fakeFetch(() => fail(500));
    expect(await failure(verifyToken(TOKEN, f, ACCT))).toMatch(/HTTP 500/);
    expect(calls).toHaveLength(1);
  });

  it("rejects an invalid, expired or disabled token with a clear message", async () => {
    expect(await failure(verifyToken(TOKEN, fakeFetch(() => fail(401)).f, ACCT))).toMatch(/rejected|invalid/i);
    expect(await failure(verifyToken(TOKEN, fakeFetch(() => ok({ id: "x", status: "expired" })).f, ACCT))).toMatch(
      /expired/,
    );
    expect(await failure(verifyToken(TOKEN, fakeFetch(() => ok({ id: "x", status: "disabled" })).f))).toMatch(
      /disabled/,
    );
  });
});

describe("revokeToken", () => {
  const auth = "boot-secret";

  it("deletes an account token at the account endpoint and a user token at /user/tokens, authenticating with the given token", async () => {
    const account = fakeFetch(() => ok({ id: "t1" }));
    expect(await revokeToken(auth, account.f, { kind: "account", accountId: ACCT, id: "t1" })).toBe("deleted");
    expect(account.calls.map((c) => `${c.method} ${c.url}`)).toEqual([`DELETE ${BASE}/accounts/${ACCT}/tokens/t1`]);
    expect(account.calls[0].headers.Authorization).toBe(`Bearer ${auth}`);

    const user = fakeFetch(() => ok({ id: "t1" }));
    expect(await revokeToken(auth, user.f, { kind: "user", accountId: ACCT, id: "t1" })).toBe("deleted");
    expect(user.calls.map((c) => `${c.method} ${c.url}`)).toEqual([`DELETE ${BASE}/user/tokens/t1`]);
  });

  it("calls a vanished token missing rather than failing", async () => {
    const gone = fakeFetch(() => fail(404));
    expect(await revokeToken(auth, gone.f, { kind: "account", accountId: ACCT, id: "t1" })).toBe("missing");
  });

  it("throws with the status on other failures, and treats a success:false body as a failure", async () => {
    const denied = fakeFetch(() => fail(403));
    expect(await failure(revokeToken(auth, denied.f, { kind: "account", accountId: ACCT, id: "t1" }))).toMatch(
      /delete.*403/i,
    );
    const lie = fakeFetch(() => json({ success: false, errors: [] }, 200));
    await expect(revokeToken(auth, lie.f, { kind: "user", accountId: ACCT, id: "t1" })).rejects.toThrow(/delete/i);
  });

  it("keeps an odd id inside its path segment", async () => {
    const del = fakeFetch(() => ok({}));
    await revokeToken(auth, del.f, { kind: "account", accountId: ACCT, id: "a/../b" });
    expect(del.calls[0].url).toBe(`${BASE}/accounts/${ACCT}/tokens/a%2F..%2Fb`);
  });

  it("never puts the token in a message", async () => {
    const err = await revokeToken(auth, offline(auth), { kind: "user", accountId: ACCT, id: "t1" }).catch((e) => e);
    expect(String(err.message)).not.toContain(auth);
  });
});

describe("tokenState", () => {
  it("is revoked only on a 401, active when still accepted, and unknown for anything else (403, 404, 5xx, offline)", async () => {
    const state = (f: typeof fetch) => tokenState(TOKEN, f, "account", ACCT);
    expect(await state(fakeFetch(() => fail(401)).f)).toBe("revoked");
    expect(await state(fakeFetch(() => ok({ id: "x", status: "active" })).f)).toBe("active");
    for (const status of [403, 404, 500])
      expect(await state(fakeFetch(() => fail(status)).f), String(status)).toBe("unknown");
    expect(await state(offline("x"))).toBe("unknown");
  });

  it("asks the endpoint that matches the kind", async () => {
    const user = fakeFetch(() => fail(401));
    await tokenState(TOKEN, user.f, "user", ACCT);
    expect(user.calls[0].url).toBe(`${BASE}/user/tokens/verify`);
    const account = fakeFetch(() => fail(401));
    await tokenState(TOKEN, account.f, "account", ACCT);
    expect(account.calls[0].url).toBe(`${BASE}/accounts/${ACCT}/tokens/verify`);
  });
});

const GROUPS = [
  { id: "g-gw-read", name: "AI Gateway Read", scopes: ["com.cloudflare.api.account"] },
  { id: "g-gw-edit", name: "AI Gateway Edit", scopes: ["com.cloudflare.api.account"] },
  { id: "g-gw-run", name: "AI Gateway Run", scopes: ["com.cloudflare.api.account"] },
  { id: "g-ai-read", name: "Workers AI Read", scopes: ["com.cloudflare.api.account"] },
  { id: "g-search", name: "Websearch Run", scopes: ["com.cloudflare.api.account"] },
  { id: "g-browser", name: "Browser Rendering - Edit", scopes: ["com.cloudflare.api.account"] },
];

describe("listAccountTokens", () => {
  it("lists names and ids, following pages until the total is reached", async () => {
    const row = (n: number, name: string) => ({ id: `id-${n}`, name, status: "active" });
    const pages = [[row(1, "gork-run"), row(2, "other")], [row(3, "gork-admin")]];
    const { f, calls } = fakeFetch((c) => {
      const page = Number(new URL(c.url).searchParams.get("page") ?? 1);
      return json({ success: true, result: pages[page - 1], result_info: { page, per_page: 2, total_count: 3 } });
    });
    const tokens = await listAccountTokens(cloudflareApi(ACCT, TOKEN, f));
    expect(tokens.map((t) => t.name)).toEqual(["gork-run", "other", "gork-admin"]);
    expect(tokens[0]).toMatchObject({ id: "id-1", status: "active" });
    expect(calls).toHaveLength(2);
  });
});

describe("listPermissionGroups", () => {
  it("reads id and name of every selectable group, and nothing without an id or marked not selectable", async () => {
    const { f } = fakeFetch(() =>
      ok([...GROUPS, { id: "hidden", name: "Hidden", is_selectable: false }, { name: "no id" }]),
    );
    const groups = await listPermissionGroups(cloudflareApi(ACCT, TOKEN, f));
    expect(groups.map((g) => g.id)).toEqual(GROUPS.map((g) => g.id));
  });
});

describe("resolvePermissionGroups", () => {
  const needs: Need[] = [
    { capability: "chat", names: ["Workers AI Read"] },
    { capability: "page reading", names: ["Browser Run Edit", "Browser Rendering Edit"] },
  ];

  it("matches by name ignoring case, spacing and hyphens, trying alternates in order, and treats Write as Edit and Rendering as Run", () => {
    expect(resolvePermissionGroups(GROUPS, needs)).toEqual([
      { id: "g-ai-read", name: "Workers AI Read", capability: "chat" },
      { id: "g-browser", name: "Browser Rendering - Edit", capability: "page reading" },
    ]);
    expect(resolvePermissionGroups([{ id: "x", name: "  workers   AI read " }], [needs[0]])[0].id).toBe("x");
    const renamed = [
      { id: "w", name: "Browser Run Write" },
      { id: "e", name: "AI Gateway Edit" },
    ];
    const pick = (need: Need) => resolvePermissionGroups(renamed, [need])[0].id;
    expect(pick({ capability: "page reading", names: ["Browser Rendering - Edit"] })).toBe("w");
    expect(pick({ capability: "gateway", names: ["AI Gateway Write"] })).toBe("e");
  });

  it("names every capability that has no group, what was tried, and only same-product groups that look related", () => {
    const groups = [
      { id: "r", name: "Browser Run Read" },
      { id: "a", name: "AI Audit Write" },
      { id: "s", name: "AI Search Read" },
    ];
    const err = (() => {
      try {
        resolvePermissionGroups(groups, [
          { capability: "page reading", names: ["Browser Run Write"] },
          { capability: "web search", names: ["Websearch Run", "Web Search Run"] },
        ]);
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err).toBeInstanceOf(CliError);
    expect(err?.message).toContain('"page reading" (looked for Browser Run Write;');
    expect(err?.message).toContain('"web search" (looked for Websearch Run, Web Search Run;');
    expect(err?.message).toContain("Browser Run Read");
    expect(err?.message).not.toContain("AI Audit");
    expect(err?.message).not.toContain("AI Search");
  });

  it("does not return the same group twice", () => {
    const dup: Need[] = [needs[0], { capability: "again", names: ["Workers AI Read"] }];
    expect(resolvePermissionGroups(GROUPS, dup).map((g) => g.id)).toEqual(["g-ai-read"]);
  });
});

describe("what the tokens need", () => {
  // The groups a real account listed on 2026-10-19 (from a live setup run), plus the two it did resolve.
  const LIVE = [
    "AI Audit Read",
    "AI Audit Write",
    "AI Gateway Metadata Read",
    "AI Gateway Read",
    "AI Gateway Run",
    "AI Gateway Write",
    "AI Search Read",
    "AI Search Run",
    "AI Search Write",
    "Browser Run Read",
    "Browser Run Write",
    "Workers AI Read",
    "Websearch Run",
  ].map((name, i) => ({ id: `live-${i}`, name }));

  it("resolve, for every billing mode and for the admin token, against the names a real account uses", () => {
    for (const billing of ["credits", "free"] as const)
      expect(() => resolvePermissionGroups(LIVE, runNeeds(billing))).not.toThrow();
    const picked = (needs: Need[]) => resolvePermissionGroups(LIVE, needs).map((g) => g.name);
    expect(picked(runNeeds("credits"))).toContain("Browser Run Write");
    expect(picked(ADMIN_NEEDS).sort()).toEqual(["AI Gateway Read", "AI Gateway Write"]);
  });
});

describe("mintToken", () => {
  const api = (route: Parameters<typeof fakeFetch>[0]) => {
    const { f, calls } = fakeFetch(route);
    return { api: cloudflareApi(ACCT, "bootstrap-secret", f), calls };
  };

  it("creates an account-owned token limited to this account and the given groups, expiring only when asked", async () => {
    const { api: a, calls } = api(() => ok({ id: "t1", name: "gork-run", value: "minted-secret", status: "active" }));
    expect(await mintToken(a, ACCT, "gork-run", ["g1", "g2"])).toEqual({ id: "t1", value: "minted-secret" });
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe(`${BASE}/accounts/${ACCT}/tokens`);
    expect(calls[0].headers.Authorization).toBe("Bearer bootstrap-secret");
    expect(calls[0].body).toEqual({
      name: "gork-run",
      policies: [
        {
          effect: "allow",
          resources: { [`com.cloudflare.api.account.${ACCT}`]: "*" },
          permission_groups: [{ id: "g1" }, { id: "g2" }],
        },
      ],
    });
    await mintToken(a, ACCT, "gork-admin", ["g"], { expiresOn: "2026-10-19T14:00:00Z" });
    expect(calls[1].body.expires_on).toBe("2026-10-19T14:00:00Z");
  });

  it("refuses to mint with no groups, which would make an empty token", async () => {
    const { api: a, calls } = api(() => ok({}));
    expect(await failure(mintToken(a, ACCT, "x", []))).toMatch(/no permission groups/i);
    expect(calls).toEqual([]);
  });

  it("explains the setup token being unable to grant a permission, and where to make one that can", async () => {
    const { api: a } = api(() => fail(403, [{ code: 9109, message: "Unauthorized to access requested resource" }]));
    const msg = await failure(mintToken(a, ACCT, "gork-run", ["g"]));
    expect(msg).toMatch(/gork-run.*403/);
    expect(msg).toContain("My Profile > API Tokens > Create additional tokens");
  });

  it("fails when Cloudflare answers success but gives no secret", async () => {
    const { api: a } = api(() => ok({ id: "t1" }));
    expect(await failure(mintToken(a, ACCT, "gork-run", ["g"]))).toMatch(/secret|value/i);
  });

  it("never puts the minted secret in an error", async () => {
    const { api: a } = api(() =>
      json({ success: false, errors: [{ message: "bad" }], result: { value: "minted-secret" } }, 400),
    );
    expect(await failure(mintToken(a, ACCT, "gork-run", ["g"]))).not.toContain("minted-secret");
  });
});

describe("probeRunToken", () => {
  const base = { accountId: ACCT, token: TOKEN, gatewayId: "gork", searchProvider: "ceramic", model: "@cf/zai-org/m" };
  const route = (over: Record<string, (c: Call) => Response> = {}) =>
    fakeFetch((c) => {
      for (const [key, fn] of Object.entries(over)) if (c.url.includes(key)) return fn(c);
      if (c.url.includes("/ai/v1/chat/completions")) return json({ choices: [{ message: { content: "hi" } }] });
      return ok({});
    });

  it("credits mode checks chat through the gateway, search through the gateway, and page reading", async () => {
    const { f, calls } = route();
    const out = await probeRunToken({ ...base, billing: "credits" }, f);
    expect(out.map((p) => [p.capability, p.ok])).toEqual([
      ["chat", true],
      ["web search", true],
      ["page reading", true],
    ]);
    const chat = calls.find((c) => c.url.endsWith("/ai/v1/chat/completions"));
    expect(chat?.headers["cf-aig-gateway-id"]).toBe("gork");
    expect(chat?.body).toMatchObject({ model: base.model, max_tokens: 1 });
    const search = calls.find((c) => c.url.endsWith("/ai/websearch"));
    expect(search?.body).toMatchObject({ provider: "ceramic", limit: 1, options: { gateway: { id: "gork" } } });
  });

  it("search: false leaves out the paid web search call and nothing else", async () => {
    const { f, calls } = route();
    const out = await probeRunToken({ ...base, billing: "credits", search: false }, f);
    expect(out.map((p) => p.capability)).toEqual(["chat", "page reading"]);
    expect(calls.some((c) => c.url.endsWith("/ai/websearch"))).toBe(false);
  });

  it("free mode sends no gateway header, skips search, and never reaches gateway.ai.cloudflare.com", async () => {
    const { f, calls } = route();
    const out = await probeRunToken({ ...base, billing: "free" }, f);
    expect(out.map((p) => p.capability)).toEqual(["chat", "page reading"]);
    for (const c of calls) {
      expect(Object.keys(c.headers).filter((h) => /^cf-aig-/i.test(h))).toEqual([]);
      expect(c.url).not.toContain("gateway.ai.cloudflare.com");
    }
  });

  it("maps a missing permission to 'missing: <group names>' for the billing mode in use, without the token", async () => {
    const refused = {
      "/ai/v1/chat/completions": () => fail(403),
      "/ai/websearch": () => fail(403),
      "/browser-rendering": () => fail(401),
    };
    const credits = await probeRunToken({ ...base, billing: "credits" }, route(refused).f);
    expect(credits.every((p) => !p.ok)).toBe(true);
    expect(credits[0].message).toMatch(/^missing: AI Gateway Read, AI Gateway Run, Workers AI Read/);
    expect(credits[1].message).toMatch(/^missing: Websearch Run/);
    expect(credits[2].message).toMatch(/^missing: Browser (Run|Rendering)/);
    for (const p of credits) expect(p.message).not.toContain(TOKEN);
    // Free mode never asks for the gateway groups, so it never tells you to add them.
    const free = await probeRunToken({ ...base, billing: "free" }, route(refused).f);
    expect(free[0].message).toMatch(/^missing: Workers AI Read/);
    expect(free[0].message).not.toMatch(/Gateway/);
  });

  it("tells each kind of refusal apart: credits, a paid-plan model, a missing gateway, rate limits, other failures, no network", async () => {
    const probe = async (billing: "credits" | "free", over: Record<string, (c: Call) => Response>) =>
      probeRunToken({ ...base, billing }, route(over).f);
    const chat = "/ai/v1/chat/completions";

    const credits = await probe("credits", {
      [chat]: () => fail(402, [{ code: 2000, message: "Insufficient credits" }]),
      "/ai/websearch": () => fail(403, [{ code: 2001, message: "not enough credits for unified billing" }]),
    });
    expect(credits[0]).toMatchObject({ ok: false, kind: "credits" });
    expect(credits[0].message).toContain("https://dash.cloudflare.com/?to=/:account/ai/ai-gateway");
    expect(credits[1].message).not.toMatch(/^missing/);

    const paid = await probe("free", { [chat]: () => fail(403, [{ code: 5035, message: "requires paid plan" }]) });
    expect(paid[0].ok).toBe(false);
    expect(paid[0].message).toMatch(/Workers Paid/);
    expect(paid[0].message).not.toMatch(/^missing/);

    const noGateway = await probe("credits", {
      [chat]: () => fail(404, [{ code: 2001, message: "Gateway not found" }]),
    });
    expect(noGateway[0].message).toMatch(/gateway.*not found.*npm run up/i);

    const limited = await probe("free", { "/browser-rendering": () => fail(429, []) });
    expect(limited[1]).toMatchObject({ ok: true });
    expect(limited[1].message).toMatch(/rate/i);
    const allowance = await probe("free", { [chat]: () => fail(429, [{ code: 3036 }]) });
    expect(allowance[0]).toMatchObject({ ok: true });
    expect(allowance[0].message).toMatch(/allowance/i);

    const broken = await probe("free", { "/browser-rendering": () => fail(500, []) });
    expect(broken[1].message).toMatch(/HTTP 500/);

    const down = await probeRunToken({ ...base, billing: "free" }, offline(TOKEN));
    expect(down.every((p) => !p.ok && !p.message.includes(TOKEN))).toBe(true);
    expect(down[0].message).toMatch(/reach Cloudflare/i);
  });
});

describe("probeAdminToken", () => {
  it("is fine when the gateway exists or doesn't exist yet (the token can read gateways)", async () => {
    for (const status of [200, 404]) {
      const { f, calls } = fakeFetch(() => (status === 200 ? ok({ id: "gork" }) : fail(404, [])));
      const p = await probeAdminToken(cloudflareApi(ACCT, TOKEN, f), "gork");
      expect(p.ok).toBe(true);
      expect(p.exists).toBe(status === 200);
      if (status === 200) expect(p.gateway).toEqual({ id: "gork" });
      expect(calls[0].url).toBe(`${BASE}/accounts/${ACCT}/ai-gateway/gateways/gork`);
    }
  });

  it("names the missing groups, and suspects an expired token, on 401/403", async () => {
    const { f } = fakeFetch(() => fail(403));
    const p = await probeAdminToken(cloudflareApi(ACCT, TOKEN, f), "gork");
    expect(p.ok).toBe(false);
    expect(p.message).toMatch(/^missing: AI Gateway Read, AI Gateway Write/);
    expect(p.message).toMatch(/expired/);
    expect(p.message).not.toContain(TOKEN);
  });
});
