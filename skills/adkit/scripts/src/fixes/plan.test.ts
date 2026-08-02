/** Unit tests for the SDK-free validation/coercion in fixes/plan.ts. */
import { describe, expect, it } from "vitest";
import {
  addAdGroupsPlan,
  addRsaCreateEntries,
  addRsaErrors,
  addRsaPlan,
  adGroupStatusPlan,
  adStatusPlan,
  biddingPlan,
  campaignStatusPlan,
  coerceKeyword,
  CONVERSION_GUARD_THRESHOLD,
  negKey,
  newNegatives,
  newPositiveKeywords,
  posKey,
  resolveAddRsaFinalUrl,
  searchPartnersPlan,
  validate,
} from "./plan.js";

function h(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `headline ${i}`);
}

function d(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `description ${i}`);
}

// ---------- rewrites ----------

describe("rewrites", () => {
  it("valid passes", () => {
    const plan = { rewrites: [{ adId: 1, headlines: h(15), descriptions: d(4) }] };
    expect(validate(plan, {}, {})).toEqual([]);
  });

  it("wrong counts flagged", () => {
    const plan = { rewrites: [{ adId: 1, headlines: h(14), descriptions: d(3) }] };
    const errs = validate(plan, {}, {});
    expect(errs.some((e) => e.includes("14 headlines"))).toBe(true);
    expect(errs.some((e) => e.includes("3 descriptions"))).toBe(true);
  });

  it("duplicate and overlength flagged", () => {
    const hs = [...h(14), "headline 0"]; // 15 but one dup
    const ds = [...d(3), "x".repeat(91)]; // 4 but one >90
    const errs = validate({ rewrites: [{ adId: 1, headlines: hs, descriptions: ds }] }, {}, {});
    expect(errs.some((e) => e.includes("duplicate headline"))).toBe(true);
    expect(errs.some((e) => e.includes("description >90"))).toBe(true);
  });

  it("headline over 30 flagged", () => {
    const hs = [...h(14), "x".repeat(31)];
    const errs = validate({ rewrites: [{ adId: 1, headlines: hs, descriptions: d(4) }] }, {}, {});
    expect(errs.some((e) => e.includes("headline >30"))).toBe(true);
  });

  it("finalUrl-only repoint passes (no 15/4 required)", () => {
    const plan = { rewrites: [{ adId: 1, finalUrl: "https://www.example.com/ideas/x" }] };
    expect(validate(plan, {}, {})).toEqual([]);
  });

  it("non-https finalUrl flagged", () => {
    const errs = validate({ rewrites: [{ adId: 1, finalUrl: "http://x.com" }] }, {}, {});
    expect(errs.some((e) => e.includes("finalUrl must be an https"))).toBe(true);
  });

  it("empty rewrite (no copy, no url) flagged", () => {
    const errs = validate({ rewrites: [{ adId: 1 }] }, {}, {});
    expect(errs.some((e) => e.includes("no headlines, descriptions, or finalUrl"))).toBe(true);
  });

  it("copy + finalUrl together passes", () => {
    const plan = { rewrites: [{ adId: 1, headlines: h(15), descriptions: d(4), finalUrl: "https://x.io/p" }] };
    expect(validate(plan, {}, {})).toEqual([]);
  });

  it("headlines-only rewrite flagged (must carry both copy arrays)", () => {
    const errs = validate({ rewrites: [{ adId: 1, headlines: h(15) }] }, {}, {});
    expect(errs.some((e) => e.includes("must replace both headlines and descriptions"))).toBe(true);
  });

  it("descriptions-only rewrite flagged even with a finalUrl", () => {
    const plan = { rewrites: [{ adId: 1, descriptions: d(4), finalUrl: "https://x.io/p" }] };
    const errs = validate(plan, {}, {});
    expect(errs.some((e) => e.includes("must replace both headlines and descriptions"))).toBe(true);
  });

  it("valid display path passes (bug 5a)", () => {
    const plan = { rewrites: [{ adId: 1, headlines: h(15), descriptions: d(4), path1: "demo", path2: "trial" }] };
    expect(validate(plan, {}, {})).toEqual([]);
  });

  it("path2 without path1 flagged", () => {
    const plan = { rewrites: [{ adId: 1, headlines: h(15), descriptions: d(4), path2: "trial" }] };
    const errs = validate(plan, {}, {});
    expect(errs.some((e) => e.includes("path2 requires path1"))).toBe(true);
  });

  it("path with a space or slash flagged", () => {
    const plan = { rewrites: [{ adId: 7, headlines: h(15), descriptions: d(4), path1: "free trial" }] };
    const errs = validate(plan, {}, {});
    expect(errs.some((e) => e.includes("ad 7: path1 may not contain spaces or '/'"))).toBe(true);
  });

  it("path over 15 chars flagged", () => {
    const plan = { rewrites: [{ adId: 1, headlines: h(15), descriptions: d(4), path1: "waytoolongsegment" }] };
    const errs = validate(plan, {}, {});
    expect(errs.some((e) => e.includes("path1 >15"))).toBe(true);
  });

  it("leftover TODO placeholder path flagged", () => {
    const plan = { rewrites: [{ adId: 1, headlines: h(15), descriptions: d(4), path1: "TODO-slug" }] };
    const errs = validate(plan, {}, {});
    expect(errs.some((e) => e.includes("scaffold placeholder"))).toBe(true);
  });
});

// ---------- appendHeadlines ----------

describe("appendHeadlines", () => {
  it("append to 15 passes", () => {
    const plan = { appendHeadlines: [{ adId: 9, add: ["new one"] }] };
    const live = { 9: h(14) };
    expect(validate(plan, live, {})).toEqual([]);
  });

  it("overshoot flagged", () => {
    const plan = { appendHeadlines: [{ adId: 9, add: ["a", "b"] }] }; // 14 + 2 = 16
    const errs = validate(plan, { 9: h(14) }, {});
    expect(errs.some((e) => e.includes("16H"))).toBe(true);
  });

  it("dedups existing then short", () => {
    // adding a headline that already exists doesn't count -> stays at 14 -> flagged
    const plan = { appendHeadlines: [{ adId: 9, add: ["headline 0"] }] };
    const errs = validate(plan, { 9: h(14) }, {});
    expect(errs.some((e) => e.includes("14H"))).toBe(true);
  });
});

