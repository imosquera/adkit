import { describe, expect, it } from "vitest";
import {
  applyPositiveKeywordsQuery,
  auditAdGroupAdQuery,
  auditKeywordMetricsQuery,
  auditSearchTermsQuery,
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
      "SELECT campaign.id, search_term_view.search_term, metrics.cost_micros, " +
        "metrics.impressions, metrics.clicks, metrics.conversions " +
        "FROM search_term_view WHERE campaign.id IN (12345,67890) " +
        "AND segments.date DURING LAST_14_DAYS",
    );
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
