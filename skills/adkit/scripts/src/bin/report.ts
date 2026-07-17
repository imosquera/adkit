/**
 * IO entry: pull last N days of Google Ads performance for ENABLED campaigns and
 * write a raw report (YAML) under ads/output/reports/.
 *
 * Port of ads_skill/bin/report.py. All query construction, metric math, and
 * cluster analysis live in the pure lib layer (lib/report, lib/cluster); this
 * module is the side-effecting shell that talks to the API and the disk. The
 * pure row->report shaping is factored into exported helpers (see buildReport /
 * shapeRows / recommendations) so it can be unit-tested with canned rows.
 *
 * Usage: adkit-report --customer <id> [--manager <id>] [--days 14]
 *        (a bare positional <customer> is still accepted for back-compat; the
 *         --customer flag wins when both are given)
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { isMainModule } from "../cli/entry.js";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import type { AdsClient, GaqlRow } from "../lib/auth.js";
import { loadReadClient } from "../lib/mcp-client.js";
import type { SearchArgs } from "../gaql/search-args.js";
import { matchTypeName } from "../ads/enums.js";
import { normalizeId } from "../cli/args.js";
import { sdkErrorMessage } from "../cli/output.js";
import { isManagerMetricsError, managerMetricsHint } from "./audit.js";
import {
  clusterSplitRecommendation,
  keywordsToPromote,
  negativesToAdd,
  type Negative,
  type Proposal,
  type SplitRecommendation,
} from "../lib/cluster.js";
import {
  adGroupQuery,
  adQuery,
  campaignDailyQuery,
  campaignTotalsQuery,
  dateWindow,
  geoQuery,
  geoRegionQuery,
  keywordQuery,
  searchTermQuery,
} from "../gaql/builders.js";
import { metricDict, type MetricDict, remediationHint, safeRatio } from "../lib/report.js";

/** The account/manager we report on by default (overridable via args). */
export const DEFAULT_CUSTOMER = "8911925499"; // 891-192-5499
export const DEFAULT_MANAGER = "4193158021"; // 419-315-8021
export const DEFAULT_DAYS = 14;

// ---------------------------------------------------------------------------
// SDK row shapes — only the fields report.py reads. The TS SDK returns nested,
// snake_case records; enums come back as STRING names, micros as numbers.
// ---------------------------------------------------------------------------

/** Raw metrics block shared by every report row. */
interface RowMetrics {
  cost_micros?: number | null;
  impressions?: number | null;
  clicks?: number | null;
  ctr?: number | null;
  average_cpc?: number | null;
  conversions?: number | null;
  cost_per_conversion?: number | null;
}

interface CampaignTotalsRow {
  campaign: { id: number | string; name: string; status: string };
  metrics: RowMetrics;
}

interface CampaignDailyRow {
  campaign: { id: number | string; name: string };
  segments: { date: string };
  metrics: RowMetrics;
}

interface AdGroupRow {
  campaign: { id: number | string };
  ad_group: { id: number | string; name: string };
  metrics: RowMetrics;
}

interface AdRow {
  campaign: { id: number | string };
  ad_group: { id: number | string };
  ad_group_ad: {
    ad: { id: number | string; name?: string | null; type: string };
    ad_strength: string;
  };
  metrics: RowMetrics;
}

interface KeywordRow {
  campaign: { id: number | string };
  ad_group: { id: number | string };
  // match_type arrives as the RAW NUMERIC enum on GAQL rows (decoded to its
  // string name via matchTypeName below); see ../ads/enums.ts.
  ad_group_criterion: { keyword: { text: string; match_type: string | number } };
  metrics: RowMetrics;
}

interface SearchTermRow {
  campaign: { id: number | string };
  ad_group: { id: number | string };
  search_term_view: { search_term: string };
  metrics: RowMetrics;
}

interface GeoRow {
  campaign: { id: number | string };
  geographic_view: { country_criterion_id?: number | string | null };
  metrics: RowMetrics;
}

