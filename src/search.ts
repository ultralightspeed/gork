import { cfFetch } from "./cf.ts";
import type { Config } from "./config.ts";
import { neutralize } from "./context.ts";

/** Results asked for per search (and kept). */
export const SEARCH_LIMIT = 5;
/** What one web search costs, USD, for the spend estimate. */
export const SEARCH_COST_USD = 0.00025;
/** Longest query sent; web_search refuses a longer one. */
export const MAX_SEARCH_QUERY = 300;
/** Longest URL web_fetch opens; a longer search result is dropped. */
export const MAX_URL = 2000;

type SearchHit = { title: string; url: string; snippet: string };

export async function webSearch(cfg: Config, query: string, fetchFn: typeof fetch = fetch): Promise<SearchHit[]> {
  const result = (await cfFetch(
    cfg,
    "/ai/websearch",
    {
      query: query.slice(0, MAX_SEARCH_QUERY),
      provider: cfg.tools.searchProvider,
      limit: SEARCH_LIMIT,
      options: { gateway: { id: cfg.cf.gatewayId } },
    },
    fetchFn,
    15_000,
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
