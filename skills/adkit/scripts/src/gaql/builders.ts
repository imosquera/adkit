/**
 * Named read-query builders — the single home for every Google Ads read query the
 * skill issues. Replaces inline template strings scattered across the audit,
 * apply-fixes, and report shells so the queries are reviewable in one place and
 * every id interpolation is routed through {@link gaqlId} (digits-only guard).
 *
 * Each builder returns a decomposed {@link SearchArgs} (`{ resource, fields,
 * conditions, orderings?, limit? }`) rather than a GAQL string, so the same value
 * can drive both the SDK backend (via {@link toGaql}) and the google-ads-mcp
 * `search` tool (which wants decomposed args, not raw GAQL). Builders are pure
 * functions (no SDK import); the IO shells run them.
 *
 * Structure: three families (report / audit / apply) share a handful of small
 * factories — {@link reportQuery} for the metric+date-window reads, and
 * {@link inListQuery} for the `<col> IN (ids…)` reads. Each public builder is a
 * thin, named wrapper over a factory, so call sites and the golden-string parity
 * tests stay stable while the `{ id.map(gaqlId).join(",") }` fragment and the
 * `SearchArgs` shape live in exactly one place instead of being copy-pasted ~20×.
 */

import { gaqlId } from "./escape.js";
import type { SearchArgs } from "./search-args.js";

// ===========================================================================
// Shared fragments & factories
// ===========================================================================

const _ENABLED = "campaign.status = 'ENABLED'";
const _METRICS: readonly string[] = [
  "metrics.cost_micros",
  "metrics.impressions",
  "metrics.clicks",
  "metrics.ctr",
  "metrics.average_cpc",
  "metrics.conversions",
  "metrics.cost_per_conversion",
];

/**
 * The last `days` COMPLETE days ending yesterday (partial current day excluded so
 * day-over-day trends are comparable). Accepts a `Date` and computes in UTC to
 * avoid tz drift. Returns `[start, end]` ISO date strings (`YYYY-MM-DD`).
 */
export function dateWindow(asOf: Date, days: number): [string, string] {
  const MS_PER_DAY = 86_400_000;
  const base = Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate());
  const endMs = base - MS_PER_DAY;
  const startMs = endMs - (days - 1) * MS_PER_DAY;
  return [isoDate(startMs), isoDate(endMs)];
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The shared report WHERE predicates: ENABLED campaigns over the date window. */
function _whereConds(start: string, end: string): readonly string[] {
  return [_ENABLED, `segments.date BETWEEN '${start}' AND '${end}'`];
}

/**
 * Factory for the /adkit report reads: `SELECT <dims>, <metrics> FROM <resource>
 * WHERE ENABLED AND date BETWEEN …`. The families differ only in `resource`, the
 * leading dimension fields, and (for the daily view) an ORDER BY — everything else
 * (the metric columns, the WHERE) is identical.
 */
function reportQuery(
  resource: string,
  dims: readonly string[],
  start: string,
  end: string,
  orderings?: readonly string[],
): SearchArgs {
  return {
    resource,
    fields: [...dims, ..._METRICS],
    conditions: _whereConds(start, end),
    ...(orderings ? { orderings } : {}),
  };
}

/** `segments.date DURING LAST_<n>_DAYS` window predicate (n truncated to an int). */
function lastNDays(days: number): string {
  return `segments.date DURING LAST_${Math.trunc(days)}_DAYS`;
}

/**
 * Factory for every `<idColumn> IN (id, id, …)` read (the audit + apply families).
 * Ids are guarded digits-only via {@link gaqlId} here — the single home for that
 * `.map(gaqlId).join(",")` fragment. `extra` is appended verbatim after the IN
 * clause, so callers control the exact remaining WHERE order (status filters, date
 * windows, type filters).
 */
function inListQuery(
  resource: string,
  fields: readonly string[],
  idColumn: string,
  ids: ReadonlyArray<string | number>,
  extra: readonly string[] = [],
): SearchArgs {
  const inClause = `${idColumn} IN (${ids.map((i) => gaqlId(i)).join(",")})`;
  return { resource, fields, conditions: [inClause, ...extra] };
}