// ---------- sitelinks & callouts ----------

describe("sitelinks and callouts", () => {
  it("both-or-neither and lengths", () => {
    const plan = {
      sitelinks: [{ campaignId: 1, add: [{ text: "x".repeat(26), description1: "only one" }] }],
    };
    const errs = validate(plan, {}, {});
    expect(errs.some((e) => e.includes("sitelink text >25"))).toBe(true);
    expect(errs.some((e) => e.includes("both-or-neither"))).toBe(true);
  });

  it("description overlength flagged", () => {
    const plan = {
      sitelinks: [{ campaignId: 1, add: [{ text: "ok", description1: "x".repeat(36), description2: "y" }] }],
    };
    const errs = validate(plan, {}, {});
    expect(errs.some((e) => e.includes("sitelink desc >35"))).toBe(true);
  });

  it("callout overlength flagged", () => {
    const errs = validate({ callouts: [{ campaignId: 1, add: ["x".repeat(26)] }] }, {}, {});
    expect(errs.some((e) => e.includes("callout >25"))).toBe(true);
  });
});

// ---------- coercion ----------

describe("coercion", () => {
  it("bare string defaults phrase", () => {
    const [kw, err] = coerceKeyword("free trial");
    expect(err).toBeNull();
    expect(kw?.text).toBe("free trial");
    expect(kw?.matchType).toBe("PHRASE");
  });

  it("rejects non-string non-object", () => {
    const [kw, err] = coerceKeyword(123);
    expect(kw).toBeNull();
    expect(err).toContain("string or object");
  });

  it("negKey is case-insensitive on text", () => {
    expect(negKey("Free Trial", "PHRASE")).toEqual(["free trial", "PHRASE"]);
  });
});

// ---------- negative keywords ----------

describe("negative keywords", () => {
  it("string and object valid", () => {
    const plan = {
      negatives: [{ campaignId: 1, add: ["free", { text: "talk to ai", matchType: "PHRASE" }] }],
    };
    expect(validate(plan, {}, {})).toEqual([]);
  });

  it("matchType case-insensitive", () => {
    const [kw, err] = coerceKeyword({ text: "roleplay", matchType: "exact" });
    expect(err).toBeNull();
    expect(kw?.matchType).toBe("EXACT");
  });

  it("bad matchType flagged", () => {
    const errs = validate({ negatives: [{ campaignId: 1, add: [{ text: "x", matchType: "FUZZY" }] }] }, {}, {});
    expect(errs.some((e) => e.includes("FUZZY") || e.toLowerCase().includes("matchtype"))).toBe(true);
  });

  it("missing campaign and empty add flagged", () => {
    const errs = validate({ negatives: [{ add: ["free"] }, { campaignId: 2, add: [] }] }, {}, {});
    expect(errs.some((e) => e.includes("missing campaignId"))).toBe(true);
    expect(errs.some((e) => e.includes("empty add list"))).toBe(true);
  });

  it("skips live duplicates", () => {
    const group = { campaignId: 5, add: ["free", { text: "Talk To AI", matchType: "PHRASE" }, "novel"] };
    const live = { 5: new Set([["free", "PHRASE"] as [string, string], ["talk to ai", "PHRASE"] as [string, string]]) };
    const fresh = newNegatives(group, live);
    expect(fresh.map((k) => k.text)).toEqual(["novel"]);
  });

  it("dedups within group", () => {
    // repeats + case variants collapse to one op so the batch has no duplicates
    const group = { campaignId: 5, add: ["free", "free", { text: "Free", matchType: "PHRASE" }, "novel"] };
    const fresh = newNegatives(group, {});
    expect(fresh.map((k) => k.text)).toEqual(["free", "novel"]);
  });

  it("distinct match types kept", () => {
    const group = {
      campaignId: 5,
      add: [
        { text: "free", matchType: "PHRASE" },
        { text: "free", matchType: "EXACT" },
      ],
    };
    const fresh = newNegatives(group, {});
    expect(fresh.map((k) => [k.text, k.matchType])).toEqual([
      ["free", "PHRASE"],
      ["free", "EXACT"],
    ]);
  });

  it("non-numeric campaign does not raise", () => {
    // validation flags it; newNegatives must not crash building the dry-run summary
    expect(newNegatives({ campaignId: "abc", add: ["free"] }, {})).not.toEqual([]);
  });

  it("non-numeric campaign flagged", () => {
    const errs = validate({ negatives: [{ campaignId: "23x", add: ["free"] }] }, {}, {});
    expect(errs.some((e) => e.includes("must be numeric"))).toBe(true);
  });
});

// ---------- budget guardrail ----------

const BUDGETS = { 5: { resource: "r", amountMicros: 30_000_000 } }; // $30/day

describe("budget guardrail", () => {
  it("within 50pct passes", () => {
    const plan = { budgets: [{ campaignId: 5, dailyMicros: 45_000_000 }] }; // exactly +50%
    expect(validate(plan, {}, BUDGETS)).toEqual([]);
  });

  it("over 50pct rejected", () => {
    const plan = { budgets: [{ campaignId: 5, dailyMicros: 46_000_000 }] };
    expect(validate(plan, {}, BUDGETS).some((e) => e.includes("exceeds guardrail"))).toBe(true);
  });

  it("maxRaisePct cannot exceed hard cap", () => {
    // plan asks for 200% headroom; hard cap clamps to 50% -> $60 still rejected vs $45
    const plan = { budgets: [{ campaignId: 5, dailyMicros: 60_000_000, maxRaisePct: 200 }] };
    const errs = validate(plan, {}, BUDGETS);
    expect(errs.some((e) => e.includes("+50%"))).toBe(true);
  });

  it("lowering always allowed", () => {
    const plan = { budgets: [{ campaignId: 5, dailyMicros: 10_000_000 }] };
    expect(validate(plan, {}, BUDGETS)).toEqual([]);
  });

  it("non-positive and missing current flagged", () => {
    const bad = validate({ budgets: [{ campaignId: 5, dailyMicros: 0 }] }, {}, BUDGETS);
    expect(bad.some((e) => e.includes("positive int"))).toBe(true);
    const missing = validate({ budgets: [{ campaignId: 7, dailyMicros: 1_000_000 }] }, {}, BUDGETS);
    expect(missing.some((e) => e.includes("no current budget"))).toBe(true);
  });
});

