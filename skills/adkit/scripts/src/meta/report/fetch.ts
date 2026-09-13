/**
 * Meta report reads (plan D5): the parsing of `--attribution`, the all-time window
 * clamp, and the nine parallel Graph reads whose parsed rows `shape.ts` turns into
 * the report.
 *
 * Pure core: {@link parseAttribution}, {@link clampAllTime}, {@link reportReadParams}.
 * I/O edge: {@link fetchMetaReportRows} issues the reads through an injected
 * {@link MetaClient}, which parses every response through its `graph.ts` schema.
 */

import type { MetaClient, Params } from "../client.js";
import type { MetaContext } from "../config.js";
import { CampaignSchema, InsightsRowSchema } from "../graph.js";
import { err, ok, type Result } from "../ids.js";
import type { AttributionWindow, MetaReportRows } from "./shape.js";

/** Default `--attribution`: Meta's standard 7-day click, 1-day view. */
export const DEFAULT_ATTRIBUTION: readonly AttributionWindow[] = ["7d_click", "1d_view"];

const ALLOWED_WINDOWS: readonly AttributionWindow[] = ["1d_click", "7d_click", "28d_click", "1d_view", "1d_ev"];
const REMOVED_WINDOWS: readonly string[] = ["7d_view", "28d_view"];

const isAllowedWindow = (w: string): w is AttributionWindow => (ALLOWED_WINDOWS as readonly string[]).includes(w);

/**
 * Parse `--attribution` (comma-separated windows). Absent → {@link DEFAULT_ATTRIBUTION}.
 * Removed view windows and unknown values are errors; duplicates collapse. Pure.
 */
export const parseAttribution = (raw?: string): Result<readonly AttributionWindow[]> => {
  if (raw === undefined) return ok(DEFAULT_ATTRIBUTION);
  const parts = raw
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "");
  const removed = parts.filter((p) => REMOVED_WINDOWS.includes(p));
  const unknown = parts.filter((p) => !isAllowedWindow(p) && !REMOVED_WINDOWS.includes(p));
  return parts.length === 0
    ? err(`--attribution: expected one or more of ${ALLOWED_WINDOWS.join(", ")}`)
    : removed.length > 0
      ? err(
          `--attribution: ${removed.join(", ")} no longer supported — Meta stopped returning the 7-day and 28-day ` +
            `view-through windows on 2026-01-12; use ${ALLOWED_WINDOWS.join(", ")}`,
        )
      : unknown.length > 0
        ? err(`--attribution: unknown window ${unknown.join(", ")} (expected ${ALLOWED_WINDOWS.join(", ")})`)
        : ok([...new Set(parts.filter(isAllowedWindow))]);
};

/** Meta's insights look-back limit, in months. */
export const META_MAX_MONTHS = 37;

const isoDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * Clamp an all-time `start` (`YYYY-MM-DD`) to Meta's 37-month maximum look-back
 * from `today` (UTC). The earliest allowed date keeps today's day of month,
 * capped at the target month's last day. Returns the later of the two. Pure.
 */
export const clampAllTime = (start: string, today: Date): string => {
  const year = today.getUTCFullYear();
  const month = today.getUTCMonth() - META_MAX_MONTHS;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const earliest = isoDate(Date.UTC(year, month, Math.min(today.getUTCDate(), lastDay)));
  return start < earliest ? earliest : start;
};

/** Inclusive `YYYY-MM-DD` report window. */
export interface ReportDateRange {
  readonly start: string;
  readonly end: string;
}

export interface FetchReportOptions {
  readonly includePaused: boolean;
  readonly attribution: readonly AttributionWindow[];
  /** Counted by `shape.ts`; the reads fetch every action so it does not narrow them. */
  readonly resultAction: string;
}

export const INSIGHTS_FIELDS = [
  "campaign_id",
  "campaign_name",
  "adset_id",
  "adset_name",
  "ad_id",
  "ad_name",
  "spend",
  "impressions",
  "reach",
  "frequency",
  "clicks",
  "inline_link_clicks",
  "ctr",
  "inline_link_click_ctr",
  "cpm",
  "cpc",
  "actions",
  "cost_per_action_type",
].join(",");

export const CAMPAIGN_FIELDS = "id,name,effective_status,objective";

const ACTIVE_ONLY = ["ACTIVE"] as const;

/** One insights read: result key in {@link MetaReportRows}, step label, and level-specific params. */
type InsightsRead = {
  readonly key: Exclude<keyof MetaReportRows, "campaigns">;
  readonly step: string;
  readonly params: Params;
};

const INSIGHTS_READS: readonly InsightsRead[] = [
  { key: "campaignTotals", step: "report-insights-campaign", params: { level: "campaign" } },
  { key: "campaignDaily", step: "report-insights-campaign-daily", params: { level: "campaign", time_increment: 1 } },
  { key: "adSets", step: "report-insights-adset", params: { level: "adset" } },
  { key: "ads", step: "report-insights-ad", params: { level: "ad" } },
  {
    key: "placements",
    step: "report-insights-placements",
    params: { level: "account", breakdowns: "publisher_platform,platform_position" },
  },
  { key: "demographics", step: "report-insights-demographics", params: { level: "account", breakdowns: "age,gender" } },
  { key: "countries", step: "report-insights-country", params: { level: "account", breakdowns: "country" } },
  { key: "regions", step: "report-insights-region", params: { level: "account", breakdowns: "region" } },
];

/** Params shared by every insights read. Pure. */
export const insightsBaseParams = (window: ReportDateRange, opts: FetchReportOptions): Params => ({
  fields: INSIGHTS_FIELDS,
  time_range: { since: window.start, until: window.end },
  action_attribution_windows: opts.attribution,
  use_account_attribution_setting: false,
  filtering: opts.includePaused
    ? undefined
    : [{ field: "campaign.effective_status", operator: "IN", value: ACTIVE_ONLY }],
});

/** Params for the campaigns read (same ACTIVE-only rule as the insights reads). Pure. */
export const campaignParams = (opts: Pick<FetchReportOptions, "includePaused">): Params => ({
  fields: CAMPAIGN_FIELDS,
  filtering: opts.includePaused ? undefined : [{ field: "effective_status", operator: "IN", value: ACTIVE_ONLY }],
});

/**
 * Issue the campaigns read and the eight insights reads in parallel and return
 * their parsed rows. Rejects with the first `MetaApiError` (its `step` names the read).
 */
export const fetchMetaReportRows = async (
  client: MetaClient,
  ctx: Pick<MetaContext, "adAccountId">,
  window: ReportDateRange,
  opts: FetchReportOptions,
): Promise<MetaReportRows> => {
  const account = ctx.adAccountId;
  const base = insightsBaseParams(window, opts);
  const [campaigns, insights] = await Promise.all([
    client.getAll(`${account}/campaigns`, campaignParams(opts), CampaignSchema, { step: "report-campaigns" }),
    Promise.all(
      INSIGHTS_READS.map(async (read) => {
        const rows = await client.getAll(`${account}/insights`, { ...base, ...read.params }, InsightsRowSchema, {
          step: read.step,
        });
        return [read.key, [...rows]] as const;
      }),
    ),
  ]);
  const byKey = Object.fromEntries(insights) as Record<InsightsRead["key"], MetaReportRows["campaignTotals"]>;
  return {
    campaigns: [...campaigns],
    campaignTotals: byKey.campaignTotals,
    campaignDaily: byKey.campaignDaily,
    adSets: byKey.adSets,
    ads: byKey.ads,
    placements: byKey.placements,
    demographics: byKey.demographics,
    countries: byKey.countries,
    regions: byKey.regions,
  };
};
