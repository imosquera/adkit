/** Unit tests for the Meta update plan: parsing, skip splitting, validation, warnings. */
import { describe, expect, it } from "vitest";

import { AdSchema, AdSetSchema, CampaignSchema, type AdSet, type Campaign } from "./graph.js";
import {
  metaWarnings,
  parseMetaPlan,
  splitChanges,
  splitMetaPlan,
  validateMetaPlan,
  type MetaLiveAd,
  type MetaLiveState,
  type MetaPlan,
} from "./plan.js";

// ---------- Fixtures ----------

const campaign = (over: Record<string, unknown> = {}): Campaign =>
  CampaignSchema.parse({ id: "100", name: "C", objective: "OUTCOME_SALES", effective_status: "ACTIVE", status: "ACTIVE", ...over });

const adSet = (over: Record<string, unknown> = {}): AdSet =>
  AdSetSchema.parse({
    id: "200",
    name: "S",
    campaign_id: "100",
    effective_status: "ACTIVE",
    status: "ACTIVE",
    optimization_goal: "OFFSITE_CONVERSIONS",
    daily_budget: "5000",
    targeting: { excluded_custom_audiences: [{ id: "900" }] },
    ...over,
  });

const ad = (over: Record<string, unknown> = {}): MetaLiveAd =>
  AdSchema.parse({
    id: "300",
    name: "A",
    adset_id: "200",
    effective_status: "PAUSED",
    status: "PAUSED",
    creative: {
      id: "400",
      asset_feed_spec: { bodies: [{ text: "b1" }, { text: "b2" }], titles: [{ text: "t1" }] },
      degrees_of_freedom_spec: { creative_features_spec: { enhance_cta: { enroll_status: "OPT_OUT" } } },
    },
    ...over,
  });

const liveOf = (p: { campaigns?: Campaign[]; adSets?: AdSet[]; ads?: MetaLiveAd[] }): MetaLiveState => ({
  campaigns: new Map((p.campaigns ?? []).map((c) => [c.id, c])),
  adSets: new Map((p.adSets ?? []).map((s) => [s.id, s])),
  ads: new Map((p.ads ?? []).map((a) => [a.id, a])),
  currency: "USD",
});

const plan = (raw: Record<string, unknown>): MetaPlan => {
  const r = parseMetaPlan({ platform: "meta", ...raw });
  if (r.kind !== "ok") throw new Error(r.message);
  return r.value;
};

// ---------- parseMetaPlan ----------

describe("parseMetaPlan", () => {
  it("parses every section, defaults missing sections to [] and canonicalises the account id", () => {
    const p = plan({
      adAccountId: "123",
      budgets: [{ level: "campaign", id: 100, dailyBudget: 80 }],
      status: [{ level: "ad", id: "300", status: "ACTIVE" }],
      exclusions: [{ adSetId: "200", add: ["901"] }],
      enhancements: [{ adId: "300", features: { enhance_cta: "OPT_IN" } }],
      textPools: [{ adId: "300", headlines: ["h"] }],
    });
    expect(p.adAccountId).toBe("act_123");
    expect(p.budgets[0]).toEqual({ level: "campaign", id: "100", dailyBudget: 80 });
    expect(p.exclusions[0]).toEqual({ adSetId: "200", add: ["901"], remove: [] });
    expect(parseMetaPlan({ platform: "meta" })).toEqual({
      kind: "ok",
      value: { platform: "meta", budgets: [], status: [], exclusions: [], enhancements: [], textPools: [] },
    });
  });

  it("rejects unknown keys, wrong platform, bad levels, unknown features and over-long texts", () => {
    const cases: unknown[] = [
      { platform: "google" },
      { platform: "meta", bogus: [] },
      { platform: "meta", budgets: [{ level: "ad", id: "1", dailyBudget: 5 }] },
      { platform: "meta", budgets: [{ level: "campaign", id: "1", dailyBudget: 0 }] },
      { platform: "meta", status: [{ level: "campaign", id: "1", status: "ENABLED" }] },
      { platform: "meta", enhancements: [{ adId: "1", features: { nope: "OPT_IN" } }] },
      { platform: "meta", enhancements: [{ adId: "1", features: {} }] },
      { platform: "meta", textPools: [{ adId: "1", headlines: ["x".repeat(256)] }] },
      { platform: "meta", textPools: [{ adId: "1" }] },
      { platform: "meta", exclusions: [{ adSetId: "1" }] },
      { platform: "meta", exclusions: [{ adSetId: "1", add: ["5"], remove: ["5"] }] },
      { platform: "meta", adAccountId: "abc" },
    ];
    cases.forEach((c) => expect(parseMetaPlan(c).kind, JSON.stringify(c)).toBe("err"));
  });

  it("reports empty exclusions and enhancements entries by message", () => {
    expect(parseMetaPlan({ platform: "meta", exclusions: [{ adSetId: "1" }] })).toEqual({
      kind: "err",
      message: "exclusions.0: exclusions entry needs add or remove",
    });
    expect(parseMetaPlan({ platform: "meta", enhancements: [{ adId: "1", features: {} }] })).toEqual({
      kind: "err",
      message: "enhancements.0: enhancements entry needs at least one feature",
    });
  });

  it("rejects duplicate entries for the same entity, reporting the path", () => {
    const r = parseMetaPlan({
      platform: "meta",
      status: [
        { level: "ad", id: "1", status: "ACTIVE" },
        { level: "adset", id: "1", status: "ACTIVE" },
        { level: "ad", id: "1", status: "PAUSED" },
      ],
    });
    expect(r).toEqual({ kind: "err", message: "status.2: duplicate status entry for ad:1" });
  });
});

