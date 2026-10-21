import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SETTINGS } from "../src/config.ts";
import { LinkSet } from "../src/links.ts";
import { describeSearch } from "../src/search.ts";
import { SEARCH_PROVIDERS } from "../src/search-providers.ts";
import { newToolState, type ReplyTally } from "../src/tools.ts";
import { type Call, callTool, fakeFetch, json, testConfig } from "./helpers.ts";

// web_search tries the cheap provider (SEARCH_PROVIDER) first and uses the fallback (SEARCH_FALLBACK) for a reply's
// further searches, and for a first search that fails on the provider's side or finds nothing.

const hit = (provider: string) => ({
  title: `${provider} hit`,
  url: `https://${provider}.example/a`,
  description: "d",
});
/** A Web Search stand-in: each provider answers with `answers[provider]` (a status, or "empty", or one hit). */
function providers(answers: Record<string, number | "empty" | "hit"> = {}) {
  return fakeFetch((c: Call) => {
    const a = answers[c.body.provider] ?? "hit";
    if (typeof a === "number")
      return new Response(`{"errors":[{"message":"bad query: ${c.body.query}"}]}`, { status: a });
    return json({ result: { items: a === "empty" ? [] : [hit(c.body.provider)] } });
  });
}
const tally = (over: Partial<ReplyTally> = {}): ReplyTally => ({
  images: 0,
  polls: 0,
  events: 0,
  searches: 0,
  fallbackSearches: 0,
  ...over,
});
const cfg = testConfig();
const search = (deps: Parameters<typeof callTool>[3] = {}, config = cfg) =>
  callTool(config, "web_search", { query: "zebra canary patch" }, deps);

describe("web_search: which provider", () => {
  it("sends a reply's first search to the cheap provider, at its own price", async () => {
    const { f, calls } = providers();
    const r = await search({ fetch: f, tally: tally() });
    expect(calls.map((c) => c.body.provider)).toEqual(["ceramic"]);
    expect(r.costUsd).toBe(0.00025);
    expect(r.search).toEqual({ primary: 1, fallback: 0 });
  });

  it("sends a reply's further searches to the fallback, at its price, and lets web_fetch open what it found", async () => {
    const { f, calls } = providers();
    const links = new LinkSet();
    const r = await search({ fetch: f, links, tally: tally({ searches: 1 }) });
    expect(calls.map((c) => c.body.provider)).toEqual(["linkup"]);
    expect(r.costUsd).toBe(0.005);
    expect(r.search).toEqual({ primary: 0, fallback: 1 });
    expect(links.has("https://linkup.example/a")).toBe(true);
  });

  it("charges SEARCH_PROVIDER=linkup at linkup's price, and never falls back to itself", async () => {
    const { f, calls } = providers({ linkup: "empty" });
    const r = await search({ fetch: f, tally: tally({ searches: 1 }) }, testConfig({ SEARCH_PROVIDER: "linkup" }));
    expect(calls.map((c) => c.body.provider)).toEqual(["linkup"]);
    expect(r.costUsd).toBe(0.005);
  });
});

describe("web_search: a first search that fails or finds nothing", () => {
  it("retries on the fallback in the same call when the cheap provider finds nothing", async () => {
    const { f, calls } = providers({ ceramic: "empty" });
    const links = new LinkSet();
    const lines: string[] = [];
    const r = await search({ fetch: f, links, tally: tally(), log: (l) => lines.push(l) });
    expect(calls.map((c) => c.body.provider)).toEqual(["ceramic", "linkup"]);
    expect(r.costUsd).toBeCloseTo(0.00525, 10);
    expect(r.search).toEqual({ primary: 1, fallback: 1 });
    expect(r.content).toContain("https://linkup.example/a");
    expect(links.has("https://linkup.example/a")).toBe(true);
    expect(lines).toEqual(["web_search: ceramic found nothing; retried on linkup"]);
  });

  it("retries on the fallback after a server error, but not after a refusal such as a bad token", async () => {
    const after502 = providers({ ceramic: 502 });
    const r = await search({ fetch: after502.f, tally: tally() });
    expect(after502.calls.map((c) => c.body.provider)).toEqual(["ceramic", "linkup"]);
    expect(r.costUsd).toBe(0.005); // only the search that answered is charged
    const lines: string[] = [];
    const after403 = providers({ ceramic: 403 });
    const refused = await search({ fetch: after403.f, tally: tally(), log: (l) => lines.push(l) });
    expect(after403.calls.map((c) => c.body.provider)).toEqual(["ceramic"]);
    expect(refused.content).toMatch(/web_search failed/);
    expect(refused.costUsd).toBe(0);
    expect(lines).toEqual(["web_search: ceramic HTTP 403"]);
  });

  it("falls back to the cheap provider when the fallback fails on a further search", async () => {
    const { f, calls } = providers({ linkup: 500 });
    const r = await search({ fetch: f, tally: tally({ searches: 1 }) });
    expect(calls.map((c) => c.body.provider)).toEqual(["linkup", "ceramic"]);
    expect(r.content).toContain("https://ceramic.example/a");
    expect(r.costUsd).toBe(0.00025);
  });

  it("never writes the query, or an error body that repeats it, into a log line", async () => {
    const lines: string[] = [];
    const cases: Array<Record<string, number | "empty" | "hit">> = [
      { ceramic: 502, linkup: 500 },
      { ceramic: 403 },
      { ceramic: "empty" },
    ];
    for (const answers of cases)
      await search({ fetch: providers(answers).f, tally: tally(), log: (l) => lines.push(l) });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toMatch(/zebra|canary|bad query/);
  });
});

