import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { MetaAdIdSchema, MetaAdSetIdSchema, MetaCampaignIdSchema, MetaCustomAudienceIdSchema, MetaPixelIdSchema } from "../ids.js";
import type { AuditAd, AuditAdSet, AuditBreakdownRow, AuditCampaign, AuditInput } from "./rows.js";
import {
  PLAYBOOK,
  advantageCreativeEnhancementsOn,
  bySeverity,
  creativeFatigue,
  fragmentedBudget,
  learningLimited,
  missingCustomerExclusion,
  scoreMetaAccount,
  stillLearningLowVolume,
  wastedBreakdownSpend,
  weakConversionSignal,
  type MetaFinding,
} from "./scoring.js";

const campaign = (fields: Partial<AuditCampaign> = {}): AuditCampaign => ({
  id: MetaCampaignIdSchema.parse("100"),
  name: "Leads US",
  status: "ACTIVE",
  objective: "OUTCOME_LEADS",
  advantageState: null,
  ...fields,
});

const adSet = (id: string, fields: Partial<AuditAdSet> = {}): AuditAdSet => ({
  id: MetaAdSetIdSchema.parse(id),
  name: `Ad set ${id}`,
  campaignId: MetaCampaignIdSchema.parse("100"),
  status: "ACTIVE",
  active: true,
  learningStatus: "SUCCESS",
  spend: 500,
  resultEvents: 140,
  weeklyResultEvents: 70,
  optimizationGoal: "OFFSITE_CONVERSIONS",
  pixelId: MetaPixelIdSchema.parse("999"),
  customEventType: "LEAD",
  includedAudienceIds: [],
  excludedAudienceIds: [MetaCustomAudienceIdSchema.parse("301")],
  advantageState: null,
  ...fields,
});

const ad = (id: string, fields: Partial<AuditAd> = {}): AuditAd => ({
  id: MetaAdIdSchema.parse(id),
  name: `Ad ${id}`,
  adSetId: MetaAdSetIdSchema.parse("200"),
  campaignId: MetaCampaignIdSchema.parse("100"),
  status: "ACTIVE",
  current: { spend: 50, impressions: 2000, frequency: 2, linkCtr: 1.5 },
  previous: { spend: 40, impressions: 1500, frequency: 1.8, linkCtr: 1.6 },
  destinationLinks: [],
  enhancements: [],
  ...fields,
});

const breakdown = (fields: Partial<AuditBreakdownRow> = {}): AuditBreakdownRow => ({
  dimension: "placement",
  segment: "facebook / feed",
  spend: 100,
  results: 10,
  spendShare: 0.5,
  costPerResult: 10,
  ...fields,
});

const input = (fields: Partial<AuditInput> = {}): AuditInput => ({
  windowDays: 14,
  resultAction: "lead",
  campaigns: [campaign()],
  adSets: [adSet("200")],
  ads: [ad("400")],
  breakdowns: [],
  account: { spend: 1000, results: 200, weeklyResultEvents: 100, costPerResult: 10 },
  ...fields,
});

const issues = (fs: readonly MetaFinding[]): string[] => fs.map((f) => f.issue);

describe("learningLimited", () => {
  it("fires on FAIL", () => {
    const [f, ...rest] = learningLimited(input({ adSets: [adSet("200", { learningStatus: "FAIL", weeklyResultEvents: 12 })] }));
    expect(rest).toEqual([]);
    expect(f).toMatchObject({ level: "adset", entityId: "200", severity: "high", playbook: PLAYBOOK.learningPhase });
    expect(f?.detail).toContain("12 result events/week");
  });

  it("fires nothing for SUCCESS, UNAVAILABLE or paused ad sets", () => {
    expect(
      learningLimited(
        input({
          adSets: [
            adSet("200"),
            adSet("201", { learningStatus: "UNAVAILABLE" }),
            adSet("202", { learningStatus: "FAIL", active: false, status: "PAUSED" }),
          ],
        }),
      ),
    ).toEqual([]);
  });
});

describe("stillLearningLowVolume", () => {
  it("fires on LEARNING under 50 weekly events", () => {
    const fs = stillLearningLowVolume(input({ adSets: [adSet("200", { learningStatus: "LEARNING", weeklyResultEvents: 21.5 })] }));
    expect(fs).toHaveLength(1);
    expect(fs[0]).toMatchObject({ severity: "medium", evidence: { weeklyResultEvents: 21.5 } });
  });

  it("does not fire at 50+ weekly events or when UNAVAILABLE", () => {
    expect(
      stillLearningLowVolume(
        input({
          adSets: [
            adSet("200", { learningStatus: "LEARNING", weeklyResultEvents: 50 }),
            adSet("201", { learningStatus: "UNAVAILABLE", weeklyResultEvents: 3 }),
          ],
        }),
      ),
    ).toEqual([]);
  });
});

