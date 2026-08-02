import { describe, expect, it } from "vitest";
import {
  adGroupQuery,
  adQuery,
  applyBiddingGuardQuery,
  applyPositiveKeywordsQuery,
  auditAdGroupAdQuery,
  auditKeywordMetricsQuery,
  auditSearchTermsQuery,
  campaignDailyQuery,
  campaignTotalsQuery,
  geoQuery,
  geoRegionQuery,
  keywordQuery,
  searchTermQuery,
} from "./builders.js";
import { toGaql } from "./search-args.js";

describe("auditKeywordMetricsQuery", () => {
  it("counts only ENABLED keywords so a paused keyword's spend stops driving clusterSplits", () => {
    const q = auditKeywordMetricsQuery(30, ["12345"]);
    expect(q.resource).toBe("keyword_view");
    expect(q.conditions).toContain("ad_group_criterion.status = 'ENABLED'");
    expect(q.conditions).toContain("segments.date DURING LAST_30_DAYS");
  });

  it("selects ad_group.id and match_type so a keyword pause plan needs no report round-trip (#22)", () => {
    const q = auditKeywordMetricsQuery(30, ["12345"]);
    expect(q.fields).toContain("ad_group.id");
    expect(q.fields).toContain("ad_group_criterion.keyword.match_type");
    expect(q.fields).toContain("ad_group_criterion.keyword.text");
    expect(q.fields).toContain("metrics.average_cpc");
    expect(q.fields).toContain("metrics.impressions");
    expect(q.fields).toContain("metrics.ctr");
  });
});

describe("auditSearchTermsQuery", () => {
  it("guards ids digits-only", () => {
    expect(() => auditSearchTermsQuery(7, ["123", "4x"])).toThrow();
  });

  it("selects terms over the window as structured args", () => {
    const q = auditSearchTermsQuery(14, ["12345", "67890"]);
    expect(q.resource).toBe("search_term_view");
    expect(q.fields).toContain("search_term_view.search_term");
    expect(q.fields).toContain("metrics.cost_micros");
    expect(q.conditions).toContain("campaign.id IN (12345,67890)");
    expect(q.conditions).toContain("segments.date DURING LAST_14_DAYS");
  });

  it("toGaql reproduces the pre-refactor GAQL string", () => {
    expect(toGaql(auditSearchTermsQuery(14, ["12345", "67890"]))).toBe(
      "SELECT campaign.id, ad_group.id, search_term_view.search_term, metrics.cost_micros, " +
        "metrics.impressions, metrics.clicks, metrics.conversions, metrics.ctr " +
        "FROM search_term_view WHERE campaign.id IN (12345,67890) " +
        "AND segments.date DURING LAST_14_DAYS",
    );
  });

  it("selects ad_group.id and ctr so a per-ad-group click/CTR ranking needs no report round-trip", () => {
    const q = auditSearchTermsQuery(14, ["12345"]);
    expect(q.fields).toContain("ad_group.id");
    expect(q.fields).toContain("metrics.ctr");
  });
});

describe("auditAdGroupAdQuery", () => {
  it("guards id digits-only", () => {
    expect(() => auditAdGroupAdQuery("4x")).toThrow();
  });

  it("fetches only non-removed RSAs so non-RSA ads are never mis-scored", () => {
    const q = auditAdGroupAdQuery("12345");
    expect(q.resource).toBe("ad_group_ad");
    expect(q.conditions).toContain("campaign.id = 12345");
    expect(q.conditions).toContain("ad_group_ad.status != 'REMOVED'");
    expect(q.conditions).toContain("ad_group_ad.ad.type = 'RESPONSIVE_SEARCH_AD'");
    expect(q.orderings).toEqual(["ad_group.name"]);
  });

  it("toGaql reproduces the pre-refactor GAQL string (ORDER BY intact)", () => {
    expect(toGaql(auditAdGroupAdQuery("12345"))).toBe(
      "SELECT ad_group.name, ad_group_ad.ad.id, ad_group_ad.ad_strength, " +
        "ad_group_ad.status, ad_group_ad.action_items, " +
        "ad_group_ad.ad.responsive_search_ad.headlines, " +
        "ad_group_ad.ad.responsive_search_ad.descriptions, ad_group_ad.ad.final_urls " +
        "FROM ad_group_ad WHERE campaign.id = 12345 AND ad_group_ad.status != 'REMOVED' " +
        "AND ad_group_ad.ad.type = 'RESPONSIVE_SEARCH_AD' ORDER BY ad_group.name",
    );
  });
});