// ---------- bidding guardrail ----------

const BIDDING_STARVED = { 5: { biddingStrategyType: "MAXIMIZE_CONVERSIONS", conversions30d: 5 } };
const bidding = (conversions30d: number) => ({
  5: { biddingStrategyType: "MAXIMIZE_CONVERSIONS", conversions30d },
});

describe("bidding guardrail", () => {
  it("refuses an unsupported or malformed strategy before ever checking live state", () => {
    const unsupported = validate(
      { bidding: [{ campaignId: 5, strategy: "manual-cpc" }] },
      {},
      {},
      undefined,
      undefined,
      undefined,
      bidding(0),
    );
    expect(unsupported.some((e) => e.includes("strategy must be one of"))).toBe(true);

    const typo = validate(
      { bidding: [{ campaignId: 5, strategy: "Maximize-Clicks" }] },
      {},
      {},
      undefined,
      undefined,
      undefined,
      bidding(0),
    );
    expect(typo.some((e) => e.includes("strategy must be"))).toBe(true);

    const missing = validate({ bidding: [{ campaignId: 5 }] }, {}, {}, undefined, undefined, undefined, bidding(0));
    expect(missing.some((e) => e.includes("strategy must be"))).toBe(true);

    // Unlike the state lookup, this check fires even for a campaign with no live
    // bidding state at all — it never depends on getState() succeeding.
    const unknownCampaign = validate(
      { bidding: [{ campaignId: 999, strategy: "not-a-strategy" }] },
      {},
      {},
      undefined,
      undefined,
      undefined,
      bidding(0),
    );
    expect(unknownCampaign.some((e) => e.includes("strategy must be"))).toBe(true);
    expect(unknownCampaign.some((e) => e.includes("no current bidding state found"))).toBe(false);
  });

  it("refuses a downgrade at exactly the 30-conversion threshold without acknowledgement", () => {
    const plan = { bidding: [{ campaignId: 5, strategy: "maximize-clicks", cpcBidCeilingMicros: 5_000_000 }] };
    const errs = validate(plan, {}, {}, undefined, undefined, undefined, bidding(CONVERSION_GUARD_THRESHOLD));
    expect(errs.some((e) => e.includes("refusing maximize-conversions -> maximize-clicks"))).toBe(true);
  });

  it("allows a downgrade at one conversion below the threshold", () => {
    const plan = { bidding: [{ campaignId: 5, strategy: "maximize-clicks", cpcBidCeilingMicros: 5_000_000 }] };
    const errs = validate(plan, {}, {}, undefined, undefined, undefined, bidding(CONVERSION_GUARD_THRESHOLD - 1));
    expect(errs).toEqual([]);
  });

  it("allows a downgrade at/above the threshold when acknowledged", () => {
    const plan = {
      bidding: [
        {
          campaignId: 5,
          strategy: "maximize-clicks",
          cpcBidCeilingMicros: 5_000_000,
          acknowledgeStrategyDowngrade: true,
        },
      ],
    };
    const errs = validate(plan, {}, {}, undefined, undefined, undefined, bidding(CONVERSION_GUARD_THRESHOLD));
    expect(errs).toEqual([]);
  });

  it("never guards the reverse (graduate-up) direction regardless of conversion count", () => {
    const plan = { bidding: [{ campaignId: 5, strategy: "maximize-conversions" }] };
    const errs = validate(plan, {}, {}, undefined, undefined, undefined, bidding(1000));
    expect(errs).toEqual([]);
  });

  it("does not guard a ceiling-only edit that leaves the campaign on maximize-clicks", () => {
    const alreadyOnClicks = { 5: { biddingStrategyType: "TARGET_SPEND", conversions30d: 1000 } };
    const plan = { bidding: [{ campaignId: 5, strategy: "maximize-clicks", cpcBidCeilingMicros: 6_000_000 }] };
    const errs = validate(plan, {}, {}, undefined, undefined, undefined, alreadyOnClicks);
    expect(errs).toEqual([]);
  });

  it("errors on an unknown campaignId", () => {
    const plan = { bidding: [{ campaignId: 9, strategy: "maximize-clicks" }] };
    const errs = validate(plan, {}, {}, undefined, undefined, undefined, BIDDING_STARVED);
    expect(errs.some((e) => e.includes("no current bidding state found"))).toBe(true);
  });

  it("accepts target-cpa and target-roas (spec.md 048 FR-001)", () => {
    const targetCpaState = { 5: { biddingStrategyType: "MAXIMIZE_CONVERSIONS", conversions30d: 0 } };
    const targetCpa = validate(
      { bidding: [{ campaignId: 5, strategy: "target-cpa", targetCpaMicros: 12_000_000 }] },
      {},
      {},
      undefined,
      undefined,
      undefined,
      targetCpaState,
    );
    expect(targetCpa).toEqual([]);

    const targetRoas = validate(
      { bidding: [{ campaignId: 5, strategy: "target-roas", targetRoas: 3.5 }] },
      {},
      {},
      undefined,
      undefined,
      undefined,
      targetCpaState,
    );
    expect(targetRoas).toEqual([]);
  });

  it("never guards graduating into target-cpa/target-roas regardless of conversion count", () => {
    const plan = { bidding: [{ campaignId: 5, strategy: "target-cpa", targetCpaMicros: 12_000_000 }] };
    const errs = validate(plan, {}, {}, undefined, undefined, undefined, bidding(1000));
    expect(errs).toEqual([]);
  });

  it("refuses a target-cpa block missing targetCpaMicros before ever checking live state", () => {
    const errs = validate(
      { bidding: [{ campaignId: 5, strategy: "target-cpa" }] },
      {},
      {},
      undefined,
      undefined,
      undefined,
      new Map(), // no live state at all — the required-field check must fire first
    );
    expect(errs.some((e) => e.includes('requires a positive integer targetCpaMicros'))).toBe(true);
    expect(errs.some((e) => e.includes("no current bidding state found"))).toBe(false);
  });

  it("refuses a target-cpa block with a non-positive or non-integer targetCpaMicros", () => {
    for (const bad of [0, -1, 1.5, "12000000", NaN]) {
      const errs = validate(
        { bidding: [{ campaignId: 5, strategy: "target-cpa", targetCpaMicros: bad }] },
        {},
        {},
        undefined,
        undefined,
        undefined,
        new Map(),
      );
      expect(errs.some((e) => e.includes("requires a positive integer targetCpaMicros"))).toBe(true);
    }
  });

  it("refuses a target-roas block missing or with a non-positive targetRoas", () => {
    for (const bad of [undefined, 0, -1, "3.5", NaN]) {
      const block: Record<string, unknown> = { campaignId: 5, strategy: "target-roas" };
      if (bad !== undefined) {
        block.targetRoas = bad;
      }
      const errs = validate({ bidding: [block] }, {}, {}, undefined, undefined, undefined, new Map());
      expect(errs.some((e) => e.includes("requires a positive numeric targetRoas"))).toBe(true);
    }
  });

  it("accepts a fractional targetRoas (unlike targetCpaMicros, it is not required to be an integer)", () => {
    const errs = validate(
      { bidding: [{ campaignId: 5, strategy: "target-roas", targetRoas: 3.5 }] },
      {},
      {},
      undefined,
      undefined,
      undefined,
      { 5: { biddingStrategyType: "MAXIMIZE_CONVERSIONS", conversions30d: 0 } },
    );
    expect(errs).toEqual([]);
  });
});