interface GeoRegionRow {
  campaign: { id: number | string };
  segments: { geo_target_region?: string | null };
  metrics: RowMetrics;
}

// ---------------------------------------------------------------------------
// Shaped report rows — the flat, normalised records written to the report.
// ---------------------------------------------------------------------------

type CampaignRecord = { id: string; name: string; status: string } & MetricDict;
type CampaignDailyRecord = { id: string; name: string; date: string } & MetricDict;
type AdGroupRecord = { campaign_id: string; id: string; name: string } & MetricDict;
type AdRecord = {
  campaign_id: string;
  ad_group_id: string;
  id: string;
  name: string;
  type: string;
  ad_strength: string;
} & MetricDict;
// `& Record<string, unknown>` so these shaped rows are assignable to the generic
// (Record-consuming) cluster helpers while keeping their known fields typed.
type KeywordRecord = {
  campaign_id: string;
  ad_group_id: string;
  text: string;
  match_type: string;
} & MetricDict &
  Record<string, unknown>;
type SearchTermRecord = {
  campaign_id: string;
  ad_group_id: string;
  search_term: string;
} & MetricDict &
  Record<string, unknown>;
// Geo rows are aggregated (summed across campaigns per geo key), so unlike the
// per-entity records above they carry only the geo key + rolled-up metrics.
type GeoRecord = { country_criterion_id: string } & MetricDict;
type GeoRegionRecord = { region: string } & MetricDict;

/** The row collections pulled from the API, before analysis. */
export interface ReportData {
  campaigns: CampaignRecord[];
  campaign_daily: CampaignDailyRecord[];
  ad_groups: AdGroupRecord[];
  ads: AdRecord[];
  keywords: KeywordRecord[];
  search_terms: SearchTermRecord[];
  geo: GeoRecord[];
  geo_regions: GeoRegionRecord[];
}

/** One campaign's deterministic cluster analysis. */
export interface Recommendation {
  campaign_id: string;
  campaign_name: string;
  promote_keywords: Proposal[];
  add_negatives: Negative[];
  split: SplitRecommendation | null;
}

/** The full raw report written to disk (and its shape). */
export interface Report extends ReportData {
  customer_id: string;
  manager_id: string;
  window: { start: string; end: string; days: number; partial_day: string };
  generated_at: string;
  recommendations: Recommendation[];
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested with canned rows)
// ---------------------------------------------------------------------------

/** Derive the normalised metric block from one SDK row's `metrics`. */
function metricsOf(metrics: RowMetrics): MetricDict {
  return metricDict({
    costMicros: metrics.cost_micros,
    impressions: metrics.impressions,
    clicks: metrics.clicks,
    ctr: metrics.ctr,
    avgCpcMicros: metrics.average_cpc,
    conversions: metrics.conversions,
    costPerConvMicros: metrics.cost_per_conversion,
  });
}

/** Grouping key for a geo bucket; a null/absent key collapses to one sentinel bucket. */
const GEO_UNKNOWN = "(unknown)";
function geoKey(value: number | string | null | undefined): string {
  return value === null || value === undefined || value === "" ? GEO_UNKNOWN : String(value);
}

/**
 * Roll per-campaign geo rows up per key: sum the additive metrics (cost,
 * impressions, clicks, conversions) then recompute every derived rate (ctr,
 * avg_cpc, cost_per_conversion) from the summed totals — a per-unit rate summed
 * across buckets is meaningless. Ordered by cost descending. Pure: no input
 * mutation (reduce into a Map, then map/sort), mirroring `byCampaign` below.
 */