describe("fragmentedBudget", () => {
  const low = (id: string, weekly: number) => adSet(id, { weeklyResultEvents: weekly });

  it("fires for 3+ active ad sets with median under 50", () => {
    const fs = fragmentedBudget(input({ adSets: [low("200", 10), low("201", 20), low("202", 90)] }));
    expect(fs).toHaveLength(1);
    expect(fs[0]).toMatchObject({ level: "campaign", entityId: "100", entityName: "Leads US", evidence: { activeAdSets: 3, medianWeeklyResultEvents: 20 } });
  });

  it("does not fire with fewer than 3 active ad sets or a healthy median", () => {
    expect(fragmentedBudget(input({ adSets: [low("200", 10), low("201", 20), adSet("202", { active: false, weeklyResultEvents: 1 })] }))).toEqual([]);
    expect(fragmentedBudget(input({ adSets: [low("200", 60), low("201", 55), low("202", 1)] }))).toEqual([]);
  });
});

describe("creativeFatigue", () => {
  it("fires at frequency 3.5+ with a 25%+ link CTR drop", () => {
    const fs = creativeFatigue(input({ ads: [ad("400", { current: { spend: 50, impressions: 2000, frequency: 4.2, linkCtr: 1 }, previous: { spend: 40, impressions: 1000, frequency: 2, linkCtr: 2 } })] }));
    expect(fs).toHaveLength(1);
    expect(fs[0]).toMatchObject({ level: "ad", severity: "high", evidence: { ctrDropPct: 50, frequency: 4.2 } });
    expect(fs[0]?.detail).toContain("down 50%");
  });

  it("does not fire without a previous window, without spend, or on a small drop", () => {
    const hot = { spend: 50, impressions: 2000, frequency: 4.2, linkCtr: 1 };
    expect(
      creativeFatigue(
        input({
          ads: [
            ad("400", { current: hot, previous: null }),
            ad("401", { current: { ...hot, spend: 0 }, previous: { ...hot, linkCtr: 2 } }),
            ad("402", { current: hot, previous: { ...hot, linkCtr: 1.2 } }),
          ],
        }),
      ),
    ).toEqual([]);
  });
});

describe("wastedBreakdownSpend", () => {
  it("fires on a big segment with zero results or 2x account cost per result", () => {
    const fs = wastedBreakdownSpend(
      input({
        breakdowns: [
          breakdown({ segment: "audience_network / classic", spend: 250, results: 0, spendShare: 0.25, costPerResult: null }),
          breakdown({ dimension: "demographic", segment: "65+ / male", spend: 300, results: 10, spendShare: 0.3, costPerResult: 30 }),
        ],
      }),
    );
    expect(issues(fs)).toEqual(["wasted_breakdown_spend", "wasted_breakdown_spend"]);
    expect(fs[0]?.detail).toContain("0 results");
    expect(fs[1]?.detail).toContain("3x");
    expect(fs[1]).toMatchObject({ level: "account", entityId: "demographic:65+ / male" });
  });

  it("does not fire for small or efficient segments, or with no account baseline", () => {
    expect(
      wastedBreakdownSpend(input({ breakdowns: [breakdown({ spendShare: 0.1, results: 0, costPerResult: null }), breakdown({ costPerResult: 15 })] })),
    ).toEqual([]);
    expect(
      wastedBreakdownSpend(
        input({ account: { spend: 100, results: 0, weeklyResultEvents: 0, costPerResult: null }, breakdowns: [breakdown({ results: 0, costPerResult: null })] }),
      ),
    ).toEqual([]);
  });
});

describe("missingCustomerExclusion", () => {
  it("fires on a prospecting ad set with no exclusions", () => {
    const fs = missingCustomerExclusion(input({ adSets: [adSet("200", { excludedAudienceIds: [] })] }));
    expect(fs).toHaveLength(1);
    expect(fs[0]).toMatchObject({ severity: "medium", playbook: PLAYBOOK.customerExclusions });
  });

  it("does not fire for retargeting, excluded, or Advantage+ ad sets", () => {
    expect(
      missingCustomerExclusion(
        input({
          campaigns: [campaign(), campaign({ id: MetaCampaignIdSchema.parse("101"), advantageState: "ADVANTAGE_PLUS_SALES" })],
          adSets: [
            adSet("200"),
            adSet("201", { excludedAudienceIds: [], includedAudienceIds: [MetaCustomAudienceIdSchema.parse("300")] }),
            adSet("202", { excludedAudienceIds: [], advantageState: "ADVANTAGE_PLUS_LEADS" }),
            adSet("203", { excludedAudienceIds: [], campaignId: MetaCampaignIdSchema.parse("101") }),
          ],
        }),
      ),
    ).toEqual([]);
  });

  it("treats a DISABLED advantage state as not Advantage+", () => {
    expect(missingCustomerExclusion(input({ adSets: [adSet("200", { excludedAudienceIds: [], advantageState: "DISABLED" })] }))).toHaveLength(1);
  });
});

