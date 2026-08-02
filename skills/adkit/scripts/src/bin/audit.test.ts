/**
 * Shell-level tests for bin/audit.ts — the IO entry point.
 *
 * The pure scoring/detection logic lives in audit/scoring.ts and is exercised by
 * scoring.test.ts. These tests cover the shell: read-only + me-too behavior,
 * campaign-name resolution, the two landing-page helpers, and the requireDigits
 * guard. A FAKE AdsClient returns canned rows keyed on GAQL substrings (matching
 * audit_test.py's `"FROM ad_group_ad" in query` approach).
 *
 * Ported from ads_skill/bin/audit_test.py, plus the dynamic
 * --differentiation-profile wiring: the me-too test passes a small profile so a
 * finding is produced (the Python baked in a single-advertiser constant).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AdsClient, AdsMutateOperation, MutateResult } from "../lib/auth.js";
import { toGaql, type SearchArgs } from "../gaql/search-args.js";
import { parseDifferentiationProfile } from "../lib/brand.js";
import { MIN_KEYWORDS, requireDigits } from "../audit/scoring.js";
import { diffNewCompetitors, updateCache, EMPTY_CACHE } from "../audit/auction-insights-cache.js";
import {
  auditCampaign,
  averageCpc,
  campaignAuctionInsights,
  campaignServing,
  isManagerMetricsError,
  keywordCpc,
  landingPageMobile,
  landingPagePolicy,
  loadAuctionInsightsCache,
  qualityScore,
  resolveAuditCustomer,
  resolveCampaign,
  resolvePsiKey,
  saveAuctionInsightsCache,
  searchTerms,
  withAuctionInsightFindings,
} from "./audit.js";
import type { KeywordCpc } from "../audit/types.js";

/** Build a fake AdsClient whose reads pick canned rows by GAQL substring. */
function fakeClient(pick: (query: string) => unknown[], onSearch?: () => void): AdsClient {
  return {
    async search<Row = Record<string, unknown>>(_customerId: string, query: string): Promise<Row[]> {
      onSearch?.();
      return pick(query) as Row[];
    },
    // audit's reads now flow through searchStructured; delegate through toGaql so the
    // canned-row picks keep matching on the exact GAQL string (toGaql reproduces it).
    async searchStructured<Row = Record<string, unknown>>(
      _customerId: string,
      args: SearchArgs,
    ): Promise<Row[]> {
      onSearch?.();
      return pick(toGaql(args)) as Row[];
    },
    async mutate(_customerId: string, _operations: AdsMutateOperation[]): Promise<MutateResult> {
      throw new Error("audit must be read-only — no mutate calls");
    },
  };
}

describe("resolveAuditCustomer (bug 4: MCC/leaf resolution)", () => {
  const yamlMcc = () => "9999999999"; // yaml has only a login_customer_id (an MCC)

  it("prefers the --customer flag", () => {
    const got = resolveAuditCustomer({ customer: "1234567890" }, { GOOGLE_ADS_CUSTOMER_ID: "2222222222" }, {
      yamlLookup: yamlMcc,
    });
    expect(got).toBe("1234567890");
  });

  it("uses GOOGLE_ADS_CUSTOMER_ID (the leaf) instead of falling back to the yaml MCC", () => {
    // The reported bug: no flag, leaf exported, yaml only has the MCC login id.
    // Must resolve to the leaf, NOT the manager account.
    const got = resolveAuditCustomer({ customer: null }, { GOOGLE_ADS_CUSTOMER_ID: "1111111111" }, {
      yamlLookup: yamlMcc,
    });
    expect(got).toBe("1111111111");
  });

  it("falls back to the yaml only when neither flag nor env is set", () => {
    const got = resolveAuditCustomer({ customer: null }, {}, { yamlLookup: yamlMcc });
    expect(got).toBe("9999999999");
  });

  it("dash-strips a flag value", () => {
    const got = resolveAuditCustomer({ customer: "111-111-1111" }, {}, { yamlLookup: () => null });
    expect(got).toBe("1111111111");
  });
});

