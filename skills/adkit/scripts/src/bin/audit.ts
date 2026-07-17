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
 *   ads.sh audit --customer 8911925499 [--campaign ID] [--all]
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
import { resolveCustomer, type ResolveCustomerOptions } from "../cli/args.js";
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
import { loadReadClient } from "../lib/mcp-client.js";
import type { SearchArgs } from "../gaql/search-args.js";
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
import {
  normalizeAdGroupAdRow,
  normalizeKeywordMetricsRow,
  normalizeLandingPageMobileRow,
  normalizePolicyTopicRow,
  normalizeQualityScoreRow,
  normalizeSearchTermRow,
  normalizeServingRow,
  type AdGroupAdRow,
  type CampaignRow,
  type KeywordRow,
  type LandingPageMobileRow,
  type RawAdGroupAdRow,
  type RawKeywordMetricsRow,
  type RawLandingPageMobileRow,
  type RawPolicyTopicRow,
  type RawQualityScoreRow,
  type RawSearchTermRow,
  type RawServingRow,
  type ServingRow,
} from "../audit/rows.js";
import type {
  AdIssue,
  CampaignFinding,
  CampaignReport,
  ClusterSplit,
  KeywordCpc,
  LandingPageEntry,
  QualityScoreEntry,
  ScoredAd,
  ScoredServing,
  SearchTermAgg,
} from "../audit/types.js";
import {
  emitLines,
  pct,
  renderCreativeSummary,
  renderImpressionShare,
  renderKeywordCpc,
  renderLandingPageHealth,
  renderQualityScoreSection,
  renderSearchTermCandidates,
} from "../audit/render.js";

// ---------------------------------------------------------------------------
// Small functional primitives.
// ---------------------------------------------------------------------------

async function search<Row = Record<string, unknown>>(
  client: AdsClient,
  customerId: string,
  args: SearchArgs,
): Promise<Row[]> {
  return client.searchStructured<Row>(customerId, args);
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
// Customer resolution + the manager-metrics guard.
// ---------------------------------------------------------------------------

/**
 * Resolve the customer to QUERY: `--customer` flag → `GOOGLE_ADS_CUSTOMER_ID` env
 * → yaml (target, then login). Mirrors create.ts precedence. Including the env leaf
 * is the fix for the MCC trap: without it, an operator with only `login_customer_id`
 * (an MCC) in google-ads.yaml would query metrics against the manager and hit
 * "Metrics cannot be requested for a manager account" even with a leaf exported.
 */
export function resolveAuditCustomer(
  args: { customer: string | null },
  env: NodeJS.ProcessEnv = process.env,
  opts: ResolveCustomerOptions = {},
): string | null {
  return resolveCustomer([args.customer, env["GOOGLE_ADS_CUSTOMER_ID"] ?? null], opts);
}

/** True when a Google Ads error is the "metrics on a manager account" rejection (query_error 59). */
export function isManagerMetricsError(exc: unknown): boolean {
  const msg = formatGoogleAdsError(exc).toLowerCase();
  return msg.includes("manager account") || msg.includes('"query_error":59') || msg.includes("query_error:59");
}

/** Actionable guidance shown when metrics were queried against a manager (MCC) account. */
export function managerMetricsHint(): string {
  return (
    "metrics were requested against a manager (MCC) account, which Google Ads rejects. " +
    "Pass --customer <leaf-account-id> (or export GOOGLE_ADS_CUSTOMER_ID=<leaf>). " +
    "google-ads.yaml's login_customer_id is the MCC login header, not a query target."
  );
}

// ---------------------------------------------------------------------------
// main.
// ---------------------------------------------------------------------------

/**
 * Wrap {@link runAudit} so a manager-metrics rejection (querying the MCC by
 * mistake) surfaces as {@link managerMetricsHint} instead of the raw error 59.
 * Other errors propagate to the run guard's generic formatter.
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  try {
    return await runAudit(argv);
  } catch (err) {
    if (isManagerMetricsError(err)) {
      emitJson(errorEnvelope(managerMetricsHint()));
      return 2;
    }
    throw err;
  }
}

export async function runAudit(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseAudarArgs(argv);
  const customer = resolveAuditCustomer(args);
  if (!customer) {
    emitJson(errorEnvelope("Provide --customer or export GOOGLE_ADS_CUSTOMER_ID (or set a target/login id in yaml)"));
    return 2;
  }
  requireDigits("customer", customer);
  requireDigits("login-customer-id", args.loginCustomerId);
  const client = loadReadClient(args.loginCustomerId);

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