function rollupGeo(rows: ReadonlyArray<{ key: string; metrics: MetricDict }>): Array<{ key: string } & MetricDict> {
  const summed = rows.reduce((acc, { key, metrics: m }) => {
    const prev = acc.get(key);
    acc.set(
      key,
      prev
        ? {
            cost: prev.cost + m.cost,
            impressions: prev.impressions + m.impressions,
            clicks: prev.clicks + m.clicks,
            conversions: prev.conversions + m.conversions,
            // Derived rates are recomputed after the fold; interim values unused.
            ctr: 0,
            avg_cpc: 0,
            cost_per_conversion: 0,
          }
        : { ...m },
    );
    return acc;
  }, new Map<string, MetricDict>());
  return [...summed.entries()]
    .map(([key, m]) => ({
      key,
      ...m,
      ctr: safeRatio(m.clicks, m.impressions),
      avg_cpc: safeRatio(m.cost, m.clicks),
      cost_per_conversion: safeRatio(m.cost, m.conversions),
    }))
    .sort((a, b) => b.cost - a.cost);
}

/**
 * Shape the raw SDK row collections into the flat, normalised report rows.
 * Pure: same rows in -> same records out. The six per-entity collections stay
 * one-record-per-row; the two geo collections are aggregated per geo key.
 */
export function shapeRows(rows: {
  campaigns: CampaignTotalsRow[];
  campaignDaily: CampaignDailyRow[];
  adGroups: AdGroupRow[];
  ads: AdRow[];
  keywords: KeywordRow[];
  searchTerms: SearchTermRow[];
  geo: GeoRow[];
  geoRegions: GeoRegionRow[];
}): ReportData {
  return {
    campaigns: rows.campaigns.map((r) => ({
      id: String(r.campaign.id),
      name: r.campaign.name,
      status: r.campaign.status,
      ...metricsOf(r.metrics),
    })),
    // Daily series runs through today (daily_end > end): the trailing day is the
    // partial current day, included so serving status "right now" is visible.
    campaign_daily: rows.campaignDaily.map((r) => ({
      id: String(r.campaign.id),
      name: r.campaign.name,
      date: r.segments.date,
      ...metricsOf(r.metrics),
    })),
    ad_groups: rows.adGroups.map((r) => ({
      campaign_id: String(r.campaign.id),
      id: String(r.ad_group.id),
      name: r.ad_group.name,
      ...metricsOf(r.metrics),
    })),
    ads: rows.ads.map((r) => ({
      campaign_id: String(r.campaign.id),
      ad_group_id: String(r.ad_group.id),
      id: String(r.ad_group_ad.ad.id),
      name: r.ad_group_ad.ad.name || `Ad ${r.ad_group_ad.ad.id}`,
      type: r.ad_group_ad.ad.type,
      ad_strength: r.ad_group_ad.ad_strength,
      ...metricsOf(r.metrics),
    })),
    keywords: rows.keywords.map((r) => ({
      campaign_id: String(r.campaign.id),
      ad_group_id: String(r.ad_group.id),
      text: r.ad_group_criterion.keyword.text,
      match_type: matchTypeName(r.ad_group_criterion.keyword.match_type),
      ...metricsOf(r.metrics),
    })),
    search_terms: rows.searchTerms.map((r) => ({
      campaign_id: String(r.campaign.id),
      ad_group_id: String(r.ad_group.id),
      search_term: r.search_term_view.search_term,
      ...metricsOf(r.metrics),
    })),
    geo: rollupGeo(
      rows.geo.map((r) => ({
        key: geoKey(r.geographic_view.country_criterion_id),
        metrics: metricsOf(r.metrics),
      })),
    ).map(({ key, ...m }) => ({ country_criterion_id: key, ...m })),
    geo_regions: rollupGeo(
      rows.geoRegions.map((r) => ({
        key: geoKey(r.segments.geo_target_region),
        metrics: metricsOf(r.metrics),
      })),
    ).map(({ key, ...m }) => ({ region: key, ...m })),
  };
}

/** Group rows by a string key (default `campaign_id`), preserving order. */
function byCampaign<T extends Record<string, unknown>>(
  rows: T[],
  key: keyof T & string = "campaign_id" as keyof T & string,
): Map<string, T[]> {
  return rows.reduce((acc, row) => {
    const id = String(row[key]);
    const list = acc.get(id);
    if (list) {
      list.push(row);
    } else {
      acc.set(id, [row]);
    }
    return acc;
  }, new Map<string, T[]>());
}