// ---------- bidding idempotent-skip partition (spec.md 048 FR-002/FR-003) ----------

describe("biddingPlan", () => {
  it("skips an entry whose strategy and target value already match live state", () => {
    const live = { 5: { biddingStrategyType: "TARGET_CPA", conversions30d: 10, targetValue: 12_000_000 } };
    const [changes, skips] = biddingPlan(
      [{ campaignId: 5, strategy: "target-cpa", targetCpaMicros: 12_000_000 }],
      live,
    );
    expect(changes).toEqual([]);
    expect(skips).toHaveLength(1);
  });

  it("treats a target-value-only change (same strategy) as a real change, not a skip", () => {
    const live = { 5: { biddingStrategyType: "TARGET_CPA", conversions30d: 10, targetValue: 12_000_000 } };
    const [changes, skips] = biddingPlan(
      [{ campaignId: 5, strategy: "target-cpa", targetCpaMicros: 15_000_000 }],
      live,
    );
    expect(skips).toEqual([]);
    expect(changes).toHaveLength(1);
  });

  it("treats a strategy change as a real change even when no target value is set", () => {
    const live = { 5: { biddingStrategyType: "MAXIMIZE_CONVERSIONS", conversions30d: 10 } };
    const [changes, skips] = biddingPlan([{ campaignId: 5, strategy: "maximize-clicks" }], live);
    expect(skips).toEqual([]);
    expect(changes).toHaveLength(1);
  });

  it("skips a maximize-clicks entry already on maximize-clicks with a matching ceiling", () => {
    const live = { 5: { biddingStrategyType: "TARGET_SPEND", conversions30d: 0, targetValue: 5_000_000 } };
    const [changes, skips] = biddingPlan(
      [{ campaignId: 5, strategy: "maximize-clicks", cpcBidCeilingMicros: 5_000_000 }],
      live,
    );
    expect(changes).toEqual([]);
    expect(skips).toHaveLength(1);
  });

  it("treats a ceiling-only change on maximize-clicks as a real change, not a skip", () => {
    const live = { 5: { biddingStrategyType: "TARGET_SPEND", conversions30d: 0, targetValue: 5_000_000 } };
    const [changes, skips] = biddingPlan(
      [{ campaignId: 5, strategy: "maximize-clicks", cpcBidCeilingMicros: 6_000_000 }],
      live,
    );
    expect(skips).toEqual([]);
    expect(changes).toHaveLength(1);
  });

  it("treats an unknown campaign or unsupported strategy as a change, not a skip", () => {
    const live = { 5: { biddingStrategyType: "TARGET_CPA", conversions30d: 0, targetValue: 12_000_000 } };
    const [changesUnknown, skipsUnknown] = biddingPlan(
      [{ campaignId: 999, strategy: "target-cpa", targetCpaMicros: 12_000_000 }],
      live,
    );
    expect(skipsUnknown).toEqual([]);
    expect(changesUnknown).toHaveLength(1);

    const [changesBad, skipsBad] = biddingPlan([{ campaignId: 5, strategy: "manual-cpc" }], live);
    expect(skipsBad).toEqual([]);
    expect(changesBad).toHaveLength(1);
  });

  it("treats a switch between spend-optimizing strategies (target-cpa -> target-roas) as a real change, never a cross-field skip", () => {
    // Guards against comparing a target-cpa micros value against a target-roas ratio
    // (or vice versa) across the strategy switch — the live strategy check must gate
    // the target-value comparison, not run alongside it.
    const live = { 5: { biddingStrategyType: "TARGET_CPA", conversions30d: 10, targetValue: 12_000_000 } };
    const [changes, skips] = biddingPlan([{ campaignId: 5, strategy: "target-roas", targetRoas: 3.5 }], live);
    expect(skips).toEqual([]);
    expect(changes).toHaveLength(1);

    // Numeric-coincidence variant: an absurd but type-legal targetRoas that happens to
    // equal the live targetCpaMicros value must still never accidentally match.
    const [changesCoincidence, skipsCoincidence] = biddingPlan(
      [{ campaignId: 5, strategy: "target-roas", targetRoas: 12_000_000 }],
      live,
    );
    expect(skipsCoincidence).toEqual([]);
    expect(changesCoincidence).toHaveLength(1);
  });
});