/**
 * The shared campaign-scope predicate ladder used by the campaign-list reads:
 * a single id wins, else ENABLED-only, else no scope. Returned as the trailing
 * conditions so callers can prepend a date window.
 */
function campaignScope(
  onlyEnabled: boolean,
  campaignId: string | null | undefined,
): readonly string[] {
  return campaignId
    ? [`campaign.id = ${gaqlId(campaignId)}`]
    : onlyEnabled
      ? [_ENABLED]
      : [];
}

// ===========================================================================
// /adkit report builders
// ===========================================================================

export function campaignTotalsQuery(start: string, end: string): SearchArgs {
  return reportQuery("campaign", ["campaign.id", "campaign.name", "campaign.status"], start, end);
}

export function campaignDailyQuery(start: string, end: string): SearchArgs {
  return reportQuery(
    "campaign",
    ["campaign.id", "campaign.name", "segments.date"],
    start,
    end,
    ["segments.date"],
  );
}

export function adGroupQuery(start: string, end: string): SearchArgs {
  return reportQuery("ad_group", ["campaign.id", "ad_group.id", "ad_group.name"], start, end);
}

export function adQuery(start: string, end: string): SearchArgs {
  // ad_group_ad.ad.name is often blank for search ads; the report shell falls
  // back to the id so every ad has a label. ad_strength is Google's creative
  // quality grade (POOR/AVERAGE/GOOD/EXCELLENT) — a fix-the-ad signal.
  return reportQuery(
    "ad_group_ad",
    [
      "campaign.id",
      "ad_group.id",
      "ad_group_ad.ad.id",
      "ad_group_ad.ad.name",
      "ad_group_ad.ad.type",
      "ad_group_ad.ad_strength",
    ],
    start,
    end,
  );
}

export function keywordQuery(start: string, end: string): SearchArgs {
  return reportQuery(
    "keyword_view",
    [
      "campaign.id",
      "ad_group.id",
      "ad_group_criterion.keyword.text",
      "ad_group_criterion.keyword.match_type",
    ],
    start,
    end,
  );
}

export function searchTermQuery(start: string, end: string): SearchArgs {
  return reportQuery(
    "search_term_view",
    ["campaign.id", "ad_group.id", "search_term_view.search_term"],
    start,
    end,
  );
}

/**
 * Geographic performance keyed by country: one `geographic_view` row per
 * (campaign, country) over the window, tagged with Google's country geo-target
 * constant id (`country_criterion_id`, e.g. 2840 = US). The report shell sums these
 * across campaigns into the per-country `geo` breakdown.
 */
export function geoQuery(start: string, end: string): SearchArgs {
  return reportQuery(
    "geographic_view",
    ["campaign.id", "geographic_view.country_criterion_id"],
    start,
    end,
  );
}

/**
 * Sub-national geographic performance keyed by region: the same `geographic_view`
 * rows segmented by `segments.geo_target_region` (US state/metro geo-target resource
 * names). The report shell sums these into the per-region `geo_regions` breakdown.
 */
export function geoRegionQuery(start: string, end: string): SearchArgs {
  return reportQuery(
    "geographic_view",
    ["campaign.id", "segments.geo_target_region"],
    start,
    end,
  );
}

// ===========================================================================
// /adkit audit builders
// ===========================================================================

/**
 * Every campaign's ENABLED keywords in one query → caller groups by
 * {campaignId: {adGroupName: [kw]}}. Ids are guarded digits-only.
 */
export function auditKeywordsQuery(campaignIds: ReadonlyArray<string | number>): SearchArgs {
  return inListQuery(
    "ad_group_criterion",
    ["campaign.id", "ad_group.name", "ad_group_criterion.keyword.text"],
    "campaign.id",
    campaignIds,
    ["ad_group_criterion.type = 'KEYWORD'", "ad_group_criterion.status != 'REMOVED'"],
  );
}

