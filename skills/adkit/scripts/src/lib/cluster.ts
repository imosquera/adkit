/**
 * Pure, data-driven keyword-cluster analysis shared by the report and audit
 * skills. Given already-fetched performance rows (no SDK, no IO), it answers three
 * questions for a campaign:
 *
 *   - keywordsToPromote: which search terms earned their keep and should become
 *     their own keywords (the data-driven replacement for a hand-authored cluster);
 *   - negativesToAdd: which search terms spent money without converting and
 *     should become campaign negatives;
 *   - clusterSplitRecommendation: whether a campaign mixes a cheap-broad and an
 *     expensive-intent keyword group (the reputation-split pattern) such that one
 *     shared budget/bid lets the cheap terms starve the expensive ones.
 *
 * Every function is referentially transparent: same rows in -> same proposal out,
 * no clock, no mutation of the inputs. The IO shells (bin/report.ts, bin/audit.ts)
 * fetch the rows and render the results.
 */

import { comparisonKey } from "./merge.js";

/** A loosely-typed performance row, as fetched from the SDK layer. */
export type Row = Record<string, unknown>;

export interface Proposal {
  text: string;
  matchType: string;
  clicks: number;
  conversions: number;
  cost: number;
}

export interface Negative {
  text: string;
  clicks: number;
  cost: number;
  impressions: number;
}

export interface SplitRecommendation {
  maxCpc: number;
  minCpc: number;
  ratio: number;
  expensive: string[];
  cheap: string[];
  reason: string;
}

/** Coerce a loosely-typed value to an integer, mirroring Python `int(v or 0)`
 * (truncate toward zero; falsy -> 0). Non-numeric input collapses to 0. */
function toInt(value: unknown): number {
  const n = Number(value) || 0;
  return Math.trunc(n);
}

/** Coerce a loosely-typed value to a float, mirroring Python `float(v or 0.0)`.
 * Non-numeric input collapses to 0. */
function toFloat(value: unknown): number {
  return Number(value) || 0;
}

/** Round to `digits` decimals using round-half-to-even (banker's rounding),
 * matching Python's built-in `round`. */
function roundHalfEven(x: number, digits: number): number {
  const factor = 10 ** digits;
  const scaled = x * factor;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  let rounded: number;
  if (diff > 0.5) {
    rounded = floor + 1;
  } else if (diff < 0.5) {
    rounded = floor;
  } else {
    // exactly .5 -> round to even
    rounded = floor % 2 === 0 ? floor : floor + 1;
  }
  return rounded / factor;
}

interface Agg {
  text: string;
  clicks: number;
  conversions: number;
  cost: number;
  impressions: number;
}

/** Pure accumulator step: agg + one row -> a new agg with that row's metrics
 * summed into its (normalized) term, first-seen original-case text preserved. */
function foldTerm(agg: Record<string, Agg>, row: Row): Record<string, Agg> {
  const raw = String(row.search_term ?? "").trim();
  const key = comparisonKey(raw);
  if (!key) {
    return agg;
  }
  const prev: Agg =
    agg[key] ?? { text: raw, clicks: 0, conversions: 0, cost: 0, impressions: 0 };
  return {
    ...agg,
    [key]: {
      text: prev.text,
      clicks: prev.clicks + toInt(row.clicks),
      conversions: prev.conversions + toFloat(row.conversions),
      cost: prev.cost + toFloat(row.cost),
      impressions: prev.impressions + toInt(row.impressions),
    },
  };
}

/** Sum metrics for each distinct search term across all ad groups it appears in.
 * Keyed by the normalized term; carries the first-seen original-case text. */
function aggregate(searchTerms: Iterable<Row>): Record<string, Agg> {
  return [...searchTerms].reduce(foldTerm, {} as Record<string, Agg>);
}

export interface KeywordsToPromoteOptions {
  minClicks?: number;
  minConversions?: number;
  limit?: number;
}

/**
 * Search terms worth adding as their own PHRASE keywords: they drew real
 * engagement (>= minClicks) or converted (>= minConversions) and are not
 * already keywords. Sorted strongest-first (conversions, then clicks, then cost).
 */
