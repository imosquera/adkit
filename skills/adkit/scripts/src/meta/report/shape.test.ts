/** Unit tests for the pure Meta report shaper. */
import { describe, expect, it } from "vitest";

import { CampaignSchema, InsightsRowSchema, type InsightsRow } from "../graph.js";
import { MetaAdAccountIdSchema } from "../ids.js";
import { metaMetricDict, resultCount, shapeMetaReport, type MetaReportRows } from "./shape.js";

const row = (fields: Record<string, unknown>): InsightsRow =>
  InsightsRowSchema.parse({ date_start: "2026-09-01", date_stop: "2026-09-07", ...fields });

const base = {
  spend: "100.50",
  impressions: "10000",
  reach: "4000",
  frequency: "2.5",
  clicks: "250",
  inline_link_clicks: "180",
  ctr: "2.5",
  cpm: "10.05",
  cpc: "0.402",
  actions: [
    { action_type: "lead", value: "4" },
    { action_type: "link_click", value: "180" },
    { action_type: "lead", value: "1" },
  ],
};

const emptyRows: MetaReportRows = {
  campaigns: [],
  campaignTotals: [],
  campaignDaily: [],
  adSets: [],
  ads: [],
  placements: [],
  demographics: [],
  countries: [],
  regions: [],
};

const meta = {
  adAccountId: MetaAdAccountIdSchema.parse("123"),
  currency: "USD",
  attribution: ["7d_click", "1d_view"] as const,
  resultAction: "lead",
  window: { start: "2026-09-01", end: "2026-09-07", days: 7, partial_day: "2026-09-08" },
  generatedAt: "2026-09-08T10:00:00Z",
};

describe("resultCount", () => {
  it("sums every action value matching the result action", () => {
    expect(resultCount(row(base), "lead")).toBe(5);
    expect(resultCount(row(base), "complete_registration")).toBe(0);
    expect(resultCount(row({ spend: "1", impressions: "1" }), "lead")).toBe(0);
  });
});

describe("metaMetricDict", () => {
  it("maps coerced insights numbers to the metric block", () => {
    expect(metaMetricDict(row(base), "lead")).toEqual({
      cost: 100.5,
      impressions: 10000,
      clicks: 250,
      ctr: 0.025,
      avg_cpc: 0.402,
      conversions: 5,
      cost_per_conversion: 20.1,
      reach: 4000,
      frequency: 2.5,
      cpm: 10.05,
      link_clicks: 180,
    });
  });

  it("truncates counts and derives omitted rates without dividing by zero", () => {
    const m = metaMetricDict(row({ spend: "12", impressions: "400.9", reach: "100" }), "lead");
    expect(m).toMatchObject({ impressions: 400, clicks: 0, ctr: 0, avg_cpc: 0, conversions: 0, cost_per_conversion: 0 });
    expect(m.frequency).toBe(4);
    expect(m.cpm).toBe(30);
    expect(metaMetricDict(row({ spend: "0", impressions: "0" }), "lead")).toMatchObject({ frequency: 0, cpm: 0 });
  });
});