describe("geoQuery", () => {
  it("reads geographic_view keyed by country over the ENABLED window", () => {
    const q = geoQuery("2026-06-08", "2026-06-21");
    expect(q.resource).toBe("geographic_view");
    expect(q.fields).toContain("geographic_view.country_criterion_id");
    expect(q.fields).toContain("metrics.cost_micros");
    expect(q.conditions).toContain("campaign.status = 'ENABLED'");
    expect(q.conditions).toContain("segments.date BETWEEN '2026-06-08' AND '2026-06-21'");
  });
});

describe("geoRegionQuery", () => {
  it("reads geographic_view segmented by geo_target_region over the ENABLED window", () => {
    const q = geoRegionQuery("2026-06-08", "2026-06-21");
    expect(q.resource).toBe("geographic_view");
    expect(q.fields).toContain("segments.geo_target_region");
    expect(q.fields).not.toContain("geographic_view.country_criterion_id");
    expect(q.conditions).toContain("segments.date BETWEEN '2026-06-08' AND '2026-06-21'");
  });
});

describe("applyPositiveKeywordsQuery", () => {
  it("guards ids digits-only", () => {
    expect(() => applyPositiveKeywordsQuery(["123", "4x"])).toThrow();
  });

  it("selects non-negative keyword criteria", () => {
    const q = applyPositiveKeywordsQuery(["12345", "67890"]);
    expect(q.resource).toBe("ad_group_criterion");
    expect(q.conditions).toContain("ad_group.id IN (12345,67890)");
    expect(q.conditions).toContain("ad_group_criterion.negative = FALSE");
    expect(q.conditions).toContain("ad_group_criterion.type = KEYWORD");
    expect(q.conditions).toContain("ad_group_criterion.status != 'REMOVED'");
  });
});

describe("applyBiddingGuardQuery", () => {
  it("guards ids digits-only", () => {
    expect(() => applyBiddingGuardQuery(["123", "4x"])).toThrow();
  });

  it("selects bid strategy, target values, conversions, and average CPC over a fixed 30-day window", () => {
    const q = applyBiddingGuardQuery(["12345", "67890"]);
    expect(q.resource).toBe("campaign");
    expect(q.fields).toEqual([
      "campaign.id",
      "campaign.bidding_strategy_type",
      "campaign.target_cpa.target_cpa_micros",
      "campaign.target_roas.target_roas",
      "campaign.target_spend.cpc_bid_ceiling_micros",
      "metrics.conversions",
      "metrics.average_cpc",
    ]);
    expect(q.conditions).toContain("campaign.id IN (12345,67890)");
    expect(q.conditions).toContain("segments.date DURING LAST_30_DAYS");
  });
});

describe("every report query's SELECT covers its own WHERE + ORDER BY fields (#43)", () => {
  const reportQueries: Record<string, (start: string, end: string) => ReturnType<typeof campaignTotalsQuery>> = {
    campaignTotalsQuery,
    campaignDailyQuery,
    adGroupQuery,
    adQuery,
    keywordQuery,
    searchTermQuery,
    geoQuery,
    geoRegionQuery,
  };

  for (const [name, build] of Object.entries(reportQueries)) {
    it(`${name}: fields ⊇ {campaign.status, segments.date, ...orderings}`, () => {
      const q = build("2026-06-08", "2026-06-21");
      expect(q.fields).toContain("campaign.status");
      expect(q.fields).toContain("segments.date");
      for (const field of q.orderings ?? []) {
        expect(q.fields).toContain(field);
      }
    });
  }
});