export function keywordsToPromote(
  searchTerms: Iterable<Row>,
  existingKeywords: Iterable<Row> = [],
  options: KeywordsToPromoteOptions = {},
): Proposal[] {
  const { minClicks = 3, minConversions = 1.0, limit = 25 } = options;
  const existing = new Set(
    [...existingKeywords].map((k) => comparisonKey(String(k.text ?? ""))),
  );
  const kept = Object.entries(aggregate(searchTerms))
    .filter(
      ([key, a]) =>
        !existing.has(key) && (a.clicks >= minClicks || a.conversions >= minConversions),
    )
    .map(([, a]) => a);
  const sorted = [...kept].sort((x, y) => {
    if (y.conversions !== x.conversions) return y.conversions - x.conversions;
    if (y.clicks !== x.clicks) return y.clicks - x.clicks;
    return y.cost - x.cost;
  });
  return sorted.slice(0, limit).map((a) => ({
    text: a.text,
    matchType: "PHRASE",
    clicks: a.clicks,
    conversions: roundHalfEven(a.conversions, 2),
    cost: roundHalfEven(a.cost, 2),
  }));
}

export interface NegativesToAddOptions {
  minCost?: number;
  limit?: number;
}

/**
 * Search terms that cost money but never converted — wasted spend, and so
 * candidates for campaign negatives. Aggregated across ad groups, sorted by
 * wasted cost descending.
 */
export function negativesToAdd(
  searchTerms: Iterable<Row>,
  options: NegativesToAddOptions = {},
): Negative[] {
  const { minCost = 1.0, limit = 25 } = options;
  const kept = Object.values(aggregate(searchTerms)).filter(
    (a) => a.conversions === 0 && a.cost >= minCost,
  );
  const sorted = [...kept].sort((x, y) => {
    if (y.cost !== x.cost) return y.cost - x.cost;
    return y.impressions - x.impressions;
  });
  return sorted.slice(0, limit).map((a) => ({
    text: a.text,
    clicks: a.clicks,
    cost: roundHalfEven(a.cost, 2),
    impressions: a.impressions,
  }));
}

export interface ClusterSplitRecommendationOptions {
  cpcRatio?: number;
  minKeywords?: number;
}

/**
 * Detect a campaign that mixes a cheap-broad and an expensive-intent keyword
 * group: when the priciest keyword's avg CPC is >= cpcRatio x the cheapest, one
 * shared budget/bid lets the cheap terms win every auction and starve the
 * expensive ones — recommend splitting the expensive group into its own campaign.
 *
 * Returns null when there aren't enough priced keywords or the spread is tight.
 * Pure: reads `text` + `avg_cpc` from each keyword row, mutates nothing.
 */
export function clusterSplitRecommendation(
  keywords: Iterable<Row>,
  options: ClusterSplitRecommendationOptions = {},
): SplitRecommendation | null {
  const { cpcRatio = 3.0, minKeywords = 4 } = options;
  const priced = [...keywords]
    .filter((k) => toFloat(k.avg_cpc) > 0)
    .map((k) => ({ text: String(k.text ?? "").trim(), cpc: toFloat(k.avg_cpc) }));
  if (priced.length < minKeywords) {
    return null;
  }
  const cpcs = priced.map((k) => k.cpc).sort((a, b) => a - b);
  const lo = cpcs[0];
  const hi = cpcs[cpcs.length - 1];
  if (lo <= 0 || hi < cpcRatio * lo) {
    return null;
  }
  // Split at the midpoint CPC: the dear half is the split candidate.
  const midpoint = (lo + hi) / 2;
  const expensive = [
    ...new Set(priced.filter((k) => k.cpc >= midpoint).map((k) => k.text)),
  ].sort();
  const cheap = [
    ...new Set(priced.filter((k) => k.cpc < midpoint).map((k) => k.text)),
  ].sort();
  return {
    maxCpc: roundHalfEven(hi, 2),
    minCpc: roundHalfEven(lo, 2),
    ratio: roundHalfEven(hi / lo, 1),
    expensive,
    cheap,
    reason:
      `Top keyword CPC ($${hi.toFixed(2)}) is ${(hi / lo).toFixed(1)}x the cheapest ($${lo.toFixed(2)}); ` +
      "split the expensive group into its own campaign with its own budget and " +
      "bids so the cheap terms stop starving it.",
  };
}