// ---------- positive keywords (US1) ----------

// live ad-group positive keywords: {adGroupId: {(text.lower, matchType)}}
const LIVE_POS = {
  12345: new Set([
    ["ai writing", "BROAD"] as [string, string],
    ["ai chatbot", "PHRASE"] as [string, string],
  ]),
};

describe("positive keywords", () => {
  it("add phrase valid passes", () => {
    const plan = { keywords: [{ adGroupId: 12345, add: [{ text: "brand voice ai", matchType: "PHRASE" }] }] };
    expect(validate(plan, {}, {}, LIVE_POS)).toEqual([]);
  });

  it("missing adGroup and empty ops flagged", () => {
    const errs = validate({ keywords: [{ add: ["x"] }, { adGroupId: 12345 }] }, {}, {}, LIVE_POS);
    expect(errs.some((e) => e.includes("missing adGroupId"))).toBe(true);
    expect(errs.some((e) => e.includes("empty operation lists"))).toBe(true);
  });

  it("non-numeric adGroup flagged", () => {
    const errs = validate({ keywords: [{ adGroupId: "9x", add: ["a"] }] }, {}, {}, LIVE_POS);
    expect(errs.some((e) => e.includes("must be numeric"))).toBe(true);
  });

  it("bad add matchType flagged", () => {
    const errs = validate(
      { keywords: [{ adGroupId: 12345, add: [{ text: "x", matchType: "FUZZY" }] }] },
      {},
      {},
      LIVE_POS,
    );
    expect(errs.some((e) => e.toLowerCase().includes("matchtype") || e.includes("FUZZY"))).toBe(true);
  });

  it("remove absent keyword rejected", () => {
    // acceptance scenario 6 / edge case: removing a keyword not on the ad group is rejected
    const plan = { keywords: [{ adGroupId: 12345, remove: [{ text: "nope", matchType: "EXACT" }] }] };
    const errs = validate(plan, {}, {}, LIVE_POS);
    expect(errs.some((e) => e.includes("not present on the ad group"))).toBe(true);
  });

  it("remove present keyword passes", () => {
    const plan = { keywords: [{ adGroupId: 12345, remove: [{ text: "AI Writing", matchType: "BROAD" }] }] };
    expect(validate(plan, {}, {}, LIVE_POS)).toEqual([]);
  });

  it("match type change remove plus add passes", () => {
    // acceptance scenario 4: change match type = remove broad + add phrase of same text
    const plan = {
      keywords: [
        {
          adGroupId: 12345,
          remove: [{ text: "ai writing", matchType: "BROAD" }],
          add: [{ text: "ai writing", matchType: "PHRASE" }],
        },
      ],
    };
    expect(validate(plan, {}, {}, LIVE_POS)).toEqual([]);
  });

  it("newPositiveKeywords skips live and dedups within group", () => {
    const group = {
      adGroupId: 12345,
      add: [
        { text: "AI Writing", matchType: "BROAD" }, // already live (case-insensitive) -> skip
        "novel keyword", // bare string -> PHRASE, fresh
        "novel keyword", // in-group dup -> collapse
      ],
    };
    const fresh = newPositiveKeywords(group, LIVE_POS);
    expect(fresh.map((k) => [k.text, k.matchType])).toEqual([["novel keyword", "PHRASE"]]);
  });

  it("newPositiveKeywords match type change not collide", () => {
    // removing broad then adding phrase of the same text: the add is fresh (different MT)
    const group = { adGroupId: 12345, add: [{ text: "ai writing", matchType: "PHRASE" }] };
    const fresh = newPositiveKeywords(group, LIVE_POS);
    expect(fresh.map((k) => [k.text, k.matchType])).toEqual([["ai writing", "PHRASE"]]);
  });

  it("posKey includes match type", () => {
    expect(posKey("AI Writing", "BROAD")).toEqual(["ai writing", "BROAD"]);
  });
});

// ---------- campaignStatus (campaign on/off, CHANGE 1) ----------

describe("campaignStatus", () => {
  it("plan splits changes and skips", () => {
    const blocks = [
      { campaignId: "1", status: "ENABLED" }, // currently PAUSED -> change
      { campaignId: "2", status: "PAUSED" }, // currently PAUSED -> skip (no-op)
      { campaignId: "3", status: "PAUSED" }, // currently ENABLED -> change
    ];
    const live = { 1: "PAUSED", 2: "PAUSED", 3: "ENABLED" };
    const [changes, skips] = campaignStatusPlan(blocks, live);
    expect(changes.map((c) => c.campaignId)).toEqual(["1", "3"]);
    expect(changes.map((c) => c.current)).toEqual(["PAUSED", "ENABLED"]);
    expect(skips.map((s) => s.campaignId)).toEqual(["2"]);
  });

  it("unknown live status is a change", () => {
    // No live status read (campaign not in the map) => never a no-op skip.
    const [changes, skips] = campaignStatusPlan([{ campaignId: "9", status: "ENABLED" }], {});
    expect(changes.length).toBe(1);
    expect(skips).toEqual([]);
    expect(changes[0].current).toBeNull();
  });

  it("validation valid passes", () => {
    const plan = {
      campaignStatus: [
        { campaignId: "123", status: "ENABLED" },
        { campaignId: 456, status: "PAUSED" },
      ],
    };
    expect(validate(plan, {}, {})).toEqual([]);
  });

  it("validation rejects bad status and id", () => {
    const plan = {
      campaignStatus: [
        { campaignId: "abc", status: "ENABLED" },
        { campaignId: "123", status: "LIVE" },
      ],
    };
    const errs = validate(plan, {}, {});
    expect(errs.some((e) => e.includes("abc"))).toBe(true);
    expect(errs.some((e) => e.includes("123") && e.includes("status"))).toBe(true);
  });
});

// ---------- adGroupStatus (ad group on/off) ----------