/**
 * Per-campaign, data-driven cluster analysis (pure cluster lib): which search
 * terms to promote to keywords, which to add as negatives, and whether the
 * campaign mixes cheap-broad + expensive-intent keywords and should be split.
 */
export function recommendations(data: ReportData): Recommendation[] {
  const st = byCampaign(data.search_terms);
  const kw = byCampaign(data.keywords);
  return data.campaigns.map((camp) => {
    const cid = String(camp.id);
    const terms = st.get(cid) ?? [];
    const kws = kw.get(cid) ?? [];
    return {
      campaign_id: cid,
      campaign_name: camp.name,
      promote_keywords: keywordsToPromote(terms, kws),
      add_negatives: negativesToAdd(terms),
      split: clusterSplitRecommendation(kws),
    };
  });
}

/**
 * Assemble the full raw report from shaped data + the run's identifiers and
 * window. Pure: mirrors report.py's `report` dict, key order preserved so the
 * emitted YAML matches (yaml.safe_dump(sort_keys=False)).
 */
export function buildReport(params: {
  customer: string;
  manager: string;
  data: ReportData;
  start: string;
  end: string;
  days: number;
  dailyEnd: string;
  generatedAt: string;
}): Report {
  return {
    customer_id: params.customer,
    manager_id: params.manager,
    window: { start: params.start, end: params.end, days: params.days, partial_day: params.dailyEnd },
    generated_at: params.generatedAt,
    ...params.data,
    // Deterministic cluster analysis computed here so it ships in the raw report
    // and the LLM-authored markdown can lean on it rather than re-derive.
    recommendations: recommendations(params.data),
  };
}

// ---------------------------------------------------------------------------
// IO shell
// ---------------------------------------------------------------------------

/** Parsed CLI arguments (parse-don't-validate: parse once, up front). */
export interface ReportArgs {
  customer: string;
  manager: string;
  days: number;
}

/**
 * Parse argv into {@link ReportArgs}: positional `customer` then `--manager`
 * and `--days` flags, matching report.py's argparse. Falls back to defaults.
 */
export function parseArgs(argv: string[]): ReportArgs {
  let customer = DEFAULT_CUSTOMER;
  let manager = DEFAULT_MANAGER;
  let days = DEFAULT_DAYS;
  let sawPositional = false;
  let customerFromFlag = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--manager") {
      manager = argv[i + 1] ?? manager;
      i += 1;
    } else if (arg === "--days") {
      days = Number.parseInt(argv[i + 1] ?? "", 10);
      i += 1;
    } else if (arg === "--customer") {
      // Mirror --manager/--days: consume the next token; a valueless trailing
      // flag keeps the default rather than swallowing an unrelated token.
      customer = argv[i + 1] ?? customer;
      customerFromFlag = true;
      i += 1;
    } else if (arg.startsWith("--manager=")) {
      manager = arg.slice("--manager=".length);
    } else if (arg.startsWith("--days=")) {
      days = Number.parseInt(arg.slice("--days=".length), 10);
    } else if (arg.startsWith("--customer=")) {
      customer = arg.slice("--customer=".length);
      customerFromFlag = true;
    } else if (!sawPositional && !customerFromFlag) {
      // Back-compat positional customer, but the explicit --customer flag wins.
      customer = arg;
      sawPositional = true;
    }
  }
  return { customer, manager, days };
}

/** Run one structured read and return every row (thin IO wrapper). */
async function search<Row>(client: AdsClient, customerId: string, args: SearchArgs): Promise<Row[]> {
  return client.searchStructured<Row>(customerId, args);
}

/**
 * Pull all six report queries from the API for `customer`, then shape them.
 * The daily series runs through `dailyEnd` (today, partial); the totals and
 * per-entity queries use the complete window `[start, end]`.
 */
