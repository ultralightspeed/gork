// The Web Search providers Cloudflare offers, with each one's list price per search (billed to AI Gateway credits with
// no markup) and whether it keeps a copy of the queries it is sent. No imports: src/config.ts reads this table.
// Source: https://developers.cloudflare.com/web-search/providers/ (October 2026).

export const SEARCH_PROVIDERS = {
  ceramic: { priceUsd: 0.00025, keepsQueries: false },
  linkup: { priceUsd: 0.005, keepsQueries: false },
  exa: { priceUsd: 0.007, keepsQueries: true },
} as const;

export type SearchProvider = keyof typeof SEARCH_PROVIDERS;

export const SEARCH_PROVIDER_NAMES = Object.keys(SEARCH_PROVIDERS) as SearchProvider[];

/** What one search with `provider` costs, USD. */
export const searchPrice = (provider: SearchProvider): number => SEARCH_PROVIDERS[provider].priceUsd;
