/**
 * The local, git-ignored run-over-run cache backing the `new_competitor`
 * finding: a customer -> campaign -> competing-domain-list snapshot from the
 * prior audit run, diffed against the current run's Auction Insights data.
 *
 * Mirrors the `DifferentiationProfileSchema`/`parseDifferentiationProfile`
 * convention in `src/lib/brand.ts` — a small local JSON, parsed once via Zod
 * at the IO boundary into a domain type the rest of this module trusts.
 */

import { z } from "zod";

export const AuctionInsightsCacheSchema = z.record(
  z.string(),
  z.record(z.string(), z.array(z.string())),
);
export type AuctionInsightsCache = z.infer<typeof AuctionInsightsCacheSchema>;

/** The neutral cache: no prior snapshot for any customer/campaign. */
export const EMPTY_CACHE: AuctionInsightsCache = {};

/**
 * Parse an untrusted cache payload (JSON read off disk) into an
 * {@link AuctionInsightsCache}, throwing on malformed shape. The IO shell that
 * reads the file is responsible for substituting {@link EMPTY_CACHE} on a
 * missing file or a thrown parse error — that fallback is a resilience choice
 * for a best-effort local file, not a re-validation of an already-parsed value.
 */
export function parseAuctionInsightsCache(data: unknown): AuctionInsightsCache {
  return AuctionInsightsCacheSchema.parse(data);
}

/**
 * Compare the current run's competing domains for one campaign against the
 * cache. `isFirstRun` is true (and `newDomains` empty) when no prior snapshot
 * exists for this customer/campaign — nothing to diff against, so
 * `new_competitor` must not fire (spec FR-007). Otherwise `newDomains` is the
 * set of current domains absent from the prior snapshot.
 */
export function diffNewCompetitors(
  cache: AuctionInsightsCache,
  customerId: string,
  campaignId: number,
  currentDomains: readonly string[],
): { isFirstRun: boolean; newDomains: string[] } {
  const prior = cache[customerId]?.[String(campaignId)];
  if (prior === undefined) {
    return { isFirstRun: true, newDomains: [] };
  }
  const priorSet = new Set(prior);
  return { isFirstRun: false, newDomains: currentDomains.filter((d) => !priorSet.has(d)) };
}

/**
 * Immutably replace one customer/campaign's cached domain list with the
 * current run's domains. Returns a new cache; never mutates `cache`.
 */
export function updateCache(
  cache: AuctionInsightsCache,
  customerId: string,
  campaignId: number,
  currentDomains: readonly string[],
): AuctionInsightsCache {
  return {
    ...cache,
    [customerId]: {
      ...cache[customerId],
      [String(campaignId)]: [...currentDomains],
    },
  };
}