describe("isManagerMetricsError (bug 4)", () => {
  it("detects the query_error 59 manager-account rejection", () => {
    const err = {
      errors: [{ error_code: { query_error: 59 }, message: "Metrics cannot be requested for a manager account." }],
    };
    expect(isManagerMetricsError(err)).toBe(true);
  });

  it("ignores unrelated errors", () => {
    expect(isManagerMetricsError(new Error("some other failure"))).toBe(false);
  });
});

describe("averageCpc (click-weighted campaign CPC baseline)", () => {
  function kwCpc(avg_cpc: number, impressions: number, ctr: number): KeywordCpc {
    return { text: "x", avg_cpc, avg_cpc_micros: avg_cpc * 1_000_000, impressions, ctr, adGroupId: null, matchType: null };
  }

  it("weights by clicks (impressions * ctr), not a flat per-keyword average", () => {
    // $1 keyword with 100 clicks, $10 keyword with 1 click -> ~$1.09, not $5.50.
    const out = averageCpc([kwCpc(1, 100, 1.0), kwCpc(10, 1, 1.0)]);
    expect(out).toBeCloseTo(1.09, 2);
  });

  it("falls back to the unweighted mean when no priced keyword has impressions", () => {
    const out = averageCpc([kwCpc(2, 0, 0), kwCpc(4, 0, 0)]);
    expect(out).toBe(3);
  });

  it("ignores unpriced (avg_cpc=0) keywords and returns 0 (unknown) when none are priced", () => {
    expect(averageCpc([kwCpc(0, 100, 1.0)])).toBe(0);
    expect(averageCpc([])).toBe(0);
  });
});

describe("requireDigits guard", () => {
  it("throws on a non-digit id (injection guard runs in the shell)", () => {
    expect(() => requireDigits("--campaign", "1; DROP TABLE")).toThrow();
  });

  it("allows a null id", () => {
    expect(() => requireDigits("--campaign", null)).not.toThrow();
  });
});

describe("auditCampaign", () => {
  it("is read-only and flags me-too copy against a differentiation profile", async () => {
    // one ad group, one ad whose copy is a generic AI promise; no extensions.
    const adRow = {
      ad_group: { name: "AiChatbot" },
      ad_group_ad: {
        ad: {
          id: 10,
          final_urls: ["https://x"],
          responsive_search_ad: {
            headlines: [{ text: "AI Writer", pinned_field: "UNSPECIFIED" }],
            descriptions: [{ text: "Best AI chatbot", pinned_field: "UNSPECIFIED" }],
          },
        },
        ad_strength: "GOOD",
        status: "ENABLED",
        action_items: [],
      },
    };

    let searches = 0;
    // ad-group-ad query returns our single ad; ext-count queries return nothing.
    const client = fakeClient(
      (query) => (query.includes("FROM ad_group_ad") ? [adRow] : []),
      () => {
        searches += 1;
      },
    );

    // dynamic profile: generic phrase present, and two axes the copy misses.
    const profile = parseDifferentiationProfile({
      genericPhrases: ["ai chatbot"],
      axes: [
        { name: "accuracy", triggers: ["accurate", "citations"] },
        { name: "privacy", triggers: ["private", "on-device"] },
      ],
    });

    const camp = { campaign: { id: 1, name: "x", status: "ENABLED" } };
    const result = await auditCampaign(client, "123", camp, [], { AiChatbot: ["ai chatbot"] }, profile);

    expect(searches).toBeGreaterThan(0);
    // the ad itself is flagged as undifferentiated me-too copy
    expect(
      result.ads.some((a) => a.issues.some((i) => i.issue === "undifferentiated_copy")),
    ).toBe(true);
    // the finding names the absent axes
    const diff = result.ads[0].issues.find((i) => i.issue === "undifferentiated_copy");
    expect(diff?.missingAxes).toEqual(["accuracy", "privacy"]);
    // full asset TEXT is surfaced (not just counts) so /adkit update can preserve good copy
    const ad = result.ads[0];
    expect(ad.headlines).toEqual(["AI Writer"]);
    expect(ad.descriptions).toEqual(["Best AI chatbot"]);
  });

  it("does not flag me-too copy under the empty profile", async () => {
    const adRow = {
      ad_group: { name: "AiChatbot" },
      ad_group_ad: {
        ad: {
          id: 10,
          final_urls: ["https://x"],
          responsive_search_ad: {
            headlines: [{ text: "AI Writer", pinned_field: "UNSPECIFIED" }],
            descriptions: [{ text: "Best AI chatbot", pinned_field: "UNSPECIFIED" }],
          },
        },
        ad_strength: "GOOD",
        status: "ENABLED",
        action_items: [],
      },
    };
    const client = fakeClient((query) => (query.includes("FROM ad_group_ad") ? [adRow] : []));
    const camp = { campaign: { id: 1, name: "x", status: "ENABLED" } };
    const result = await auditCampaign(client, "123", camp, [], { AiChatbot: ["ai chatbot"] }, {
      competitors: [],
      axes: [],
      genericPhrases: [],
    });
    expect(
      result.ads.some((a) => a.issues.some((i) => i.issue === "undifferentiated_copy")),
    ).toBe(false);
  });
});

