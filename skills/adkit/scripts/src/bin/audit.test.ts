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

import { describe, expect, it } from "vitest";

import type { AdsClient, AdsMutateOperation, MutateResult } from "../lib/auth.js";
import { parseDifferentiationProfile } from "../lib/brand.js";
import { MIN_KEYWORDS, requireDigits } from "../audit/scoring.js";
import {
  auditCampaign,
  campaignServing,
  keywordCpc,
  landingPageMobile,
  landingPagePolicy,
  qualityScore,
  resolveCampaign,
  searchTerms,
} from "./audit.js";

/** Build a fake AdsClient whose `search` picks canned rows by GAQL substring. */
function fakeClient(pick: (query: string) => unknown[], onSearch?: () => void): AdsClient {
  return {
    async search<Row = Record<string, unknown>>(_customerId: string, query: string): Promise<Row[]> {
      onSearch?.();
      return pick(query) as Row[];
    },
    async mutate(_customerId: string, _operations: AdsMutateOperation[]): Promise<MutateResult> {
      throw new Error("audit must be read-only — no mutate calls");
    },
  };
}

describe("requireDigits guard", () => {
  it("throws on a non-digit id (injection guard runs in the shell)", () => {
    expect(() => requireDigits("campaign", "1; DROP TABLE")).toThrow();
  });

  it("allows a null id", () => {
    expect(() => requireDigits("campaign", null)).not.toThrow();
  });
});

describe("auditCampaign", () => {
  it("is read-only and flags me-too copy against a differentiation profile", async () => {
    // one ad group, one ad whose copy is a generic AI promise; no extensions.
    const adRow = {
      ad_group: { name: "Commercial" },
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
    const result = await auditCampaign(client, "123", camp, [], { Commercial: ["ai chatbot"] }, profile);

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
      ad_group: { name: "Commercial" },
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
    const result = await auditCampaign(client, "123", camp, [], { Commercial: ["ai chatbot"] }, {
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
    const agKeywords = { Commercial: ["a", "b"], Brand: ["c"] }; // 3 total
    const result = await auditCampaign(client, "123", camp, [], agKeywords, emptyProfile);
    expect(result.keywords).toBe(3);
    const finding = result.campaignFindings.find((f) => f.issue === "keywords_under");
    expect(finding).toBeDefined();
    expect(finding?.need).toBe(MIN_KEYWORDS - 3);
    expect(finding?.detail).toContain(`3/${MIN_KEYWORDS}`);
  });

  it("does not flag a campaign at or above MIN_KEYWORDS", async () => {
    const agKeywords = { Commercial: Array.from({ length: MIN_KEYWORDS }, (_, i) => `kw${i}`) };
    const result = await auditCampaign(client, "123", camp, [], agKeywords, emptyProfile);
    expect(result.keywords).toBe(MIN_KEYWORDS);
    expect(result.campaignFindings.some((f) => f.issue === "keywords_under")).toBe(false);
  });
});

// The Google Ads API omits empty nested messages and zero-valued metric fields
// from `search` rows entirely. A healthy account routinely returns keywords/ads/
// search-terms/criteria with a missing metrics/quality_info/policy_summary/
// responsive_search_ad. The boundary normalizers must absorb every such gap so the
// audit produces findings instead of throwing a bare TypeError mid-run.
describe("boundary normalizers absorb API-omitted nested fields", () => {
  it("auditCampaign: a non-RSA ad (no responsive_search_ad) scores as 0H/0D, no throw", async () => {
    const nonRsaAd = {
      ad_group: { name: "Commercial" },
      ad_group_ad: {
        ad: { id: 10, final_urls: ["https://x"] }, // no responsive_search_ad
        ad_strength: "PENDING",
        status: "ENABLED",
      },
    };
    const client = fakeClient((query) => (query.includes("FROM ad_group_ad") ? [nonRsaAd] : []));
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
