import { describe, expect, it } from "vitest";
import { CliError } from "../scripts/lib/errors.ts";
import {
  cloudflareApi,
  creditBalance,
  deleteGateway,
  ensureGateway,
  gatewaySpec,
  gatewaySummary,
  readGateway,
} from "../scripts/lib/gateway.ts";
import { fakeFetch, json } from "./helpers.ts";

const apiWith = (route: Parameters<typeof fakeFetch>[0]) => {
  const { f, calls } = fakeFetch(route);
  return { api: cloudflareApi("acct", "admin-token", f), calls };
};
const ok = (result: unknown = {}) => json({ success: true, result });

describe("gatewaySpec", () => {
  it("sets the daily spend limit 20% above the budget, at least 5 cents above", () => {
    const limit = (budgetUsd: number) => gatewaySpec({ budgetUsd }).spend_limits.rules[0].limit;
    expect(limit(0.5)).toBe(0.6);
    expect(limit(10)).toBe(12);
    expect(limit(0.01)).toBe(0.06);
    expect(limit(0)).toBe(0.05);
  });

  it("bills Workers AI to the free allowance (standard) in free mode, never to credits", () => {
    expect(gatewaySpec({ budgetUsd: 1, billing: "free" }).workers_ai_billing_mode).toBe("standard");
    expect(gatewaySpec({ budgetUsd: 1, billing: "credits" }).workers_ai_billing_mode).toBe("unified");
  });

  it("requires auth, retains no data, and enforces the spend limit, in either billing mode", () => {
    for (const billing of ["credits", "free"] as const) {
      expect(gatewaySpec({ budgetUsd: 1, billing })).toMatchObject({
        authentication: true,
        zdr: true,
        spend_limits: { enabled: true, rules: [{ window: 86400 }] },
      });
    }
  });
});

