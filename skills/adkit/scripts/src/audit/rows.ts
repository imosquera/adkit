/**
 * Google Ads API row shapes for the /adkit audit reads, plus the boundary
 * normalizers (parse, don't validate).
 *
 * The `*Row` types are the PROOFS downstream scoring relies on — every nested
 * message and metric present. But the google-ads-api `search` returns the wire
 * shape, where the API OMITS empty nested messages and zero-valued metric fields
 * entirely: a keyword with no spend has no `metrics`, a criterion with no Quality
 * Score yet has no `quality_info`, a non-RSA ad has no `responsive_search_ad`. The
 * `Raw*Row` types are that honest, loose shape; each `normalize*` parses one raw row
 * into its strong `*Row` — zero-filling metrics, defaulting empty messages — exactly
 * once, at the fetch boundary. Downstream code then never re-checks presence. Add a
 * field to a `Raw*Row` and the compiler forces the matching `normalize*` to account
 * for it.
 *
 * Enum fields arrive as their STRING name already (no `.name`).
 */

// ---------------------------------------------------------------------------
// Strong row shapes (the parsed proofs).
// ---------------------------------------------------------------------------

export interface TextAsset {
  text: string;
  /** ServedAssetFieldType enum name, or "UNSPECIFIED"/undefined when unpinned. */
  pinned_field?: string;
}

export interface CampaignRow {
  campaign: { id: number; name: string; status: string };
}

export interface KeywordRow {
  campaign: { id: number };
  ad_group: { name: string };
  ad_group_criterion: { keyword: { text: string } };
}

export interface AdGroupAdRow {
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

export interface ServingRow {
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

export interface KeywordMetricsRow {
  campaign: { id: number };
  // Optional to match this module's boundary convention (consumers absorb
  // API-omitted nested fields rather than throw). ad_group.id is always selected
  // by auditKeywordMetricsQuery, so in practice it is present; the consumer maps a
  // (shouldn't-happen) omission to null — an honest "unknown", not a bogus id 0.
  ad_group?: { id: number };
  ad_group_criterion: { keyword: { text: string; match_type?: string } };
  metrics: { average_cpc: number };
}

export interface SearchTermRow {
  campaign: { id: number };
  search_term_view: { search_term: string };
  metrics: { clicks: number; conversions: number; cost_micros: number; impressions: number };
}

export interface QualityScoreRow {
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

export interface LandingPageMobileRow {
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

export interface PolicyTopicRow {
  ad_group_ad: {
    ad: { final_urls?: string[] };
    policy_summary: { policy_topic_entries: Array<{ topic: string }> };
  };
}

// ---------------------------------------------------------------------------
// Raw (wire) row shapes + boundary normalizers.
// ---------------------------------------------------------------------------

/** Coalesce an omitted (zero-valued) numeric metric field back to 0. */
const num = (x: number | null | undefined): number => x ?? 0;

/**
 * Zero-fill a fixed set of numeric metric keys from a possibly-omitted metrics
 * object — the shared core of every flat-metric normalizer, so the per-key
 * `num(raw?.x)` list lives once. Keys the API omitted come back as 0.
 */
function zeroFillMetrics<K extends string>(
  raw: Partial<Record<K, number | null | undefined>> | undefined,
  keys: readonly K[],
): Record<K, number> {
  return Object.fromEntries(keys.map((k) => [k, num(raw?.[k])])) as Record<K, number>;
}

export interface RawAdGroupAdRow {
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

export function normalizeAdGroupAdRow(r: RawAdGroupAdRow): AdGroupAdRow {
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

export interface RawServingRow {
  campaign: { id: number; name: string; bidding_strategy_type: string };
  campaign_budget?: { amount_micros?: number };
  metrics?: Partial<ServingRow["metrics"]>;
}

const SERVING_METRIC_KEYS = [
  "impressions",
  "conversions",
  "search_impression_share",
  "search_budget_lost_impression_share",
  "search_rank_lost_impression_share",
] as const;

export function normalizeServingRow(r: RawServingRow): ServingRow {
  return {
    campaign: r.campaign,
    campaign_budget: { amount_micros: num(r.campaign_budget?.amount_micros) },
    metrics: zeroFillMetrics(r.metrics, SERVING_METRIC_KEYS),
  };
}

export interface RawKeywordMetricsRow {
  campaign: { id: number };
  ad_group?: { id: number };
  ad_group_criterion: { keyword: { text: string; match_type?: string } };
  metrics?: { average_cpc?: number };
}

export function normalizeKeywordMetricsRow(r: RawKeywordMetricsRow): KeywordMetricsRow {
  return { ...r, metrics: zeroFillMetrics(r.metrics, ["average_cpc"] as const) };
}

export interface RawSearchTermRow {
  campaign: { id: number };
  search_term_view: { search_term: string };
  metrics?: Partial<SearchTermRow["metrics"]>;
}

const SEARCH_TERM_METRIC_KEYS = ["clicks", "conversions", "cost_micros", "impressions"] as const;

export function normalizeSearchTermRow(r: RawSearchTermRow): SearchTermRow {
  return { ...r, metrics: zeroFillMetrics(r.metrics, SEARCH_TERM_METRIC_KEYS) };
}

export interface RawQualityScoreRow {
  campaign: { id: number };
  ad_group_criterion: {
    keyword: { text: string };
    quality_info?: Partial<QualityScoreRow["ad_group_criterion"]["quality_info"]>;
  };
}

export function normalizeQualityScoreRow(r: RawQualityScoreRow): QualityScoreRow {
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

export interface RawLandingPageMobileRow {
  campaign: { id: number };
  landing_page_view: { unexpanded_final_url: string };
  metrics?: Partial<LandingPageMobileRow["metrics"]>;
}

export function normalizeLandingPageMobileRow(r: RawLandingPageMobileRow): LandingPageMobileRow {
  const m = r.metrics;
  return {
    ...r,
    metrics: {
      // The percentage fields are meaningfully null ("no data"); mobileFindings
      // already skips null, so preserve it rather than zero-filling.
      mobile_friendly_clicks_percentage: m?.mobile_friendly_clicks_percentage ?? null,
      valid_accelerated_mobile_pages_clicks_percentage:
        m?.valid_accelerated_mobile_pages_clicks_percentage ?? null,
      ...zeroFillMetrics(m, ["speed_score", "clicks", "impressions", "ctr"] as const),
    },
  };
}

export interface RawPolicyTopicRow {
  ad_group_ad: {
    ad: { final_urls?: string[] };
    policy_summary?: { policy_topic_entries?: Array<{ topic: string }> };
  };
}

export function normalizePolicyTopicRow(r: RawPolicyTopicRow): PolicyTopicRow {
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
