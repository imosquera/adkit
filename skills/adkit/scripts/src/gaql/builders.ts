/**
 * Named GAQL query builders — the single home for every Google Ads Query the
 * skill issues. Replaces inline template strings scattered across the audit,
 * apply-fixes, and report shells so the queries are reviewable in one place and
 * every id interpolation is routed through {@link gaqlId} (digits-only guard).
 *
 * Builders here are pure string functions (no SDK import); the IO shells run them.
 * The /adkit report builders historically lived in lib/report; they are
 * re-exported from there for backwards compatibility.
 */

import { gaqlId } from "./escape.js";

// ===========================================================================
// /adkit report builders (re-exported by lib/report)
// ===========================================================================

// Shared GAQL fragments — defined once, reused by every builder (DRY).
const _ENABLED = "campaign.status = 'ENABLED'";
const _METRICS =
  "metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.ctr, " +
  "metrics.average_cpc, metrics.conversions, metrics.cost_per_conversion";

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

function _where(start: string, end: string): string {
  return `WHERE ${_ENABLED} AND segments.date BETWEEN '${start}' AND '${end}'`;
}

export function campaignTotalsQuery(start: string, end: string): string {
  return (
    `SELECT campaign.id, campaign.name, campaign.status, ${_METRICS} ` +
    `FROM campaign ${_where(start, end)}`
  );
}

export function campaignDailyQuery(start: string, end: string): string {
  return (
    `SELECT campaign.id, campaign.name, segments.date, ${_METRICS} ` +
    `FROM campaign ${_where(start, end)} ORDER BY segments.date`
  );
}

export function adGroupQuery(start: string, end: string): string {
  return (
    `SELECT campaign.id, ad_group.id, ad_group.name, ${_METRICS} ` +
    `FROM ad_group ${_where(start, end)}`
  );
}

export function adQuery(start: string, end: string): string {
  // ad_group_ad.ad.name is often blank for search ads; the report shell falls
  // back to the id so every ad has a label. ad_strength is Google's creative
  // quality grade (POOR/AVERAGE/GOOD/EXCELLENT) — a fix-the-ad signal.
  return (
    "SELECT campaign.id, ad_group.id, ad_group_ad.ad.id, " +
    "ad_group_ad.ad.name, ad_group_ad.ad.type, ad_group_ad.ad_strength, " +
    `${_METRICS} FROM ad_group_ad ${_where(start, end)}`
  );
}

export function keywordQuery(start: string, end: string): string {
  return (
    "SELECT campaign.id, ad_group.id, ad_group_criterion.keyword.text, " +
    `ad_group_criterion.keyword.match_type, ${_METRICS} ` +
    `FROM keyword_view ${_where(start, end)}`
  );
}

export function searchTermQuery(start: string, end: string): string {
  return (
    "SELECT campaign.id, ad_group.id, search_term_view.search_term, " +
    `${_METRICS} FROM search_term_view ${_where(start, end)}`
  );
}

// ===========================================================================
// /adkit audit builders
// ===========================================================================

/**
 * Every campaign's ENABLED keywords in one query → caller groups by
 * {campaignId: {adGroupName: [kw]}}. Ids are guarded digits-only.
 */
export function auditKeywordsQuery(campaignIds: ReadonlyArray<string | number>): string {
  const ids = campaignIds.map((c) => gaqlId(c)).join(",");
  return (
    "SELECT campaign.id, ad_group.name, ad_group_criterion.keyword.text " +
    `FROM ad_group_criterion WHERE campaign.id IN (${ids}) ` +
    "AND ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.status != 'REMOVED'"
  );
}

/**
 * Every campaign's ENABLED keywords with average CPC over the window → caller
 * groups by campaignId to detect cheap-broad vs expensive-intent clusters.
 */
