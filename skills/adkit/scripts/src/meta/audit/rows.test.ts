import { describe, expect, it } from "vitest";

import { AdSchema, AdSetSchema, CampaignSchema, InsightsRowSchema, type InsightsRow } from "../graph.js";
import {
  destinationLinksOf,
  enhancementsOf,
  resultEventsOf,
  toAdWindow,
  toAuditRows,
  toWeekly,
  type MetaAuditRaw,
} from "./rows.js";

const row = (fields: Record<string, unknown>): InsightsRow =>
  InsightsRowSchema.parse({ date_start: "2026-09-01", date_stop: "2026-09-14", spend: "0", impressions: "0", ...fields });

const campaign = CampaignSchema.parse({
  id: "100",
  name: "Leads US",
  objective: "OUTCOME_LEADS",
  effective_status: "ACTIVE",
  advantage_state_info: { advantage_state: "ADVANTAGE_PLUS_SALES" },
});

const adSetLearning = AdSetSchema.parse({
  id: "200",
  name: "Broad",
  campaign_id: "100",
  effective_status: "ACTIVE",
  optimization_goal: "OFFSITE_CONVERSIONS",
  promoted_object: { pixel_id: "999", custom_event_type: "LEAD" },
  targeting: {
    custom_audiences: [{ id: "300" }],
    excluded_custom_audiences: [{ id: "301" }, { id: "302" }],
  },
  learning_stage_info: { status: "LEARNING" },
  campaign: { id: "100", advantage_state_info: { advantage_state: "DISABLED" } },
});

const adSetBare = AdSetSchema.parse({
  id: "201",
  name: "Paused",
  campaign_id: "100",
  effective_status: "PAUSED",
  optimization_goal: "LINK_CLICKS",
  targeting: {},
});

const ad = AdSchema.parse({
  id: "400",
  name: "Ad A",
  adset_id: "200",
  effective_status: "ACTIVE",
  creative: {
    id: "500",
    asset_feed_spec: {
      link_urls: [{ website_url: "https://a.example/" }, { website_url: "https://b.example/" }],
    },
    object_story_spec: { page_id: "600", link_data: { link: "https://a.example/" } },
    degrees_of_freedom_spec: {
      creative_features_spec: {
        enhance_cta: { enroll_status: "OPT_IN" },
        text_optimizations: { enroll_status: "OPT_OUT" },
        weird: { enroll_status: "SOMETHING_ELSE" },
      },
    },
  },
});

const orphanAd = AdSchema.parse({ id: "401", name: "Orphan", adset_id: "999", effective_status: "ACTIVE", creative: { id: "501" } });
const orphanWithCampaign = AdSchema.parse({
  id: "402",
  name: "Orphan with campaign",
  adset_id: "998",
  campaign_id: "100",
  effective_status: "ACTIVE",
  creative: { id: "502" },
});

const baseRaw = (): MetaAuditRaw => ({
  campaigns: [campaign],
  adSets: [adSetLearning, adSetBare],
  ads: [ad, orphanAd, orphanWithCampaign],
  adSetInsights: [
    row({ adset_id: "200", spend: "140", impressions: "1000", actions: [{ action_type: "lead", value: "10" }, { action_type: "link_click", value: "90" }] }),
    row({ adset_id: "200", spend: "60", impressions: "500", actions: [{ action_type: "lead", value: "4" }] }),
  ],
  adInsightsCurrent: [row({ ad_id: "400", spend: "50", impressions: "2000", frequency: "4.2", inline_link_clicks: "20" })],
  adInsightsPrevious: [row({ ad_id: "400", spend: "40", impressions: "1000", frequency: "2", inline_link_click_ctr: "2" })],
  placementBreakdown: [
    row({ publisher_platform: "facebook", platform_position: "feed", spend: "150", actions: [{ action_type: "lead", value: "14" }] }),
    row({ publisher_platform: "audience_network", platform_position: "classic", spend: "50" }),
  ],
  demographicBreakdown: [
    row({ age: "25-34", gender: "female", spend: "100", actions: [{ action_type: "lead", value: "10" }] }),
    row({ age: "25-34", gender: "female", spend: "20", actions: [{ action_type: "lead", value: "2" }] }),
    row({ age: "65+", gender: "male", spend: "80", actions: [{ action_type: "lead", value: "2" }] }),
  ],
  windowDays: 14,
  resultAction: "lead",
});

