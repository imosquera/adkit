import { describe, expect, it } from "vitest";
import type { AdsClient, AdsMutateOperation, MutateResult } from "../lib/auth.js";
import { DisplayBriefSchema, parseAnyBrief, type DisplayBrief } from "../lib/schema.js";
import { briefImageIssues, imageDimensions, type LoadedImage } from "./images.js";
import { enums } from "google-ads-api";
import { createMissingDemographicExclusions, demographicExclusions, findMissingResponsiveDisplayAds } from "./entities.js";
import { displayDryRunSummary } from "../bin/create.js";
import { publishDisplay } from "./publish.js";

const IMG = "gs://adkit-images/ads/wide.png";
const SQ = "https://storage.googleapis.com/adkit-images/ads/square.png";

function displayBrief(overrides: Record<string, unknown> = {}): DisplayBrief {
  return DisplayBriefSchema.parse({
    type: "display",
    name: "konnect-display",
    version: 1,
    campaign: { name: "konnect-display", budgetMicros: 10_000_000 },
    adGroups: [
      {
        name: "remarketing",
        defaultBidMicros: 1_000_000,
        audiences: { userLists: ["111"], userInterests: ["80432"] },
        responsiveDisplayAds: [
          {
            marketingImages: [IMG],
            squareMarketingImages: [SQ],
            headlines: [{ text: "Ship faster" }],
            longHeadline: { text: "Ship faster with fewer integrations" },
            descriptions: [{ text: "Live in 30 days." }],
            businessName: "Konnect",
            finalUrl: "https://www.example.com/x",
          },
        ],
      },
    ],
    ...overrides,
  });
}

/** A minimal PNG header carrying only width/height — enough for imageDimensions. */
function png(width: number, height: number): Uint8Array {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}

function library(wide: [number, number], square: [number, number]): Map<string, LoadedImage> {
  const wideUrl = "https://storage.googleapis.com/adkit-images/ads/wide.png";
  return new Map([
    [wideUrl, { url: wideUrl, bytes: png(...wide), width: wide[0], height: wide[1] }],
    [SQ, { url: SQ, bytes: png(...square), width: square[0], height: square[1] }],
  ]);
}

describe("display brief parsing", () => {
  it("dispatches on type and normalizes gs:// image refs to public https", () => {
    const brief = parseAnyBrief({ ...displayBrief(), type: "display" }) as DisplayBrief;
    expect(brief.adGroups[0]!.responsiveDisplayAds[0]!.marketingImages[0]).toBe(
      "https://storage.googleapis.com/adkit-images/ads/wide.png",
    );
  });

  it("rejects an ad group with no audiences and optimized targeting off", () => {
    expect(() =>
      displayBrief({
        adGroups: [{ ...displayBrief().adGroups[0], audiences: {} }],
      }),
    ).toThrow(/at least one audience/);
  });
});