/**
 * Every campaign's ENABLED keywords with average CPC over the window → caller
 * groups by campaignId to detect cheap-broad vs expensive-intent clusters.
 */
export function auditKeywordMetricsQuery(
  days: number,
  campaignIds: ReadonlyArray<string | number>,
): SearchArgs {
  return inListQuery(
    "keyword_view",
    ["campaign.id", "ad_group_criterion.keyword.text", "metrics.average_cpc"],
    "campaign.id",
    campaignIds,
    ["ad_group_criterion.status = 'ENABLED'", lastNDays(days)],
  );
}

/**
 * Each campaign's search terms with metrics over the window → caller derives
 * negative-keyword + promote candidates with the same cluster logic /adkit report
 * uses. Ids guarded digits-only.
 */
export function auditSearchTermsQuery(
  days: number,
  campaignIds: ReadonlyArray<string | number>,
): SearchArgs {
  return inListQuery(
    "search_term_view",
    [
      "campaign.id",
      "search_term_view.search_term",
      "metrics.cost_micros",
      "metrics.impressions",
      "metrics.clicks",
      "metrics.conversions",
    ],
    "campaign.id",
    campaignIds,
    [lastNDays(days)],
  );
}

/** List campaigns to audit: a single id, ENABLED-only, or all. */
export function auditCampaignsQuery(
  onlyEnabled: boolean,
  campaignId: string | null | undefined,
): SearchArgs {
  return {
    resource: "campaign",
    fields: ["campaign.id", "campaign.name", "campaign.status"],
    conditions: campaignScope(onlyEnabled, campaignId),
    orderings: ["campaign.name"],
  };
}

/** Count campaign assets of one extension fieldType (SITELINK/CALLOUT). */
export function auditExtCountQuery(campId: string, fieldType: string): SearchArgs {
  return {
    resource: "campaign_asset",
    fields: ["campaign.id"],
    conditions: [
      `campaign.id = ${gaqlId(campId)}`,
      `campaign_asset.field_type = '${fieldType}'`,
    ],
  };
}

/**
 * Current Quality Score snapshot per keyword: overall score (1-10) plus the three
 * component ratings (BELOW_AVERAGE/AVERAGE/ABOVE_AVERAGE) for expected CTR, ad
 * relevance, and landing page experience. No date segmentation — these are
 * current-state fields on ad_group_criterion.
 */
export function auditQualityScoreQuery(
  campaignIds: ReadonlyArray<string | number>,
): SearchArgs {
  return inListQuery(
    "keyword_view",
    [
      "campaign.id",
      "ad_group_criterion.keyword.text",
      "ad_group_criterion.quality_info.quality_score",
      "ad_group_criterion.quality_info.search_predicted_ctr",
      "ad_group_criterion.quality_info.creative_quality_score",
      "ad_group_criterion.quality_info.post_click_quality_score",
    ],
    "campaign.id",
    campaignIds,
    ["ad_group_criterion.type = 'KEYWORD'", "ad_group_criterion.status != 'REMOVED'"],
  );
}

/** All non-removed RSAs in a campaign with the fields the creative audit reads. */
export function auditAdGroupAdQuery(campId: string): SearchArgs {
  return {
    resource: "ad_group_ad",
    fields: [
      "ad_group.name",
      "ad_group_ad.ad.id",
      "ad_group_ad.ad_strength",
      "ad_group_ad.status",
      "ad_group_ad.action_items",
      "ad_group_ad.ad.responsive_search_ad.headlines",
      "ad_group_ad.ad.responsive_search_ad.descriptions",
      "ad_group_ad.ad.final_urls",
    ],
    conditions: [
      `campaign.id = ${gaqlId(campId)}`,
      "ad_group_ad.status != 'REMOVED'",
      // Constrain to RSAs so a non-RSA ad (call-only, display, legacy ETA) is never fetched,
      // normalized into an empty RSA, and mis-scored as headlines_under/descriptions_under.
      "ad_group_ad.ad.type = 'RESPONSIVE_SEARCH_AD'",
    ],
    orderings: ["ad_group.name"],
  };
}

