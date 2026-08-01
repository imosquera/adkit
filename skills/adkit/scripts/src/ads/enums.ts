import { enums } from "google-ads-api";

/**
 * Decode a KeywordMatchType as it arrives on a GAQL response row into its
 * string name (EXACT / PHRASE / BROAD / UNSPECIFIED / UNKNOWN).
 *
 * The SDK returns the RAW NUMERIC enum (e.g. 3) for `match_type` on
 * `ad_group_criterion` / `campaign_criterion` rows — NOT the string name — even
 * though some sibling fields (e.g. `campaign.status`) arrive pre-decoded. The
 * plan side always speaks the string form, so live rows must be decoded to it
 * before their identity keys can match.
 *
 * `enums.KeywordMatchType` is a bidirectional map, so it is defensive to pass a
 * value that is already a string name: it is returned unchanged. An out-of-range
 * number decodes to `undefined`, which simply fails to match any plan keyword.
 */
export function matchTypeName(mt: string | number): string {
  return typeof mt === "number" ? enums.KeywordMatchType[mt] : mt;
}

/** Google Ads `AdStrength` enum names — the decoded form `adStrengthName` proves. */
export type AdStrengthName =
  | "UNSPECIFIED"
  | "UNKNOWN"
  | "PENDING"
  | "NO_ADS"
  | "POOR"
  | "AVERAGE"
  | "GOOD"
  | "EXCELLENT";

const AD_STRENGTH_NAMES: ReadonlySet<string> = new Set([
  "UNSPECIFIED",
  "UNKNOWN",
  "PENDING",
  "NO_ADS",
  "POOR",
  "AVERAGE",
  "GOOD",
  "EXCELLENT",
]);

/**
 * Decode an `ad_group_ad.ad_strength` value as it arrives on a GAQL response
 * row into its string name (EXCELLENT / GOOD / AVERAGE / POOR / NO_ADS /
 * PENDING / UNKNOWN / UNSPECIFIED).
 *
 * The SDK returns the RAW NUMERIC enum (e.g. `7` for EXCELLENT), not the
 * string name — same pattern as `matchTypeName` above. Downstream comparisons
 * against string literals (e.g. `!== "EXCELLENT"`) are silently always-true
 * against the raw ordinal, so this decode must happen once, here, before the
 * value reaches `ScoredAd.strength` (see issue #51).
 *
 * Unlike `matchTypeName`, an unrecognized value here is not benign — it feeds
 * `!== "EXCELLENT"` comparisons where an `undefined` would silently misclassify
 * an ad as needing work. So this throws on an out-of-range ordinal or unknown
 * string instead of casting past the check: `AdStrengthName` stays a proof, not
 * a type-level promise.
 */
export function adStrengthName(strength: string | number): AdStrengthName {
  const decoded = typeof strength === "number" ? enums.AdStrength[strength] : strength;
  if (!AD_STRENGTH_NAMES.has(decoded)) {
    throw new Error(`Unknown AdStrength value: ${JSON.stringify(strength)}`);
  }
  return decoded as AdStrengthName;
}
