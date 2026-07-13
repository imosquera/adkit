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