describe("helpers", () => {
  it("counts only matching actions and scales to a week", () => {
    const r = row({ actions: [{ action_type: "lead", value: "3" }, { action_type: "purchase", value: "5" }] });
    expect(resultEventsOf(r, "lead")).toBe(3);
    expect(resultEventsOf(row({}), "lead")).toBe(0);
    expect(toWeekly(20, 14)).toBe(10);
    expect(toWeekly(20, 0)).toBe(0);
  });

  it("collapses an empty window to zeros", () => {
    expect(toAdWindow([])).toEqual({ spend: 0, impressions: 0, frequency: 0, linkCtr: 0 });
  });

  it("derives frequency from reach and CTR from link clicks across rows", () => {
    const w = toAdWindow([
      row({ spend: "10", impressions: "300", reach: "100", inline_link_clicks: "3" }),
      row({ spend: "5", impressions: "100", reach: "100", inline_link_clicks: "1" }),
    ]);
    expect(w).toEqual({ spend: 15, impressions: 400, frequency: 2, linkCtr: 1 });
  });

  it("collects unique destination links and flattens known enhancement statuses", () => {
    expect(destinationLinksOf(ad.creative)).toEqual(["https://a.example/", "https://b.example/"]);
    expect(enhancementsOf(ad.creative)).toEqual([
      { feature: "enhance_cta", enrollStatus: "OPT_IN" },
      { feature: "text_optimizations", enrollStatus: "OPT_OUT" },
    ]);
    expect(destinationLinksOf(orphanAd.creative)).toEqual([]);
    expect(enhancementsOf(orphanAd.creative)).toEqual([]);
  });
});

describe("toAuditRows", () => {
  const input = toAuditRows(baseRaw());

  it("maps campaigns", () => {
    expect(input.campaigns).toEqual([
      { id: "100", name: "Leads US", status: "ACTIVE", objective: "OUTCOME_LEADS", advantageState: "ADVANTAGE_PLUS_SALES" },
    ]);
  });

  it("builds ad set rows with learning, volume, targeting and signal fields", () => {
    const [learning, bare] = input.adSets;
    expect(learning).toEqual({
      id: "200",
      name: "Broad",
      campaignId: "100",
      status: "ACTIVE",
      active: true,
      learningStatus: "LEARNING",
      spend: 200,
      resultEvents: 14,
      weeklyResultEvents: 7,
      optimizationGoal: "OFFSITE_CONVERSIONS",
      pixelId: "999",
      customEventType: "LEAD",
      includedAudienceIds: ["300"],
      excludedAudienceIds: ["301", "302"],
      advantageState: "DISABLED",
    });
    expect(bare).toMatchObject({
      active: false,
      learningStatus: "UNAVAILABLE",
      spend: 0,
      weeklyResultEvents: 0,
      pixelId: null,
      customEventType: null,
      includedAudienceIds: [],
      excludedAudienceIds: [],
      advantageState: "ADVANTAGE_PLUS_SALES",
    });
  });

  it("builds ad rows with both windows, links and enhancements; drops ungroupable ads", () => {
    expect(input.ads.map((a) => a.id)).toEqual(["400", "402"]);
    const [first, second] = input.ads;
    expect(first).toMatchObject({
      adSetId: "200",
      campaignId: "100",
      current: { spend: 50, impressions: 2000, frequency: 4.2, linkCtr: 1 },
      previous: { spend: 40, impressions: 1000, frequency: 2, linkCtr: 2 },
      destinationLinks: ["https://a.example/", "https://b.example/"],
      enhancements: [
        { feature: "enhance_cta", enrollStatus: "OPT_IN" },
        { feature: "text_optimizations", enrollStatus: "OPT_OUT" },
      ],
    });
    expect(second).toMatchObject({ campaignId: "100", previous: null, current: { spend: 0, linkCtr: 0 } });
  });

  it("aggregates breakdown segments with spend share and cost per result", () => {
    expect(input.breakdowns).toEqual([
      { dimension: "placement", segment: "facebook / feed", spend: 150, results: 14, spendShare: 0.75, costPerResult: 150 / 14 },
      { dimension: "placement", segment: "audience_network / classic", spend: 50, results: 0, spendShare: 0.25, costPerResult: null },
      { dimension: "demographic", segment: "25-34 / female", spend: 120, results: 12, spendShare: 0.6, costPerResult: 10 },
      { dimension: "demographic", segment: "65+ / male", spend: 80, results: 2, spendShare: 0.4, costPerResult: 40 },
    ]);
  });

  it("computes account totals from ad set insights", () => {
    expect(input.account).toEqual({ spend: 200, results: 14, weeklyResultEvents: 7, costPerResult: 200 / 14 });
  });

  it("handles an empty account", () => {
    const empty = toAuditRows({
      ...baseRaw(),
      campaigns: [],
      adSets: [],
      ads: [],
      adSetInsights: [],
      adInsightsCurrent: [],
      adInsightsPrevious: [],
      placementBreakdown: [],
      demographicBreakdown: [],
    });
    expect(empty.account).toEqual({ spend: 0, results: 0, weeklyResultEvents: 0, costPerResult: null });
    expect(empty.breakdowns).toEqual([]);
  });

  it("does not mutate its input", () => {
    const raw = baseRaw();
    const snapshot = JSON.stringify(raw);
    toAuditRows(raw);
    expect(JSON.stringify(raw)).toBe(snapshot);
  });
});