describe("weakConversionSignal", () => {
  it("fires per ad set without a pixel and once account-wide under 50 weekly events", () => {
    const fs = weakConversionSignal(
      input({
        adSets: [adSet("200", { pixelId: null })],
        account: { spend: 1000, results: 40, weeklyResultEvents: 20, costPerResult: 25 },
      }),
    );
    expect(fs.map((f) => f.level)).toEqual(["adset", "account"]);
    expect(fs[1]?.detail).toContain("20 lead events/week");
  });

  it("does not fire with a pixel and enough volume, or without conversion goals", () => {
    expect(weakConversionSignal(input())).toEqual([]);
    expect(
      weakConversionSignal(
        input({
          adSets: [adSet("200", { optimizationGoal: "LINK_CLICKS", pixelId: null })],
          account: { spend: 10, results: 0, weeklyResultEvents: 0, costPerResult: null },
        }),
      ),
    ).toEqual([]);
  });
});

describe("advantageCreativeEnhancementsOn", () => {
  it("fires when a rewriting enhancement is opted in", () => {
    const fs = advantageCreativeEnhancementsOn(
      input({ ads: [ad("400", { enhancements: [{ feature: "text_optimizations", enrollStatus: "OPT_IN" }, { feature: "enhance_cta", enrollStatus: "OPT_OUT" }] })] }),
    );
    expect(fs).toHaveLength(1);
    expect(fs[0]).toMatchObject({ severity: "low", evidence: { optedIn: "text_optimizations", count: 1 } });
  });

  it("does not fire for opt-outs or the safe image_touchups", () => {
    expect(
      advantageCreativeEnhancementsOn(
        input({ ads: [ad("400", { enhancements: [{ feature: "image_touchups", enrollStatus: "OPT_IN" }, { feature: "music", enrollStatus: "OPT_OUT" }] })] }),
      ),
    ).toEqual([]);
  });
});

describe("scoreMetaAccount", () => {
  it("groups findings by campaign, high → low, with account findings apart", () => {
    const second = campaign({ id: MetaCampaignIdSchema.parse("101"), name: "Clean" });
    const score = scoreMetaAccount(
      input({
        campaigns: [campaign(), second],
        adSets: [adSet("200", { excludedAudienceIds: [], learningStatus: "FAIL" })],
        ads: [ad("400", { enhancements: [{ feature: "add_text_overlay", enrollStatus: "OPT_IN" }] })],
        breakdowns: [breakdown({ results: 0, costPerResult: null, spendShare: 0.4 })],
      }),
    );
    expect(issues(score.campaigns["100"] ?? [])).toEqual([
      "learning_limited",
      "missing_customer_exclusion",
      "advantage_creative_enhancements_on",
    ]);
    expect(score.campaigns["101"]).toEqual([]);
    expect(issues(score.account)).toEqual(["wasted_breakdown_spend"]);
  });

  it("returns empty groups for a healthy account", () => {
    expect(scoreMetaAccount(input())).toEqual({ campaigns: { "100": [] }, account: [] });
  });

  it("sorts by severity stably", () => {
    const f = (issue: MetaFinding["issue"], severity: MetaFinding["severity"]): MetaFinding => ({
      level: "ad", entityId: "1", entityName: "a", issue, severity, detail: "", evidence: {}, fix: "", playbook: "",
    });
    expect(issues(bySeverity([f("advantage_creative_enhancements_on", "low"), f("fragmented_budget", "medium"), f("creative_fatigue", "high"), f("still_learning_low_volume", "medium")]))).toEqual([
      "creative_fatigue",
      "fragmented_budget",
      "still_learning_low_volume",
      "advantage_creative_enhancements_on",
    ]);
  });
});

describe("playbook links", () => {
  /** GitHub-style heading anchor. */
  const slug = (heading: string): string =>
    heading
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s/g, "-");

  it.each(Object.values(PLAYBOOK))("%s resolves to a real heading", (link) => {
    const [file, anchor] = link.split("#");
    const path = fileURLToPath(new URL(`../../../../${file ?? ""}`, import.meta.url));
    const anchors = readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => /^#{1,6}\s/.test(l))
      .map((l) => slug(l.replace(/^#+/, "")));
    expect(anchors).toContain(anchor);
  });
});
