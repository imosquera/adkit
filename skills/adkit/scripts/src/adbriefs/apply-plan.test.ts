/**
 * Unit tests for adbriefs/apply-plan.ts — resolvePlanGroups (id resolution + per-slug
 * grouping) and applyPlanToBrief (pure Brief transform from a resolved group).
 */

import { describe, expect, it } from "vitest";
import { applyPlanToBrief, resolvePlanGroups, type ApplyPlanComputed } from "./apply-plan.js";
import type { StateIndex } from "./state.js";
import type { AddRsaCreatePlanEntry, AdGroupCreatePlanEntry } from "../fixes/plan.js";
import { BriefSchema } from "../lib/schema.js";
import type { Brief } from "../lib/schema.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function emptyIndex(): StateIndex {
  return { byCampaignId: new Map(), byAdGroupId: new Map(), byAdId: new Map() };
}

/** A StateIndex covering two campaigns/briefs: "alpha" (campaign 100) and "beta" (campaign 200). */
function twoCampaignIndex(): StateIndex {
  return {
    byCampaignId: new Map([
      ["100", { slug: "alpha", campaignName: "Alpha" }],
      ["200", { slug: "beta", campaignName: "Beta" }],
    ]),
    byAdGroupId: new Map([
      ["111", { slug: "alpha", campaignName: "Alpha", adGroupName: "widgets" }],
      ["211", { slug: "beta", campaignName: "Beta", adGroupName: "gadgets" }],
    ]),
    byAdId: new Map([
      ["1111", { slug: "alpha", campaignName: "Alpha", adGroupName: "widgets", rsaIndex: 0 }],
      ["2111", { slug: "beta", campaignName: "Beta", adGroupName: "gadgets", rsaIndex: 0 }],
    ]),
  };
}

/**
 * One RSA fixture. `variant` 0 keeps the pre-existing plain "headline N" text (several
 * tests assert against it verbatim); other variants get a distinguishing prefix so a
 * second RSA in the same ad group reads as visibly distinct (cross-RSA duplicate text
 * is schema-legal — uniqueness is enforced within one RSA, not across the pair).
 */
function rsaFixture(variant = 0) {
  const label = variant === 0 ? "" : `alt${variant} `;
  return {
    headlines: Array.from({ length: 15 }, (_, i) => ({ text: `${label}headline ${i}` })),
    descriptions: Array.from({ length: 4 }, (_, i) => ({ text: `${label}description ${i}` })),
    finalUrl: "https://example.com/x",
  };
}

function baseBrief(overrides: Partial<Brief> = {}): Brief {
  return {
    name: "alpha",
    version: 1,
    campaign: {
      name: "Alpha",
      budgetMicros: 25_000_000,
      networkSettings: "search-partners-display",
      bidStrategy: "maximize-clicks",
      aiMax: true,
      negativeKeywords: [],
      sitelinks: [],
      callouts: [],
    },
    adGroups: [
      {
        name: "widgets",
        defaultBidMicros: 1_500_000,
        responsiveSearchAds: [rsaFixture(0), rsaFixture(1)],
        keywords: [{ text: "existing keyword", matchType: "PHRASE" }],
        aiMax: false,
      },
    ],
    ...overrides,
  } as Brief;
}

// ---------------------------------------------------------------------------
// resolvePlanGroups
// ---------------------------------------------------------------------------