describe("image checks", () => {
  it("reads PNG dimensions from the header", () => {
    expect(imageDimensions(png(1200, 628))).toEqual({ width: 1200, height: 628 });
    expect(imageDimensions(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it("flags wrong aspect ratios and undersized images, passes in-spec ones", () => {
    const brief = displayBrief();
    expect(briefImageIssues(brief, library([1200, 628], [300, 300]))).toEqual([]);
    const issues = briefImageIssues(brief, library([1200, 1200], [200, 200]));
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatch(/marketingImages must be 1.91:1/);
    expect(issues[1]).toMatch(/at least 300x300/);
  });
});

describe("publishDisplay", () => {
  it("creates campaign, image assets, ad group, audiences and the ad in order", async () => {
    const calls: AdsMutateOperation[][] = [];
    const client: AdsClient = {
      search: async <Row = unknown>(): Promise<Row[]> => [] as Row[],
      searchStructured: async <Row = unknown>(): Promise<Row[]> => [] as Row[],
      mutate: async (_c, ops): Promise<MutateResult> => {
        calls.push(ops);
        return { results: ops.map((_, i) => ({ resource_name: `rn/${calls.length}/${i}` })) };
      },
    };
    const outcome = await publishDisplay(client, "1234567890", displayBrief(), library([1200, 628], [300, 300]));

    expect(outcome.failure).toBeNull();
    // budget, campaign, location, image assets, ad group, audiences, ad (all devices → no device op)
    expect(calls.map((ops) => ops[0]!.entity)).toEqual([
      "campaign_budget",
      "campaign",
      "campaign_criterion",
      "asset",
      "ad_group",
      "ad_group_criterion",
      "ad_group_ad",
    ]);
    expect(calls[5]!.map((op) => op.resource)).toEqual([
      expect.objectContaining({ user_interest: { user_interest_category: "customers/1234567890/userInterests/80432" } }),
      expect.objectContaining({ user_list: { user_list: "customers/1234567890/userLists/111" } }),
    ]);
    const ad = calls[6]![0]!.resource as { ad: { responsive_display_ad: { marketing_images: unknown } } };
    expect(ad.ad.responsive_display_ad.marketing_images).toEqual([{ asset: "rn/4/0" }]);
    expect(outcome.results.adGroups[0]!.responsiveDisplayAdIds).toEqual(["rn/7/0"]);
  });
});

describe("findMissingResponsiveDisplayAds", () => {
  const WIDE = "https://storage.googleapis.com/adkit-images/ads/wide.png";
  const assets = new Map([
    [WIDE, "customers/1/assets/10"],
    [SQ, "customers/1/assets/11"],
  ]);
  const liveRow = (overrides: Record<string, unknown> = {}) => ({
    ad_group_ad: {
      ad: {
        final_urls: ["https://www.example.com/x"],
        responsive_display_ad: {
          marketing_images: [{ asset: "customers/1/assets/10" }],
          square_marketing_images: [{ asset: "customers/1/assets/11" }],
          headlines: [{ text: "Ship faster" }],
          long_headline: { text: "Ship faster with fewer integrations" },
          descriptions: [{ text: "Live in 30 days." }],
          business_name: "Konnect",
          ...overrides,
        },
      },
    },
  });
  const clientWith = (rows: unknown[]): AdsClient => ({
    search: async <Row>() => rows as Row[],
    searchStructured: async <Row>() => [] as Row[],
    mutate: async () => ({ results: [] }),
  });
  const ads = displayBrief().adGroups[0]!.responsiveDisplayAds;

  it("treats an ad with identical images, copy, name and URL as live", async () => {
    expect(await findMissingResponsiveDisplayAds(clientWith([liveRow()]), "1", "ag", ads, assets)).toEqual([]);
  });

  it("treats a changed image, business name or final URL as missing", async () => {
    for (const row of [
      liveRow({ marketing_images: [{ asset: "customers/1/assets/99" }] }),
      liveRow({ business_name: "Old name" }),
      { ad_group_ad: { ad: { ...liveRow().ad_group_ad.ad, final_urls: ["https://www.example.com/old"] } } },
    ]) {
      expect(await findMissingResponsiveDisplayAds(clientWith([row]), "1", "ag", ads, assets)).toHaveLength(1);
    }
  });
});

describe("display demographics", () => {
  const withDemographics = (demographics: unknown) =>
    displayBrief({ adGroups: [{ ...displayBrief().adGroups[0], demographics }] });

  it("accepts listed age ranges and parental statuses", () => {
    const ag = withDemographics({ ageRanges: ["25-34", "unknown"], parentalStatus: ["parent"] }).adGroups[0]!;
    expect(ag.demographics).toEqual({ ageRanges: ["25-34", "unknown"], parentalStatus: ["parent"] });
  });

  it("rejects empty lists, duplicates, unknown values and extra keys", () => {
    expect(() => withDemographics({ ageRanges: [] })).toThrow();
    expect(() => withDemographics({ parentalStatus: ["parent", "parent"] })).toThrow(/must not repeat/);
    expect(() => withDemographics({ ageRanges: ["13-17"] })).toThrow();
    expect(() => withDemographics({ genders: ["female"] })).toThrow();
  });

  it("excludes the complement of the listed values, nothing when omitted", () => {
    expect(demographicExclusions(displayBrief().adGroups[0]!)).toEqual([]);
    const ag = withDemographics({ ageRanges: ["25-34", "35-44", "45-54", "unknown"], parentalStatus: ["parent", "unknown"] })
      .adGroups[0]!;
    expect(demographicExclusions(ag)).toEqual([
      ["age_range", enums.AgeRangeType.AGE_RANGE_18_24],
      ["age_range", enums.AgeRangeType.AGE_RANGE_55_64],
      ["age_range", enums.AgeRangeType.AGE_RANGE_65_UP],
      ["parental_status", enums.ParentalStatusType.NOT_A_PARENT],
    ]);
  });

  it("creates only the negative criteria not already live", async () => {
    const calls: AdsMutateOperation[][] = [];
    const client: AdsClient = {
      search: async <Row>() =>
        [{ ad_group_criterion: { age_range: { type: "AGE_RANGE_18_24" } } }] as Row[],
      searchStructured: async <Row>() => [] as Row[],
      mutate: async (_c, ops) => {
        calls.push(ops);
        return { results: ops.map((_, i) => ({ resource_name: `rn/${i}` })) };
      },
    };
    const ag = withDemographics({ ageRanges: ["25-34", "35-44", "45-54", "55-64", "65+", "unknown"] }).adGroups[0]!;
    expect(await createMissingDemographicExclusions(client, "1", ag, "ag")).toEqual([]);
    expect(calls).toEqual([]);

    const ag2 = withDemographics({ parentalStatus: ["parent", "unknown"] }).adGroups[0]!;
    await createMissingDemographicExclusions(client, "1", ag2, "ag");
    expect(calls[0]!.map((op) => op.resource)).toEqual([
      { ad_group: "ag", status: enums.AdGroupCriterionStatus.ENABLED, negative: true, parental_status: { type: enums.ParentalStatusType.NOT_A_PARENT } },
    ]);
  });

  it("counts the exclusions in the dry-run plan", () => {
    const summary = displayDryRunSummary(withDemographics({ parentalStatus: ["parent"] }), new Map());
    expect(summary["willPublish"]).toContain("audiences → demographic exclusions →");
    expect(summary["willPublish"]).toContain("2 demographic exclusions total");
  });
});
