import { CfError, cfFetch } from "./cf.ts";
import type { Config } from "./config.ts";
import { neutralize } from "./context.ts";
import { type SearchProvider, searchPrice } from "./search-providers.ts";

/** Results asked for per search (and kept). */
export const SEARCH_LIMIT = 5;
/** Longest query sent; web_search refuses a longer one. */
export const MAX_SEARCH_QUERY = 300;
/** Longest URL web_fetch opens; a longer search result is dropped. */
export const MAX_URL = 2000;
/** How long one search may take. */
const SEARCH_TIMEOUT_MS = 15_000;
/** Most fallback searches in one reply. */
export const MAX_FALLBACKS_PER_REPLY = 2;

export type SearchHit = { title: string; url: string; snippet: string };

export async function webSearch(
  cfg: Config,
  query: string,
  provider: SearchProvider,
  fetchFn: typeof fetch = fetch,
): Promise<SearchHit[]> {
  const result = (await cfFetch(
    cfg,
    "/ai/websearch",
    {
      query: query.slice(0, MAX_SEARCH_QUERY),
      provider,
      limit: SEARCH_LIMIT,
      options: { gateway: { id: cfg.cf.gatewayId } },
    },
    fetchFn,
    SEARCH_TIMEOUT_MS,
    { headers: { "cf-aig-collect-log-payload": "false" } },
  )) as { items?: Array<{ title?: string; url?: string; description?: string }> };
  return (result.items ?? [])
    .flatMap((i) => {
      const url = httpUrl(i.url);
      return url ? [{ ...i, url }] : [];
    })
    .slice(0, SEARCH_LIMIT)
    .map((i) => ({
      title: neutralize(String(i.title ?? i.url), 150),
      url: i.url,
      snippet: neutralize(String(i.description ?? "").replace(/\s+/g, " "), 1000),
    }));
}

/** What one web_search call did: its results (null when no search ran or every search failed) and what it cost. */
export type SearchOutcome = {
  hits: SearchHit[] | null;
  /** Why there are no hits: the budget refused the search, or the providers failed. */
  refused?: "budget" | "failed";
  costUsd: number;
  /** Searches made on each provider, counting failed ones (for the per-reply cap and the reply's log line). */
  used: { primary: number; fallback: number };
};

/**
 * One web_search call. The reply's first search goes to cfg.tools.searchProvider (cheap) and is retried once on the
 * fallback when the provider answers with a server error or finds nothing. A later search in the reply goes to the
 * fallback: the model searching again is its own sign that the cheap results missed. The fallback is used at most
 * MAX_FALLBACKS_PER_REPLY times a reply and as often as `takeFallback` allows a day; past that, or when the budget
 * or the time left won't cover it, the cheap provider is used. A second search in one call starts only if it can finish
 * before the reply's deadline. Each search is reserved at its provider's price just before it is sent (today's fallback
 * allowance is checked first, so no money is held for a fallback that can't run), and only searches that answered are
 * charged. Log lines name providers and statuses, never the
 * query or a provider's error body (which can repeat the query).
 */
