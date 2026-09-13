/**
 * Audit rows (plan D6): flattens the parsed Graph reads (campaigns, ad sets, ads
 * with creatives, insights windows and breakdowns) into per-entity rows that carry
 * every value a `scoring.ts` rule needs, so the rules never touch raw Graph shapes.
 *
 * Pure: `toAuditRows` takes already-parsed `graph.ts` values (the parse boundary is
 * `meta/client.ts`) and returns new values; no I/O.
 *
 * Conventions:
 * - Money is in the account's major units as Graph insights report it (`spend`).
 * - "Weekly result events" = sum of `actions[].value` whose `action_type` equals
 *   `resultAction`, scaled to 7 days from `windowDays`.
 * - Link CTR is a percentage, as Meta's `inline_link_click_ctr`.
 */

import type { Ad, AdSet, Campaign, InsightsRow } from "../graph.js";
import type {
  MetaAdId,
  MetaAdSetId,
  MetaCampaignId,
  MetaCustomAudienceId,
  MetaPixelId,
} from "../ids.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Raw audit reads, each already parsed through its `graph.ts` schema. */
export type MetaAuditRaw = {
  campaigns: readonly Campaign[];
  adSets: readonly AdSet[];
  ads: readonly Ad[];
  /** `level=adset` insights for the current window (with `actions`). */
  adSetInsights: readonly InsightsRow[];
  /** `level=ad` insights for the current window. */
  adInsightsCurrent: readonly InsightsRow[];
  /** `level=ad` insights for the window immediately before the current one. */
  adInsightsPrevious: readonly InsightsRow[];
  /** Account insights broken down by `publisher_platform,platform_position`. */
  placementBreakdown: readonly InsightsRow[];
  /** Account insights broken down by `age,gender`. */
  demographicBreakdown: readonly InsightsRow[];
  /** Length of each insights window in days (7/14/30). */
  windowDays: number;
  /** `action_type` counted as a result (e.g. `lead`, `offsite_conversion.fb_pixel_purchase`). */
  resultAction: string;
};

/** Ad set learning status; `UNAVAILABLE` when Meta omits `learning_stage_info`. */
export type AuditLearningStatus = "LEARNING" | "SUCCESS" | "FAIL" | "UNAVAILABLE";

export type AuditCampaign = {
  id: MetaCampaignId;
  name: string;
  status: string;
  objective: string;
  /** `advantage_state_info.advantage_state`, or null when not reported. */
  advantageState: string | null;
};

export type AuditAdSet = {
  id: MetaAdSetId;
  name: string;
  campaignId: MetaCampaignId;
  status: string;
  /** `effective_status === "ACTIVE"`. */
  active: boolean;
  learningStatus: AuditLearningStatus;
  spend: number;
  /** Result events in the current window. */
  resultEvents: number;
  weeklyResultEvents: number;
  optimizationGoal: string;
  pixelId: MetaPixelId | null;
  customEventType: string | null;
  includedAudienceIds: readonly MetaCustomAudienceId[];
  excludedAudienceIds: readonly MetaCustomAudienceId[];
  /** Campaign-level Advantage+ state (via the ad set's `campaign{}` expansion or the campaign read). */
  advantageState: string | null;
};

export type AuditEnhancement = { feature: string; enrollStatus: "OPT_IN" | "OPT_OUT" };

/** One insights window for an ad; zeros when the ad had no delivery. */
export type AuditAdWindow = {
  spend: number;
  impressions: number;
  frequency: number;
  /** Percent (inline link clicks / impressions × 100). */
  linkCtr: number;
};

export type AuditAd = {
  id: MetaAdId;
  name: string;
  adSetId: MetaAdSetId;
  campaignId: MetaCampaignId;
  status: string;
  current: AuditAdWindow;
  /** Null when the ad had no insights row in the previous window. */
  previous: AuditAdWindow | null;
  /** Unique destination URLs in first-seen order. */
  destinationLinks: readonly string[];
  enhancements: readonly AuditEnhancement[];
};

export type AuditBreakdownDimension = "placement" | "demographic";