describe("auditCampaign keyword-count finding", () => {
  const emptyProfile = { competitors: [], axes: [], genericPhrases: [] };
  const camp = { campaign: { id: 1, name: "x", status: "ENABLED" } };
  // no ads and no extensions — this test isolates the keyword-count check
  const client = fakeClient(() => []);

  it("flags a campaign with fewer than MIN_KEYWORDS, counting across ad groups", async () => {
    const agKeywords = { AiChatbot: ["a", "b"], Brand: ["c"] }; // 3 total
    const result = await auditCampaign(client, "123", camp, [], agKeywords, emptyProfile);
    expect(result.keywords).toBe(3);
    const finding = result.campaignFindings.find((f) => f.issue === "keywords_under");
    expect(finding).toBeDefined();
    expect(finding?.need).toBe(MIN_KEYWORDS - 3);
    expect(finding?.detail).toContain(`3/${MIN_KEYWORDS}`);
  });

  it("does not flag a campaign at or above MIN_KEYWORDS", async () => {
    const agKeywords = { AiChatbot: Array.from({ length: MIN_KEYWORDS }, (_, i) => `kw${i}`) };
    const result = await auditCampaign(client, "123", camp, [], agKeywords, emptyProfile);
    expect(result.keywords).toBe(MIN_KEYWORDS);
    expect(result.campaignFindings.some((f) => f.issue === "keywords_under")).toBe(false);
  });
});