export async function searchWithFallback(
  cfg: Config,
  query: string,
  o: {
    /** Searches this reply already ran. */
    earlier: number;
    /** Fallback searches this reply already made. */
    fallbacksEarlier: number;
    /** Today's fallback searches (SEARCH_FALLBACK_PER_DAY). */
    allowance: { available(): boolean; take(): boolean };
    reserve: (usd: number) => boolean;
    /** When the reply must be answered by, and the clock, in ms. */
    deadline: number;
    now: () => number;
    fetch: typeof fetch;
    log?: (line: string) => void;
  },
): Promise<SearchOutcome> {
  const primary = cfg.tools.searchProvider;
  const fallback = cfg.tools.searchFallback;
  const used = { primary: 0, fallback: 0 };
  let costUsd = 0;
  let fallbackTried = false;

  /** Searches one provider; returns its hits, or null with the reason when it failed. */
  const ask = async (provider: SearchProvider): Promise<{ hits: SearchHit[] } | { error: string; retry: boolean }> => {
    if (provider === primary) used.primary++;
    else used.fallback++;
    try {
      const hits = await webSearch(cfg, query, provider, o.fetch);
      costUsd += searchPrice(provider);
      return { hits };
    } catch (err) {
      // A server error is the provider's problem, so another provider may answer; a refusal (a bad token, a bad
      // request) or a timeout would most likely fail again or run out the clock.
      if (err instanceof CfError) return { error: `HTTP ${err.status}`, retry: err.status >= 500 };
      return { error: err instanceof Error && err.name === "TimeoutError" ? "timed out" : "failed", retry: false };
    }
  };
  /** Whether 
eedMs is left before the deadline, measured now. */
  const timeFor = (needMs: number) => o.deadline - o.now() >= needMs;
  /** Whether the fallback may be used now; reserves its price and claims today's slot when it may. */
  const mayFallBack = (needMs: number): boolean =>
    fallback !== null &&
    !fallbackTried &&
    o.fallbacksEarlier + used.fallback < MAX_FALLBACKS_PER_REPLY &&
    timeFor(needMs) &&
    o.allowance.available() &&
    o.reserve(searchPrice(fallback)) &&
    o.allowance.take();

  if (o.earlier > 0 && mayFallBack(0)) {
    fallbackTried = true;
    const r = await ask(fallback as SearchProvider);
    if ("hits" in r) return { hits: r.hits, costUsd, used };
    // The cheap provider is now a second search in this call, so it too must be able to finish in time.
    if (!timeFor(SEARCH_TIMEOUT_MS)) {
      o.log?.(`web_search: ${fallback} ${r.error}`);
      return { hits: null, refused: "failed", costUsd, used };
    }
    o.log?.(`web_search: ${fallback} ${r.error}; searched ${primary} instead`);
  }

  if (!o.reserve(searchPrice(primary))) return { hits: null, refused: "budget", costUsd, used };
  const r = await ask(primary);
  if ("hits" in r && r.hits.length > 0) return { hits: r.hits, costUsd, used };
  const why = "hits" in r ? "found nothing" : r.error;
  const retry = "hits" in r || r.retry;
  // A second search can take as long as the first, so it is skipped when it couldn't finish before the deadline.
  if (retry && mayFallBack(SEARCH_TIMEOUT_MS)) {
    fallbackTried = true;
    const second = await ask(fallback as SearchProvider);
    if ("hits" in second) {
      o.log?.(`web_search: ${primary} ${why}; retried on ${fallback}`);
      return { hits: second.hits, costUsd, used };
    }
    o.log?.(`web_search: ${primary} ${why}; ${fallback} ${second.error}`);
    return "hits" in r ? { hits: r.hits, costUsd, used } : { hits: null, refused: "failed", costUsd, used };
  }
  if ("hits" in r) return { hits: r.hits, costUsd, used };
  o.log?.(`web_search: ${primary} ${r.error}`);
  return { hits: null, refused: "failed", costUsd, used };
}

/**
 * The URL as the URL parser writes it (brackets, spaces and line breaks percent-encoded), or null when it isn't an
 * http(s) URL web_fetch could open. The model is shown exactly the URL that web_search adds to the reply's links.
 */
function httpUrl(raw: unknown): string | null {
  let u: URL;
  try {
    u = new URL(String(raw));
  } catch {
    return null;
  }
  return (u.protocol === "https:" || u.protocol === "http:") && u.href.length <= MAX_URL ? u.href : null;
}

export function formatHits(query: string, hits: SearchHit[]): string {
  const q = neutralize(query, 100);
  if (hits.length === 0) return `No results for "${q}". Answer from what you know and say you couldn't verify.`;
  return (
    `Search results for "${q}" (untrusted web text):\n\n` +
    hits.map((h, i) => `${i + 1}. ${h.title}\n${h.url}\n${h.snippet}`).join("\n\n")
  );
}

/** One line for the startup log and doctor: which providers web search uses, and the most the fallback can cost. */
export function describeSearch(cfg: Config): string {
  if (cfg.billing === "free") return "web search: off (free mode has none)";
  const p = cfg.tools.searchProvider;
  const head = `web search: ${p} ($${searchPrice(p)} a search)`;
  const fb = cfg.tools.searchFallback;
  if (!fb) return `${head}, no fallback`;
  const max = (cfg.tools.searchFallbackPerDay * searchPrice(fb)).toFixed(2);
  return `${head}; a reply's further searches, and a first search that fails or finds nothing, use ${fb} ($${searchPrice(fb)}), up to ${cfg.tools.searchFallbackPerDay} a day (about $${max}; the count restarts with gork, and DAILY_BUDGET_USD always caps spending)`;
}
