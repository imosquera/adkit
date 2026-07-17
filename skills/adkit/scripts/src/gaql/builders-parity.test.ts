import { describe, expect, it } from "vitest";
import {
  adGroupQuery,
  adQuery,
  applyAdGroupNamesQuery,
  applyAdGroupStatusesQuery,
  applyBudgetsQuery,
  applyCampaignStatusesQuery,
  applyHeadlinesQuery,
  applyLanguagesQuery,
  applyNegativesQuery,
  applyPositiveKeywordsQuery,
  applySearchPartnersQuery,
  auditCampaignsQuery,
  auditExtCountQuery,
  auditKeywordMetricsQuery,
  auditKeywordsQuery,
  auditLandingPageMobileQuery,
  auditPolicyTopicsQuery,
  auditQualityScoreQuery,
  auditServingQuery,
  campaignDailyQuery,
  campaignTotalsQuery,
  keywordQuery,
  searchTermQuery,
} from "./builders.js";
import { toGaql } from "./search-args.js";

/**
 * Golden-string parity for the string→SearchArgs builder migration. Each expected
 * value is the EXACT GAQL string the builder emitted before the refactor (verified
 * byte-identical against the pre-refactor `builders.ts` for all 27 cases). If a
 * builder's decomposed `SearchArgs` ever drifts — a dropped condition, reordered
 * field, lost ORDER BY — `toGaql(builder(...))` stops matching and this fails. This
 * is the core protection that the read migration didn't change what the API runs.
 */
const IDS = ["12345", "67890"];