describe("auditCampaign RSA-count-per-ad-group finding (issue #175)", () => {
  const emptyProfile = { competitors: [], axes: [], genericPhrases: [] };
  const camp = { campaign: { id: 1, name: "x", status: "ENABLED" } };

  /** One ad_group_ad row for `adGroupName`, minimal but scoreAd-safe. */
  const adRow = (adGroupName: string) => ({
    ad_group: { name: adGroupName },
    ad_group_ad: {
      ad: {
        id: 10,
        final_urls: ["https://x"],
        responsive_search_ad: {
          headlines: Array.from({ length: 15 }, (_, i) => ({ text: `H${i}`, pinned_field: "UNSPECIFIED" })),
          descriptions: Array.from({ length: 4 }, (_, i) => ({ text: `D${i}`, pinned_field: "UNSPECIFIED" })),
        },
      },
      ad_strength: "EXCELLENT",
      status: "ENABLED",
      action_items: [],
    },
  });

  it("flags an ad group with only 1 enabled RSA", async () => {
    const client = fakeClient((query) => (query.includes("FROM ad_group_ad") ? [adRow("Widgets")] : []));
    const result = await auditCampaign(client, "123", camp, [], {}, emptyProfile);
    const finding = result.campaignFindings.find((f) => f.issue === "rsa_count_mismatch");
    expect(finding).toBeDefined();
    expect(finding?.detail).toContain("Widgets");
    expect(finding?.detail).toContain("1/2");
  });

  it("does not flag an ad group with exactly 2 enabled RSAs", async () => {
    const client = fakeClient((query) =>
      query.includes("FROM ad_group_ad") ? [adRow("Widgets"), adRow("Widgets")] : [],
    );
    const result = await auditCampaign(client, "123", camp, [], {}, emptyProfile);
    expect(result.campaignFindings.some((f) => f.issue === "rsa_count_mismatch")).toBe(false);
  });

  it("flags an ad group with 3 enabled RSAs (over the target, not just under)", async () => {
    const client = fakeClient((query) =>
      query.includes("FROM ad_group_ad") ? [adRow("Widgets"), adRow("Widgets"), adRow("Widgets")] : [],
    );
    const result = await auditCampaign(client, "123", camp, [], {}, emptyProfile);
    const finding = result.campaignFindings.find((f) => f.issue === "rsa_count_mismatch");
    expect(finding).toBeDefined();
    expect(finding?.detail).toContain("3/2");
  });

  it("counts each ad group independently — one mismatched, one correct", async () => {
    const client = fakeClient((query) =>
      query.includes("FROM ad_group_ad") ? [adRow("Widgets"), adRow("Gadgets"), adRow("Gadgets")] : [],
    );
    const result = await auditCampaign(client, "123", camp, [], {}, emptyProfile);
    const mismatches = result.campaignFindings.filter((f) => f.issue === "rsa_count_mismatch");
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]?.detail).toContain("Widgets");
  });

  it("does not double-flag a 2-RSA ad group when a REMOVED 3rd RSA is excluded", async () => {
    // auditAdGroupAdQuery constrains ad_group_ad.status != REMOVED at the query
    // boundary (PAUSED still counts — /adkit create always publishes RSAs
    // PAUSED), so a fake returning only 2 rows models a REMOVED 3rd RSA never
    // appearing in these rows: a 2-RSA ad group is not flagged.
    const client = fakeClient((query) =>
      query.includes("FROM ad_group_ad") ? [adRow("Widgets"), adRow("Widgets")] : [],
    );
    const result = await auditCampaign(client, "123", camp, [], {}, emptyProfile);
    expect(result.campaignFindings.some((f) => f.issue === "rsa_count_mismatch")).toBe(false);
  });

  it("flags a live ad group with zero RSAs — it never appears in the ad_group_ad rows", async () => {
    // A group with no non-removed RSAs returns no ad_group_ad row at all, so the
    // count can only come from an independent ad-group list (applyAdGroupNamesQuery).
    const client = fakeClient((query) => {
      if (query.includes("FROM ad_group_ad")) return [adRow("Gadgets"), adRow("Gadgets")];
      if (query.includes("FROM ad_group WHERE")) {
        return [{ ad_group: { name: "Widgets" } }, { ad_group: { name: "Gadgets" } }];
      }
      return [];
    });
    const result = await auditCampaign(client, "123", camp, [], {}, emptyProfile);
    const mismatches = result.campaignFindings.filter((f) => f.issue === "rsa_count_mismatch");
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]?.detail).toContain("Widgets");
    expect(mismatches[0]?.detail).toContain("0/2");
  });
});