describe("ensureGateway", () => {
  it("creates a missing gateway with its id and the spec", async () => {
    const { api, calls } = apiWith((c) => (c.method === "GET" ? json({}, 404) : ok()));
    expect(await ensureGateway(api, "my-gw", 0.5)).toBe("created");
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST"]);
    expect(calls[1].url).toMatch(/\/accounts\/acct\/ai-gateway\/gateways$/);
    expect(calls[1].body).toEqual({ id: "my-gw", ...gatewaySpec({ budgetUsd: 0.5 }) });
    expect(calls[1].headers.Authorization).toBe("Bearer admin-token");
  });

  it("in free mode creates, and converts an existing credits gateway to, standard billing, never unified", async () => {
    const fresh = apiWith((c) => (c.method === "GET" ? json({}, 404) : ok()));
    await ensureGateway(fresh.api, "gw", 1, "free");
    expect(fresh.calls[1].body).toMatchObject({ workers_ai_billing_mode: "standard" });

    const credits = gatewaySpec({ budgetUsd: 1 });
    const existing = apiWith((c) => (c.method === "GET" ? ok(credits) : ok()));
    expect(await ensureGateway(existing.api, "gw", 1, "free")).toBe("updated");
    expect(existing.calls[1].body).toMatchObject({ workers_ai_billing_mode: "standard" });
  });

  it("says unchanged, and sends no PUT, when every setting already matches", async () => {
    const spec = gatewaySpec({ budgetUsd: 2 });
    const { api, calls } = apiWith(() => ok({ ...spec, id: "my-gw", created_at: "x" }));
    expect(await ensureGateway(api, "my-gw", 2)).toBe("unchanged");
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("ignores fields Cloudflare adds when it reports settings back (seen live: enabled on each spend rule)", async () => {
    const spec = gatewaySpec({ budgetUsd: 2 });
    const reported = {
      ...spec,
      spend_limits: { ...spec.spend_limits, rules: spec.spend_limits.rules.map((r) => ({ ...r, enabled: true })) },
    };
    const { api, calls } = apiWith(() => ok(reported));
    expect(await ensureGateway(api, "my-gw", 2)).toBe("unchanged");
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("still updates when a spend rule is missing or an extra one exists", async () => {
    const spec = gatewaySpec({ budgetUsd: 2 });
    const rule = spec.spend_limits.rules[0];
    for (const rules of [[], [rule, { ...rule, id: "other" }]]) {
      const { api, calls } = apiWith((c) =>
        c.method === "GET" ? ok({ ...spec, spend_limits: { enabled: true, rules } }) : ok(),
      );
      expect(await ensureGateway(api, "my-gw", 2)).toBe("updated");
      expect(calls.map((c) => c.method)).toEqual(["GET", "PUT"]);
    }
  });

  it("updates, and says so, when any one setting differs (even inside spend limits)", async () => {
    const spec = gatewaySpec({ budgetUsd: 2 });
    for (const existing of [
      { ...spec, zdr: false },
      { ...spec, workers_ai_billing_mode: "standard" },
      { ...spec, spend_limits: { ...spec.spend_limits, rules: [{ ...spec.spend_limits.rules[0], limit: 99 }] } },
      Object.fromEntries(Object.entries(spec).filter(([k]) => k !== "authentication")),
    ]) {
      const { api, calls } = apiWith((c) => (c.method === "GET" ? ok(existing) : ok()));
      expect(await ensureGateway(api, "my-gw", 2)).toBe("updated");
      expect(calls.map((c) => c.method)).toEqual(["GET", "PUT"]);
      // The whole wanted spec is written to that gateway, not just the field that differed.
      expect(calls[1].url).toMatch(/\/ai-gateway\/gateways\/my-gw$/);
      expect(calls[1].body).toEqual(spec);
    }
  });

  it("writes nothing when the gateway can't be read", async () => {
    const { api, calls } = apiWith(() => json({ success: false, errors: [{ message: "forbidden" }] }, 403));
    await expect(ensureGateway(api, "gw", 1)).rejects.toThrow(/read AI Gateway failed: HTTP 403.*forbidden/);
    expect(calls).toHaveLength(1);
  });

  it("reports a failed create or update as a CliError", async () => {
    const create = apiWith((c) =>
      c.method === "GET" ? json({}, 404) : json({ success: false, errors: ["nope"] }, 400),
    );
    await expect(ensureGateway(create.api, "gw", 1)).rejects.toThrow(CliError);
    await expect(ensureGateway(create.api, "gw", 1)).rejects.toThrow(/create AI Gateway failed: HTTP 400/);
    const update = apiWith((c) => (c.method === "PUT" ? json({}, 500) : ok()));
    await expect(ensureGateway(update.api, "gw", 1)).rejects.toThrow(/update AI Gateway failed: HTTP 500/);
  });
});

describe("deleteGateway", () => {
  it("treats a missing gateway as already gone", async () => {
    expect(await deleteGateway(apiWith(() => json({}, 404)).api, "gw")).toBe("missing");
    expect(await deleteGateway(apiWith(() => ok()).api, "gw")).toBe("deleted");
  });

  it("fails on any other error", async () => {
    await expect(deleteGateway(apiWith(() => json({}, 403)).api, "gw")).rejects.toThrow(/HTTP 403/);
  });
});

describe("creditBalance", () => {
  it("reads the balance, and is null whenever it can't", async () => {
    expect(await creditBalance(apiWith(() => ok({ balance: 0 })).api)).toBe(0);
    expect(await creditBalance(apiWith(() => ok({ balance: "4.5" })).api)).toBe(4.5);
    expect(await creditBalance(apiWith(() => ok({})).api)).toBeNull();
    expect(await creditBalance(apiWith(() => json({}, 404)).api)).toBeNull();
    expect(
      await creditBalance(cloudflareApi("a", "t", (async () => Promise.reject(new Error("offline"))) as never)),
    ).toBeNull();
  });
});

describe("readGateway", () => {
  it("returns the settings, or null when there is no such gateway", async () => {
    expect(await readGateway(apiWith(() => ok({ zdr: true })).api, "gw")).toEqual({ zdr: true });
    expect(await readGateway(apiWith(() => json({}, 404)).api, "gw")).toBeNull();
  });
});

describe("gatewaySummary", () => {
  it("lists the settings that matter, and says unknown or none for what the API did not return", () => {
    const text = gatewaySummary({
      ...gatewaySpec({ budgetUsd: 2 }),
      workers_ai_billing_mode: "standard",
      zdr: false,
      authentication: false,
    }).join("\n");
    expect(text).toMatch(/billing: standard/);
    expect(text).toMatch(/authentication: off/);
    expect(text).toMatch(/zero data retention: off/);
    expect(text).toMatch(/spend limit: \$2\.4 per day/);

    const bare = gatewaySummary({}).join("\n");
    expect(bare).toMatch(/billing: unknown/);
    expect(bare).toMatch(/spend limit: none/);
  });

  it("never prints a raw object or control characters from the API", () => {
    const text = gatewaySummary({ workers_ai_billing_mode: "std‮\u001b[31m", zdr: "yes" }).join("\n");
    expect(text).not.toContain("‮");
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("[object");
  });
});