async function pull(
  client: AdsClient,
  customerId: string,
  start: string,
  end: string,
  dailyEnd: string,
): Promise<ReportData> {
  const [campaigns, campaignDaily, adGroups, ads, keywords, searchTerms, geo, geoRegions] =
    await Promise.all([
      search<CampaignTotalsRow>(client, customerId, campaignTotalsQuery(start, end)),
      search<CampaignDailyRow>(client, customerId, campaignDailyQuery(start, dailyEnd)),
      search<AdGroupRow>(client, customerId, adGroupQuery(start, end)),
      search<AdRow>(client, customerId, adQuery(start, end)),
      search<KeywordRow>(client, customerId, keywordQuery(start, end)),
      search<SearchTermRow>(client, customerId, searchTermQuery(start, end)),
      search<GeoRow>(client, customerId, geoQuery(start, end)),
      search<GeoRegionRow>(client, customerId, geoRegionQuery(start, end)),
    ]);
  return shapeRows({ campaigns, campaignDaily, adGroups, ads, keywords, searchTerms, geo, geoRegions });
}

/** Absolute path of the report file for a given day + customer. */
export function reportPath(cwd: string, generatedAt: string, customer: string): string {
  return join(cwd, "ads", "output", "reports", `${generatedAt}-${customer}-raw.yaml`);
}

/**
 * IO entry point. Loads credentials, pulls the report, writes the raw YAML under
 * ads/output/reports/, and prints the path. Returns a process exit code.
 *
 * `clientFactory` is injectable so tests can supply a fake AdsClient; production
 * calls default to {@link loadReadClient} (SDK by default; MCP when ADKIT_READ_BACKEND=mcp).
 */
export async function main(
  argv: string[],
  clientFactory: (manager: string) => AdsClient = loadReadClient,
): Promise<number> {
  const args = parseArgs(argv);
  const customer = normalizeId(args.customer);
  const manager = normalizeId(args.manager);

  let client: AdsClient;
  try {
    client = clientFactory(manager);
  } catch (exc) {
    process.stderr.write(
      `error: could not load Google Ads credentials (${String(exc)}). ` +
        "Run: bash ads.sh render-yaml\n",
    );
    return 1;
  }

  // The one clock read; injected into the pure layer.
  const today = new Date();
  const [start, end] = dateWindow(today, args.days);
  const generatedAt = isoToday(today);
  const dailyEnd = generatedAt; // daily series runs through today (partial)

  let data: ReportData;
  try {
    data = await pull(client, customer, start, end, dailyEnd);
  } catch (exc) {
    // A report necessarily queries metrics, so it can hit the same "metrics on a
    // manager account" rejection (query_error 59) that audit detects. Reuse
    // audit's detection + guidance instead of duplicating it.
    const isManagerMetrics = isManagerMetricsError(exc);
    const msgs = isManagerMetrics ? managerMetricsHint() : sdkErrorMessage(exc);
    const hint = isManagerMetrics ? "" : remediationHint(msgs, customer, manager);
    process.stderr.write(
      `error: Google Ads query failed for customer ${customer} via manager ${manager}: ` +
        `${msgs}${hint ? ". " + hint : ""}\n`,
    );
    return 1;
  }

  if (data.campaigns.length === 0) {
    process.stderr.write(
      `no ENABLED campaigns with activity in ${customer} ` +
        `between ${start} and ${end}; nothing written.\n`,
    );
    return 1;
  }

  const report = buildReport({
    customer,
    manager,
    data,
    start,
    end,
    days: args.days,
    dailyEnd,
    generatedAt,
  });

  const outPath = reportPath(process.cwd(), generatedAt, customer);
  mkdirSync(join(process.cwd(), "ads", "output", "reports"), { recursive: true });
  writeFileSync(outPath, stringifyYaml(report, { sortMapEntries: false }));
  process.stdout.write(`${outPath}\n`);
  return 0;
}

/** UTC ISO date (`YYYY-MM-DD`) of `date`, matching Python's `date.today().isoformat()`. */
function isoToday(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// Execute when run as the entry module.
if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((exc) => {
      process.stderr.write(`error: ${String(exc)}\n`);
      process.exit(1);
    });
}