// The Google Ads API omits empty nested messages and zero-valued metric fields
// from `search` rows entirely. A healthy account routinely returns keywords/ads/
// search-terms/criteria with a missing metrics/quality_info/policy_summary/
// responsive_search_ad. The boundary normalizers must absorb every such gap so the
// audit produces findings instead of throwing a bare TypeError mid-run.
describe("boundary normalizers absorb API-omitted nested fields", () => {
  // Non-RSA ads are excluded at the query boundary (auditAdGroupAdQuery constrains
  // ad_group_ad.ad.type), so scoring never fabricates empty RSA assets for them. This
  // asserts the normalizer's remaining job: a genuine RSA whose headlines/descriptions
  // the API omitted still parses to 0H/0D and is flagged as under-filled, not crashed.
  it("auditCampaign: an RSA with omitted asset lists scores as 0H/0D, no throw", async () => {
    const rsaMissingAssets = {
      ad_group: { name: "AiChatbot" },
      ad_group_ad: {
        ad: { id: 10, final_urls: ["https://x"] }, // responsive_search_ad omitted by the API
        ad_strength: "PENDING",
        status: "ENABLED",
      },
    };
    const client = fakeClient((query) => (query.includes("FROM ad_group_ad") ? [rsaMissingAssets] : []));
    const camp = { campaign: { id: 1, name: "x", status: "ENABLED" } };
    const result = await auditCampaign(client, "123", camp, [], {}, {
      competitors: [],
      axes: [],
      genericPhrases: [],
    });
    expect(result.ads).toHaveLength(1);
    expect(result.ads[0].headlines).toEqual([]);
    expect(result.ads[0].descriptions).toEqual([]);
    // an empty RSA is under-filled on both axes rather than crashing the parse
    const issues = result.ads[0].issues.map((i) => i.issue);
    expect(issues).toContain("headlines_under");
    expect(issues).toContain("descriptions_under");
  });

  it("campaignServing: a row with no metrics scores zero_impressions, no throw", async () => {
    const rows = [
      {
        campaign: { id: 1, name: "starved", bidding_strategy_type: "MAXIMIZE_CONVERSIONS" },
        campaign_budget: {}, // no amount_micros
        // no metrics
      },
    ];
    const result = await campaignServing(fakeClient(() => rows), "123", 7, true, null);
    expect(result).toHaveLength(1);
    expect(result[0].impressions).toBe(0);
    expect(result[0].budgetMicros).toBe(0);
    expect(result[0].flags).toContain("zero_impressions");
  });

  it("campaignAuctionInsights: groups rows by campaign, sorted by impression share descending", async () => {
    const rows = [
      {
        campaign: { id: 1 },
        auction_insight_domain: { domain: "low.com" },
        metrics: {
          auction_insight_search_impression_share: 0.1,
          auction_insight_search_overlap_rate: 0.1,
          auction_insight_search_position_above_rate: 0.1,
          auction_insight_search_top_impression_percentage: 0.1,
          auction_insight_search_outranking_share: 0.1,
        },
      },
      {
        campaign: { id: 1 },
        auction_insight_domain: { domain: "high.com" },
        metrics: {
          auction_insight_search_impression_share: 0.9,
          auction_insight_search_overlap_rate: 0.2,
          auction_insight_search_position_above_rate: 0.2,
          auction_insight_search_top_impression_percentage: 0.2,
          auction_insight_search_outranking_share: 0.72,
        },
      },
    ];
    const result = await campaignAuctionInsights(fakeClient(() => rows), "123", 7, [1]);
    expect(result[1].map((r) => r.domain)).toEqual(["high.com", "low.com"]);
  });

  it("campaignAuctionInsights: no campaign ids -> no query, empty map", async () => {
    let called = false;
    const result = await campaignAuctionInsights(
      fakeClient(() => [], () => {
        called = true;
      }),
      "123",
      7,
      [],
    );
    expect(result).toEqual({});
    expect(called).toBe(false);
  });

  it("withAuctionInsightFindings: adds losing_to_competitor only when rank_constrained + >60% outranking", () => {
    const base: Parameters<typeof withAuctionInsightFindings>[0] = {
      campaignId: 1,
      campaignName: "acme",
      bidStrategy: "MAXIMIZE_CONVERSIONS",
      budgetMicros: 0,
      impressions: 1000,
      conversions: 1,
      searchImpressionShare: 0.5,
      lostISBudget: 0,
      lostISRank: 0.2,
      flags: ["rank_constrained"],
      impressionShareRecs: [],
    };
    const domains = [
      {
        campaignId: 1,
        domain: "beatsyou.com",
        impressionShare: 0.5,
        overlapRate: 0.5,
        positionAboveRate: 0.5,
        topOfPageRate: 0.5,
        outrankingShare: 0.71,
      },
    ];
    const result = withAuctionInsightFindings(base, domains, []);
    expect(result.flags).toContain("losing_to_competitor");
    expect(result.impressionShareRecs.some((r) => r.includes("beatsyou.com"))).toBe(true);

    const notConstrained = withAuctionInsightFindings({ ...base, flags: [] }, domains, []);
    expect(notConstrained.flags).not.toContain("losing_to_competitor");
  });

  it("withAuctionInsightFindings: adds new_competitor when the cache diff reports new domains", () => {
    const base: Parameters<typeof withAuctionInsightFindings>[0] = {
      campaignId: 1,
      campaignName: "acme",
      bidStrategy: "MAXIMIZE_CONVERSIONS",
      budgetMicros: 0,
      impressions: 1000,
      conversions: 1,
      searchImpressionShare: 0.5,
      lostISBudget: 0,
      lostISRank: 0,
      flags: [],
      impressionShareRecs: [],
    };
    const result = withAuctionInsightFindings(base, [], ["newcomer.com"]);
    expect(result.flags).toContain("new_competitor");
    expect(result.impressionShareRecs.some((r) => r.includes("newcomer.com"))).toBe(true);

    const noNew = withAuctionInsightFindings(base, [], []);
    expect(noNew).toBe(base); // unchanged input returned as-is, no new object
  });

  it("keywordCpc: a keyword with no spend (no metrics) reads avg_cpc 0, no throw", async () => {
    const rows = [
      {
        campaign: { id: 1 },
        ad_group_criterion: { keyword: { text: "widget" } },
        // no metrics
      },
    ];
    const result = await keywordCpc(fakeClient(() => rows), "123", 7, [1]);
    expect(result[1]).toHaveLength(1);
    expect(result[1][0].avg_cpc).toBe(0);
    expect(result[1][0].avg_cpc_micros).toBe(0);
    // impressions + ctr zero-fill when the API omits metrics.
    expect(result[1][0].impressions).toBe(0);
    expect(result[1][0].ctr).toBe(0);
    // API-omitted ad_group / match_type degrade to an honest null, never a bogus id 0.
    expect(result[1][0].adGroupId).toBeNull();
    expect(result[1][0].matchType).toBeNull();
  });

  it("searchTerms: a term with no metrics reads all-zero aggregates, no throw", async () => {
    const rows = [
      {
        campaign: { id: 1 },
        search_term_view: { search_term: "free widget" },
        // no metrics
      },
    ];
    const result = await searchTerms(fakeClient(() => rows), "123", 7, [1]);
    expect(result[1]).toHaveLength(1);
    expect(result[1][0]).toMatchObject({
      search_term: "free widget",
      clicks: 0,
      conversions: 0,
      cost: 0,
      impressions: 0,
    });
  });

  it("qualityScore: a criterion with no quality_info is omitted, no throw", async () => {
    const rows = [
      {
        campaign: { id: 1 },
        ad_group_criterion: { keyword: { text: "no-qs-yet" } }, // no quality_info
      },
      {
        campaign: { id: 1 },
        ad_group_criterion: {
          keyword: { text: "scored" },
          quality_info: {
            quality_score: 6,
            post_click_quality_score: "AVERAGE",
            creative_quality_score: "AVERAGE",
            search_predicted_ctr: "AVERAGE",
          },
        },
      },
    ];
    const result = await qualityScore(fakeClient(() => rows), "123", [1]);
    // the unscored criterion is dropped (quality_score 0); only the scored one survives
    expect(result[1]).toHaveLength(1);
    expect(result[1][0].keyword).toBe("scored");
  });

  it("qualityScore: post_click_quality_score arriving as the raw enum integer normalizes to the string bucket (issue #40)", async () => {
    const rows = [
      {
        campaign: { id: 1 },
        ad_group_criterion: {
          keyword: { text: "int-enum" },
          quality_info: {
            quality_score: 3,
            // google-ads-api returns these as raw QualityScoreBucket integers
            // (2 = BELOW_AVERAGE), not their resolved string name.
            post_click_quality_score: 2,
            creative_quality_score: "AVERAGE",
            search_predicted_ctr: "AVERAGE",
          },
        },
      },
    ];
    const result = await qualityScore(fakeClient(() => rows), "123", [1]);
    expect(result[1]).toHaveLength(1);
    expect(result[1][0].landingPageExp).toBe("BELOW_AVERAGE");
  });

  it("qualityScore: creative_quality_score and search_predicted_ctr arriving as raw enum integers also normalize to string buckets (issue #40)", async () => {
    const rows = [
      {
        campaign: { id: 1 },
        ad_group_criterion: {
          keyword: { text: "int-enum-2" },
          quality_info: {
            quality_score: 3,
            post_click_quality_score: "AVERAGE",
            creative_quality_score: 2,
            search_predicted_ctr: 2,
          },
        },
      },
    ];
    const result = await qualityScore(fakeClient(() => rows), "123", [1]);
    expect(result[1]).toHaveLength(1);
    expect(result[1][0].adRelevance).toBe("BELOW_AVERAGE");
    expect(result[1][0].expectedCtr).toBe("BELOW_AVERAGE");
  });

  it("landingPageMobile: a URL with no metrics yields no findings, no throw", async () => {
    const rows = [
      {
        campaign: { id: 1 },
        landing_page_view: { unexpanded_final_url: "https://example.com/quiet" },
        // no metrics
      },
    ];
    const result = await landingPageMobile(fakeClient(() => rows), "123", 7, [1]);
    expect(result[1] ?? []).toEqual([]);
  });

  it("landingPagePolicy: an ad with no policy_summary yields no findings, no throw", async () => {
    const rows = [
      {
        ad_group_ad: { ad: { final_urls: ["https://example.com/ok"] } }, // no policy_summary
      },
    ];
    const result = await landingPagePolicy(fakeClient(() => rows), "123", [1]);
    expect(result[1] ?? []).toEqual([]);
  });
});

