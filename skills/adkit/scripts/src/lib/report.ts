/**
 * Pure helpers for the /adkit report skill: metric derivation and error-hint
 * mapping. No SDK imports — every function is referentially transparent and
 * covered by report.test.ts. GAQL query builders live in the central
 * `gaql/builders` module; callers import them directly from there.
 *
 * The IO entrypoint injects the as-of date and feeds raw API values into these
 * functions; nothing here reads the clock or mutates input.
 */

/**
 * Map a Google Ads API error message to an actionable next step. Bad/expired
 * tokens surface at query time (not at credential load), so route those to
 * render-yaml; permission/access problems point at the customer/manager ids.
 */
export function remediationHint(message: string, customer: string, manager: string): string {
  const low = message.toLowerCase();
  if (["authenticat", "credential", "developer token", "oauth"].some((k) => low.includes(k))) {
    return "Re-render credentials: bash ads.sh render-yaml";
  }
  if (["permission", "authoriz", "not authorized"].some((k) => low.includes(k))) {
    return `Verify customer ${customer} is accessible under manager ${manager}.`;
  }
  return "";
}

/** Google money fields are micros (1/1,000,000 of the account currency). */
export function microsToCurrency(micros: number | null | undefined): number {
  return (micros ?? 0) / 1_000_000;
}

/**
 * Zero-denominator → 0.0 (never raise), so 'spent nothing' stays distinguishable
 * from an error. See spec Edge Cases.
 */
export function safeRatio(numerator: number, denominator: number): number {
  return denominator ? numerator / denominator : 0.0;
}

/** Raw API metric values for one row (before normalisation). */
export interface MetricDictOptions {
  costMicros: number | null | undefined;
  impressions: number | null | undefined;
  clicks: number | null | undefined;
  ctr: number | null | undefined;
  avgCpcMicros: number | null | undefined;
  conversions: number | null | undefined;
  costPerConvMicros: number | null | undefined;
}

/** Normalised report shape for one row's metrics. */
export interface MetricDict {
  cost: number;
  impressions: number;
  clicks: number;
  ctr: number;
  avg_cpc: number;
  conversions: number;
  cost_per_conversion: number;
}

/**
 * Normalise one row's raw API metric values into the report shape: micros
 * converted to currency, counts coerced, CTR taken from the API but falling back
 * to a guarded clicks/impressions ratio when absent.
 */
export function metricDict(options: MetricDictOptions): MetricDict {
  const imps = Math.trunc(options.impressions ?? 0);
  const clk = Math.trunc(options.clicks ?? 0);
  return {
    cost: microsToCurrency(options.costMicros),
    impressions: imps,
    clicks: clk,
    ctr: options.ctr !== null && options.ctr !== undefined ? options.ctr : safeRatio(clk, imps),
    avg_cpc: microsToCurrency(options.avgCpcMicros),
    conversions: options.conversions ?? 0,
    cost_per_conversion: microsToCurrency(options.costPerConvMicros),
  };
}
