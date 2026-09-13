/**
 * Pure shaping of parsed Meta insights rows into the report written to disk
 * (plan D5). No I/O: `meta/report/fetch.ts` returns {@link MetaReportRows},
 * `meta/bin/report.ts` passes them here with the run's identifiers and writes
 * the result as YAML.
 *
 * The output reuses Google's {@link ReportData} collections so the report
 * reference and chart tooling read both platforms the same way:
 *
 * - `ad_groups` are ad sets; `ads[].type` is `"META_AD"` and `ads[].ad_strength`
 *   `"UNSPECIFIED"` (Meta has no ad-strength rating).
 * - `keywords`, `search_terms` and `recommendations` are empty (search-only concepts).
 * - `geo` carries the ISO 3166-1 alpha-2 country code (Meta's `country` breakdown)
 *   in `country_criterion_id` — the only country key `GeoRecord` has — and repeats
 *   it as `country` so the file does not pass it off as a Google criterion id.
 *   `geo_regions[].region` is Meta's region name (e.g. `"California"`).
 *
 * Metric conventions match `metricDict` in `lib/report.ts`: counts are truncated
 * to integers, money stays unrounded in account currency (Graph money is a
 * decimal string already coerced by `InsightsRowSchema`, never micros), and rates
 * are derived with `safeRatio`. `ctr` is a fraction (clicks / impressions) as in
 * Google reports, not Meta's percentage `ctr` field.
 */

import type { Report, ReportData } from "../../bin/report.js";
import { safeRatio, type MetricDict } from "../../lib/report.js";
import type { Campaign, InsightsRow } from "../graph.js";
import type { MetaAdAccountId } from "../ids.js";

/** Attribution windows Meta still returns (the 7d/28d view windows were removed 2026-01-12). */
export type AttributionWindow = "1d_click" | "7d_click" | "28d_click" | "1d_view" | "1d_ev";

/** Parsed rows from every report read; produced by `fetchMetaReportRows`. */
export type MetaReportRows = {
  /** `act_<id>/campaigns` — name and `effective_status` per campaign. */
  campaigns: Campaign[];
  /** `level=campaign` insights. */
  campaignTotals: InsightsRow[];
  /** `level=campaign&time_increment=1` insights. */
  campaignDaily: InsightsRow[];
  /** `level=adset` insights. */
  adSets: InsightsRow[];
  /** `level=ad` insights. */
  ads: InsightsRow[];
  /** `level=account&breakdowns=publisher_platform,platform_position`. */
  placements: InsightsRow[];
  /** `level=account&breakdowns=age,gender`. */
  demographics: InsightsRow[];
  /** `level=account&breakdowns=country`. */
  countries: InsightsRow[];
  /** `level=account&breakdowns=region`. */
  regions: InsightsRow[];
};

/** Google's metric block plus the Meta delivery metrics audit and report docs rely on. */
export type MetaMetricDict = MetricDict & {
  reach: number;
  frequency: number;
  cpm: number;
  link_clicks: number;
};

type CampaignRecord = ReportData["campaigns"][number] & MetaMetricDict;
type CampaignDailyRecord = ReportData["campaign_daily"][number] & MetaMetricDict;
type AdSetRecord = ReportData["ad_groups"][number] & MetaMetricDict;
type AdRecord = ReportData["ads"][number] & MetaMetricDict;
type CountryRecord = ReportData["geo"][number] & MetaMetricDict & { country: string };
type RegionRecord = ReportData["geo_regions"][number] & MetaMetricDict;
export type PlacementRecord = MetaMetricDict & { publisher_platform: string; platform_position: string };
export type DemographicRecord = MetaMetricDict & { age: string; gender: string };

/** The Meta report written to disk. */
export interface MetaReport extends ReportData {
  platform: "meta";
  /** Canonical `act_<digits>`; also the report file-name key. */
  customer_id: string;
  manager_id: null;
  currency: string;
  attribution: readonly AttributionWindow[];
  result_action: string;
  window: Report["window"];
  generated_at: string;
  campaigns: CampaignRecord[];
  campaign_daily: CampaignDailyRecord[];
  ad_groups: AdSetRecord[];
  ads: AdRecord[];
  keywords: [];
  search_terms: [];
  geo: CountryRecord[];
  geo_regions: RegionRecord[];
  /** Keyword clustering is Google-only. */
  recommendations: [];
  placements: PlacementRecord[];
  demographics: DemographicRecord[];
}

export interface MetaReportMeta {
  adAccountId: MetaAdAccountId;
  currency: string;
  attribution: readonly AttributionWindow[];
  resultAction: string;
  window: Report["window"];
  generatedAt: string;
}

/** Key for a breakdown value Meta left blank (mirrors Google's geo sentinel). */
const UNKNOWN = "(unknown)";
const keyOf = (value: string | undefined): string => (value === undefined || value === "" ? UNKNOWN : value);

/** Sum of `actions[].value` whose `action_type` is the configured result action. */
export const resultCount = (row: InsightsRow, resultAction: string): number =>
  (row.actions ?? []).filter((a) => a.action_type === resultAction).reduce((sum, a) => sum + a.value, 0);

/**
 * One insights row → {@link MetaMetricDict}. Rates Meta omits when there is no
 * data fall back to guarded ratios of the row's own totals.
 */