describe("resolveCampaign", () => {
  it("matches a name substring to the single id, case-insensitively", async () => {
    const rows = [
      { campaign: { id: 10, name: "tonewell-social-proof-20260624-abee-search" } },
      { campaign: { id: 20, name: "pitchvoice-social-proof-20260625-7a21-search" } },
    ];
    const [cid, err] = await resolveCampaign(fakeClient(() => rows), "123", "ABEE", true);
    expect(cid).toBe("10");
    expect(err).toBeNull();
  });

  it("reports no-match and ambiguous errors", async () => {
    const rows = [
      { campaign: { id: 10, name: "tonewell-abee-search" } },
      { campaign: { id: 20, name: "pitchvoice-7a21-search" } },
    ];
    const client = fakeClient(() => rows);

    const [cidNo, errNo] = await resolveCampaign(client, "123", "nomatch", true);
    expect(cidNo).toBeNull();
    expect(errNo).toContain("no campaign name matches");

    const [cidAmb, errAmb] = await resolveCampaign(client, "123", "search", true);
    expect(cidAmb).toBeNull();
    expect(errAmb).toContain("ambiguous");
  });
});

describe("landingPageMobile", () => {
  it("flags the bad URL and not the clean URL", async () => {
    const rows = [
      {
        campaign: { id: 1 },
        landing_page_view: { unexpanded_final_url: "https://example.com/bad" },
        metrics: {
          mobile_friendly_clicks_percentage: 0.5,
          valid_accelerated_mobile_pages_clicks_percentage: 0.8,
          speed_score: 2,
          clicks: 100,
          impressions: 500,
          ctr: 0.2,
        },
      },
      {
        campaign: { id: 1 },
        landing_page_view: { unexpanded_final_url: "https://example.com/good" },
        metrics: {
          mobile_friendly_clicks_percentage: 1.0,
          valid_accelerated_mobile_pages_clicks_percentage: null,
          speed_score: 9,
          clicks: 50,
          impressions: 200,
          ctr: 0.25,
        },
      },
    ];
    const result = await landingPageMobile(fakeClient(() => rows), "123", 7, [1]);
    const urlsFlagged = new Set((result[1] ?? []).map((item) => item.url));
    expect(urlsFlagged).toEqual(new Set(["https://example.com/bad"]));
    const issues = new Set(result[1].map((item) => item.issue));
    expect(issues).toEqual(
      new Set(["mobile_unfriendly_clicks", "invalid_amp_clicks", "slow_landing_page"]),
    );
  });
});