export function auditKeywordMetricsQuery(
  days: number,
  campaignIds: ReadonlyArray<string | number>,
): string {
  const ids = campaignIds.map((c) => gaqlId(c)).join(",");
  return (
    "SELECT campaign.id, ad_group_criterion.keyword.text, metrics.average_cpc " +
    `FROM keyword_view WHERE campaign.id IN (${ids}) ` +
    `AND segments.date DURING LAST_${Math.trunc(days)}_DAYS`
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
): string {
  const ids = campaignIds.map((c) => gaqlId(c)).join(",");
  return (
    "SELECT campaign.id, search_term_view.search_term, " +
    "metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions " +
    `FROM search_term_view WHERE campaign.id IN (${ids}) ` +
    `AND segments.date DURING LAST_${Math.trunc(days)}_DAYS`
  );
}

/** List campaigns to audit: a single id, ENABLED-only, or all. */
export function auditCampaignsQuery(
  onlyEnabled: boolean,
  campaignId: string | null | undefined,
): string {
  const where = campaignId
    ? [`campaign.id = ${gaqlId(campaignId)}`]
    : onlyEnabled
      ? ["campaign.status = 'ENABLED'"]
      : [];
  const clause = where.length > 0 ? " WHERE " + where.join(" AND ") : "";
  return `SELECT campaign.id, campaign.name, campaign.status FROM campaign${clause} ORDER BY campaign.name`;
}

/** Count campaign assets of one extension fieldType (SITELINK/CALLOUT). */
export function auditExtCountQuery(campId: string, fieldType: string): string {
  return (
    `SELECT campaign.id FROM campaign_asset WHERE campaign.id = ${gaqlId(campId)} ` +
    `AND campaign_asset.field_type = '${fieldType}'`
  );
}

/**
 * Current Quality Score snapshot per keyword: overall score (1-10) plus the three
 * component ratings (BELOW_AVERAGE/AVERAGE/ABOVE_AVERAGE) for expected CTR, ad
 * relevance, and landing page experience. No date segmentation — these are
 * current-state fields on ad_group_criterion.
 */
export function auditQualityScoreQuery(
  campaignIds: ReadonlyArray<string | number>,
): string {
  const ids = campaignIds.map((c) => gaqlId(c)).join(",");
  return (
    "SELECT campaign.id, ad_group_criterion.keyword.text, " +
    "ad_group_criterion.quality_info.quality_score, " +
    "ad_group_criterion.quality_info.search_predicted_ctr, " +
    "ad_group_criterion.quality_info.creative_quality_score, " +
    "ad_group_criterion.quality_info.post_click_quality_score " +
    `FROM keyword_view WHERE campaign.id IN (${ids}) ` +
    "AND ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.status != 'REMOVED'"
  );
}

/** All non-removed RSAs in a campaign with the fields the creative audit reads. */
export function auditAdGroupAdQuery(campId: string): string {
  return (
    "SELECT ad_group.name, ad_group_ad.ad.id, ad_group_ad.ad_strength, ad_group_ad.status, " +
    "ad_group_ad.action_items, ad_group_ad.ad.responsive_search_ad.headlines, " +
    "ad_group_ad.ad.responsive_search_ad.descriptions, ad_group_ad.ad.final_urls " +
    `FROM ad_group_ad WHERE campaign.id = ${gaqlId(campId)} AND ad_group_ad.status != 'REMOVED' ` +
    // Constrain to RSAs so a non-RSA ad (call-only, display, legacy ETA) is never fetched,
    // normalized into an empty RSA, and mis-scored as headlines_under/descriptions_under.
    "AND ad_group_ad.ad.type = 'RESPONSIVE_SEARCH_AD' " +
    "ORDER BY ad_group.name"
  );
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
): string {
  const ids = campaignIds.map((c) => gaqlId(c)).join(",");
  return (
    "SELECT campaign.id, landing_page_view.unexpanded_final_url, " +
    "metrics.mobile_friendly_clicks_percentage, " +
    "metrics.valid_accelerated_mobile_pages_clicks_percentage, metrics.speed_score, " +
    "metrics.clicks, metrics.impressions, metrics.ctr " +
    `FROM landing_page_view WHERE campaign.id IN (${ids}) ` +
    `AND segments.date DURING LAST_${Math.trunc(days)}_DAYS`
  );
}

/**
 * Policy findings on enabled ads in one campaign — caller filters
 * policy_topic_entries for destination/URL topics (DESTINATION_NOT_WORKING,
 * DESTINATION_MISMATCH) that the audit table maps to a concrete fix.
 */
export function auditPolicyTopicsQuery(campId: string): string {
  return (
    "SELECT ad_group_ad.ad.id, ad_group_ad.ad.final_urls, " +
    "ad_group_ad.policy_summary.policy_topic_entries " +
    `FROM ad_group_ad WHERE campaign.id = ${gaqlId(campId)} ` +
    "AND ad_group_ad.status = 'ENABLED'"
  );
}

/** Impression-share / budget / rank metrics for the serving layer. */
export function auditServingQuery(
  days: number,
  onlyEnabled: boolean,
  campaignId: string | null | undefined,
): string {
  const base = [`segments.date DURING LAST_${Math.trunc(days)}_DAYS`];
  const where = campaignId
    ? [...base, `campaign.id = ${gaqlId(campaignId)}`]
    : onlyEnabled
      ? [...base, "campaign.status = 'ENABLED'"]
      : base;
  return (
    "SELECT campaign.id, campaign.name, campaign.bidding_strategy_type, campaign_budget.amount_micros, " +
    "metrics.impressions, metrics.conversions, metrics.search_impression_share, " +
    "metrics.search_budget_lost_impression_share, metrics.search_rank_lost_impression_share " +
    `FROM campaign WHERE ${where.join(" AND ")}`
  );
}

// ===========================================================================
// /adkit update builders (apply-fixes)
// ===========================================================================

/** Existing campaign-level negative keywords, to dedup a fixes plan against. */
export function applyNegativesQuery(
  campaignIds: ReadonlyArray<string | number>,
): string {
  const ids = campaignIds.map((i) => gaqlId(i)).join(",");
  return (
    "SELECT campaign.id, campaign_criterion.keyword.text, " +
    "campaign_criterion.keyword.match_type FROM campaign_criterion " +
    `WHERE campaign.id IN (${ids}) AND campaign_criterion.negative = TRUE ` +
    "AND campaign_criterion.type = KEYWORD"
  );
}

/** Each campaign's current budget resource + amount, for the budget guardrail. */
export function applyBudgetsQuery(
  campaignIds: ReadonlyArray<string | number>,
): string {
  const ids = campaignIds.map((i) => gaqlId(i)).join(",");
  return (
    "SELECT campaign.id, campaign_budget.resource_name, campaign_budget.amount_micros " +
    `FROM campaign WHERE campaign.id IN (${ids})`
  );
}

/**
 * Each campaign's current serving status, so a campaignStatus fixes block can skip
 * a no-op flip (a campaign already in the requested status).
 */
export function applyCampaignStatusesQuery(
  campaignIds: ReadonlyArray<string | number>,
): string {
  const ids = campaignIds.map((i) => gaqlId(i)).join(",");
  return (
    "SELECT campaign.id, campaign.status " +
    `FROM campaign WHERE campaign.id IN (${ids})`
  );
}

/**
 * Each ad group's current serving status, so an adGroupStatus fixes block can skip
 * a no-op flip (an ad group already in the requested status).
 */
export function applyAdGroupStatusesQuery(
  adGroupIds: ReadonlyArray<string | number>,
): string {
  const ids = adGroupIds.map((i) => gaqlId(i)).join(",");
  return (
    "SELECT ad_group.id, ad_group.status " +
    `FROM ad_group WHERE ad_group.id IN (${ids})`
  );
}

/** Live RSA headlines for the ads an appendHeadlines plan touches. */
export function applyHeadlinesQuery(adIds: ReadonlyArray<string | number>): string {
  const ids = adIds.map((i) => gaqlId(i)).join(",");
  return (
    "SELECT ad_group_ad.ad.id, ad_group_ad.ad.responsive_search_ad.headlines " +
    `FROM ad_group_ad WHERE ad_group_ad.ad.id IN (${ids})`
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
): string {
  const ids = adGroupIds.map((i) => gaqlId(i)).join(",");
  return (
    "SELECT ad_group.id, ad_group_criterion.criterion_id, ad_group_criterion.resource_name, " +
    "ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, " +
    "ad_group_criterion.status FROM ad_group_criterion " +
    `WHERE ad_group.id IN (${ids}) AND ad_group_criterion.type = KEYWORD ` +
    "AND ad_group_criterion.negative = FALSE AND ad_group_criterion.status != 'REMOVED'"
  );
}
