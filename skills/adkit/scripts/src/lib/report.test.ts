import { describe, expect, it } from "vitest";
import {
  adGroupQuery,
  adQuery,
  campaignDailyQuery,
  campaignTotalsQuery,
  dateWindow,
  keywordQuery,
  metricDict,
  microsToCurrency,
  remediationHint,
  safeRatio,
  searchTermQuery,
} from "./report.js";
import { toGaql } from "../gaql/search-args.js";

describe("dateWindow", () => {
  it("excludes partial today", () => {
    // 14 complete days ending yesterday (2026-06-08..2026-06-21), not today.
    expect(dateWindow(new Date(Date.UTC(2026, 5, 22)), 14)).toEqual(["2026-06-08", "2026-06-21"]);
  });

  it("handles a single day", () => {
    expect(dateWindow(new Date(Date.UTC(2026, 5, 22)), 1)).toEqual(["2026-06-21", "2026-06-21"]);
  });
});

describe("report queries", () => {
  it("all filter enabled and date range", () => {
    const builders = [
      campaignTotalsQuery,
      campaignDailyQuery,
      adGroupQuery,
      adQuery,
      keywordQuery,
      searchTermQuery,
    ];
    for (const build of builders) {
      const q = toGaql(build("2026-06-08", "2026-06-21"));
      expect(q).toContain("campaign.status = 'ENABLED'");
      expect(q).toContain("segments.date BETWEEN '2026-06-08' AND '2026-06-21'");
    }
  });

  it("use correct FROM resources", () => {
    expect(toGaql(campaignTotalsQuery("a", "b"))).toContain("FROM campaign ");
    expect(toGaql(adGroupQuery("a", "b"))).toContain("FROM ad_group ");
    expect(toGaql(adQuery("a", "b"))).toContain("FROM ad_group_ad ");
    expect(toGaql(keywordQuery("a", "b"))).toContain("FROM keyword_view");
    expect(toGaql(searchTermQuery("a", "b"))).toContain("FROM search_term_view");
    // The builders also expose the decomposed resource directly.
    expect(campaignTotalsQuery("a", "b").resource).toBe("campaign");
    expect(searchTermQuery("a", "b").resource).toBe("search_term_view");
  });

  it("ad query selects ad_strength", () => {
    expect(adQuery("2026-06-08", "2026-06-21").fields).toContain("ad_group_ad.ad_strength");
  });

  it("campaign daily is date-segmented and ordered", () => {
    const q = campaignDailyQuery("a", "b");
    expect(q.fields).toContain("segments.date");
    expect(q.orderings).toEqual(["segments.date"]);
    expect(toGaql(q)).toContain("ORDER BY segments.date");
  });

  it("campaign daily carries full metric schema", () => {
    const q = campaignDailyQuery("a", "b");
    for (const field of ["metrics.ctr", "metrics.average_cpc", "metrics.cost_per_conversion"]) {
      expect(q.fields).toContain(field);
    }
  });
});

describe("remediationHint", () => {
  it("routes token errors to render-yaml", () => {
    expect(remediationHint("Request had invalid authentication credentials", "111", "222")).toContain(
      "render-yaml",
    );
    expect(remediationHint("OAuth token expired", "111", "222")).toContain("render-yaml");
  });

  it("routes permission errors to ids", () => {
    const h = remediationHint("User doesn't have permission to access customer", "111", "222");
    expect(h).toContain("111");
    expect(h).toContain("222");
  });

  it("empty for unknown errors", () => {
    expect(remediationHint("some unrelated quota message", "111", "222")).toBe("");
  });
});

describe("microsToCurrency", () => {
  it("converts micros", () => {
    expect(microsToCurrency(1_500_000)).toBe(1.5);
    expect(microsToCurrency(null)).toBe(0.0);
  });
});

describe("safeRatio", () => {
  it("zero denominator", () => {
    expect(safeRatio(5, 0)).toBe(0.0);
    expect(safeRatio(2, 4)).toBe(0.5);
  });
});

describe("metricDict", () => {
  it("zeroed row", () => {
    const d = metricDict({
      costMicros: null,
      impressions: 0,
      clicks: 0,
      ctr: null,
      avgCpcMicros: null,
      conversions: null,
      costPerConvMicros: null,
    });
    expect(d).toEqual({
      cost: 0.0,
      impressions: 0,
      clicks: 0,
      ctr: 0.0,
      avg_cpc: 0.0,
      conversions: 0.0,
      cost_per_conversion: 0.0,
    });
  });

  it("ctr fallback to guarded clicks/impressions", () => {
    const d = metricDict({
      costMicros: 2_000_000,
      impressions: 100,
      clicks: 5,
      ctr: null,
      avgCpcMicros: 400_000,
      conversions: 2.0,
      costPerConvMicros: 1_000_000,
    });
    expect(d.ctr).toBe(0.05);
    expect(d.cost).toBe(2.0);
    expect(d.avg_cpc).toBe(0.4);
    expect(d.cost_per_conversion).toBe(1.0);
  });

  it("uses api ctr when zero", () => {
    const d = metricDict({
      costMicros: 0,
      impressions: 100,
      clicks: 0,
      ctr: 0.0,
      avgCpcMicros: null,
      conversions: null,
      costPerConvMicros: null,
    });
    expect(d.ctr).toBe(0.0);
  });
});