export const metaMetricDict = (row: InsightsRow, resultAction: string): MetaMetricDict => {
  const impressions = Math.trunc(row.impressions);
  const clicks = Math.trunc(row.clicks ?? 0);
  const reach = Math.trunc(row.reach ?? 0);
  const conversions = resultCount(row, resultAction);
  return {
    cost: row.spend,
    impressions,
    clicks,
    ctr: safeRatio(clicks, impressions),
    avg_cpc: row.cpc ?? safeRatio(row.spend, clicks),
    conversions,
    cost_per_conversion: safeRatio(row.spend, conversions),
    reach,
    frequency: row.frequency ?? safeRatio(impressions, reach),
    cpm: row.cpm ?? safeRatio(row.spend * 1000, impressions),
    link_clicks: Math.trunc(row.inline_link_clicks ?? 0),
  };
};

const ZERO_METRICS: MetaMetricDict = {
  cost: 0,
  impressions: 0,
  clicks: 0,
  ctr: 0,
  avg_cpc: 0,
  conversions: 0,
  cost_per_conversion: 0,
  reach: 0,
  frequency: 0,
  cpm: 0,
  link_clicks: 0,
};

const byCostDesc = <T extends { cost: number }>(rows: readonly T[]): T[] =>
  [...rows].sort((a, b) => b.cost - a.cost);

/**
 * Campaigns: every campaign from the campaigns read (zero metrics when Meta
 * returned no insights row, i.e. no delivery in the window), then any insights
 * row whose campaign the read did not return (status `"UNKNOWN"`).
 */
const shapeCampaigns = (rows: MetaReportRows, resultAction: string): CampaignRecord[] => {
  const totals = new Map(
    rows.campaignTotals.flatMap((r) => (r.campaign_id === undefined ? [] : [[String(r.campaign_id), r] as const])),
  );
  const listed = new Set(rows.campaigns.map((c) => String(c.id)));
  const fromList = rows.campaigns.map((c) => {
    const row = totals.get(String(c.id));
    return {
      id: String(c.id),
      name: c.name,
      status: c.effective_status,
      ...(row ? metaMetricDict(row, resultAction) : ZERO_METRICS),
    };
  });
  const orphans = [...totals.entries()]
    .filter(([id]) => !listed.has(id))
    .map(([id, r]) => ({ id, name: r.campaign_name ?? "", status: "UNKNOWN", ...metaMetricDict(r, resultAction) }));
  return [...fromList, ...orphans];
};

/**
 * Shape parsed rows into the Meta report. Pure: same rows in → same report out.
 * Entity-level rows lacking their level's id (which Meta always sends at that
 * level) cannot be attributed and are dropped.
 */
export const shapeMetaReport = (rows: MetaReportRows, meta: MetaReportMeta): MetaReport => {
  const ra = meta.resultAction;
  const campaignNames = new Map(rows.campaigns.map((c) => [String(c.id), c.name] as const));
  return {
    platform: "meta",
    customer_id: meta.adAccountId,
    manager_id: null,
    currency: meta.currency,
    attribution: meta.attribution,
    result_action: ra,
    window: meta.window,
    generated_at: meta.generatedAt,
    campaigns: shapeCampaigns(rows, ra),
    campaign_daily: rows.campaignDaily.flatMap((r) =>
      r.campaign_id === undefined
        ? []
        : [
            {
              id: String(r.campaign_id),
              name: r.campaign_name ?? campaignNames.get(String(r.campaign_id)) ?? "",
              date: r.date_start,
              ...metaMetricDict(r, ra),
            },
          ],
    ),
    ad_groups: rows.adSets.flatMap((r) =>
      r.campaign_id === undefined || r.adset_id === undefined
        ? []
        : [
            {
              campaign_id: String(r.campaign_id),
              id: String(r.adset_id),
              name: r.adset_name ?? "",
              ...metaMetricDict(r, ra),
            },
          ],
    ),
    ads: rows.ads.flatMap((r) =>
      r.campaign_id === undefined || r.adset_id === undefined || r.ad_id === undefined
        ? []
        : [
            {
              campaign_id: String(r.campaign_id),
              ad_group_id: String(r.adset_id),
              id: String(r.ad_id),
              name: r.ad_name || `Ad ${r.ad_id}`,
              type: "META_AD",
              ad_strength: "UNSPECIFIED",
              ...metaMetricDict(r, ra),
            },
          ],
    ),
    keywords: [],
    search_terms: [],
    geo: byCostDesc(
      rows.countries.map((r) => {
        const country = keyOf(r.country);
        return { country_criterion_id: country, country, ...metaMetricDict(r, ra) };
      }),
    ),
    geo_regions: byCostDesc(rows.regions.map((r) => ({ region: keyOf(r.region), ...metaMetricDict(r, ra) }))),
    recommendations: [],
    placements: byCostDesc(
      rows.placements.map((r) => ({
        publisher_platform: keyOf(r.publisher_platform),
        platform_position: keyOf(r.platform_position),
        ...metaMetricDict(r, ra),
      })),
    ),
    demographics: byCostDesc(
      rows.demographics.map((r) => ({ age: keyOf(r.age), gender: keyOf(r.gender), ...metaMetricDict(r, ra) })),
    ),
  };
};