describe("adGroupStatus", () => {
  it("plan splits changes and skips", () => {
    const blocks = [
      { adGroupId: "1", status: "ENABLED" }, // currently PAUSED -> change
      { adGroupId: "2", status: "PAUSED" }, // currently PAUSED -> skip (no-op)
      { adGroupId: "3", status: "PAUSED" }, // currently ENABLED -> change
    ];
    const live = { 1: "PAUSED", 2: "PAUSED", 3: "ENABLED" };
    const [changes, skips] = adGroupStatusPlan(blocks, live);
    expect(changes.map((c) => c.adGroupId)).toEqual(["1", "3"]);
    expect(changes.map((c) => c.current)).toEqual(["PAUSED", "ENABLED"]);
    expect(skips.map((s) => s.adGroupId)).toEqual(["2"]);
  });

  it("unknown live status is a change", () => {
    // No live status read (ad group not in the map) => never a no-op skip.
    const [changes, skips] = adGroupStatusPlan([{ adGroupId: "9", status: "PAUSED" }], {});
    expect(changes.length).toBe(1);
    expect(skips).toEqual([]);
    expect(changes[0].current).toBeNull();
  });

  it("validation valid passes", () => {
    const plan = {
      adGroupStatus: [
        { adGroupId: "789", status: "PAUSED" },
        { adGroupId: 200325112680, status: "ENABLED" },
      ],
    };
    expect(validate(plan, {}, {})).toEqual([]);
  });

  it("validation rejects bad status and id", () => {
    const plan = {
      adGroupStatus: [
        { adGroupId: "xyz", status: "PAUSED" },
        { adGroupId: "789", status: "OFF" },
      ],
    };
    const errs = validate(plan, {}, {});
    expect(errs.some((e) => e.includes("xyz"))).toBe(true);
    expect(errs.some((e) => e.includes("789") && e.includes("status"))).toBe(true);
  });
});

// ---------- adStatus (single ad on/off) ----------

describe("adStatus", () => {
  it("plan splits changes and skips (keyed by adId)", () => {
    const blocks = [
      { adId: "1", status: "ENABLED" }, // currently PAUSED -> change
      { adId: "2", status: "PAUSED" }, // currently PAUSED -> skip (no-op)
    ];
    const live = { 1: "PAUSED", 2: "PAUSED" };
    const [changes, skips] = adStatusPlan(blocks, live);
    expect(changes.map((c) => c.adId)).toEqual(["1"]);
    expect(changes[0].current).toBe("PAUSED");
    expect(skips.map((s) => s.adId)).toEqual(["2"]);
  });

  it("unknown live status is a change", () => {
    const [changes, skips] = adStatusPlan([{ adId: "9", status: "ENABLED" }], {});
    expect(changes.length).toBe(1);
    expect(skips).toEqual([]);
    expect(changes[0].current).toBeNull();
  });

  it("validation valid passes", () => {
    const plan = { adStatus: [{ adId: "816978549834", status: "ENABLED" }] };
    expect(validate(plan, {}, {})).toEqual([]);
  });

  it("validation rejects bad status and id", () => {
    const plan = { adStatus: [{ adId: "nope", status: "ON" }] };
    const errs = validate(plan, {}, {});
    expect(errs.some((e) => e.includes("nope"))).toBe(true);
    expect(errs.some((e) => e.includes("status"))).toBe(true);
  });

  it("rejects an ad with no live parent ad group (stale/removed id)", () => {
    const plan = { adStatus: [{ adId: "999", status: "ENABLED" }] };
    // live parent map provided but empty -> ad 999 has no parent
    const errs = validate(plan, {}, {}, undefined, undefined, {});
    expect(errs.some((e) => e.includes("999") && e.includes("no live ad group"))).toBe(true);
  });

  it("passes when the ad's live parent ad group is known", () => {
    const plan = { adStatus: [{ adId: "999", status: "ENABLED" }] };
    const errs = validate(plan, {}, {}, undefined, undefined, { 999: 42 });
    expect(errs).toEqual([]);
  });
});

// ---------- searchPartners (campaign network_settings.target_search_network toggle) ----------

describe("searchPartners", () => {
  it("plan splits changes and skips", () => {
    const blocks = [
      { campaignId: "1", enabled: false }, // currently true -> change
      { campaignId: "2", enabled: false }, // currently false -> skip (no-op)
      { campaignId: "3", enabled: true }, // currently false -> change
    ];
    const live = { 1: true, 2: false, 3: false };
    const [changes, skips] = searchPartnersPlan(blocks, live);
    expect(changes.map((c) => c.campaignId)).toEqual(["1", "3"]);
    expect(changes.map((c) => c.current)).toEqual([true, false]);
    expect(skips.map((s) => s.campaignId)).toEqual(["2"]);
  });

  it("unknown live setting is a change", () => {
    // No live setting read (campaign not in the map) => never a no-op skip.
    const [changes, skips] = searchPartnersPlan([{ campaignId: "9", enabled: false }], {});
    expect(changes.length).toBe(1);
    expect(skips).toEqual([]);
    expect(changes[0].current).toBeNull();
  });

  it("validation valid passes", () => {
    const plan = {
      searchPartners: [
        { campaignId: "123", enabled: false },
        { campaignId: 456, enabled: true },
      ],
    };
    expect(validate(plan, {}, {})).toEqual([]);
  });

  it("validation rejects bad id and non-boolean enabled", () => {
    const plan = {
      searchPartners: [
        { campaignId: "abc", enabled: false },
        { campaignId: "123", enabled: "off" },
      ],
    };
    const errs = validate(plan, {}, {});
    expect(errs.some((e) => e.includes("abc"))).toBe(true);
    expect(errs.some((e) => e.includes("123") && e.includes("enabled"))).toBe(true);
  });

  it("rejects enabled:true when live target_google_search is false", () => {
    const plan = { searchPartners: [{ campaignId: "100", enabled: true }] };
    const errs = validate(plan, {}, {}, undefined, { 100: false });
    expect(errs.some((e) => e.includes("100") && e.includes("Google Search targeting is off"))).toBe(true);
  });

  it("does not reject enabled:false regardless of live target_google_search", () => {
    const plan = { searchPartners: [{ campaignId: "100", enabled: false }] };
    expect(validate(plan, {}, {}, undefined, { 100: false })).toEqual([]);
  });

  it("does not reject enabled:true when live target_google_search is unknown or true", () => {
    const plan = { searchPartners: [{ campaignId: "100", enabled: true }] };
    expect(validate(plan, {}, {}, undefined, {})).toEqual([]);
    expect(validate(plan, {}, {}, undefined, { 100: true })).toEqual([]);
  });
});

