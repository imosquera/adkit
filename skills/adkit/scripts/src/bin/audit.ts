/**
 * IO entry: audit ENABLED campaigns for RSA/extension best-practice gaps.
 *
 * Report only — emits findings as JSON on stdout plus a human table on stderr.
 * Deterministic: it decides WHAT is wrong (under-fill, dupes, banned phrases,
 * extension gaps, Google's own ad_strength + action_items). Authoring the fix copy
 * is the model's job (see audit.md); applying it is apply_fixes.py's job.
 *
 * Ported from ads_skill/bin/audit.py. The one intended change over the Python is
 * that the me-too-copy check is now DYNAMIC: a `--differentiation-profile <path>`
 * flag supplies a per-run {@link DifferentiationProfile} that is threaded into the
 * per-ad scoring; absent, the empty profile flags nothing.
 *
 * google-ads-api row shapes differ from the Python proto: `client.search` returns
 * nested snake_case plain objects, enum fields are already their STRING name (so no
 * `.name` access), and repeated fields are arrays.
 *
 * Usage:
 *   ads.sh audit --customer 1111111111 [--campaign ID] [--all]
 *                 [--login-customer-id MCC] [--banned "VAT,USD,EUR,Portugal"]
 *                 [--differentiation-profile profile.json]
 */

import { readFileSync } from "node:fs";
import { isMainModule } from "../cli/entry.js";
import { formatGoogleAdsError } from "../ads/errors.js";
import { parseArgs } from "node:util";

import {
  IS_OPPORTUNITY,
  LOST_HI,
  MIN_CALLOUTS,
  MIN_DESCRIPTIONS,
  MIN_HEADLINES,
  MIN_KEYWORDS,
  MIN_SITELINKS,
  SHARED_HEADLINE_GROUPS,
  cannibalization,
  differentiationGaps,
  pathToExcellent,
  requireDigits,
  type CannibalizationPair,
} from "../audit/scoring.js";
import { resolveCustomer } from "../cli/args.js";
import { emitJson, errorEnvelope, ok } from "../cli/output.js";
import {
  auditAdGroupAdQuery,
  auditCampaignsQuery,
  auditExtCountQuery,
  auditKeywordMetricsQuery,
  auditKeywordsQuery,
  auditLandingPageMobileQuery,
  auditPolicyTopicsQuery,
  auditQualityScoreQuery,
  auditSearchTermsQuery,
  auditServingQuery,
} from "../gaql/builders.js";
import type { AdsClient } from "../lib/auth.js";
import { loadClient } from "../lib/auth.js";
import {
  EMPTY_PROFILE,
  parseDifferentiationProfile,
  type DifferentiationProfile,
} from "../lib/brand.js";
import {
  clusterSplitRecommendation,
  keywordsToPromote,
  negativesToAdd,
} from "../lib/cluster.js";
import { microsToCurrency } from "../lib/report.js";

// ---------------------------------------------------------------------------
// Row interfaces — the narrow shapes of the google-ads-api query results this
// module reads. Enum fields arrive as their STRING name already (no `.name`).
// ---------------------------------------------------------------------------

interface TextAsset {
  text: string;
  /** ServedAssetFieldType enum name, or "UNSPECIFIED"/undefined when unpinned. */
  pinned_field?: string;
}

interface CampaignRow {
  campaign: { id: number; name: string; status: string };
}

interface KeywordRow {
  campaign: { id: number };
  ad_group: { name: string };
  ad_group_criterion: { keyword: { text: string } };
}

interface AdGroupAdRow {
  ad_group: { name: string };
  ad_group_ad: {
    ad: {
      id: number;
      final_urls?: string[];
      responsive_search_ad: { headlines: TextAsset[]; descriptions: TextAsset[] };
    };
    ad_strength: string;
    status: string;
    action_items?: string[];
  };
}

interface ServingRow {
  campaign: { id: number; name: string; bidding_strategy_type: string };
  campaign_budget: { amount_micros: number };
  metrics: {
    impressions: number;
    conversions: number;
    search_impression_share: number;
    search_budget_lost_impression_share: number;
    search_rank_lost_impression_share: number;
  };
}

interface KeywordMetricsRow {
  campaign: { id: number };
  ad_group_criterion: { keyword: { text: string } };
  metrics: { average_cpc: number };
}

interface SearchTermRow {
  campaign: { id: number };
  search_term_view: { search_term: string };
  metrics: { clicks: number; conversions: number; cost_micros: number; impressions: number };
}

interface QualityScoreRow {
  campaign: { id: number };
  ad_group_criterion: {
    keyword: { text: string };
    quality_info: {
      quality_score: number;
      post_click_quality_score: string;
      creative_quality_score: string;
      search_predicted_ctr: string;
    };
  };
}

interface LandingPageMobileRow {
  campaign: { id: number };
  landing_page_view: { unexpanded_final_url: string };
  metrics: {
    mobile_friendly_clicks_percentage: number | null;
    valid_accelerated_mobile_pages_clicks_percentage: number | null;
    speed_score: number;
    clicks: number;
    impressions: number;
    ctr: number;
  };
}

interface PolicyTopicRow {
  ad_group_ad: {
    ad: { final_urls?: string[] };
    policy_summary: { policy_topic_entries: Array<{ topic: string }> };
  };
}

// ---------------------------------------------------------------------------
// Raw row shapes + boundary normalizers (parse, don't validate).
//
// The `*Row` types above are the PROOFS downstream scoring relies on — every
// nested message and metric present. But the google-ads-api `search` returns the
// wire shape, where the API OMITS empty nested messages and zero-valued metric
// fields entirely: a keyword with no spend has no `metrics`, a criterion with no
// Quality Score yet has no `quality_info`, a non-RSA ad has no `responsive_search_ad`.
// The `Raw*Row` types below are that honest, loose shape; each `normalize*` parses
// one raw row into its strong `*Row` — zero-filling metrics, defaulting empty
// messages — exactly once, at the fetch boundary. Downstream code then never
// re-checks presence. Add a field to a `Raw*Row` and the compiler forces the
// matching `normalize*` to account for it.
// ---------------------------------------------------------------------------

/** Coalesce an omitted (zero-valued) numeric metric field back to 0. */
const num = (x: number | null | undefined): number => x ?? 0;