describe("landingPagePolicy", () => {
  it("flags destination topics only, not unrelated policy topics", async () => {
    const rows = [
      {
        ad_group_ad: {
          ad: { final_urls: ["https://example.com/broken"] },
          policy_summary: { policy_topic_entries: [{ topic: "DESTINATION_NOT_WORKING" }] },
        },
      },
      {
        ad_group_ad: {
          ad: { final_urls: ["https://example.com/fine"] },
          policy_summary: { policy_topic_entries: [{ topic: "ALCOHOL" }] },
        },
      },
    ];
    const result = await landingPagePolicy(fakeClient(() => rows), "123", [1]);
    expect(result[1]).toHaveLength(1);
    expect(result[1][0].url).toBe("https://example.com/broken");
    expect(result[1][0].issue).toBe("destination_not_working");
  });
});

describe("resolvePsiKey (issue #40: PSI key sourceable from .adkit.yaml / Secret Manager)", () => {
  it("prefers the --psi-key flag over env and config", () => {
    expect(resolvePsiKey("flag-key", "env-key", "config-key")).toBe("flag-key");
  });

  it("prefers PAGESPEED_API_KEY env over config when no flag is passed", () => {
    expect(resolvePsiKey(undefined, "env-key", "config-key")).toBe("env-key");
  });

  it("falls back to the config value (psi_api_key, sourced from Secret Manager via render-yaml) when flag and env are both absent", () => {
    expect(resolvePsiKey(undefined, undefined, "config-key")).toBe("config-key");
  });

  it("returns null when no tier has a value", () => {
    expect(resolvePsiKey(undefined, undefined, undefined)).toBeNull();
  });

  it("treats a blank/whitespace-only tier as absent, falling through to the next", () => {
    expect(resolvePsiKey("  ", undefined, "config-key")).toBe("config-key");
    expect(resolvePsiKey(undefined, "   ", "config-key")).toBe("config-key");
  });
});

