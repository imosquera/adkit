/**
 * Table tests for the zero-impression serving diagnosis (audit/diagnosis.ts).
 *
 * The derivation is pure given the queried rows, so each blocker code gets one
 * fixture: a healthy account, mutated in exactly the one way that should produce
 * that code. Plus the all-green `no_blocker_found` verdict and a
 * partial-permission degrade (billing unreadable ⇒ no blocker invented).
 */

import { describe, expect, it } from "vitest";
import { enums } from "google-ads-api";

import {
  buildServingDiagnosis,
  negativeBlocks,
  type DiagnosisRows,
  type RawDiagnosisAdRow,
  type RawDiagnosisKeywordRow,
} from "./diagnosis.js";

const TODAY = "2026-09-20";
const CID = 24206941608;
const AG = 199541791323;

function ad(id: number, over: Partial<RawDiagnosisAdRow["ad_group_ad"]> = {}): RawDiagnosisAdRow {
  return {
    campaign: { id: CID },
    ad_group: { id: AG, name: "Younger Players" },
    ad_group_ad: {
      ad: { id },
      status: "ENABLED",
      policy_summary: { approval_status: "APPROVED", review_status: "REVIEWED" },
      ...over,
    },
  };
}

function keyword(
  text: string,
  over: Partial<RawDiagnosisKeywordRow["ad_group_criterion"]> = {},
): RawDiagnosisKeywordRow {
  return {
    campaign: { id: CID },
    ad_group: { id: AG },
    ad_group_criterion: {
      negative: false,
      status: "ENABLED",
      approval_status: "APPROVED",
      system_serving_status: "ELIGIBLE",
      keyword: { text, match_type: "PHRASE" },
      ...over,
    },
  };
}

/** A fully healthy zero-impression campaign: every eligibility signal green. */
function healthy(): DiagnosisRows {
  return {
    campaign: {
      campaign: {
        id: CID,
        name: "winter-programs-search",
        status: "ENABLED",
        serving_status: "SERVING",
        primary_status: "ELIGIBLE",
        primary_status_reasons: [],
        start_date_time: "2026-09-03",
        end_date_time: "2037-12-30",
        network_settings: { target_google_search: true, target_search_network: true },
      },
      campaign_budget: { amount_micros: 50_000_000, status: "ENABLED", delivery_method: "STANDARD" },
    },
    adGroups: [
      {
        campaign: { id: CID },
        ad_group: {
          id: AG,
          name: "Younger Players",
          status: "ENABLED",
          primary_status: "ELIGIBLE",
          primary_status_reasons: [],
        },
      },
    ],
    ads: [ad(1), ad(2)],
    keywords: [keyword("winter programs"), keyword("youth hockey camp")],
    campaignCriteria: [],
    sharedSets: [],
    sharedNegatives: [],
    billing: { billing_setup: { status: "APPROVED" } },
    brandAssets: null,
    notes: [],
  };
}

/**
 * A healthy zero-impression Display campaign: live RDAs, no keywords (Display has
 * none), and the given brand-asset links.
 */
function display(brandAssets: DiagnosisRows["brandAssets"]): DiagnosisRows {
  const r = healthy();
  return {
    ...r,
    campaign: {
      ...r.campaign,
      campaign: {
        ...r.campaign.campaign,
        name: "winter-programs-display",
        advertising_channel_type: enums.AdvertisingChannelType.DISPLAY, // raw ordinal, as the SDK returns it
        network_settings: { target_content_network: true },
      },
    },
    keywords: [],
    brandAssets,
  };
}

const ACCOUNT_BRAND = {
  campaign: [],
  customer: [
    { customer_asset: { field_type: enums.AssetFieldType.BUSINESS_NAME } },
    { customer_asset: { field_type: enums.AssetFieldType.BUSINESS_LOGO } },
  ],
};

const codes = (rows: DiagnosisRows): string[] =>
  buildServingDiagnosis(rows, TODAY).blockers.map((b) => b.code);