interface RawAdGroupAdRow {
  ad_group: { name: string };
  ad_group_ad: {
    ad: {
      id: number;
      final_urls?: string[];
      responsive_search_ad?: { headlines?: TextAsset[]; descriptions?: TextAsset[] };
    };
    ad_strength: string;
    status: string;
    action_items?: string[];
  };
}

function normalizeAdGroupAdRow(r: RawAdGroupAdRow): AdGroupAdRow {
  const rsa = r.ad_group_ad.ad.responsive_search_ad;
  return {
    ...r,
    ad_group_ad: {
      ...r.ad_group_ad,
      ad: {
        ...r.ad_group_ad.ad,
        responsive_search_ad: {
          headlines: rsa?.headlines ?? [],
          descriptions: rsa?.descriptions ?? [],
        },
      },
    },
  };
}

interface RawServingRow {
  campaign: { id: number; name: string; bidding_strategy_type: string };
  campaign_budget?: { amount_micros?: number };
  metrics?: Partial<ServingRow["metrics"]>;
}

function normalizeServingRow(r: RawServingRow): ServingRow {
  return {
    campaign: r.campaign,
    campaign_budget: { amount_micros: num(r.campaign_budget?.amount_micros) },
    metrics: {
      impressions: num(r.metrics?.impressions),
      conversions: num(r.metrics?.conversions),
      search_impression_share: num(r.metrics?.search_impression_share),
      search_budget_lost_impression_share: num(r.metrics?.search_budget_lost_impression_share),
      search_rank_lost_impression_share: num(r.metrics?.search_rank_lost_impression_share),
    },
  };
}

interface RawKeywordMetricsRow {
  campaign: { id: number };
  ad_group_criterion: { keyword: { text: string } };
  metrics?: { average_cpc?: number };
}

function normalizeKeywordMetricsRow(r: RawKeywordMetricsRow): KeywordMetricsRow {
  return { ...r, metrics: { average_cpc: num(r.metrics?.average_cpc) } };
}

interface RawSearchTermRow {
  campaign: { id: number };
  search_term_view: { search_term: string };
  metrics?: Partial<SearchTermRow["metrics"]>;
}

function normalizeSearchTermRow(r: RawSearchTermRow): SearchTermRow {
  return {
    ...r,
    metrics: {
      clicks: num(r.metrics?.clicks),
      conversions: num(r.metrics?.conversions),
      cost_micros: num(r.metrics?.cost_micros),
      impressions: num(r.metrics?.impressions),
    },
  };
}

interface RawQualityScoreRow {
  campaign: { id: number };
  ad_group_criterion: {
    keyword: { text: string };
    quality_info?: Partial<QualityScoreRow["ad_group_criterion"]["quality_info"]>;
  };
}

function normalizeQualityScoreRow(r: RawQualityScoreRow): QualityScoreRow {
  const qi = r.ad_group_criterion.quality_info;
  return {
    ...r,
    ad_group_criterion: {
      ...r.ad_group_criterion,
      quality_info: {
        quality_score: num(qi?.quality_score),
        post_click_quality_score: qi?.post_click_quality_score ?? "",
        creative_quality_score: qi?.creative_quality_score ?? "",
        search_predicted_ctr: qi?.search_predicted_ctr ?? "",
      },
    },
  };
}

interface RawLandingPageMobileRow {
  campaign: { id: number };
  landing_page_view: { unexpanded_final_url: string };
  metrics?: Partial<LandingPageMobileRow["metrics"]>;
}

function normalizeLandingPageMobileRow(r: RawLandingPageMobileRow): LandingPageMobileRow {
  const m = r.metrics;
  return {
    ...r,
    metrics: {
      // The percentage fields are meaningfully null ("no data"); mobileFindings
      // already skips null, so preserve it rather than zero-filling.
      mobile_friendly_clicks_percentage: m?.mobile_friendly_clicks_percentage ?? null,
      valid_accelerated_mobile_pages_clicks_percentage:
        m?.valid_accelerated_mobile_pages_clicks_percentage ?? null,
      speed_score: num(m?.speed_score),
      clicks: num(m?.clicks),
      impressions: num(m?.impressions),
      ctr: num(m?.ctr),
    },
  };
}

interface RawPolicyTopicRow {
  ad_group_ad: {
    ad: { final_urls?: string[] };
    policy_summary?: { policy_topic_entries?: Array<{ topic: string }> };
  };
}