/**
 * Per-URL mobile/AMP click quality and page-speed score from landing_page_view,
 * over the window. Caller flags mobile_friendly_clicks_percentage < 1.0 (always)
 * and valid_accelerated_mobile_pages_clicks_percentage < 1.0 (only when AMP clicks
 * exist, i.e. the field is populated).
 */
export function auditLandingPageMobileQuery(
  days: number,
  campaignIds: ReadonlyArray<string | number>,
): SearchArgs {
  return inListQuery(
    "landing_page_view",
    [
      "campaign.id",
      "landing_page_view.unexpanded_final_url",
      "metrics.mobile_friendly_clicks_percentage",
      "metrics.valid_accelerated_mobile_pages_clicks_percentage",
      "metrics.speed_score",
      "metrics.clicks",
      "metrics.impressions",
      "metrics.ctr",
    ],
    "campaign.id",
    campaignIds,
    [lastNDays(days)],
  );
}

/**
 * Policy findings on enabled ads in one campaign — caller filters
 * policy_topic_entries for destination/URL topics (DESTINATION_NOT_WORKING,
 * DESTINATION_MISMATCH) that the audit table maps to a concrete fix.
 */
export function auditPolicyTopicsQuery(campId: string): SearchArgs {
  return {
    resource: "ad_group_ad",
    fields: [
      "ad_group_ad.ad.id",
      "ad_group_ad.ad.final_urls",
      "ad_group_ad.policy_summary.policy_topic_entries",
    ],
    conditions: [`campaign.id = ${gaqlId(campId)}`, "ad_group_ad.status = 'ENABLED'"],
  };
}

/** Impression-share / budget / rank metrics for the serving layer. */
export function auditServingQuery(
  days: number,
  onlyEnabled: boolean,
  campaignId: string | null | undefined,
): SearchArgs {
  return {
    resource: "campaign",
    fields: [
      "campaign.id",
      "campaign.name",
      "campaign.bidding_strategy_type",
      "campaign_budget.amount_micros",
      "metrics.impressions",
      "metrics.conversions",
      "metrics.search_impression_share",
      "metrics.search_budget_lost_impression_share",
      "metrics.search_rank_lost_impression_share",
    ],
    conditions: [lastNDays(days), ...campaignScope(onlyEnabled, campaignId)],
  };
}

// ===========================================================================
// /adkit update builders (apply-fixes)
// ===========================================================================

/** Existing campaign-level negative keywords, to dedup a fixes plan against. */
export function applyNegativesQuery(
  campaignIds: ReadonlyArray<string | number>,
): SearchArgs {
  return inListQuery(
    "campaign_criterion",
    [
      "campaign.id",
      "campaign_criterion.keyword.text",
      "campaign_criterion.keyword.match_type",
    ],
    "campaign.id",
    campaignIds,
    ["campaign_criterion.negative = TRUE", "campaign_criterion.type = KEYWORD"],
  );
}

/** Each campaign's current budget resource + amount, for the budget guardrail. */
export function applyBudgetsQuery(
  campaignIds: ReadonlyArray<string | number>,
): SearchArgs {
  return inListQuery(
    "campaign",
    ["campaign.id", "campaign_budget.resource_name", "campaign_budget.amount_micros"],
    "campaign.id",
    campaignIds,
  );
}

/**
 * Each campaign's current serving status, so a campaignStatus fixes block can skip
 * a no-op flip (a campaign already in the requested status).
 */
export function applyCampaignStatusesQuery(
  campaignIds: ReadonlyArray<string | number>,
): SearchArgs {
  return inListQuery("campaign", ["campaign.id", "campaign.status"], "campaign.id", campaignIds);
}

/**
 * Each campaign's current Search Partners setting plus target_google_search, so a
 * searchPartners fixes block can skip a no-op flip (a campaign already at the
 * requested setting) and reject an ENABLE that Google Ads would reject server-side
 * (target_search_network=true requires target_google_search=true).
 */