describe("blocker derivation", () => {
  const cases: Array<[string, () => DiagnosisRows]> = [
    [
      "account_not_billed",
      () => ({ ...healthy(), billing: { billing_setup: { status: "CANCELLED" } } }),
    ],
    [
      "campaign_pending",
      () => {
        const r = healthy();
        r.campaign.campaign.start_date_time = "2026-10-01";
        return r;
      },
    ],
    [
      "campaign_ended",
      () => {
        const r = healthy();
        r.campaign.campaign.end_date_time = "2026-09-10";
        return r;
      },
    ],
    [
      "budget_removed",
      () => {
        const r = healthy();
        r.campaign.campaign_budget = { amount_micros: 50_000_000, status: "REMOVED" };
        return r;
      },
    ],
    [
      "budget_paused",
      () => {
        const r = healthy();
        r.campaign.campaign_budget = { amount_micros: 50_000_000, status: "PAUSED" };
        return r;
      },
    ],
    [
      "campaign_paused",
      () => {
        const r = healthy();
        r.campaign.campaign.status = "PAUSED";
        return r;
      },
    ],
    ["ad_group_removed", () => ({ ...healthy(), adGroups: [], ads: [], keywords: [] })],
    [
      "ad_groups_paused",
      () => {
        const r = healthy();
        r.adGroups[0].ad_group.status = "PAUSED";
        return r;
      },
    ],
    ["no_eligible_ads", () => ({ ...healthy(), ads: [] })],
    [
      "ads_paused",
      () => ({ ...healthy(), ads: [ad(1, { status: "PAUSED" }), ad(2, { status: "PAUSED" })] }),
    ],
    [
      "ads_disapproved",
      () => ({
        ...healthy(),
        ads: [
          ad(1, {
            policy_summary: {
              approval_status: "DISAPPROVED",
              review_status: "REVIEWED",
              policy_topic_entries: [{ topic: "TRADEMARKS_IN_AD_TEXT" }],
            },
          }),
          ad(2),
        ],
      }),
    ],
    [
      "ads_under_review",
      () => ({
        ...healthy(),
        ads: [
          ad(1, {
            policy_summary: { approval_status: "APPROVED", review_status: "REVIEW_IN_PROGRESS" },
          }),
          ad(2, {
            policy_summary: { approval_status: "APPROVED", review_status: "REVIEW_IN_PROGRESS" },
          }),
        ],
      }),
    ],
    [
      "keywords_disapproved",
      () => ({
        ...healthy(),
        keywords: [
          keyword("winter programs", { approval_status: "DISAPPROVED" }),
          keyword("youth hockey camp", { approval_status: "DISAPPROVED" }),
        ],
      }),
    ],
    ["no_keywords", () => ({ ...healthy(), keywords: [] })],
    [
      "keywords_rarely_served",
      () => ({
        ...healthy(),
        keywords: [
          keyword("winter programs", { system_serving_status: "RARELY_SERVED" }),
          keyword("youth hockey camp", { system_serving_status: "RARELY_SERVED" }),
        ],
      }),
    ],
    [
      "negatives_block_everything",
      () => ({
        ...healthy(),
        campaignCriteria: [
          {
            campaign: { id: CID },
            campaign_criterion: {
              type: "KEYWORD",
              negative: true,
              status: "ENABLED",
              keyword: { text: "winter", match_type: "PHRASE" },
            },
          },
        ],
        // both positives contain "winter"? only one does — give a negative that covers both
        keywords: [keyword("winter programs"), keyword("winter hockey camp")],
      }),
    ],
    [
      "targeting_too_narrow",
      () => ({
        ...healthy(),
        campaignCriteria: [
          {
            campaign: { id: CID },
            campaign_criterion: {
              type: "PROXIMITY",
              status: "ENABLED",
              proximity: {
                radius: 5,
                radius_units: "MILES",
                address: { city_name: "Gambrills", postal_code: "21054" },
              },
            },
          },
        ],
      }),
    ],
    ["no_blocker_found", healthy],
  ];

  for (const [code, rows] of cases) {
    it(`reports ${code}`, () => {
      expect(codes(rows())).toContain(code);
    });
  }

  it("reports no_blocker_found ONLY when nothing else fired", () => {
    const paused = healthy();
    paused.campaign.campaign.status = "PAUSED";
    expect(codes(paused)).not.toContain("no_blocker_found");
    expect(codes(healthy())).toEqual(["no_blocker_found"]);
  });

  it("names what it checked in the no_blocker_found verdict", () => {
    const [verdict] = buildServingDiagnosis(healthy(), TODAY).blockers;
    expect(verdict.detail).toContain("billing");
    expect(verdict.detail).toContain("2 keyword(s)");
  });

  it("says /adkit create publishes RSAs PAUSED in the ads_paused fix", () => {
    const rows = { ...healthy(), ads: [ad(1, { status: "PAUSED" }), ad(2, { status: "PAUSED" })] };
    const paused = buildServingDiagnosis(rows, TODAY).blockers.find((b) => b.code === "ads_paused");
    expect(paused?.detail).toBe("2 of 2 RSAs in 'Younger Players' are PAUSED");
    expect(paused?.fix).toContain("/adkit create");
  });
});