// ---------- languages (English-only) ----------

describe("languages", () => {
  it("a digits-only campaignId passes", () => {
    expect(validate({ languages: [{ campaignId: "23969397981" }, { campaignId: 456 }] }, {}, {})).toEqual([]);
  });

  it("missing campaignId is flagged", () => {
    expect(validate({ languages: [{}] }, {}, {}).some((e) => e.includes("missing campaignId"))).toBe(true);
  });

  it("non-numeric campaignId is flagged", () => {
    expect(validate({ languages: [{ campaignId: "23x" }] }, {}, {}).some((e) => e.includes("must be numeric"))).toBe(
      true,
    );
  });
});

// ---------- adGroups (add-ad-group) ----------

/**
 * A valid ad-group block body authored with the bare-string ergonomics the rest of
 * the update plan uses: string headlines/descriptions and a lower-case keyword
 * matchType (the boundary normalizer coerces both to the schema shape).
 */
function adGroupBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "close deals ai",
    defaultBidMicros: 2_000_000,
    responsiveSearchAds: [
      { headlines: h(15), descriptions: d(4), finalUrl: "https://example.com/ideas/close-deals-ai" },
      { headlines: h(15), descriptions: d(4), finalUrl: "https://example.com/ideas/close-deals-ai" },
    ],
    keywords: ["close deals ai", { text: "ai deal closer", matchType: "exact" }],
    ...overrides,
  };
}

describe("adGroups validation", () => {
  it("a valid add-ad-group block passes", () => {
    const plan = { adGroups: [{ campaignId: "23955052962", adGroup: adGroupBody() }] };
    expect(validate(plan, {}, {})).toEqual([]);
  });

  it("missing campaignId is flagged", () => {
    const plan = { adGroups: [{ adGroup: adGroupBody() }] };
    expect(validate(plan, {}, {}).some((e) => e.includes("missing campaignId"))).toBe(true);
  });

  it("non-numeric campaignId is flagged", () => {
    const plan = { adGroups: [{ campaignId: "abc", adGroup: adGroupBody() }] };
    expect(validate(plan, {}, {}).some((e) => e.includes("campaignId must be numeric"))).toBe(true);
  });

  it("missing adGroup is flagged", () => {
    const plan = { adGroups: [{ campaignId: "100" }] };
    expect(validate(plan, {}, {}).some((e) => e.includes("missing adGroup"))).toBe(true);
  });

  it("a bad RSA (14 headlines) surfaces the field path", () => {
    const bad = adGroupBody({
      responsiveSearchAds: [
        {
          headlines: h(14).map((text) => ({ text })),
          descriptions: d(4).map((text) => ({ text })),
          finalUrl: "https://example.com/x",
        },
        { headlines: h(15).map((text) => ({ text })), descriptions: d(4).map((text) => ({ text })), finalUrl: "https://example.com/x" },
      ],
    });
    const errs = validate({ adGroups: [{ campaignId: "100", adGroup: bad }] }, {}, {});
    expect(errs.some((e) => e.includes("adGroup.responsiveSearchAds") && e.includes("headlines"))).toBe(true);
  });

  it("a single RSA (missing the second angle) surfaces a cardinality error", () => {
    const bad = adGroupBody({
      responsiveSearchAds: [{ headlines: h(15), descriptions: d(4), finalUrl: "https://example.com/x" }],
    });
    const errs = validate({ adGroups: [{ campaignId: "100", adGroup: bad }] }, {}, {});
    expect(errs.some((e) => e.includes("adGroup.responsiveSearchAds"))).toBe(true);
  });

  it("too many keywords (>30) is flagged", () => {
    const bad = adGroupBody({
      keywords: Array.from({ length: 31 }, (_, i) => ({ text: `kw ${i}`, matchType: "PHRASE" })),
    });
    const errs = validate({ adGroups: [{ campaignId: "100", adGroup: bad }] }, {}, {});
    expect(errs.some((e) => e.includes("adGroup.keywords"))).toBe(true);
  });
});

describe("addAdGroupsPlan", () => {
  it("splits creates from name-collision skips (case-insensitive)", () => {
    const blocks = [
      { campaignId: "100", adGroup: adGroupBody({ name: "brand new group" }) },
      { campaignId: "100", adGroup: adGroupBody({ name: "Existing Group" }) },
    ];
    const liveNames = { 100: new Set(["existing group"]) };
    const [creates, skips] = addAdGroupsPlan(blocks, liveNames);
    expect(creates.map((c) => c.name)).toEqual(["brand new group"]);
    expect(skips.map((s) => s.name)).toEqual(["Existing Group"]);
  });

  it("with no live names everything is a create", () => {
    const blocks = [{ campaignId: "100", adGroup: adGroupBody({ name: "a" }) }];
    const [creates, skips] = addAdGroupsPlan(blocks, undefined);
    expect(creates).toHaveLength(1);
    expect(skips).toHaveLength(0);
  });
});

// ---------- addRsa ----------

/** A valid addRsa block body: 15 headlines / 4 descriptions + explicit finalUrl. */
function addRsaBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    adGroupId: "789",
    headlines: h(15),
    descriptions: d(4),
    finalUrl: "https://example.com/ideas/close-deals-ai",
    ...overrides,
  };
}

describe("resolveAddRsaFinalUrl", () => {
  it("returns the block's own finalUrl when present", () => {
    const block = addRsaBody({ finalUrl: "https://example.com/own" });
    const live = new Map([[789, { count: 1, soleFinalUrl: "https://example.com/live" }]]);
    expect(resolveAddRsaFinalUrl(block, live)).toBe("https://example.com/own");
  });

  it("defaults to the sole live RSA's finalUrl when omitted and live count is 1", () => {
    const { finalUrl: _drop, ...block } = addRsaBody();
    const live = new Map([[789, { count: 1, soleFinalUrl: "https://example.com/live" }]]);
    expect(resolveAddRsaFinalUrl(block, live)).toBe("https://example.com/live");
  });

  it("is undefined when omitted and live count is 0 (nothing to default from)", () => {
    const { finalUrl: _drop, ...block } = addRsaBody();
    const live = new Map([[789, { count: 0 }]]);
    expect(resolveAddRsaFinalUrl(block, live)).toBeUndefined();
  });
});