describe("Auction Insights cache IO shell", () => {
  let dir: string;
  let cachePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "adkit-audit-cache-"));
    cachePath = join(dir, "cache.json");
    process.env["ADKIT_AUCTION_INSIGHTS_CACHE"] = cachePath;
  });

  afterEach(() => {
    delete process.env["ADKIT_AUCTION_INSIGHTS_CACHE"];
    rmSync(dir, { recursive: true, force: true });
  });

  it("loadAuctionInsightsCache returns EMPTY_CACHE when no file exists yet", () => {
    expect(loadAuctionInsightsCache()).toEqual(EMPTY_CACHE);
  });

  it("saveAuctionInsightsCache then loadAuctionInsightsCache round-trips", () => {
    const cache = updateCache(EMPTY_CACHE, "111", 222, ["a.com", "b.com"]);
    saveAuctionInsightsCache(cache);
    expect(loadAuctionInsightsCache()).toEqual(cache);
  });

  it("loadAuctionInsightsCache falls back to EMPTY_CACHE on malformed JSON on disk", () => {
    saveAuctionInsightsCache(EMPTY_CACHE);
    // overwrite with garbage the parser must reject
    writeFileSync(cachePath, "{not valid json");
    expect(loadAuctionInsightsCache()).toEqual(EMPTY_CACHE);
  });

  it("two sequential runs sharing a persisted cache: first seeds it silently, second sees only the truly new domain", () => {
    // Run 1: campaign 222 sees two domains, no prior cache.
    const run1Domains = ["a.com", "b.com"];
    const run1Diff = diffNewCompetitors(loadAuctionInsightsCache(), "111", 222, run1Domains);
    expect(run1Diff).toEqual({ isFirstRun: true, newDomains: [] });
    saveAuctionInsightsCache(updateCache(loadAuctionInsightsCache(), "111", 222, run1Domains));

    // Run 2: a third domain shows up alongside the two already-seen ones.
    const run2Domains = ["a.com", "b.com", "c.com"];
    const run2Diff = diffNewCompetitors(loadAuctionInsightsCache(), "111", 222, run2Domains);
    expect(run2Diff).toEqual({ isFirstRun: false, newDomains: ["c.com"] });
    saveAuctionInsightsCache(updateCache(loadAuctionInsightsCache(), "111", 222, run2Domains));

    // Run 3: nothing new — everything from run 2 is now the baseline.
    const run3Diff = diffNewCompetitors(loadAuctionInsightsCache(), "111", 222, run2Domains);
    expect(run3Diff).toEqual({ isFirstRun: false, newDomains: [] });
  });
});