// ---------- splitting ----------

describe("splitChanges", () => {
  it("skips satisfied entries, keeps missing and differing ones, preserving order", () => {
    const live = new Map([
      ["a", 1],
      ["b", 2],
    ]);
    const entries = [
      { k: "a", v: 1 },
      { k: "b", v: 3 },
      { k: "z", v: 1 },
    ];
    const r = splitChanges(entries, live, (e) => e.k, (e, l) => e.v === l);
    expect(r.skips).toEqual([{ k: "a", v: 1 }]);
    expect(r.changes).toEqual([
      { k: "b", v: 3 },
      { k: "z", v: 1 },
    ]);
  });
});

describe("splitMetaPlan", () => {
  const live = liveOf({ campaigns: [campaign({ daily_budget: "8000" })], adSets: [adSet()], ads: [ad()] });

  it("skips entries live state already satisfies", () => {
    const p = plan({
      budgets: [
        { level: "campaign", id: "100", dailyBudget: 80 },
        { level: "adset", id: "200", dailyBudget: 50 },
      ],
      status: [
        { level: "campaign", id: "100", status: "ACTIVE" },
        { level: "ad", id: "300", status: "PAUSED" },
      ],
      exclusions: [{ adSetId: "200", add: ["900"], remove: ["901"] }],
      enhancements: [{ adId: "300", features: { enhance_cta: "OPT_OUT" } }],
      textPools: [{ adId: "300", primaryTexts: ["b1", "b2"], headlines: ["t1"], descriptions: [] }],
    });
    const s = splitMetaPlan(p, live);
    expect(s.changes).toEqual({ budgets: [], status: [], exclusions: [], enhancements: [], textPools: [] });
    expect(s.skips.budgets).toHaveLength(2);
    expect(s.skips.textPools).toHaveLength(1);
  });

  it("keeps entries that would change live state", () => {
    const p = plan({
      budgets: [{ level: "adset", id: "200", dailyBudget: 50.01 }],
      status: [{ level: "adset", id: "200", status: "PAUSED" }],
      exclusions: [{ adSetId: "200", remove: ["900"] }],
      enhancements: [{ adId: "300", features: { enhance_cta: "OPT_OUT", text_optimizations: "OPT_OUT" } }],
      textPools: [{ adId: "300", primaryTexts: ["b2", "b1"] }],
    });
    const s = splitMetaPlan(p, live);
    expect(s.changes.budgets).toHaveLength(1);
    expect(s.changes.status).toHaveLength(1);
    expect(s.changes.exclusions).toHaveLength(1);
    expect(s.changes.enhancements).toHaveLength(1);
    expect(s.changes.textPools).toHaveLength(1);
  });

  it("uses the account currency's minor units", () => {
    const jpy = { ...liveOf({ adSets: [adSet({ daily_budget: "5000" })] }), currency: "JPY" };
    const s = splitMetaPlan(plan({ budgets: [{ level: "adset", id: "200", dailyBudget: 5000 }] }), jpy);
    expect(s.skips.budgets).toHaveLength(1);
  });
});

// ---------- validateMetaPlan ----------