export type AuditBreakdownRow = {
  dimension: AuditBreakdownDimension;
  /** e.g. `facebook / feed`, `25-34 / female`. */
  segment: string;
  spend: number;
  results: number;
  /** Segment spend ÷ total spend of the same dimension (0..1). */
  spendShare: number;
  /** Null when the segment has no results. */
  costPerResult: number | null;
};

export type AuditAccountTotals = {
  spend: number;
  results: number;
  weeklyResultEvents: number;
  /** Null when the account has no results. */
  costPerResult: number | null;
};

export type AuditInput = {
  windowDays: number;
  resultAction: string;
  campaigns: readonly AuditCampaign[];
  adSets: readonly AuditAdSet[];
  ads: readonly AuditAd[];
  breakdowns: readonly AuditBreakdownRow[];
  account: AuditAccountTotals;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0);

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];

/** Result events in one row: sum of `actions` matching `resultAction`. */
export const resultEventsOf = (row: InsightsRow, resultAction: string): number =>
  sum((row.actions ?? []).filter((a) => a.action_type === resultAction).map((a) => a.value));

/** Scale a window count to a 7-day rate. */
export const toWeekly = (count: number, windowDays: number): number =>
  windowDays > 0 ? (count * 7) / windowDays : 0;

/** Group items by key (first-seen key order); items whose key is undefined are skipped. */
const groupBy = <K, T>(items: readonly T[], key: (item: T) => K | undefined): Map<K, T[]> =>
  new Map(
    unique(items.map(key).filter((k): k is K => k !== undefined)).map((k) => [
      k,
      items.filter((item) => key(item) === k),
    ]),
  );

/** Collapse one window's insights rows for an ad into totals. */
export const toAdWindow = (rows: readonly InsightsRow[]): AuditAdWindow => {
  const spend = sum(rows.map((r) => r.spend));
  const impressions = sum(rows.map((r) => r.impressions));
  const reach = sum(rows.map((r) => r.reach ?? 0));
  const frequency =
    rows.length === 1
      ? (rows[0]?.frequency ?? (reach > 0 ? impressions / reach : 0))
      : reach > 0
        ? impressions / reach
        : Math.max(0, ...rows.map((r) => r.frequency ?? 0));
  const hasLinkClicks = rows.some((r) => r.inline_link_clicks !== undefined);
  const linkCtr =
    impressions <= 0
      ? 0
      : hasLinkClicks
        ? (sum(rows.map((r) => r.inline_link_clicks ?? 0)) / impressions) * 100
        : sum(rows.map((r) => (r.inline_link_click_ctr ?? 0) * r.impressions)) / impressions;
  return { spend, impressions, frequency, linkCtr };
};

/** Unique destination links from a creative's asset feed and link data. */
export const destinationLinksOf = (creative: Ad["creative"]): string[] =>
  unique([
    ...(creative.asset_feed_spec?.link_urls ?? []).map((l) => l.website_url),
    ...(creative.object_story_spec?.link_data?.link !== undefined
      ? [creative.object_story_spec.link_data.link]
      : []),
  ]);

const isEnrollStatus = (s: string): s is AuditEnhancement["enrollStatus"] => s === "OPT_IN" || s === "OPT_OUT";

/** Flatten `degrees_of_freedom_spec.creative_features_spec`; unrecognised statuses are dropped. */
export const enhancementsOf = (creative: Ad["creative"]): AuditEnhancement[] =>
  Object.entries(creative.degrees_of_freedom_spec?.creative_features_spec ?? {}).flatMap(([feature, spec]) =>
    isEnrollStatus(spec.enroll_status) ? [{ feature, enrollStatus: spec.enroll_status }] : [],
  );

const segmentOf = (dimension: AuditBreakdownDimension, row: InsightsRow): string =>
  dimension === "placement"
    ? `${row.publisher_platform ?? "unknown"} / ${row.platform_position ?? "unknown"}`
    : `${row.age ?? "unknown"} / ${row.gender ?? "unknown"}`;