function normalizePolicyTopicRow(r: RawPolicyTopicRow): PolicyTopicRow {
  return {
    ...r,
    ad_group_ad: {
      ...r.ad_group_ad,
      policy_summary: {
        policy_topic_entries: r.ad_group_ad.policy_summary?.policy_topic_entries ?? [],
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Output-shape types (the scored dicts the Python builds).
// ---------------------------------------------------------------------------

type AdIssue = Record<string, unknown>;

interface ScoredAd {
  adId: number;
  adGroup: string;
  strength: string;
  status: string;
  headlines: string[];
  descriptions: string[];
  finalUrl: string | null;
  actionItems: string[];
  issues: AdIssue[];
  keywords: string[];
  pathToExcellent: string[];
}

interface CampaignFinding {
  level: string;
  issue: string;
  detail: string;
  need?: number;
  items?: Record<string, string[]>;
}

interface CampaignReport {
  campaignId: number;
  campaignName: string;
  status: string;
  keywords: number;
  sitelinks: number;
  callouts: number;
  campaignFindings: CampaignFinding[];
  ads: ScoredAd[];
}

interface ScoredServing {
  campaignId: number;
  campaignName: string;
  bidStrategy: string;
  budgetMicros: number;
  impressions: number;
  conversions: number;
  searchImpressionShare: number;
  lostISBudget: number;
  lostISRank: number;
  flags: string[];
  impressionShareRecs: string[];
}

interface KeywordCpc {
  text: string;
  avg_cpc: number;
  avg_cpc_micros: number;
  // These rows feed the generic (Record-consuming) cluster helpers.
  [key: string]: unknown;
}

interface ClusterSplit {
  campaignId: number;
  campaignName: string;
  [key: string]: unknown;
}

interface SearchTermAgg {
  search_term: string;
  clicks: number;
  conversions: number;
  cost: number;
  impressions: number;
  // These rows feed the generic (Record-consuming) cluster helpers.
  [key: string]: unknown;
}

interface QualityScoreEntry {
  keyword: string;
  qualityScore: number;
  landingPageExp: string;
  adRelevance: string;
  expectedCtr: string;
}

interface LandingPageEntry {
  url: string | null;
  issue: string;
  detail: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Small functional primitives.
// ---------------------------------------------------------------------------

async function search<Row = Record<string, unknown>>(
  client: AdsClient,
  customerId: string,
  query: string,
): Promise<Row[]> {
  return client.search<Row>(customerId, query);
}

/**
 * Pure fold: an iterable of [key, value] pairs -> {key: [values]}, first-seen key
 * order preserved. The one place every campaignId/etc.-keyed grouping in this
 * module goes through, instead of each caller hand-rolling a push loop.
 */
function groupBy<K extends string | number, V>(pairs: Iterable<[K, V]>): Record<K, V[]> {
  return [...pairs].reduce(
    (acc, [k, v]) => ({ ...acc, [k]: [...(acc[k] ?? []), v] }),
    {} as Record<K, V[]>,
  );
}

/** Pin detection: an asset's pinned_field present and not the neutral sentinels. */
function isPinned(field: string | null | undefined): boolean {
  return field !== undefined && field !== null && field !== "UNSPECIFIED" && field !== "UNKNOWN";
}

// ---------------------------------------------------------------------------
// Fetch helpers.
// ---------------------------------------------------------------------------

/**
 * One query for every campaign's ENABLED keywords → {campaignId: {adGroupName: [kw]}}.
 * Replaces the old per-campaign + per-cannibalization-pair fetches.
 */
async function allKeywords(
  client: AdsClient,
  customerId: string,
  campaignIds: number[],
): Promise<Record<number, Record<string, string[]>>> {
  if (campaignIds.length === 0) {
    return {};
  }
  const rows = await search<KeywordRow>(client, customerId, auditKeywordsQuery(campaignIds));
  const byCampaign = groupBy(rows.map((r): [number, KeywordRow] => [r.campaign.id, r]));
  return Object.fromEntries(
    Object.entries(byCampaign).map(([cid, crows]) => [
      Number(cid),
      groupBy(
        crows.map((r): [string, string] => [r.ad_group.name, r.ad_group_criterion.keyword.text]),
      ),
    ]),
  );
}

async function campaigns(
  client: AdsClient,
  customerId: string,
  onlyEnabled: boolean,
  campaignId: string | null,
): Promise<CampaignRow[]> {
  return search<CampaignRow>(client, customerId, auditCampaignsQuery(onlyEnabled, campaignId));
}

/**
 * Resolve --campaign given as a name substring to its id → [id, error].
 *
 * Match happens in JS (the needle never touches GAQL), so there's no injection
 * surface and digit ids skip this path entirely. 0 matches or >1 match is an error
 * the caller surfaces verbatim.
 */
export async function resolveCampaign(
  client: AdsClient,
  customerId: string,
  needle: string,
  onlyEnabled: boolean,
): Promise<[string | null, string | null]> {
  const rows = await search<CampaignRow>(
    client,
    customerId,
    auditCampaignsQuery(onlyEnabled, null),
  );
  const matches = rows
    .filter((r) => r.campaign.name.toLowerCase().includes(needle.toLowerCase()))
    .map((r): [number, string] => [r.campaign.id, r.campaign.name]);
  if (matches.length === 0) {
    return [null, `no campaign name matches '${needle}'`];
  }
  if (matches.length > 1) {
    const names = matches.map(([, n]) => n).join(", ");
    return [null, `campaign name '${needle}' is ambiguous, matches: ${names}`];
  }
  return [String(matches[0][0]), null];
}

async function extCount(
  client: AdsClient,
  customerId: string,
  campId: string,
  fieldType: string,
): Promise<number> {
  const rows = await search(client, customerId, auditExtCountQuery(campId, fieldType));
  return rows.length;
}

// ---------------------------------------------------------------------------
// Creative scoring.
// ---------------------------------------------------------------------------

/** Pure: one ad_group_ad row -> its scored ad dict (issues, pathToExcellent, etc.). */
function scoreAd(
  r: AdGroupAdRow,
  banned: string[],
  agKeywords: Record<string, string[]>,
  profile: DifferentiationProfile,
): ScoredAd {
  const a = r.ad_group_ad;
  const rsa = a.ad.responsive_search_ad;
  const hs = rsa.headlines.map((h) => h.text);
  const ds = rsa.descriptions.map((d) => d.text);
  // AdTextAsset exposes the pin as `pinned_field` (ServedAssetFieldType); an unpinned
  // asset reads UNSPECIFIED. Anything else (HEADLINE_1, …) is a pin.
  const pins = [...rsa.headlines, ...rsa.descriptions]
    .filter((h) => isPinned(h.pinned_field))
    .map((h) => h.text);
  const dupH = [...new Set(hs.filter((h) => hs.filter((x) => x === h).length > 1))].sort();
  // description that merely echoes a headline (the all-caps "headline-as-description" smell)
  const echo = ds.filter((d) => hs.includes(d));
  const hit = [
    ...new Set(
      [...hs, ...ds].filter((t) =>
        banned.some((b) => b && t.toLowerCase().includes(b.toLowerCase())),
      ),
    ),
  ].sort();
  // Me-too copy: flag ads whose message reads as a generic AI-tool promise and name the
  // absent differentiation axes (FR-014/FR-015), judged against the per-run profile.
  const diff = differentiationGaps(hs, ds, profile);
  const actionItems = a.action_items ?? [];
  const adIssues: AdIssue[] = [
    ...(hs.length < MIN_HEADLINES
      ? [{ issue: "headlines_under", have: hs.length, need: MIN_HEADLINES }]
      : []),
    ...(ds.length < MIN_DESCRIPTIONS
      ? [{ issue: "descriptions_under", have: ds.length, need: MIN_DESCRIPTIONS }]
      : []),
    ...(dupH.length > 0 ? [{ issue: "duplicate_headlines", items: dupH }] : []),
    ...(echo.length > 0 ? [{ issue: "description_echoes_headline", items: echo }] : []),
    ...(hit.length > 0 ? [{ issue: "banned_phrase", items: hit }] : []),
    ...(pins.length > 0 ? [{ issue: "pinned_assets", items: pins }] : []),
    ...(diff ? [diff as AdIssue] : []),
  ];
  const keywords = agKeywords[r.ad_group.name] ?? [];
  return {
    adId: a.ad.id,
    adGroup: r.ad_group.name,
    strength: a.ad_strength,
    status: a.status,
    // Full asset text (not just counts) so /adkit update can preserve good copy when
    // authoring rewrites/appends instead of re-fetching it live.
    headlines: hs,
    descriptions: ds,
    finalUrl: (a.ad.final_urls ?? [])[0] ?? null,
    actionItems: [...actionItems],
    issues: adIssues,
    keywords,
    pathToExcellent: pathToExcellent(
      r.ad_group.name,
      keywords,
      hs,
      ds,
      dupH,
      echo,
      hit,
      pins,
      [...actionItems],
      a.ad_strength,
    ),
  };
}

export async function auditCampaign(
  client: AdsClient,
  customerId: string,
  camp: CampaignRow,
  banned: string[],
  agKeywords: Record<string, string[]>,
  profile: DifferentiationProfile,
): Promise<CampaignReport> {
  const cid = camp.campaign.id;
  const sitelinks = await extCount(client, customerId, String(cid), "SITELINK");
  const callouts = await extCount(client, customerId, String(cid), "CALLOUT");
  const rows = (
    await search<RawAdGroupAdRow>(client, customerId, auditAdGroupAdQuery(String(cid)))
  ).map(normalizeAdGroupAdRow);
  const adsOut = rows.map((r) => scoreAd(r, banned, agKeywords, profile));

  // Headlines reused across many ad groups read as boilerplate — fold every
  // (headline, ad group name) pair across all rows, then dedupe per headline.
  const headlineHits: Array<[string, string]> = rows.flatMap((r) =>
    r.ad_group_ad.ad.responsive_search_ad.headlines.map(
      (t): [string, string] => [t.text, r.ad_group.name],
    ),
  );
  const headlineGroups: Record<string, string[]> = Object.fromEntries(
    Object.entries(groupBy(headlineHits)).map(([h, names]) => [h, [...new Set(names)].sort()]),
  );
  const shared: Record<string, string[]> = Object.fromEntries(
    Object.entries(headlineGroups).filter(([, g]) => g.length >= SHARED_HEADLINE_GROUPS),
  );

  // Total ENABLED keywords across the campaign's ad groups — the reach lever. Google's
  // guidance: successful campaigns carry >= MIN_KEYWORDS to match more real searches.
  const keywordCount = Object.values(agKeywords).flat().length;

  const findings: CampaignFinding[] = [
    ...(keywordCount < MIN_KEYWORDS
      ? [
          {
            level: "campaign",
            issue: "keywords_under",
            detail:
              `${keywordCount}/${MIN_KEYWORDS} keywords — add more to reach people actively ` +
              "searching for your products and services",
            need: MIN_KEYWORDS - keywordCount,
          },
        ]
      : []),
    ...(sitelinks < MIN_SITELINKS
      ? [
          {
            level: "campaign",
            issue: "sitelinks_under",
            detail: `${sitelinks}/${MIN_SITELINKS} sitelinks`,
            need: MIN_SITELINKS - sitelinks,
          },
        ]
      : []),
    ...(callouts < MIN_CALLOUTS
      ? [
          {
            level: "campaign",
            issue: "callouts_under",
            detail: `${callouts}/${MIN_CALLOUTS} callouts`,
            need: MIN_CALLOUTS - callouts,
          },
        ]
      : []),
    ...(Object.keys(shared).length > 0
      ? [
          {
            level: "campaign",
            issue: "shared_boilerplate_headlines",
            detail: `${Object.keys(shared).length} headlines reused across >= ${SHARED_HEADLINE_GROUPS} ad groups`,
            items: shared,
          },
        ]
      : []),
  ];
  return {
    campaignId: cid,
    campaignName: camp.campaign.name,
    status: camp.campaign.status,
    keywords: keywordCount,
    sitelinks,
    callouts,
    campaignFindings: findings,
    ads: adsOut,
  };
}

// ---------------------------------------------------------------------------
// Impression-share layer — WHY a campaign isn't winning more impressions (a separate
// axis from ad strength: an EXCELLENT ad can still hold tiny IS). Reports lost IS to
// budget vs Ad Rank, the cold-start throttle, and self-competition between campaigns.
// ---------------------------------------------------------------------------

/** Format a fraction as a whole-percent string, matching Python `f"{x*100:.0f}%"`. */
function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/** Pure: one serving-query row -> its scored campaign dict (flags/recs). */
function scoreServing(r: ServingRow): ScoredServing {
  const cp = r.campaign;
  const m = r.metrics;
  const impr = m.impressions;
  const conv = m.conversions;
  const lostBudget = m.search_budget_lost_impression_share;
  const lostRank = m.search_rank_lost_impression_share;
  let flags: string[];
  let recs: string[];
  if (impr === 0) {
    const coldStart = cp.bidding_strategy_type === "MAXIMIZE_CONVERSIONS" && conv === 0;
    flags = ["zero_impressions", ...(coldStart ? ["cold_start_throttle"] : [])];
    recs = coldStart
      ? [
          "New campaign on Maximize Conversions with no conversions — it bids weakly and " +
            "stays starved. Feed it conversions or warm up on Maximize Clicks.",
        ]
      : [];
  } else {
    const budgetConstrained = lostBudget >= LOST_HI;
    const rankConstrained = lostRank >= LOST_HI;
    const hasHeadroom = Boolean(
      m.search_impression_share && m.search_impression_share < IS_OPPORTUNITY,
    );
    flags = [
      ...(budgetConstrained ? ["budget_constrained"] : []),
      ...(rankConstrained ? ["rank_constrained"] : []),
    ];
    recs = [
      ...(budgetConstrained
        ? [
            `Losing ${pct(lostBudget)} of impression share to BUDGET — raise the daily ` +
              "budget (or tighten geo/schedule/keywords) to capture it.",
          ]
        : []),
      ...(rankConstrained
        ? [
            `Losing ${pct(lostRank)} of impression share to AD RANK — lift Quality Score ` +
              "(ad relevance, ad strength, landing page) and/or bids; add negatives to raise CTR.",
          ]
        : []),
      ...(hasHeadroom
        ? [
            `Search impression share is ${pct(m.search_impression_share)} — headroom to ` +
              `${pct(IS_OPPORTUNITY)}+; act on the dominant lost-IS reason above.`,
          ]
        : []),
    ];
  }
  return {
    campaignId: cp.id,
    campaignName: cp.name,
    bidStrategy: cp.bidding_strategy_type,
    budgetMicros: r.campaign_budget.amount_micros,
    impressions: impr,
    conversions: conv,
    searchImpressionShare: m.search_impression_share,
    lostISBudget: lostBudget,
    lostISRank: lostRank,
    flags,
    impressionShareRecs: recs,
  };
}

export async function campaignServing(
  client: AdsClient,
  customerId: string,
  days: number,
  onlyEnabled: boolean,
  campaignId: string | null,
): Promise<ScoredServing[]> {
  const rows = await search<RawServingRow>(
    client,
    customerId,
    auditServingQuery(days, onlyEnabled, campaignId),
  );
  return rows.map(normalizeServingRow).map(scoreServing);
}

// ---------------------------------------------------------------------------
// Keyword-CPC layer.
// ---------------------------------------------------------------------------

/**
 * {campaignId: [{text, avg_cpc(dollars), avg_cpc_micros}]} for ENABLED keywords,
 * highest CPC first. avg_cpc is the currency value the cluster detector reads.
 */
export async function keywordCpc(
  client: AdsClient,
  customerId: string,
  days: number,
  campaignIds: number[],
): Promise<Record<number, KeywordCpc[]>> {
  if (campaignIds.length === 0) {
    return {};
  }
  const rows = (
    await search<RawKeywordMetricsRow>(
      client,
      customerId,
      auditKeywordMetricsQuery(days, campaignIds),
    )
  ).map(normalizeKeywordMetricsRow);
  const grouped = groupBy(
    rows.map((r): [number, KeywordCpc] => [
      r.campaign.id,
      {
        text: r.ad_group_criterion.keyword.text,
        avg_cpc: microsToCurrency(r.metrics.average_cpc),
        avg_cpc_micros: Math.trunc(r.metrics.average_cpc || 0),
      },
    ]),
  );
  return Object.fromEntries(
    Object.entries(grouped).map(([cid, kws]) => [
      Number(cid),
      [...kws].sort((a, b) => b.avg_cpc - a.avg_cpc),
    ]),
  );
}

/**
 * Per-campaign cluster-split recommendations (only campaigns where the CPC spread
 * crosses the threshold appear).
 */
function clusterSplits(
  kwCpc: Record<number, KeywordCpc[]>,
  names: Record<number, string>,
): ClusterSplit[] {
  return Object.entries(kwCpc)
    .map(([cid, kws]): [number, ReturnType<typeof clusterSplitRecommendation>] => [
      Number(cid),
      clusterSplitRecommendation(kws),
    ])
    .filter(([, rec]) => rec !== null)
    .map(([cid, rec]) => ({
      campaignId: cid,
      campaignName: names[cid] ?? String(cid),
      ...(rec as object),
    }));
}

// ---------------------------------------------------------------------------
// Search-term layer.
// ---------------------------------------------------------------------------

/**
 * {campaignId: [{search_term, clicks, conversions, cost(dollars), impressions}]}
 * over the window, for the negatives/promote derivation.
 */
export async function searchTerms(
  client: AdsClient,
  customerId: string,
  days: number,
  campaignIds: number[],
): Promise<Record<number, SearchTermAgg[]>> {
  if (campaignIds.length === 0) {
    return {};
  }
  const rows = (
    await search<RawSearchTermRow>(client, customerId, auditSearchTermsQuery(days, campaignIds))
  ).map(normalizeSearchTermRow);
  return groupBy(
    rows.map((r): [number, SearchTermAgg] => [
      r.campaign.id,
      {
        search_term: r.search_term_view.search_term,
        clicks: r.metrics.clicks,
        conversions: r.metrics.conversions,
        cost: microsToCurrency(r.metrics.cost_micros),
        impressions: r.metrics.impressions,
      },
    ]),
  );
}

/**
 * Pure: search-term rows -> [addNegatives, promoteKeywords], each keyed by campaignId
 * and only present where non-empty.
 */
function negativesAndPromotions(
  terms: Record<number, SearchTermAgg[]>,
  kwByCampaign: Record<number, Record<string, string[]>>,
): [Record<number, ReturnType<typeof negativesToAdd>>, Record<number, ReturnType<typeof keywordsToPromote>>] {
  const addNegatives: Record<number, ReturnType<typeof negativesToAdd>> = {};
  const promoteKeywords: Record<number, ReturnType<typeof keywordsToPromote>> = {};
  for (const [cidStr, cterms] of Object.entries(terms)) {
    const cid = Number(cidStr);
    const existing = Object.values(kwByCampaign[cid] ?? {}).flatMap((kws) =>
      kws.map((kw) => ({ text: kw })),
    );
    const negs = negativesToAdd(cterms);
    const proms = keywordsToPromote(cterms, existing);
    if (negs.length > 0) {
      addNegatives[cid] = negs;
    }
    if (proms.length > 0) {
      promoteKeywords[cid] = proms;
    }
  }
  return [addNegatives, promoteKeywords];
}

// ---------------------------------------------------------------------------
// Quality Score layer.
// ---------------------------------------------------------------------------

/**
 * {campaignId: [{keyword, qualityScore, landingPageExp, adRelevance, expectedCtr}]}
 * from the current-state Quality Score snapshot. Keywords with no score yet
 * (new/low-traffic) are omitted — quality_score returns 0 in that case.
 */
export async function qualityScore(
  client: AdsClient,
  customerId: string,
  campaignIds: number[],
): Promise<Record<number, QualityScoreEntry[]>> {
  if (campaignIds.length === 0) {
    return {};
  }
  const rows = (
    await search<RawQualityScoreRow>(client, customerId, auditQualityScoreQuery(campaignIds))
  ).map(normalizeQualityScoreRow);
  const scored = rows
    .map((r): [number, QualityScoreEntry] | null => {
      const qi = r.ad_group_criterion.quality_info;
      const score = qi.quality_score;
      if (!score) {
        return null;
      }
      return [
        r.campaign.id,
        {
          keyword: r.ad_group_criterion.keyword.text,
          qualityScore: Math.trunc(score),
          landingPageExp: qi.post_click_quality_score,
          adRelevance: qi.creative_quality_score,
          expectedCtr: qi.search_predicted_ctr,
        },
      ];
    })
    .filter((x): x is [number, QualityScoreEntry] => x !== null);
  const grouped = groupBy(scored);
  return Object.fromEntries(
    Object.entries(grouped).map(([cid, kws]) => [
      Number(cid),
      [...kws].sort((a, b) => a.qualityScore - b.qualityScore),
    ]),
  );
}

// ---------------------------------------------------------------------------
// Landing page health.
// ---------------------------------------------------------------------------

const SLOW_SPEED_SCORE = 3; // speed_score is 1(slowest)-10(fastest); Google buckets 1-3 as "Slow"

const POLICY_TOPIC_FIXES: Record<string, string> = {
  DESTINATION_NOT_WORKING:
    "Page not found (404) or unreachable — bad final URL, broken tracking template, " +
    "or AdsBot blocked by robots.txt. Fix the URL or unblock Googlebot-Ads.",
  DESTINATION_MISMATCH:
    "Final URL mismatch — the redirect chain doesn't resolve to the final URL's domain. " +
    "Align the tracking template and final URL to the same domain.",
};

/** Pure: one landing_page_view row's metrics -> 0-3 finding dicts (issue/detail). */
function mobileFindings(m: LandingPageMobileRow["metrics"]): Array<{ issue: string; detail: string }> {
  const mobilePct = m.mobile_friendly_clicks_percentage;
  const ampPct = m.valid_accelerated_mobile_pages_clicks_percentage;
  const speed = m.speed_score;
  const candidates = [
    mobilePct !== null && mobilePct !== undefined && mobilePct < 1.0
      ? {
          issue: "mobile_unfriendly_clicks",
          detail:
            `only ${pct(mobilePct)} of mobile clicks reach a mobile-friendly page — remove ` +
            'viewport-blocking elements, set <meta name="viewport">, compress images.',
        }
      : null,
    ampPct !== null && ampPct !== undefined && ampPct < 1.0
      ? {
          issue: "invalid_amp_clicks",
          detail: `only ${pct(ampPct)} of AMP clicks reach valid AMP markup — validate at the AMP Validator.`,
        }
      : null,
    speed && speed <= SLOW_SPEED_SCORE
      ? {
          issue: "slow_landing_page",
          detail:
            `speed_score ${speed}/10 — a 1-second mobile delay can cut conversions ` +
            "up to 20%; cut render-blocking assets and server response time.",
        }
      : null,
  ];
  return candidates.filter((f): f is { issue: string; detail: string } => f !== null);
}

/**
 * {campaignId: [{url, issue, detail}]} for URLs failing the mobile-friendly or
 * valid-AMP click-rate checks, or scoring slow on speed_score, over the window.
 */
export async function landingPageMobile(
  client: AdsClient,
  customerId: string,
  days: number,
  campaignIds: number[],
): Promise<Record<number, LandingPageEntry[]>> {
  if (campaignIds.length === 0) {
    return {};
  }
  const rows = (
    await search<RawLandingPageMobileRow>(
      client,
      customerId,
      auditLandingPageMobileQuery(days, campaignIds),
    )
  ).map(normalizeLandingPageMobileRow);
  const entries: Array<[number, LandingPageEntry]> = rows.flatMap((r) =>
    mobileFindings(r.metrics).map((finding): [number, LandingPageEntry] => [
      r.campaign.id,
      {
        url: r.landing_page_view.unexpanded_final_url,
        clicks: r.metrics.clicks,
        impressions: r.metrics.impressions,
        ctr: r.metrics.ctr,
        ...finding,
      },
    ]),
  );
  return groupBy(entries);
}

/**
 * {campaignId: [{url, issue, detail}]} for enabled ads carrying a
 * DESTINATION_NOT_WORKING/DESTINATION_MISMATCH policy topic entry (current approval
 * state — not windowed).
 */
export async function landingPagePolicy(
  client: AdsClient,
  customerId: string,
  campaignIds: number[],
): Promise<Record<number, LandingPageEntry[]>> {
  const perCampaign = await Promise.all(
    campaignIds.map(async (cid): Promise<Array<[number, LandingPageEntry]>> => {
      const rows = (
        await search<RawPolicyTopicRow>(client, customerId, auditPolicyTopicsQuery(String(cid)))
      ).map(normalizePolicyTopicRow);
      return rows.flatMap((r) =>
        r.ad_group_ad.policy_summary.policy_topic_entries
          .filter((entry) => entry.topic in POLICY_TOPIC_FIXES)
          .map((entry): [number, LandingPageEntry] => [
            cid,
            {
              url: (r.ad_group_ad.ad.final_urls ?? [])[0] ?? null,
              issue: entry.topic.toLowerCase(),
              detail: POLICY_TOPIC_FIXES[entry.topic],
            },
          ]),
      );
    }),
  );
  return groupBy(perCampaign.flat());
}

/** Pure merge of two {key: [list]} dicts, concatenating lists for shared keys. */
function mergeLists<V>(
  a: Record<number, V[]>,
  b: Record<number, V[]>,
): Record<number, V[]> {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)].map(Number))];
  return Object.fromEntries(keys.map((k) => [k, [...(a[k] ?? []), ...(b[k] ?? [])]]));
}

// ---------------------------------------------------------------------------
// stderr rendering — every render* function is a pure data -> string[] transform;
// main() is the only place that actually prints (via emitLines).
// ---------------------------------------------------------------------------

function emitLines(lines: string[]): void {
  for (const line of lines) {
    process.stderr.write(line + "\n");
  }
}

/** Left-pad/truncate-free right-fill, matching Python `f"{s:<width}"`. */
function ljust(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

/** Right-justify, matching Python `f"{s:>width}"`. */
function rjust(s: string, width: number): string {
  return s.length >= width ? s : " ".repeat(width - s.length) + s;
}

function renderCreativeSummary(report: CampaignReport[]): string[] {
  function campaignLines(c: CampaignReport): [string[], number] {
    const badAds = c.ads.filter((a) => a.issues.length > 0);
    const header = [
      `\n${c.campaignName} (${c.campaignId}) [${c.status}] ` +
        `keywords=${c.keywords} sitelinks=${c.sitelinks} callouts=${c.callouts}`,
    ];
    const findingLines = c.campaignFindings.map((f) => `  ! ${f.issue}: ${f.detail}`);
    const adLines = c.ads.flatMap((a) => [
      `    [${ljust(a.strength, 9)}] ${ljust(a.adGroup, 34)} ${a.headlines.length}H/${a.descriptions.length}D  ` +
        `${a.issues.map((i) => i.issue).join(", ") || "ok"}`,
      ...(a.strength !== "EXCELLENT"
        ? a.pathToExcellent.map((step) => `        -> ${step}`)
        : []),
    ]);
    return [
      [...header, ...findingLines, ...adLines],
      c.campaignFindings.length + badAds.length,
    ];
  }

  const perCampaign = report.map(campaignLines);
  const lines = perCampaign.flatMap(([cl]) => cl);
  const total = perCampaign.reduce((sum, [, count]) => sum + count, 0);
  return [...lines, `\n${total} creative findings across ${report.length} campaigns`];
}

function renderImpressionShare(
  serving: ScoredServing[],
  cannib: CannibalizationPair[],
  days: number,
): string[] {
  function row(c: ScoredServing): string[] {
    const tag = c.flags.join(", ") || "serving";
    const isPct = c.impressions ? pct(c.searchImpressionShare) : "  -";
    const lb = pct(c.lostISBudget);
    const lr = pct(c.lostISRank);
    return [
      `    ${ljust(c.campaignName, 34)} impr=${rjust(String(c.impressions), 6)} IS=${rjust(isPct, 4)} ` +
        `lostBudget=${rjust(lb, 4)} lostRank=${rjust(lr, 4)} conv=${c.conversions.toFixed(0)} [${tag}]`,
      ...c.impressionShareRecs.map((rec) => `        -> ${rec}`),
    ];
  }

  return [
    `\n=== IMPRESSION SHARE (last ${days} days) ===`,
    ...serving.flatMap(row),
    ...cannib.map(
      (p) =>
        `  ~ cannibalization: ${p.a} <> ${p.b} share ${JSON.stringify(p.shared)} (starved: ${p.starvedLikely})`,
    ),
  ];
}

function renderKeywordCpc(
  serving: ScoredServing[],
  keywordCpcMap: Record<number, KeywordCpc[]>,
  splits: ClusterSplit[],
  days: number,
): string[] {
  function row(c: ScoredServing): string[] {
    const kws = keywordCpcMap[c.campaignId] ?? [];
    if (kws.length === 0) {
      return [];
    }
    const top = kws
      .slice(0, 3)
      .map((k) => `${k.text} $${k.avg_cpc.toFixed(2)}`)
      .join(", ");
    return [`    ${ljust(c.campaignName, 34)} top CPC: ${top}`];
  }

  return [
    `\n=== KEYWORD CPC (last ${days} days) ===`,
    ...serving.flatMap(row),
    ...splits.map((s) => `  ! cluster split: ${s.campaignName} — ${s.reason as string}`),
  ];
}

function renderSearchTermCandidates(
  addNegatives: Record<number, ReturnType<typeof negativesToAdd>>,
  promoteKeywords: Record<number, ReturnType<typeof keywordsToPromote>>,
  names: Record<number, string>,
  days: number,
): string[] {
  function negativesRow(cid: number, negs: ReturnType<typeof negativesToAdd>): string {
    const top = negs
      .slice(0, 5)
      .map((n) => `${n.text} ($${n.cost.toFixed(2)})`)
      .join(", ");
    const wasted = negs.reduce((sum, n) => sum + n.cost, 0);
    return `    ${ljust(names[cid] ?? String(cid), 34)} $${wasted.toFixed(2)} wasted / ${negs.length} terms: ${top}`;
  }

  function promoteRow(cid: number, proms: ReturnType<typeof keywordsToPromote>): string {
    const top = proms
      .slice(0, 5)
      .map((p) => `${p.text} (${p.conversions.toFixed(0)} conv)`)
      .join(", ");
    return `    ${ljust(names[cid] ?? String(cid), 34)} ${proms.length} terms: ${top}`;
  }

  const negativesSection =
    Object.keys(addNegatives).length > 0
      ? [
          `\n=== SEARCH-TERM WASTE → NEGATIVE CANDIDATES (last ${days} days) ===`,
          ...Object.entries(addNegatives).map(([cid, negs]) => negativesRow(Number(cid), negs)),
        ]
      : [];
  const promoteSection =
    Object.keys(promoteKeywords).length > 0
      ? [
          `\n=== CONVERTING SEARCH TERMS → PROMOTE CANDIDATES (last ${days} days) ===`,
          ...Object.entries(promoteKeywords).map(([cid, proms]) => promoteRow(Number(cid), proms)),
        ]
      : [];
  return [...negativesSection, ...promoteSection];
}

function renderQualityScoreSection(
  title: string,
  component: "landingPageExp" | "adRelevance" | "expectedCtr",
  qualityScoreMap: Record<number, QualityScoreEntry[]>,
  campNames: Record<number, string>,
): string[] {
  const bad: Record<number, QualityScoreEntry[]> = Object.fromEntries(
    Object.entries(qualityScoreMap)
      .map(([cid, kws]): [number, QualityScoreEntry[]] => [
        Number(cid),
        kws.filter((k) => k[component] === "BELOW_AVERAGE"),
      ])
      .filter(([, kws]) => kws.length > 0),
  );
  if (Object.keys(bad).length === 0) {
    return [];
  }

  function row(cid: number, kws: QualityScoreEntry[]): string {
    const top = kws
      .slice(0, 5)
      .map((k) => `${k.keyword} (QS ${k.qualityScore})`)
      .join(", ");
    return `    ${ljust(campNames[cid] ?? String(cid), 34)} ${kws.length} keywords: ${top}`;
  }

  return [
    `\n=== ${title} ===`,
    ...Object.entries(bad).map(([cid, kws]) => row(Number(cid), kws)),
  ];
}

function renderLandingPageHealth(
  landingPageHealth: Record<number, LandingPageEntry[]>,
  campNames: Record<number, string>,
): string[] {
  if (Object.keys(landingPageHealth).length === 0) {
    return [];
  }
  return [
    `\n=== LANDING PAGE HEALTH ===`,
    ...Object.entries(landingPageHealth).flatMap(([cidStr, items]) => {
      const cid = Number(cidStr);
      return [
        `    ${ljust(campNames[cid] ?? String(cid), 34)} ${items.length} issue(s):`,
        ...items.map((it) => `        -> [${it.issue}] ${it.url}: ${it.detail}`),
      ];
    }),
  ];
}

// ---------------------------------------------------------------------------
// Argument parsing (parse, don't validate).
// ---------------------------------------------------------------------------

interface ParsedArgs {
  customer: string | null;
  loginCustomerId: string | null;
  campaign: string | null;
  all: boolean;
  banned: string[];
  days: number;
  noServing: boolean;
  profile: DifferentiationProfile;
}

/** Only 7/14/30 are valid windows, mirroring argparse `choices=[7, 14, 30]`. */
const VALID_DAYS = new Set([7, 14, 30]);

/**
 * Parse argv into typed values once. The differentiation profile is read+parsed
 * here (parse, don't validate); downstream code takes the parsed profile.
 */
function parseAudarArgs(argv: string[]): ParsedArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      customer: { type: "string" },
      "login-customer-id": { type: "string" },
      campaign: { type: "string" },
      all: { type: "boolean", default: false },
      banned: { type: "string", default: "" },
      days: { type: "string", default: "7" },
      "no-serving": { type: "boolean", default: false },
      "differentiation-profile": { type: "string" },
    },
    allowPositionals: false,
  });

  const days = Number(values.days);
  if (!VALID_DAYS.has(days)) {
    throw new Error(`error: --days must be one of 7, 14, 30, got ${values.days}`);
  }

  const profilePath = values["differentiation-profile"];
  const profile = profilePath
    ? parseDifferentiationProfile(JSON.parse(readFileSync(profilePath, "utf8")))
    : EMPTY_PROFILE;

  return {
    customer: values.customer ?? null,
    loginCustomerId: values["login-customer-id"] ?? null,
    campaign: values.campaign ?? null,
    all: values.all ?? false,
    banned: (values.banned ?? "").split(",").map((b) => b.trim()).filter((b) => b),
    days,
    noServing: values["no-serving"] ?? false,
    profile,
  };
}