describe("web_search: when the fallback is not used", () => {
  it("not when SEARCH_FALLBACK is none, or SEARCH_FALLBACK_PER_DAY is 0", async () => {
    for (const config of [testConfig({ SEARCH_FALLBACK: "none" }), testConfig({ SEARCH_FALLBACK_PER_DAY: "0" })]) {
      const { f, calls } = providers({ ceramic: "empty" });
      await search({ fetch: f, tally: tally({ searches: 1 }) }, config);
      expect(calls.map((c) => c.body.provider)).toEqual(["ceramic"]);
    }
  });

  it("not more than twice in one reply", async () => {
    const { f, calls } = providers();
    await search({ fetch: f, tally: tally({ searches: 3, fallbackSearches: 2 }) });
    expect(calls.map((c) => c.body.provider)).toEqual(["ceramic"]);
  });

  it("not more than SEARCH_FALLBACK_PER_DAY times a day, across replies", async () => {
    const config = testConfig({ SEARCH_FALLBACK_PER_DAY: "1" });
    const state = newToolState(config);
    const { f, calls } = providers();
    await search({ fetch: f, state, tally: tally({ searches: 1 }) }, config);
    await search({ fetch: f, state, tally: tally({ searches: 1 }) }, config);
    expect(calls.map((c) => c.body.provider)).toEqual(["linkup", "ceramic"]);
  });

  it("not when too little time is left before the reply's deadline to wait for a second search", async () => {
    const { f, calls } = providers({ ceramic: "empty" });
    const now = 1_000_000;
    await search({ fetch: f, tally: tally(), now: () => now, deadline: now + 5_000 });
    expect(calls.map((c) => c.body.provider)).toEqual(["ceramic"]);
  });
});

describe("web_search: the budget", () => {
  it("reserves each provider's own price right before asking it", async () => {
    const reserved: number[] = [];
    const { f } = providers({ ceramic: "empty" });
    await search({
      fetch: f,
      tally: tally(),
      reserve: (usd) => {
        reserved.push(usd);
        return true;
      },
    });
    expect(reserved).toEqual([0.00025, 0.005]);
  });

  it("runs no search the budget refuses, and says so", async () => {
    const { f, calls } = providers();
    const r = await search({ fetch: f, tally: tally(), reserve: () => false });
    expect(calls).toHaveLength(0);
    expect(r.content).toMatch(/daily budget is used up/);
    expect(r.costUsd).toBe(0);
  });

  it("keeps the cheap search when the budget has room for it but not for the fallback", async () => {
    const { f, calls } = providers();
    const r = await search({ fetch: f, tally: tally({ searches: 1 }), reserve: (usd) => usd < 0.001 });
    expect(calls.map((c) => c.body.provider)).toEqual(["ceramic"]);
    expect(r.costUsd).toBe(0.00025);
  });
});

describe("the search settings", () => {
  it("default to the cheap provider first and linkup as the fallback, at most 20 a day", () => {
    expect(cfg.tools).toMatchObject({ searchProvider: "ceramic", searchFallback: "linkup", searchFallbackPerDay: 20 });
  });

  it("treat a fallback that is the provider itself, none, or 0 a day as no fallback", () => {
    const overs: Array<Record<string, string>> = [
      { SEARCH_PROVIDER: "linkup" },
      { SEARCH_FALLBACK: "none" },
      { SEARCH_FALLBACK_PER_DAY: "0" },
    ];
    for (const over of overs) expect(testConfig(over).tools.searchFallback, JSON.stringify(over)).toBeNull();
  });

  it("refuse exa as the fallback: it is the one provider that keeps a copy of the queries", () => {
    expect(() => testConfig({ SEARCH_FALLBACK: "exa" })).toThrow(/SEARCH_FALLBACK/);
  });
});

describe("what the docs say searches cost", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

  it("matches the price table, for the cheap provider and the fallback, and the daily cap", () => {
    expect(readme).toContain(`$${SEARCH_PROVIDERS.ceramic.priceUsd}`);
    expect(readme).toContain(`$${SEARCH_PROVIDERS.linkup.priceUsd}`);
    const perDay = Number(SETTINGS.SEARCH_FALLBACK_PER_DAY.default);
    expect(readme).toContain(`${perDay} a day`);
    expect(readme).toContain(`$${(perDay * SEARCH_PROVIDERS.linkup.priceUsd).toFixed(2)}`);
  });
});

describe("the line that announces web search (startup log and doctor)", () => {
  it("names both providers, their prices, the daily cap and the most it can cost", () => {
    expect(describeSearch(cfg)).toBe(
      "web search: ceramic ($0.00025 a search); a reply's further searches, and a first search that fails or finds nothing, use linkup ($0.005), up to 20 a day (at most $0.10)",
    );
  });

  it("says when there is no fallback, and when free mode has no web search", () => {
    expect(describeSearch(testConfig({ SEARCH_FALLBACK: "none" }))).toBe(
      "web search: ceramic ($0.00025 a search), no fallback",
    );
    expect(describeSearch(testConfig({ BILLING_MODE: "free" }))).toBe("web search: off (free mode has none)");
  });

  it("is logged when the bot starts, before it connects", () => {
    const main = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8").split(
      "async function main(): Promise<void> {",
    )[1];
    expect(main).toMatch(/log\(describeSearch\(cfg\)\)/);
    expect(main.indexOf("describeSearch(cfg)")).toBeLessThan(main.indexOf("client.login"));
  });
});