describe("addRsa validation", () => {
  it("a valid 15H/4D block passes", () => {
    const plan = { addRsa: [addRsaBody()] };
    expect(validate(plan, {}, {})).toEqual([]);
  });

  it("addRsaErrors accepts a well-formed block", () => {
    expect(addRsaErrors([addRsaBody()], new Map())).toEqual([]);
  });

  it("addRsaErrors rejects a missing finalUrl when the live count is 0", () => {
    const { finalUrl: _drop, ...block } = addRsaBody();
    const live = new Map([[789, { count: 0 }]]);
    const errs = addRsaErrors([block], live);
    expect(errs.some((e) => e.includes("adGroup 789") && e.includes("finalUrl"))).toBe(true);
  });

  it("missing adGroupId is flagged", () => {
    const { adGroupId: _drop, ...block } = addRsaBody();
    expect(addRsaErrors([block], new Map()).some((e) => e.includes("missing adGroupId"))).toBe(true);
  });

  it("non-numeric adGroupId is flagged", () => {
    const block = addRsaBody({ adGroupId: "abc" });
    expect(addRsaErrors([block], new Map()).some((e) => e.includes("adGroupId must be numeric"))).toBe(true);
  });

  it("wrong headline/description count is flagged", () => {
    const block = addRsaBody({ headlines: h(12), descriptions: d(3) });
    const errs = addRsaErrors([block], new Map());
    expect(errs.some((e) => e.includes("adGroup 789") && e.includes("headlines"))).toBe(true);
    expect(errs.some((e) => e.includes("adGroup 789") && e.includes("descriptions"))).toBe(true);
  });

  it("an over-length headline is flagged", () => {
    const block = addRsaBody({ headlines: [...h(14), "x".repeat(31)] });
    const errs = addRsaErrors([block], new Map());
    expect(errs.some((e) => e.includes("headlines"))).toBe(true);
  });

  it("an over-length description is flagged", () => {
    const block = addRsaBody({ descriptions: [...d(3), "x".repeat(91)] });
    const errs = addRsaErrors([block], new Map());
    expect(errs.some((e) => e.includes("descriptions"))).toBe(true);
  });

  it("a duplicate headline is flagged", () => {
    const block = addRsaBody({ headlines: [...h(14), "headline 0"] });
    const errs = addRsaErrors([block], new Map());
    expect(errs.some((e) => e.includes("headlines") && e.includes("unique"))).toBe(true);
  });

  it("a duplicate description is flagged", () => {
    const block = addRsaBody({ descriptions: [...d(3), "description 0"] });
    const errs = addRsaErrors([block], new Map());
    expect(errs.some((e) => e.includes("descriptions") && e.includes("unique"))).toBe(true);
  });

  it("an invalid path1/path2 is flagged", () => {
    const block = addRsaBody({ path1: "has space" });
    const errs = addRsaErrors([block], new Map());
    expect(errs.some((e) => e.includes("path1"))).toBe(true);
  });
});

describe("addRsaPlan", () => {
  it("an ad group with 1 live RSA partitions as a create", () => {
    const live = new Map([[789, { count: 1, soleFinalUrl: "https://example.com/x" }]]);
    const [changes, skips] = addRsaPlan([addRsaBody()], live);
    expect(changes).toHaveLength(1);
    expect(skips).toHaveLength(0);
  });

  it("an ad group with 0 live RSAs partitions as a create", () => {
    const live = new Map([[789, { count: 0 }]]);
    const [changes, skips] = addRsaPlan([addRsaBody()], live);
    expect(changes).toHaveLength(1);
    expect(skips).toHaveLength(0);
  });

  it("an ad group already at 2 live RSAs partitions as a skip", () => {
    const live = new Map([[789, { count: 2 }]]);
    const [changes, skips] = addRsaPlan([addRsaBody()], live);
    expect(changes).toHaveLength(0);
    expect(skips).toHaveLength(1);
  });

  it("an ad group already at 3+ live RSAs (over-count) also partitions as a skip", () => {
    const live = new Map([[789, { count: 3 }]]);
    const [changes, skips] = addRsaPlan([addRsaBody()], live);
    expect(changes).toHaveLength(0);
    expect(skips).toHaveLength(1);
  });

  it("two blocks targeting the same adGroupId starting at 1 live RSA: [create, skip]", () => {
    const live = new Map([[789, { count: 1, soleFinalUrl: "https://example.com/x" }]]);
    const blocks = [addRsaBody(), addRsaBody({ headlines: h(15).map((t) => `${t} v2`) })];
    const [changes, skips] = addRsaPlan(blocks, live);
    expect(changes).toHaveLength(1);
    expect(skips).toHaveLength(1);
    expect(changes[0]).toBe(blocks[0]);
    expect(skips[0]).toBe(blocks[1]);
  });

  it("with no live state everything is a create", () => {
    const [changes, skips] = addRsaPlan([addRsaBody()], new Map());
    expect(changes).toHaveLength(1);
    expect(skips).toHaveLength(0);
  });
});

describe("addRsaCreateEntries", () => {
  it("builds the already-parsed, already-defaulted ResponsiveSearchAd per change", () => {
    const { finalUrl: _drop, ...block } = addRsaBody();
    const live = new Map([[789, { count: 1, soleFinalUrl: "https://example.com/live" }]]);
    const entries = addRsaCreateEntries([block], live);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.adGroupId).toBe("789");
    expect(entries[0]!.rsa.finalUrl).toBe("https://example.com/live");
    expect(entries[0]!.rsa.headlines).toHaveLength(15);
    expect(entries[0]!.rsa.descriptions).toHaveLength(4);
  });
});