describe("Display campaigns (#85)", () => {
  it("reports brand_assets_missing — and no Search-only blocker — with no brand assets linked", () => {
    const d = buildServingDiagnosis(display({ campaign: [], customer: [] }), TODAY);
    expect(d.campaign.channelType).toBe("DISPLAY");
    expect(d.missingBrandAssets).toEqual(["BUSINESS_NAME", "BUSINESS_LOGO"]);
    expect(d.blockers.map((b) => b.code)).toEqual(["brand_assets_missing"]);
    const [blocker] = d.blockers;
    expect(blocker.detail).toContain("business name (BUSINESS_NAME) or business logo (BUSINESS_LOGO)");
    expect(blocker.fix).toContain("/adkit create");
  });

  it("names only the missing field when the campaign links the other", () => {
    const d = buildServingDiagnosis(
      display({
        campaign: [{ campaign: { id: CID }, campaign_asset: { field_type: "BUSINESS_LOGO" } }],
        customer: [],
      }),
      TODAY,
    );
    expect(d.missingBrandAssets).toEqual(["BUSINESS_NAME"]);
    expect(d.blockers.find((b) => b.code === "brand_assets_missing")?.detail).not.toContain("BUSINESS_LOGO");
  });

  it("finds no blocker when the account links both brand assets", () => {
    const d = buildServingDiagnosis(display(ACCOUNT_BRAND), TODAY);
    expect(d.missingBrandAssets).toEqual([]);
    expect(d.blockers.map((b) => b.code)).toEqual(["no_blocker_found"]);
    expect(d.blockers[0].detail).not.toContain("keyword");
    expect(d.blockers[0].detail).toContain("brand assets");
  });

  it("invents no brand blocker when the asset links were unreadable", () => {
    const d = buildServingDiagnosis(display(null), TODAY);
    expect(d.missingBrandAssets).toBeUndefined();
    expect(d.blockers.map((b) => b.code)).toEqual(["no_blocker_found"]);
  });

  it("speaks of responsive display ads, not RSAs, in ad blockers", () => {
    const rows = { ...display(ACCOUNT_BRAND), ads: [ad(1, { status: "PAUSED" })] };
    const paused = buildServingDiagnosis(rows, TODAY).blockers.find((b) => b.code === "ads_paused");
    expect(paused?.detail).toBe("1 of 1 responsive display ads in 'Younger Players' are PAUSED");
  });

  it("leaves a Search campaign's keyword blockers and missing brand assets alone", () => {
    const rows = { ...healthy(), keywords: [], brandAssets: { campaign: [], customer: [] } };
    const d = buildServingDiagnosis(rows, TODAY);
    expect(d.campaign.channelType).toBe("SEARCH");
    expect(d.missingBrandAssets).toBeUndefined();
    expect(d.blockers.map((b) => b.code)).toEqual(["no_keywords"]);
  });
});

describe("graceful degrade (partial permissions)", () => {
  it("omits `billing` and invents no blocker when billing_setup is unreadable", () => {
    const rows: DiagnosisRows = {
      ...healthy(),
      billing: null,
      notes: ["billing setup unavailable — PERMISSION_DENIED"],
    };
    const d = buildServingDiagnosis(rows, TODAY);
    expect(d.billing).toBeUndefined();
    expect(d.blockers.map((b) => b.code)).not.toContain("account_not_billed");
    expect(d.notes).toEqual(["billing setup unavailable — PERMISSION_DENIED"]);
  });
});

describe("enum decoding at the boundary", () => {
  it("decodes raw ordinals to names — never surfaces a bare int", () => {
    const rows = healthy();
    rows.campaign.campaign.status = 3; // CampaignStatus.PAUSED
    rows.campaign.campaign_budget = { amount_micros: 1, status: 2, delivery_method: 2 };
    rows.ads = [ad(1, { status: 3 }), ad(2, { status: 3 })]; // AdGroupAdStatus.PAUSED
    const d = buildServingDiagnosis(rows, TODAY);
    expect(d.campaign.status).toBe("PAUSED");
    expect(d.campaign.budget.status).toBe("ENABLED");
    expect(d.campaign.budget.deliveryMethod).toBe("STANDARD");
    expect(d.adGroups[0].pausedAds).toBe(2);
    expect(JSON.stringify(d)).not.toMatch(/"status":\d/);
  });

  it("decodes a proximity radius in kilometres for the narrow-targeting check", () => {
    const rows: DiagnosisRows = {
      ...healthy(),
      campaignCriteria: [
        {
          campaign: { id: CID },
          campaign_criterion: {
            type: "PROXIMITY",
            status: "ENABLED",
            // 20 km ≈ 12.4 miles — under the 15-mile bar even though the number isn't.
            proximity: { radius: 20, radius_units: 3 }, // ProximityRadiusUnits.KILOMETERS
          },
        },
      ],
    };
    const d = buildServingDiagnosis(rows, TODAY);
    expect(d.targeting.proximity[0].units).toBe("KILOMETERS");
    expect(d.blockers.map((b) => b.code)).toContain("targeting_too_narrow");
  });
});

describe("negativeBlocks", () => {
  it("blocks when every negative token is in the keyword", () => {
    expect(negativeBlocks("winter", "winter programs")).toBe(true);
    expect(negativeBlocks("winter programs", "winter programs near me")).toBe(true);
  });

  it("does not block an unrelated or broader negative", () => {
    expect(negativeBlocks("summer", "winter programs")).toBe(false);
    expect(negativeBlocks("winter programs cheap", "winter programs")).toBe(false);
  });
});