// ---------------------------------------------------------------------------
// main.
// ---------------------------------------------------------------------------

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseAudarArgs(argv);
  const customer = resolveCustomer([args.customer]);
  if (!customer) {
    emitJson(errorEnvelope("Provide --customer (or set login_customer_id in yaml)"));
    return 2;
  }
  requireDigits("customer", customer);
  requireDigits("login-customer-id", args.loginCustomerId);
  const client = loadClient(args.loginCustomerId);

  // --campaign accepts an id (digits) or a name substring; resolve the name to an id once.
  let campaignId = args.campaign;
  if (campaignId && !/^\d+$/.test(campaignId)) {
    const [resolved, err] = await resolveCampaign(client, customer, campaignId, !args.all);
    if (err) {
      emitJson(errorEnvelope(err));
      return 2;
    }
    campaignId = resolved;
  }
  requireDigits("campaign", campaignId);

  const camps = await campaigns(client, customer, !args.all, campaignId);
  const campIds = camps.map((c) => c.campaign.id);
  const kwByCampaign = await allKeywords(client, customer, campIds);
  const report = await Promise.all(
    camps.map((c) =>
      auditCampaign(client, customer, c, args.banned, kwByCampaign[c.campaign.id] ?? {}, args.profile),
    ),
  );

  const qualityScoreMap = await qualityScore(client, customer, campIds);
  let landingPageHealth = await landingPagePolicy(client, customer, campIds);

  let serving: ScoredServing[] = [];
  let cannib: CannibalizationPair[] = [];
  let keywordCpcMap: Record<number, KeywordCpc[]> = {};
  let splits: ClusterSplit[] = [];
  let addNegatives: Record<number, ReturnType<typeof negativesToAdd>> = {};
  let promoteKeywords: Record<number, ReturnType<typeof keywordsToPromote>> = {};
  if (!args.noServing) {
    serving = await campaignServing(client, customer, args.days, !args.all, campaignId);
    cannib = cannibalization(serving, kwByCampaign);
    keywordCpcMap = await keywordCpc(client, customer, args.days, campIds);
    splits = clusterSplits(
      keywordCpcMap,
      Object.fromEntries(camps.map((c) => [c.campaign.id, c.campaign.name])),
    );
    landingPageHealth = mergeLists(
      landingPageHealth,
      await landingPageMobile(client, customer, args.days, campIds),
    );
    const terms = await searchTerms(client, customer, args.days, campIds);
    [addNegatives, promoteKeywords] = negativesAndPromotions(terms, kwByCampaign);
  }

  // human summary -> stderr (stdout stays clean JSON for piping)
  emitLines(renderCreativeSummary(report));
  if (!args.noServing) {
    const names = Object.fromEntries(serving.map((c) => [c.campaignId, c.campaignName]));
    emitLines(renderImpressionShare(serving, cannib, args.days));
    emitLines(renderKeywordCpc(serving, keywordCpcMap, splits, args.days));
    emitLines(renderSearchTermCandidates(addNegatives, promoteKeywords, names, args.days));
  }

  const campNames = Object.fromEntries(camps.map((c) => [c.campaign.id, c.campaign.name]));
  emitLines(
    renderQualityScoreSection(
      "QUALITY SCORE — LANDING PAGE EXP. BELOW AVERAGE",
      "landingPageExp",
      qualityScoreMap,
      campNames,
    ),
  );
  emitLines(
    renderQualityScoreSection(
      "QUALITY SCORE — AD RELEVANCE BELOW AVERAGE",
      "adRelevance",
      qualityScoreMap,
      campNames,
    ),
  );
  emitLines(
    renderQualityScoreSection(
      "QUALITY SCORE — EXPECTED CTR BELOW AVERAGE",
      "expectedCtr",
      qualityScoreMap,
      campNames,
    ),
  );
  emitLines(renderLandingPageHealth(landingPageHealth, campNames));

  const stringKeyed = <V>(m: Record<number, V>): Record<string, V> =>
    Object.fromEntries(Object.entries(m).map(([k, v]) => [String(k), v]));

  emitJson(
    ok({
      customer,
      campaigns: report,
      serving,
      cannibalization: cannib,
      keywordCpc: stringKeyed(keywordCpcMap),
      clusterSplits: splits,
      addNegatives: stringKeyed(addNegatives),
      promoteKeywords: stringKeyed(promoteKeywords),
      qualityScore: stringKeyed(qualityScoreMap),
      landingPageHealth: stringKeyed(landingPageHealth),
    }),
  );
  return 0;
}

// Run guard: execute main only when invoked directly, not when imported by tests.
if (isMainModule(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      emitJson(errorEnvelope(formatGoogleAdsError(err)));
      process.exit(1);
    });
}