export function applySearchPartnersQuery(
  campaignIds: ReadonlyArray<string | number>,
): SearchArgs {
  return inListQuery(
    "campaign",
    [
      "campaign.id",
      "campaign.network_settings.target_search_network",
      "campaign.network_settings.target_google_search",
    ],
    "campaign.id",
    campaignIds,
  );
}

/**
 * Each ad group's current serving status, so an adGroupStatus fixes block can skip
 * a no-op flip (an ad group already in the requested status).
 */
export function applyAdGroupStatusesQuery(
  adGroupIds: ReadonlyArray<string | number>,
): SearchArgs {
  return inListQuery("ad_group", ["ad_group.id", "ad_group.status"], "ad_group.id", adGroupIds);
}

/**
 * Live status + parent ad-group id per ad, so an `adStatus` (ad on/off) block can
 * skip a no-op flip and resolve the ad_group_ad resource name (which needs both
 * adGroupId and adId). Ids guarded via gaqlId.
 */
export function applyAdStatusesQuery(
  adIds: ReadonlyArray<string | number>,
): string {
  const ids = adIds.map((i) => gaqlId(i)).join(",");
  return (
    "SELECT ad_group.id, ad_group_ad.ad.id, ad_group_ad.status " +
    `FROM ad_group_ad WHERE ad_group_ad.ad.id IN (${ids})`
  );
}

/**
 * Live (non-removed) ad-group names per campaign, so an `adGroups` (add-ad-group)
 * fixes block can skip a name that already exists in the target campaign (the
 * add is idempotent — re-running never creates a duplicate ad group). Ids guarded.
 */
export function applyAdGroupNamesQuery(
  campaignIds: ReadonlyArray<string | number>,
): SearchArgs {
  return inListQuery(
    "ad_group",
    ["campaign.id", "ad_group.name"],
    "campaign.id",
    campaignIds,
    ["ad_group.status != 'REMOVED'"],
  );
}

/**
 * Live (non-removed) language targeting criteria per campaign, so a `languages`
 * (English-only) block can add English when absent and remove every other language.
 * Ids guarded digits-only.
 */
export function applyLanguagesQuery(
  campaignIds: ReadonlyArray<string | number>,
): SearchArgs {
  return inListQuery(
    "campaign_criterion",
    [
      "campaign.id",
      "campaign_criterion.resource_name",
      "campaign_criterion.language.language_constant",
    ],
    "campaign.id",
    campaignIds,
    ["campaign_criterion.type = LANGUAGE", "campaign_criterion.status != 'REMOVED'"],
  );
}

/** Live RSA headlines for the ads an appendHeadlines plan touches. */
export function applyHeadlinesQuery(adIds: ReadonlyArray<string | number>): SearchArgs {
  return inListQuery(
    "ad_group_ad",
    ["ad_group_ad.ad.id", "ad_group_ad.ad.responsive_search_ad.headlines"],
    "ad_group_ad.ad.id",
    adIds,
  );
}

/**
 * Live POSITIVE (non-negative) keyword criteria for the ad groups a fixes-plan
 * `keywords` block touches → caller groups by
 * {adGroupId: {(text.lower, matchType): criterionResource}}. Used to dedup ADDs
 * against live state and to resolve the criterion to REMOVE/PAUSE. Ids guarded.
 */
export function applyPositiveKeywordsQuery(
  adGroupIds: ReadonlyArray<string | number>,
): SearchArgs {
  return inListQuery(
    "ad_group_criterion",
    [
      "ad_group.id",
      "ad_group_criterion.criterion_id",
      "ad_group_criterion.resource_name",
      "ad_group_criterion.keyword.text",
      "ad_group_criterion.keyword.match_type",
      "ad_group_criterion.status",
    ],
    "ad_group.id",
    adGroupIds,
    [
      "ad_group_criterion.type = KEYWORD",
      "ad_group_criterion.negative = FALSE",
      "ad_group_criterion.status != 'REMOVED'",
    ],
  );
}