describe("shapeMetaReport", () => {
  const rows: MetaReportRows = {
    campaigns: [
      CampaignSchema.parse({ id: "11", name: "Leads", objective: "OUTCOME_LEADS", effective_status: "ACTIVE" }),
      CampaignSchema.parse({ id: "12", name: "Idle", objective: "OUTCOME_LEADS", effective_status: "ACTIVE" }),
    ],
    campaignTotals: [
      row({ ...base, campaign_id: "11", campaign_name: "Leads" }),
      row({ spend: "5", impressions: "50", campaign_id: "13", campaign_name: "Unlisted" }),
    ],
    campaignDaily: [
      row({ ...base, campaign_id: "11", date_start: "2026-09-02", date_stop: "2026-09-02" }),
      row({ ...base }),
    ],
    adSets: [row({ ...base, campaign_id: "11", adset_id: "21", adset_name: "Broad" })],
    ads: [
      row({ ...base, campaign_id: "11", adset_id: "21", ad_id: "31", ad_name: "Video A" }),
      row({ ...base, campaign_id: "11", adset_id: "21", ad_id: "32", ad_name: "" }),
    ],
    placements: [
      row({ spend: "10", impressions: "100", publisher_platform: "instagram", platform_position: "reels" }),
      row({ spend: "90", impressions: "900", publisher_platform: "facebook", platform_position: "feed" }),
    ],
    demographics: [row({ spend: "20", impressions: "200", age: "25-34", gender: "female" })],
    countries: [
      row({ spend: "30", impressions: "300", country: "CA" }),
      row({ spend: "70", impressions: "700", country: "US" }),
    ],
    regions: [row({ spend: "15", impressions: "150", region: "California" }), row({ spend: "1", impressions: "1" })],
  };
  const report = shapeMetaReport(rows, meta);

  it("writes the Meta header fields", () => {
    expect(report).toMatchObject({
      platform: "meta",
      customer_id: "act_123",
      manager_id: null,
      currency: "USD",
      attribution: ["7d_click", "1d_view"],
      result_action: "lead",
      window: meta.window,
      generated_at: meta.generatedAt,
      keywords: [],
      search_terms: [],
      recommendations: [],
    });
  });

  it("lists every campaign, zero-filling ones without delivery and appending unlisted insights rows", () => {
    expect(report.campaigns.map((c) => [c.id, c.name, c.status, c.cost, c.conversions])).toEqual([
      ["11", "Leads", "ACTIVE", 100.5, 5],
      ["12", "Idle", "ACTIVE", 0, 0],
      ["13", "Unlisted", "UNKNOWN", 5, 0],
    ]);
  });

  it("maps daily rows by date, naming from the campaigns read and dropping rows without a campaign id", () => {
    expect(report.campaign_daily).toHaveLength(1);
    expect(report.campaign_daily[0]).toMatchObject({ id: "11", name: "Leads", date: "2026-09-02", frequency: 2.5 });
  });

  it("maps ad sets to ad_groups and ads with Meta placeholders and delivery metrics", () => {
    expect(report.ad_groups).toEqual([
      { campaign_id: "11", id: "21", name: "Broad", ...metaMetricDict(rows.adSets[0]!, "lead") },
    ]);
    expect(report.ads.map((a) => [a.id, a.ad_group_id, a.name, a.type, a.ad_strength, a.frequency, a.reach])).toEqual([
      ["31", "21", "Video A", "META_AD", "UNSPECIFIED", 2.5, 4000],
      ["32", "21", "Ad 32", "META_AD", "UNSPECIFIED", 2.5, 4000],
    ]);
  });

  it("maps countries to geo (ISO code in country_criterion_id) and regions to geo_regions, cost-descending", () => {
    expect(report.geo.map((g) => [g.country_criterion_id, g.country, g.cost])).toEqual([
      ["US", "US", 70],
      ["CA", "CA", 30],
    ]);
    expect(report.geo_regions.map((g) => [g.region, g.cost])).toEqual([
      ["California", 15],
      ["(unknown)", 1],
    ]);
  });

  it("shapes placements and demographics", () => {
    expect(report.placements.map((p) => [p.publisher_platform, p.platform_position, p.cost])).toEqual([
      ["facebook", "feed", 90],
      ["instagram", "reels", 10],
    ]);
    expect(report.demographics[0]).toMatchObject({ age: "25-34", gender: "female", cost: 20, cpm: 100 });
  });

  it("handles an account with no rows", () => {
    expect(shapeMetaReport(emptyRows, meta)).toMatchObject({
      campaigns: [],
      campaign_daily: [],
      ad_groups: [],
      ads: [],
      geo: [],
      geo_regions: [],
      placements: [],
      demographics: [],
    });
  });

  it("does not mutate its input", () => {
    const before = JSON.stringify(rows);
    shapeMetaReport(rows, meta);
    expect(JSON.stringify(rows)).toBe(before);
  });
});