const toBreakdownRows = (
  dimension: AuditBreakdownDimension,
  rows: readonly InsightsRow[],
  resultAction: string,
): AuditBreakdownRow[] => {
  const total = sum(rows.map((r) => r.spend));
  return [...groupBy(rows, (r) => segmentOf(dimension, r))].map(([segment, segmentRows]) => {
    const spend = sum(segmentRows.map((r) => r.spend));
    const results = sum(segmentRows.map((r) => resultEventsOf(r, resultAction)));
    return {
      dimension,
      segment,
      spend,
      results,
      spendShare: total > 0 ? spend / total : 0,
      costPerResult: results > 0 ? spend / results : null,
    };
  });
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Build the audit rows. Ads whose ad set is not among `adSets` fall back to the ad's
 * own `campaign_id`; an ad with neither is dropped (it cannot be grouped by campaign).
 */
export const toAuditRows = (raw: MetaAuditRaw): AuditInput => {
  const { windowDays, resultAction } = raw;

  const campaignAdvantage = new Map(
    raw.campaigns.map((c) => [c.id, c.advantage_state_info?.advantage_state ?? null] as const),
  );

  const campaigns: AuditCampaign[] = raw.campaigns.map((c) => ({
    id: c.id,
    name: c.name,
    status: c.effective_status,
    objective: c.objective,
    advantageState: c.advantage_state_info?.advantage_state ?? null,
  }));

  const adSetRows = groupBy(raw.adSetInsights, (r) => r.adset_id);

  const adSets: AuditAdSet[] = raw.adSets.map((s) => {
    const rows = adSetRows.get(s.id) ?? [];
    const resultEvents = sum(rows.map((r) => resultEventsOf(r, resultAction)));
    return {
      id: s.id,
      name: s.name,
      campaignId: s.campaign_id,
      status: s.effective_status,
      active: s.effective_status === "ACTIVE",
      learningStatus: s.learning_stage_info?.status ?? "UNAVAILABLE",
      spend: sum(rows.map((r) => r.spend)),
      resultEvents,
      weeklyResultEvents: toWeekly(resultEvents, windowDays),
      optimizationGoal: s.optimization_goal,
      pixelId: s.promoted_object?.pixel_id ?? null,
      customEventType: s.promoted_object?.custom_event_type ?? null,
      includedAudienceIds: (s.targeting.custom_audiences ?? []).map((a) => a.id),
      excludedAudienceIds: (s.targeting.excluded_custom_audiences ?? []).map((a) => a.id),
      advantageState:
        s.campaign?.advantage_state_info?.advantage_state ?? campaignAdvantage.get(s.campaign_id) ?? null,
    };
  });

  const adSetCampaign = new Map(raw.adSets.map((s) => [s.id, s.campaign_id] as const));
  const currentRows = groupBy(raw.adInsightsCurrent, (r) => r.ad_id);
  const previousRows = groupBy(raw.adInsightsPrevious, (r) => r.ad_id);

  const ads: AuditAd[] = raw.ads.flatMap((a) => {
    const campaignId = adSetCampaign.get(a.adset_id) ?? a.campaign_id;
    if (campaignId === undefined) return [];
    const previous = previousRows.get(a.id);
    return [
      {
        id: a.id,
        name: a.name,
        adSetId: a.adset_id,
        campaignId,
        status: a.effective_status,
        current: toAdWindow(currentRows.get(a.id) ?? []),
        previous: previous === undefined ? null : toAdWindow(previous),
        destinationLinks: destinationLinksOf(a.creative),
        enhancements: enhancementsOf(a.creative),
      },
    ];
  });

  const breakdowns = [
    ...toBreakdownRows("placement", raw.placementBreakdown, resultAction),
    ...toBreakdownRows("demographic", raw.demographicBreakdown, resultAction),
  ];

  const accountSpend = sum(raw.adSetInsights.map((r) => r.spend));
  const accountResults = sum(raw.adSetInsights.map((r) => resultEventsOf(r, resultAction)));

  return {
    windowDays,
    resultAction,
    campaigns,
    adSets,
    ads,
    breakdowns,
    account: {
      spend: accountSpend,
      results: accountResults,
      weeklyResultEvents: toWeekly(accountResults, windowDays),
      costPerResult: accountResults > 0 ? accountSpend / accountResults : null,
    },
  };
};
