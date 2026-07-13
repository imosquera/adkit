/** Unit tests for the SDK-free validation/coercion in fixes/plan.ts. */
import { describe, expect, it } from "vitest";
import {
  adGroupStatusPlan,
  campaignStatusPlan,
  coerceKeyword,
  negKey,
  newNegatives,
  newPositiveKeywords,
  posKey,
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