describe("validateMetaPlan", () => {
  it("reports unknown ids in every section", () => {
    const p = plan({
      budgets: [{ level: "campaign", id: "1", dailyBudget: 5 }],
      status: [{ level: "ad", id: "2", status: "ACTIVE" }],
      exclusions: [{ adSetId: "3", add: ["9"] }],
      enhancements: [{ adId: "4", features: { enhance_cta: "OPT_IN" } }],
      textPools: [{ adId: "5", headlines: ["h"] }],
    });
    expect(validateMetaPlan(p, liveOf({}))).toEqual([
      "budgets: campaign 1 not found in ad account",
      "status: ad 2 not found in ad account",
      "exclusions: ad set 3 not found in ad account",
      "enhancements: ad 4 not found in ad account",
      "textPools: ad 5 not found in ad account",
    ]);
  });

  it("rejects raises above 50% and allows exactly 50% and decreases", () => {
    const live = liveOf({ adSets: [adSet({ daily_budget: "5000" })] });
    const at = (dailyBudget: number) => validateMetaPlan(plan({ budgets: [{ level: "adset", id: "200", dailyBudget }] }), live);
    expect(at(75)).toEqual([]);
    expect(at(10)).toEqual([]);
    expect(at(75.01)).toEqual(["budgets: ad set 200: dailyBudget 75.01 USD exceeds guardrail (5000 +50% = 7500 minor units)"]);
  });

  it("rejects budget level vs CBO/ABO and lifetime mismatches", () => {
    const live = liveOf({
      campaigns: [campaign(), campaign({ id: "101", lifetime_budget: "100000" })],
      adSets: [adSet({ daily_budget: undefined })],
    });
    const p = plan({
      budgets: [
        { level: "campaign", id: "100", dailyBudget: 5 },
        { level: "campaign", id: "101", dailyBudget: 5 },
        { level: "adset", id: "200", dailyBudget: 5 },
      ],
    });
    expect(validateMetaPlan(p, live)).toEqual([
      "budgets: campaign 100: campaign uses ad set budgets (ABO); set the budget with level: adset",
      "budgets: campaign 101: uses a lifetime budget; dailyBudget cannot be set",
      "budgets: ad set 200: campaign uses a campaign budget (CBO); set the budget with level: campaign",
    ]);
  });
});

// ---------- metaWarnings ----------

describe("metaWarnings", () => {
  it("flags enables and budget increases", () => {
    const live = liveOf({ campaigns: [campaign({ daily_budget: "10000" })], adSets: [adSet()], ads: [ad()] });
    const w = metaWarnings(
      plan({
        status: [
          { level: "ad", id: "300", status: "ACTIVE" },
          { level: "adset", id: "200", status: "PAUSED" },
        ],
        budgets: [
          { level: "campaign", id: "100", dailyBudget: 110 },
          { level: "adset", id: "200", dailyBudget: 40 },
        ],
      }),
      live,
    );
    expect(w.enableStartsLiveSpend).toEqual(["300"]);
    expect(w.budgetIncreases).toEqual(["100"]);
    expect(w.learningResetRisk).toEqual([]);
    expect(w.exclusionIgnored).toEqual([]);
    expect(w.lines).toEqual([
      "enabling ad 300 starts live spend",
      "raising daily budget of campaign 100 to 110 USD increases spend",
    ]);
  });

  it("flags learning-reset risk for >20% budget changes, exclusions and creative swaps on LEARNING ad sets", () => {
    const learning = { learning_stage_info: { status: "LEARNING" } };
    const live = liveOf({
      campaigns: [campaign({ daily_budget: "10000" })],
      adSets: [adSet(learning), adSet({ id: "201", ...learning }), adSet({ id: "202" })],
      ads: [ad(), ad({ id: "301", adset_id: "202" })],
    });
    const small = metaWarnings(plan({ budgets: [{ level: "adset", id: "200", dailyBudget: 60 }] }), live);
    expect(small.learningResetRisk).toEqual([]);

    const w = metaWarnings(
      plan({
        budgets: [{ level: "campaign", id: "100", dailyBudget: 70 }],
        exclusions: [{ adSetId: "201", add: ["1"] }],
        textPools: [
          { adId: "300", headlines: ["h"] },
          { adId: "301", headlines: ["h"] },
        ],
      }),
      live,
    );
    expect(w.learningResetRisk).toEqual(["200", "201"]);
    expect(w.budgetIncreases).toEqual([]);
    expect(w.lines).toHaveLength(4);
  });

  it("flags exclusions on Advantage+ campaigns via the ad set expansion or the campaign read", () => {
    const live = liveOf({
      campaigns: [campaign({ id: "101", advantage_state_info: { advantage_state: "ADVANTAGE_PLUS_SALES" } })],
      adSets: [
        adSet({ campaign: { id: "100", advantage_state_info: { advantage_state: "ADVANTAGE_PLUS_SALES" } } }),
        adSet({ id: "201", campaign_id: "101" }),
        adSet({ id: "202", campaign: { id: "100", advantage_state_info: { advantage_state: "DISABLED" } } }),
        adSet({ id: "203" }),
      ],
    });
    const w = metaWarnings(
      plan({ exclusions: ["200", "201", "202", "203"].map((adSetId) => ({ adSetId, add: ["1"] })) }),
      live,
    );
    expect(w.exclusionIgnored).toEqual(["200", "201"]);
  });
});