describe("resolvePlanGroups", () => {
  it("resolves every id-bearing section to a single slug", () => {
    const plan = {
      rewrites: [{ adId: "1111", headlines: ["h"] }],
      negatives: [{ campaignId: "100", add: ["free"] }],
      keywords: [{ adGroupId: "111", add: ["kw"] }],
    };
    const groups = resolvePlanGroups(plan, twoCampaignIndex());
    expect(groups).toHaveLength(1);
    expect(groups[0]!.slug).toBe("alpha");
    expect(groups[0]!.sections.rewrites).toHaveLength(1);
    expect(groups[0]!.sections.negatives).toHaveLength(1);
    expect(groups[0]!.sections.keywords).toHaveLength(1);
    expect(groups[0]!.unresolvedIds).toEqual([]);
  });

  it("splits a plan touching multiple campaigns into one group per resolved slug (FR-010)", () => {
    const plan = {
      rewrites: [
        { adId: "1111", headlines: ["h1"] },
        { adId: "2111", headlines: ["h2"] },
      ],
      budgets: [
        { campaignId: "100", dailyMicros: 1 },
        { campaignId: "200", dailyMicros: 2 },
      ],
    };
    const groups = resolvePlanGroups(plan, twoCampaignIndex());
    const slugs = groups.map((g) => g.slug).sort();
    expect(slugs).toEqual(["alpha", "beta"]);
    const alpha = groups.find((g) => g.slug === "alpha")!;
    const beta = groups.find((g) => g.slug === "beta")!;
    expect(alpha.sections.rewrites).toHaveLength(1);
    expect(alpha.sections.budgets).toHaveLength(1);
    expect(beta.sections.rewrites).toHaveLength(1);
    expect(beta.sections.budgets).toHaveLength(1);
  });

  it("collects an unresolvable id as a standalone warning while a sibling id still resolves (FR-001)", () => {
    const plan = {
      rewrites: [
        { adId: "1111", headlines: ["h1"] }, // resolves
        { adId: "9999", headlines: ["h2"] }, // stale — no record anywhere
      ],
    };
    const groups = resolvePlanGroups(plan, twoCampaignIndex());
    const alpha = groups.find((g) => g.slug === "alpha")!;
    expect(alpha.sections.rewrites).toHaveLength(1);
    const unresolvedGroup = groups.find((g) => g.slug === "");
    expect(unresolvedGroup?.unresolvedIds).toEqual([{ kind: "adId", id: "9999" }]);
  });

  it("an entirely-unresolvable campaign (missing state file) reports every id as unresolved, no slug", () => {
    const plan = {
      campaignStatus: [{ campaignId: "999", status: "ENABLED" }],
      rewrites: [{ adId: "1234", headlines: ["h"] }],
    };
    const groups = resolvePlanGroups(plan, emptyIndex());
    expect(groups).toHaveLength(1);
    expect(groups[0]!.slug).toBe("");
    expect(groups[0]!.unresolvedIds).toEqual(
      expect.arrayContaining([
        { kind: "campaignId", id: "999" },
        { kind: "adId", id: "1234" },
      ]),
    );
  });

  it("returns [] for an empty plan against an empty index", () => {
    expect(resolvePlanGroups({}, emptyIndex())).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// applyPlanToBrief
// ---------------------------------------------------------------------------

describe("applyPlanToBrief", () => {
  function groupFor(plan: Record<string, unknown>): ReturnType<typeof resolvePlanGroups>[number] {
    const groups = resolvePlanGroups(plan, twoCampaignIndex());
    return groups.find((g) => g.slug === "alpha")!;
  }

  it("a rewrite replaces the targeted ad group's headlines/descriptions", () => {
    const plan = {
      rewrites: [
        {
          adId: "1111",
          headlines: Array.from({ length: 15 }, (_, i) => `new headline ${i}`),
          descriptions: Array.from({ length: 4 }, (_, i) => `new description ${i}`),
        },
      ],
    };
    const result = applyPlanToBrief(baseBrief(), groupFor(plan));
    expect(result.adGroups[0]!.responsiveSearchAds[0]!.headlines.map((h) => h.text)).toEqual(
      Array.from({ length: 15 }, (_, i) => `new headline ${i}`),
    );
    expect(result.adGroups[0]!.responsiveSearchAds[0]!.descriptions.map((d) => d.text)).toEqual(
      Array.from({ length: 4 }, (_, i) => `new description ${i}`),
    );
  });

  it("a rewrite targets ONLY the rsaIndex its adId resolved to — the ad group's other RSA is untouched", () => {
    // adId "1111" resolves to rsaIndex 0 (see twoCampaignIndex); responsiveSearchAds[1]
    // must survive byte-for-byte, proving the rewrite didn't fall back to "whole ad
    // group" now that an ad group carries RSAS_PER_AD_GROUP entries.
    const plan = {
      rewrites: [
        {
          adId: "1111",
          headlines: Array.from({ length: 15 }, (_, i) => `new headline ${i}`),
          descriptions: Array.from({ length: 4 }, (_, i) => `new description ${i}`),
        },
      ],
    };
    const base = baseBrief();
    const result = applyPlanToBrief(base, groupFor(plan));
    expect(result.adGroups[0]!.responsiveSearchAds[1]).toEqual(base.adGroups[0]!.responsiveSearchAds[1]);
  });

  it("appendHeadlines merges new headlines and dedups case-sensitively against existing brief headlines", () => {
    const plan = { appendHeadlines: [{ adId: "1111", add: ["headline 0", "Headline 0", "brand new headline"] }] };
    const result = applyPlanToBrief(baseBrief(), groupFor(plan));
    const texts = result.adGroups[0]!.responsiveSearchAds[0]!.headlines.map((h) => h.text);
    expect(texts).toContain("brand new headline");
    expect(texts).toContain("Headline 0"); // different case is NOT a duplicate — case-sensitive dedup
    expect(texts.filter((t) => t === "headline 0")).toHaveLength(1); // exact match deduped
  });

  it("negatives append fresh negatives, deduped against the brief's existing negativeKeywords", () => {
    const plan = { negatives: [{ campaignId: "100", add: ["free", "existing"] }] };
    const brief = baseBrief({
      campaign: {
        ...baseBrief().campaign,
        negativeKeywords: [{ text: "existing", matchType: "PHRASE" }],
      },
    });
    const result = applyPlanToBrief(brief, groupFor(plan));
    expect(result.campaign.negativeKeywords).toEqual([
      { text: "existing", matchType: "PHRASE" },
      { text: "free", matchType: "PHRASE" },
    ]);
  });

  it("keywords add + remove edits the targeted ad group's keyword list", () => {
    const plan = {
      keywords: [{ adGroupId: "111", add: ["new kw"], remove: ["existing keyword"] }],
    };
    const result = applyPlanToBrief(baseBrief(), groupFor(plan));
    const kws = result.adGroups[0]!.keywords.map((k) => k.text);
    expect(kws).toEqual(["new kw"]);
  });

  it("sitelinks/callouts append and dedup against existing brief content", () => {
    const plan = {
      sitelinks: [{ campaignId: "100", add: [{ text: "New Link", finalUrl: "https://example.com/l" }] }],
      callouts: [{ campaignId: "100", add: ["No new portal", "No new portal"] }],
    };
    const result = applyPlanToBrief(baseBrief(), groupFor(plan));
    expect(result.campaign.sitelinks).toEqual([{ text: "New Link", finalUrl: "https://example.com/l" }]);
    expect(result.campaign.callouts).toEqual(["No new portal"]);
  });

  it("budgets set campaign.budgetMicros from the plan's dailyMicros", () => {
    const plan = { budgets: [{ campaignId: "100", dailyMicros: 40_000_000 }] };
    const result = applyPlanToBrief(baseBrief(), groupFor(plan));
    expect(result.campaign.budgetMicros).toBe(40_000_000);
  });

  it("bidding stages bidStrategy and cpcBidCeilingMicros from the plan block", () => {
    const plan = {
      bidding: [{ campaignId: "100", strategy: "maximize-clicks", cpcBidCeilingMicros: 5_500_000 }],
    };
    const result = applyPlanToBrief(baseBrief(), groupFor(plan));
    expect(result.campaign.bidStrategy).toBe("maximize-clicks");
    expect(result.campaign.cpcBidCeilingMicros).toBe(5_500_000);
  });

  it("bidding switching away from maximize-clicks clears a previously staged ceiling", () => {
    const brief = baseBrief({
      campaign: {
        ...baseBrief().campaign,
        bidStrategy: "maximize-clicks",
        cpcBidCeilingMicros: 4_000_000,
      },
    });
    const plan = { bidding: [{ campaignId: "100", strategy: "maximize-conversions" }] };
    const result = applyPlanToBrief(brief, groupFor(plan));
    expect(result.campaign.bidStrategy).toBe("maximize-conversions");
    expect(result.campaign.cpcBidCeilingMicros).toBeUndefined();
  });

  it("no bidding blocks leaves campaign.bidStrategy/cpcBidCeilingMicros unchanged", () => {
    const brief = baseBrief();
    const plan = { budgets: [{ campaignId: "100", dailyMicros: 40_000_000 }] };
    const result = applyPlanToBrief(brief, groupFor(plan));
    expect(result.campaign.bidStrategy).toBe(brief.campaign.bidStrategy);
    expect(result.campaign.cpcBidCeilingMicros).toBe(brief.campaign.cpcBidCeilingMicros);
  });

  it("bidding stages bidStrategy and targetCpaMicros for target-cpa (spec.md 048)", () => {
    const plan = {
      bidding: [{ campaignId: "100", strategy: "target-cpa", targetCpaMicros: 12_000_000 }],
    };
    const result = applyPlanToBrief(baseBrief(), groupFor(plan));
    expect(result.campaign.bidStrategy).toBe("target-cpa");
    expect(result.campaign.targetCpaMicros).toBe(12_000_000);
  });

  it("bidding stages bidStrategy and targetRoas for target-roas (spec.md 048)", () => {
    const plan = {
      bidding: [{ campaignId: "100", strategy: "target-roas", targetRoas: 3.5 }],
    };
    const result = applyPlanToBrief(baseBrief(), groupFor(plan));
    expect(result.campaign.bidStrategy).toBe("target-roas");
    expect(result.campaign.targetRoas).toBe(3.5);
  });

  it("bidding switching away from target-cpa/target-roas clears their companion fields", () => {
    const brief = baseBrief({
      campaign: {
        ...baseBrief().campaign,
        bidStrategy: "target-cpa",
        targetCpaMicros: 12_000_000,
      },
    });
    const plan = { bidding: [{ campaignId: "100", strategy: "maximize-clicks" }] };
    const result = applyPlanToBrief(brief, groupFor(plan));
    expect(result.campaign.bidStrategy).toBe("maximize-clicks");
    expect(result.campaign.targetCpaMicros).toBeUndefined();
  });

  it("bidding switching away from target-roas to maximize-clicks clears targetRoas", () => {
    const brief = baseBrief({
      campaign: {
        ...baseBrief().campaign,
        bidStrategy: "target-roas",
        targetRoas: 3.5,
      },
    });
    const plan = { bidding: [{ campaignId: "100", strategy: "maximize-clicks" }] };
    const result = applyPlanToBrief(brief, groupFor(plan));
    expect(result.campaign.bidStrategy).toBe("maximize-clicks");
    expect(result.campaign.targetRoas).toBeUndefined();
  });

  it("bidding switching directly between target-cpa and target-roas clears the old companion field and sets the new one", () => {
    const brief = baseBrief({
      campaign: {
        ...baseBrief().campaign,
        bidStrategy: "target-cpa",
        targetCpaMicros: 12_000_000,
      },
    });
    const plan = { bidding: [{ campaignId: "100", strategy: "target-roas", targetRoas: 3.5 }] };
    const result = applyPlanToBrief(brief, groupFor(plan));
    expect(result.campaign.bidStrategy).toBe("target-roas");
    expect(result.campaign.targetRoas).toBe(3.5);
    expect(result.campaign.targetCpaMicros).toBeUndefined();
  });

  it("adGroups create appends a new ad group not already present by name", () => {
    const plan = { adGroups: [{ campaignId: "100", adGroup: { name: "placeholder" } }] };
    const created: AdGroupCreatePlanEntry = {
      campaignId: "100",
      name: "new-group",
      adGroup: {
        name: "new-group",
        defaultBidMicros: 2_000_000,
        responsiveSearchAds: [rsaFixture(0), rsaFixture(1)],
        keywords: [{ text: "kw", matchType: "PHRASE" }],
        aiMax: false,
      },
    };
    const computed: ApplyPlanComputed = { adGroupCreates: [created] };
    const result = applyPlanToBrief(baseBrief(), groupFor(plan), computed);
    expect(result.adGroups.map((ag) => ag.name)).toEqual(["widgets", "new-group"]);
  });

  it("adGroups create is trusted from computed.adGroupCreates even when a same-name (case-insensitive) ad group already sits in the on-disk brief (staging-drift regression)", () => {
    // Regression: the old code filtered computed.adGroupCreates against the ON-DISK
    // BRIEF's existing ad-group names, a DIFFERENT source of truth than the LIVE names
    // addAdGroupsPlan already filtered against. A stale/hand-edited brief name that
    // doesn't exist live must not cause the genuinely-new live ad group to be silently
    // dropped from staging.
    const brief = baseBrief({
      adGroups: [
        ...baseBrief().adGroups,
        {
          name: "Stale Group",
          defaultBidMicros: 1_000_000,
          responsiveSearchAds: [
            {
              headlines: Array.from({ length: 15 }, (_, i) => ({ text: `stale headline ${i}` })),
              descriptions: Array.from({ length: 4 }, (_, i) => ({ text: `stale description ${i}` })),
              finalUrl: "https://example.com/stale",
            },
            {
              headlines: Array.from({ length: 15 }, (_, i) => ({ text: `stale alt headline ${i}` })),
              descriptions: Array.from({ length: 4 }, (_, i) => ({ text: `stale alt description ${i}` })),
              finalUrl: "https://example.com/stale",
            },
          ],
          keywords: [{ text: "stale keyword", matchType: "PHRASE" }],
          aiMax: false,
        },
      ],
    });
    const plan = { adGroups: [{ campaignId: "100", adGroup: { name: "placeholder" } }] };
    const created: AdGroupCreatePlanEntry = {
      campaignId: "100",
      name: "stale group", // case-insensitively matches the brief's existing "Stale Group"
      adGroup: {
        name: "stale group",
        defaultBidMicros: 2_000_000,
        responsiveSearchAds: [rsaFixture(0), rsaFixture(1)],
        keywords: [{ text: "kw", matchType: "PHRASE" }],
        aiMax: false,
      },
    };
    const computed: ApplyPlanComputed = { adGroupCreates: [created] };
    const result = applyPlanToBrief(brief, groupFor(plan), computed);
    // Pre-fix: the brief-name filter would have dropped the create, leaving only 1.
    expect(result.adGroups.filter((ag) => ag.name.toLowerCase() === "stale group")).toHaveLength(2);
  });

  it("two rewrite blocks targeting the same ad group: the staged brief reflects the LAST block (mirrors live's last-wins mutation order)", () => {
    const plan = {
      rewrites: [
        {
          adId: "1111",
          headlines: Array.from({ length: 15 }, (_, i) => `first headline ${i}`),
          descriptions: Array.from({ length: 4 }, (_, i) => `first description ${i}`),
        },
        {
          adId: "1111",
          headlines: Array.from({ length: 15 }, (_, i) => `second headline ${i}`),
          descriptions: Array.from({ length: 4 }, (_, i) => `second description ${i}`),
        },
      ],
    };
    const result = applyPlanToBrief(baseBrief(), groupFor(plan));
    expect(result.adGroups[0]!.responsiveSearchAds[0]!.headlines.map((h) => h.text)).toEqual(
      Array.from({ length: 15 }, (_, i) => `second headline ${i}`),
    );
  });

  it("a no-op change-list leaves the result serialization-identical to base (FR-011)", () => {
    const brief = baseBrief();
    const plan = {}; // touches nothing
    const groups = resolvePlanGroups(plan, twoCampaignIndex());
    expect(groups).toEqual([]);
    // With no group at all there is nothing to apply — applyPlanToBrief is only ever
    // called for a resolved group, so simulate the "resolved but empty" case directly.
    const emptyGroup = { slug: "alpha", campaignName: "Alpha", sections: { rewrites: [], appendHeadlines: [], sitelinks: [], callouts: [], negatives: [], keywords: [], budgets: [], bidding: [], adGroups: [], addRsa: [] }, unresolvedIds: [] };
    const result = applyPlanToBrief(brief, emptyGroup);
    expect(result).toEqual(brief);
  });
});

// ---------------------------------------------------------------------------
// addRsa staging
// ---------------------------------------------------------------------------

describe("addRsa staging", () => {
  function groupFor(plan: Record<string, unknown>): ReturnType<typeof resolvePlanGroups>[number] {
    const groups = resolvePlanGroups(plan, twoCampaignIndex());
    return groups.find((g) => g.slug === "alpha")!;
  }

  /** "widgets" ad group with only 1 live RSA — the under-2 addRsa target case. */
  function oneRsaBrief(): Brief {
    return baseBrief({
      adGroups: [
        {
          name: "widgets",
          defaultBidMicros: 1_500_000,
          responsiveSearchAds: [rsaFixture(0)],
          keywords: [{ text: "existing keyword", matchType: "PHRASE" }],
          aiMax: false,
        },
      ],
    });
  }

  it("a resolved addRsa block appends the new RSA, producing a brief that re-parses against BriefSchema with exactly 2 entries (SC-004)", () => {
    const plan = { addRsa: [{ adGroupId: "111", headlines: [], descriptions: [] }] };
    const created: AddRsaCreatePlanEntry = { adGroupId: "111", rsa: rsaFixture(1) };
    const computed: ApplyPlanComputed = { addRsaCreates: [created] };
    const result = applyPlanToBrief(oneRsaBrief(), groupFor(plan), computed);
    expect(result.adGroups[0]!.responsiveSearchAds).toHaveLength(2);
    expect(result.adGroups[0]!.responsiveSearchAds[1]).toEqual(rsaFixture(1));
    expect(() => BriefSchema.parse(result)).not.toThrow();
  });

  it("an addRsa block whose adGroupId does not resolve to any tracked brief slug produces no brief change and surfaces via unresolvedIds (FR-012)", () => {
    const plan = { addRsa: [{ adGroupId: "999", headlines: [], descriptions: [] }] };
    const groups = resolvePlanGroups(plan, twoCampaignIndex());
    const unresolvedGroup = groups.find((g) => g.slug === "");
    expect(unresolvedGroup?.unresolvedIds).toEqual([{ kind: "adGroupId", id: "999" }]);
    expect(groups.find((g) => g.slug === "alpha")).toBeUndefined();
  });

  it("an addRsa block with no matching computed.addRsaCreates entry leaves the ad group untouched", () => {
    const plan = { addRsa: [{ adGroupId: "111", headlines: [], descriptions: [] }] };
    const result = applyPlanToBrief(oneRsaBrief(), groupFor(plan), {});
    expect(result.adGroups[0]!.responsiveSearchAds).toHaveLength(1);
  });

  it("stages the new RSA even when the brief file's on-disk responsiveSearchAds already shows RSAS_PER_AD_GROUP entries, as long as computed.addRsaCreates has a matching create — a stale local count must never override the live-derived create (regression)", () => {
    // `baseBrief()` already carries 2 on-disk RSAs for "widgets" (drifted/stale
    // relative to live, which addRsaPlan says actually had only 1) — the exact
    // "brief already shows 2 locally" drift scenario the removed
    // `responsiveSearchAds.length < RSAS_PER_AD_GROUP` gate used to mishandle by
    // silently dropping the newly-created live RSA instead of staging it.
    const plan = { addRsa: [{ adGroupId: "111", headlines: [], descriptions: [] }] };
    const created: AddRsaCreatePlanEntry = { adGroupId: "111", rsa: rsaFixture(2) };
    const computed: ApplyPlanComputed = { addRsaCreates: [created] };
    const result = applyPlanToBrief(baseBrief(), groupFor(plan), computed);
    expect(result.adGroups[0]!.responsiveSearchAds).toHaveLength(3);
    expect(result.adGroups[0]!.responsiveSearchAds[2]).toEqual(rsaFixture(2));
  });
});