const CASES: ReadonlyArray<[string, string]> = [
  [
    toGaql(campaignTotalsQuery("2026-06-08", "2026-06-21")),
    "SELECT campaign.id, campaign.name, campaign.status, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.ctr, metrics.average_cpc, metrics.conversions, metrics.cost_per_conversion FROM campaign WHERE campaign.status = 'ENABLED' AND segments.date BETWEEN '2026-06-08' AND '2026-06-21'",
  ],
  [
    toGaql(campaignDailyQuery("2026-06-08", "2026-06-21")),
    "SELECT campaign.id, campaign.name, segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.ctr, metrics.average_cpc, metrics.conversions, metrics.cost_per_conversion FROM campaign WHERE campaign.status = 'ENABLED' AND segments.date BETWEEN '2026-06-08' AND '2026-06-21' ORDER BY segments.date",
  ],
  [
    toGaql(adGroupQuery("2026-06-08", "2026-06-21")),
    "SELECT campaign.id, ad_group.id, ad_group.name, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.ctr, metrics.average_cpc, metrics.conversions, metrics.cost_per_conversion FROM ad_group WHERE campaign.status = 'ENABLED' AND segments.date BETWEEN '2026-06-08' AND '2026-06-21'",
  ],
  [
    toGaql(adQuery("2026-06-08", "2026-06-21")),
    "SELECT campaign.id, ad_group.id, ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.ad.type, ad_group_ad.ad_strength, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.ctr, metrics.average_cpc, metrics.conversions, metrics.cost_per_conversion FROM ad_group_ad WHERE campaign.status = 'ENABLED' AND segments.date BETWEEN '2026-06-08' AND '2026-06-21'",
  ],
  [
    toGaql(keywordQuery("2026-06-08", "2026-06-21")),
    "SELECT campaign.id, ad_group.id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.ctr, metrics.average_cpc, metrics.conversions, metrics.cost_per_conversion FROM keyword_view WHERE campaign.status = 'ENABLED' AND segments.date BETWEEN '2026-06-08' AND '2026-06-21'",
  ],
  [
    toGaql(searchTermQuery("2026-06-08", "2026-06-21")),
    "SELECT campaign.id, ad_group.id, search_term_view.search_term, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.ctr, metrics.average_cpc, metrics.conversions, metrics.cost_per_conversion FROM search_term_view WHERE campaign.status = 'ENABLED' AND segments.date BETWEEN '2026-06-08' AND '2026-06-21'",
  ],
  [
    toGaql(auditKeywordsQuery(IDS)),
    "SELECT campaign.id, ad_group.name, ad_group_criterion.keyword.text FROM ad_group_criterion WHERE campaign.id IN (12345,67890) AND ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.status != 'REMOVED'",
  ],
  [
    toGaql(auditKeywordMetricsQuery(30, IDS)),
    "SELECT campaign.id, ad_group_criterion.keyword.text, metrics.average_cpc FROM keyword_view WHERE campaign.id IN (12345,67890) AND ad_group_criterion.status = 'ENABLED' AND segments.date DURING LAST_30_DAYS",
  ],
  [
    toGaql(auditCampaignsQuery(true, null)),
    "SELECT campaign.id, campaign.name, campaign.status FROM campaign WHERE campaign.status = 'ENABLED' ORDER BY campaign.name",
  ],
  [
    toGaql(auditCampaignsQuery(false, "12345")),
    "SELECT campaign.id, campaign.name, campaign.status FROM campaign WHERE campaign.id = 12345 ORDER BY campaign.name",
  ],
  [
    toGaql(auditCampaignsQuery(false, null)),
    "SELECT campaign.id, campaign.name, campaign.status FROM campaign ORDER BY campaign.name",
  ],
  [
    toGaql(auditExtCountQuery("12345", "SITELINK")),
    "SELECT campaign.id FROM campaign_asset WHERE campaign.id = 12345 AND campaign_asset.field_type = 'SITELINK'",
  ],
  [
    toGaql(auditQualityScoreQuery(IDS)),
    "SELECT campaign.id, ad_group_criterion.keyword.text, ad_group_criterion.quality_info.quality_score, ad_group_criterion.quality_info.search_predicted_ctr, ad_group_criterion.quality_info.creative_quality_score, ad_group_criterion.quality_info.post_click_quality_score FROM keyword_view WHERE campaign.id IN (12345,67890) AND ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.status != 'REMOVED'",
  ],
  [
    toGaql(auditLandingPageMobileQuery(7, IDS)),
    "SELECT campaign.id, landing_page_view.unexpanded_final_url, metrics.mobile_friendly_clicks_percentage, metrics.valid_accelerated_mobile_pages_clicks_percentage, metrics.speed_score, metrics.clicks, metrics.impressions, metrics.ctr FROM landing_page_view WHERE campaign.id IN (12345,67890) AND segments.date DURING LAST_7_DAYS",
  ],
  [
    toGaql(auditPolicyTopicsQuery("12345")),
    "SELECT ad_group_ad.ad.id, ad_group_ad.ad.final_urls, ad_group_ad.policy_summary.policy_topic_entries FROM ad_group_ad WHERE campaign.id = 12345 AND ad_group_ad.status = 'ENABLED'",
  ],
  [
    toGaql(auditServingQuery(30, false, "12345")),
    "SELECT campaign.id, campaign.name, campaign.bidding_strategy_type, campaign_budget.amount_micros, metrics.impressions, metrics.conversions, metrics.search_impression_share, metrics.search_budget_lost_impression_share, metrics.search_rank_lost_impression_share FROM campaign WHERE segments.date DURING LAST_30_DAYS AND campaign.id = 12345",
  ],
  [
    toGaql(auditServingQuery(30, true, null)),
    "SELECT campaign.id, campaign.name, campaign.bidding_strategy_type, campaign_budget.amount_micros, metrics.impressions, metrics.conversions, metrics.search_impression_share, metrics.search_budget_lost_impression_share, metrics.search_rank_lost_impression_share FROM campaign WHERE segments.date DURING LAST_30_DAYS AND campaign.status = 'ENABLED'",
  ],
  [
    toGaql(auditServingQuery(30, false, null)),
    "SELECT campaign.id, campaign.name, campaign.bidding_strategy_type, campaign_budget.amount_micros, metrics.impressions, metrics.conversions, metrics.search_impression_share, metrics.search_budget_lost_impression_share, metrics.search_rank_lost_impression_share FROM campaign WHERE segments.date DURING LAST_30_DAYS",
  ],
  [
    toGaql(applyNegativesQuery(IDS)),
    "SELECT campaign.id, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type FROM campaign_criterion WHERE campaign.id IN (12345,67890) AND campaign_criterion.negative = TRUE AND campaign_criterion.type = KEYWORD",
  ],
  [
    toGaql(applyBudgetsQuery(IDS)),
    "SELECT campaign.id, campaign_budget.resource_name, campaign_budget.amount_micros FROM campaign WHERE campaign.id IN (12345,67890)",
  ],
  [
    toGaql(applyCampaignStatusesQuery(IDS)),
    "SELECT campaign.id, campaign.status FROM campaign WHERE campaign.id IN (12345,67890)",
  ],
  [
    toGaql(applySearchPartnersQuery(IDS)),
    "SELECT campaign.id, campaign.network_settings.target_search_network, campaign.network_settings.target_google_search FROM campaign WHERE campaign.id IN (12345,67890)",
  ],
  [
    toGaql(applyAdGroupStatusesQuery(IDS)),
    "SELECT ad_group.id, ad_group.status FROM ad_group WHERE ad_group.id IN (12345,67890)",
  ],
  [
    toGaql(applyAdGroupNamesQuery(IDS)),
    "SELECT campaign.id, ad_group.name FROM ad_group WHERE campaign.id IN (12345,67890) AND ad_group.status != 'REMOVED'",
  ],
  [
    toGaql(applyLanguagesQuery(IDS)),
    "SELECT campaign.id, campaign_criterion.resource_name, campaign_criterion.language.language_constant FROM campaign_criterion WHERE campaign.id IN (12345,67890) AND campaign_criterion.type = LANGUAGE AND campaign_criterion.status != 'REMOVED'",
  ],
  [
    toGaql(applyHeadlinesQuery(IDS)),
    "SELECT ad_group_ad.ad.id, ad_group_ad.ad.responsive_search_ad.headlines FROM ad_group_ad WHERE ad_group_ad.ad.id IN (12345,67890)",
  ],
  [
    toGaql(applyPositiveKeywordsQuery(IDS)),
    "SELECT ad_group.id, ad_group_criterion.criterion_id, ad_group_criterion.resource_name, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.status FROM ad_group_criterion WHERE ad_group.id IN (12345,67890) AND ad_group_criterion.type = KEYWORD AND ad_group_criterion.negative = FALSE AND ad_group_criterion.status != 'REMOVED'",
  ],
];

describe("builder GAQL parity (toGaql reproduces the pre-refactor strings)", () => {
  it.each(CASES)("case #%# reproduces its exact pre-refactor GAQL", (actual, expected) => {
    expect(actual).toBe(expected);
  });

  it("covers every builder family (report, audit, apply-fixes)", () => {
    expect(CASES.length).toBe(27);
  });
});
