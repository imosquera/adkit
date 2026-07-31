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
 * Which manager (login-customer-id) a run ACTUALLY went through, as far as the
 * command can tell. Three cases, not two:
 *  - `id` — that MCC id was sent as the login header (from `--manager`, from
 *    `GOOGLE_ADS_LOGIN_CUSTOMER_ID`, or read back out of google-ads.yaml),
 *  - `none` — no login header was sent at all (direct access),
 *  - `yaml` — the login was inherited from google-ads.yaml, whose value could not be
 *    read back (e.g. no credentials file under `ADKIT_READ_BACKEND=mcp`). A header
 *    may well have been sent, so claiming "no manager" here would be a lie.
 */
export type EffectiveManager =
  | { readonly kind: "id"; readonly id: string }
  | { readonly kind: "none" }
  | { readonly kind: "yaml" };

/** The report's `manager_id` field: the id when known, an explicit null otherwise (FR-008). */
export function managerIdField(manager: EffectiveManager): string | null {
  return manager.kind === "id" ? manager.id : null;
}

/** Trailing clause naming the manager a failed query went through (FR-008). */
export function managerPhrase(manager: EffectiveManager): string {
  switch (manager.kind) {
    case "id":
      return ` via manager ${manager.id}`;
    case "yaml":
      return " via the login_customer_id in google-ads.yaml";
    case "none":
      return " with no manager";
  }
}

/**
 * Map a Google Ads API error message to an actionable next step. Bad/expired
 * tokens surface at query time (not at credential load), so route those to
 * render-yaml; permission/access problems point at the customer/manager ids.
 */
export function remediationHint(
  message: string,
  customer: string,
  manager: EffectiveManager,
): string {
  const low = message.toLowerCase();
  if (["authenticat", "credential", "developer token", "oauth"].some((k) => low.includes(k))) {
    return "Re-render credentials: bash ads.sh render-yaml";
  }
  if (["permission", "authoriz", "not authorized"].some((k) => low.includes(k))) {
    // Three-way, matching {@link EffectiveManager}: blame a manager only when one is
    // known; point at the credentials when the login was inherited from them but the
    // value is unreadable; name the tiers that COULD supply one only when the run
    // genuinely sent no login header.
    switch (manager.kind) {
      case "id":
        return `Verify customer ${customer} is accessible under manager ${manager.id}.`;
      case "yaml":
        return (
          `Verify customer ${customer} is accessible under the login_customer_id in ` +
          `google-ads.yaml, or pass --manager <mcc-id> to override it.`
        );
      case "none":
        return (
          `Verify customer ${customer} is directly accessible, or pass --manager <mcc-id> ` +
          `(or export GOOGLE_ADS_LOGIN_CUSTOMER_ID) to reach it through a manager.`
        );
    }
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
