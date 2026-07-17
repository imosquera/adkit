import { describe, expect, it } from "vitest";
import { enums } from "google-ads-api";
import type { AdsClient, AdsMutateOperation, MutateResult } from "../lib/auth.js";
import { parseBrief, type Keyword } from "../lib/schema.js";
import {
  ALL_DEVICES,
  ENGLISH_LANGUAGE_CONSTANT,
  GEO_TARGETS,
  buildKeywordOps,
  buildLanguageOps,
  createAdGroup,
  createCallouts,
  createNegativeKeywords,
  createPriceAsset,
  createSearchCampaign,
  createSitelinks,
  createStructuredSnippet,
  setCampaignStatus,
  targetDevices,
  targetUsCanada,
} from "./entities.js";

/** A recording fake: captures every mutate batch, returns synthetic resource names. */
function makeFake(): { client: AdsClient; calls: Array<{ customerId: string; ops: AdsMutateOperation[] }> } {
  const calls: Array<{ customerId: string; ops: AdsMutateOperation[] }> = [];
  const client: AdsClient = {
    search: async () => [],
    // entities.ts resolves via raw `search`; searchStructured is unused here.
    searchStructured: async () => [],
    mutate: async (customerId, ops): Promise<MutateResult> => {
      calls.push({ customerId, ops });
      return { results: ops.map((_, i) => ({ resource_name: `rn/${i}` })) };
    },
  };
  return { client, calls };
}

const CAMPAIGN_RN = "customers/123/campaigns/9";

function briefFixture(campaignOverrides: Record<string, unknown>): ReturnType<typeof parseBrief> {
  return parseBrief({
    name: "konnect-test",
    version: 1,
    campaign: {
      name: "konnect-test-search",
      budgetMicros: 10_000_000,
      networkSettings: "search-only",
      ...campaignOverrides,
    },
    adGroups: [
      {
        name: "Ag",
        defaultBidMicros: 1_500_000,
        responsiveSearchAd: {
          headlines: Array.from({ length: 15 }, (_, i) => ({ text: `H${i}` })),
          descriptions: Array.from({ length: 4 }, (_, i) => ({ text: `D${i}` })),
          finalUrl: "https://www.example.com/x",
        },
        keywords: [{ text: "kw", matchType: "PHRASE" }],
      },
    ],
  });
}

describe("createAdGroup", () => {
  it("defaults to an ENABLED ad group (the /adkit create flow, inside a PAUSED campaign)", async () => {
    const { client, calls } = makeFake();
    const ag = briefFixture({}).adGroups[0]!;
    await createAdGroup(client, "123", ag, CAMPAIGN_RN);
    expect(calls[0]!.ops[0]!.resource["status"]).toBe(enums.AdGroupStatus.ENABLED);
  });

  it("creates the ad group PAUSED when asked (adding to a live campaign — bug 5)", async () => {
    const { client, calls } = makeFake();
    const ag = briefFixture({}).adGroups[0]!;
    await createAdGroup(client, "123", ag, CAMPAIGN_RN, "PAUSED");
    expect(calls[0]!.ops[0]!.resource["status"]).toBe(enums.AdGroupStatus.PAUSED);
  });
});

describe("targetUsCanada", () => {
  it("sets both geos on the campaign", async () => {
    const { client, calls } = makeFake();
    await targetUsCanada(client, "123", CAMPAIGN_RN);

    expect(calls[0]!.customerId).toBe("123");
    const ops = calls[0]!.ops;
    expect(ops.every((op) => op.resource["campaign"] === CAMPAIGN_RN)).toBe(true);
    const geos = ops.map((op) => (op.resource["location"] as { geo_target_constant: string }).geo_target_constant);
    expect(geos).toEqual([...GEO_TARGETS]);
    expect(geos).toEqual(["geoTargetConstants/2840", "geoTargetConstants/2124"]);
  });
});

describe("createSitelinks", () => {
  const sitelinks = [
    { text: "How It Works", finalUrl: "https://www.example.com/a" },
    { text: "Pricing", finalUrl: "https://www.example.com/b", description1: "line one", description2: "line two" },
    { text: "Trial", finalUrl: "https://www.example.com/c" },
    { text: "Brands", finalUrl: "https://www.example.com/d" },
    { text: "Demo", finalUrl: "https://www.example.com/e" },
    { text: "Contact", finalUrl: "https://www.example.com/f" },
  ];

  it("links all sitelink assets to the campaign", async () => {
    const { client, calls } = makeFake();
    const rns = await createSitelinks(client, "123", briefFixture({ sitelinks }), CAMPAIGN_RN);

    const assetOps = calls[0]!.ops;
    expect(assetOps).toHaveLength(6);
    expect((assetOps[0]!.resource["sitelink_asset"] as { link_text: string }).link_text).toBe("How It Works");
    // descriptions set only on the one that supplied them
    expect((assetOps[1]!.resource["sitelink_asset"] as { description1?: string }).description1).toBe("line one");
    expect((assetOps[0]!.resource["sitelink_asset"] as { description1?: string }).description1).toBeUndefined();
    // every campaign-asset link uses the SITELINK field type
    const linkOps = calls[1]!.ops;
    expect(linkOps.every((op) => op.resource["field_type"] === enums.AssetFieldType.SITELINK)).toBe(true);
    expect(rns).toHaveLength(6);
  });

  it("no-ops when there are none", async () => {
    const { client } = makeFake();
    expect(await createSitelinks(client, "123", briefFixture({ sitelinks: [] }), CAMPAIGN_RN)).toEqual([]);
  });
});

describe("createCallouts", () => {
  it("links all callout assets to the campaign", async () => {
    const { client, calls } = makeFake();
    const callouts = ["No new integrations", "Live in 30 days", "Mid-market CPG", "Real promo ROI"];
    const rns = await createCallouts(client, "123", briefFixture({ callouts }), CAMPAIGN_RN);

    const assetOps = calls[0]!.ops;
    expect(assetOps).toHaveLength(4);
    expect((assetOps[0]!.resource["callout_asset"] as { callout_text: string }).callout_text).toBe(
      "No new integrations",
    );
    const linkOps = calls[1]!.ops;
    expect(linkOps.every((op) => op.resource["field_type"] === enums.AssetFieldType.CALLOUT)).toBe(true);
    expect(rns).toHaveLength(4);
  });

  it("no-ops when there are none", async () => {
    const { client } = makeFake();
    expect(await createCallouts(client, "123", briefFixture({ callouts: [] }), CAMPAIGN_RN)).toEqual([]);
  });

  it("rejects a brief with fewer than four callouts", () => {
    expect(() => briefFixture({ callouts: ["only one", "two", "three"] })).toThrow();
  });
});

describe("createSearchCampaign", () => {
  function campaignResource(op: AdsMutateOperation): Record<string, unknown> {
    return op.resource;
  }

  it("defaults to Maximize Clicks (target_spend)", async () => {
    const { client, calls } = makeFake();
    await createSearchCampaign(client, "123", briefFixture({ aiMax: true }), "customers/123/budgets/1");
    const resource = campaignResource(calls[0]!.ops[0]!);
    expect(resource["target_spend"]).toBeDefined();
    expect(resource["maximize_conversions"]).toBeUndefined();
  });

  it("applies the cpc ceiling under maximize-clicks", async () => {
    const { client, calls } = makeFake();
    const brief = briefFixture({ bidStrategy: "maximize-clicks", cpcBidCeilingMicros: 2_000_000 });
    await createSearchCampaign(client, "123", brief, "customers/123/budgets/1");
    const resource = campaignResource(calls[0]!.ops[0]!);
    expect((resource["target_spend"] as { cpc_bid_ceiling_micros: number }).cpc_bid_ceiling_micros).toBe(2_000_000);
  });

  it("uses maximize_conversions when requested", async () => {
    const { client, calls } = makeFake();
    const brief = briefFixture({ bidStrategy: "maximize-conversions" });
    await createSearchCampaign(client, "123", brief, "customers/123/budgets/1");
    const resource = campaignResource(calls[0]!.ops[0]!);
    expect((resource["maximize_conversions"] as { target_cpa_micros: number }).target_cpa_micros).toBe(0);
    expect(resource["target_spend"]).toBeUndefined();
  });

  it("enables ai max by default", async () => {
    const { client, calls } = makeFake();
    await createSearchCampaign(client, "123", briefFixture({ aiMax: true }), "customers/123/budgets/1");
    const resource = campaignResource(calls[0]!.ops[0]!);
    expect((resource["ai_max_setting"] as { enable_ai_max: boolean }).enable_ai_max).toBe(true);
  });

  it("declares EU political status (required on new campaigns)", async () => {
    const { client, calls } = makeFake();
    await createSearchCampaign(client, "123", briefFixture({ aiMax: true }), "customers/123/budgets/1");
    const resource = campaignResource(calls[0]!.ops[0]!);
    expect(resource["contains_eu_political_advertising"]).toBe(
      enums.EuPoliticalAdvertisingStatus.DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING,
    );
  });

  it("respects ai max off", async () => {
    const { client, calls } = makeFake();
    await createSearchCampaign(client, "123", briefFixture({ aiMax: false }), "customers/123/budgets/1");
    const resource = campaignResource(calls[0]!.ops[0]!);
    expect((resource["ai_max_setting"] as { enable_ai_max: boolean }).enable_ai_max).toBe(false);
  });

  it("honors networkSettings: Search Partners follow the brief, Display always off", async () => {
    const cases = [
      { networkSettings: "search-only", expectedSearchNetwork: false },
      { networkSettings: "search-partners-display", expectedSearchNetwork: true },
    ] as const;
    for (const { networkSettings, expectedSearchNetwork } of cases) {
      const { client, calls } = makeFake();
      await createSearchCampaign(client, "123", briefFixture({ networkSettings }), "customers/123/budgets/1");
      const ns = campaignResource(calls[0]!.ops[0]!)["network_settings"] as {
        target_google_search: boolean;
        target_search_network: boolean;
        target_content_network: boolean;
      };
      expect(ns.target_google_search).toBe(true);
      expect(ns.target_search_network).toBe(expectedSearchNetwork);
      expect(ns.target_content_network).toBe(false);
    }
  });
});

describe("targetDevices", () => {
  it("excludes the unlisted devices at -100%", async () => {
    const { client, calls } = makeFake();
    await targetDevices(client, "123", CAMPAIGN_RN, ["computer"]);
    const ops = calls[0]!.ops;
    const excludedTypes = new Set(ops.map((op) => (op.resource["device"] as { type: number }).type));
    expect(excludedTypes).toEqual(
      new Set([enums.Device.MOBILE, enums.Device.TABLET, enums.Device.CONNECTED_TV]),
    );
    expect(ops.every((op) => op.resource["bid_modifier"] === 0.0)).toBe(true);
    expect(ops.every((op) => op.resource["campaign"] === CAMPAIGN_RN)).toBe(true);
  });

  it("defaults to excluding mobile", async () => {
    const { client, calls } = makeFake();
    await targetDevices(client, "123", CAMPAIGN_RN, undefined);
    const ops = calls[0]!.ops;
    const excludedTypes = new Set(ops.map((op) => (op.resource["device"] as { type: number }).type));
    expect(excludedTypes).toEqual(new Set([enums.Device.MOBILE]));
    expect(ops.every((op) => op.resource["bid_modifier"] === 0.0)).toBe(true);
  });

  it("no-ops when every device is listed", async () => {
    const { client, calls } = makeFake();
    await targetDevices(client, "123", CAMPAIGN_RN, [...ALL_DEVICES]);
    expect(calls).toHaveLength(0);
  });
});

describe("createNegativeKeywords", () => {
  it("sets the negative flag on each criterion", async () => {
    const { client, calls } = makeFake();
    const negs: Keyword[] = [
      { text: "jobs", matchType: "PHRASE" },
      { text: "near me", matchType: "BROAD" },
    ];
    const rns = await createNegativeKeywords(client, "123", CAMPAIGN_RN, negs);
    expect(rns).toHaveLength(2);
    const ops = calls[0]!.ops;
    expect(ops.every((op) => op.resource["negative"] === true)).toBe(true);
    expect(ops.map((op) => (op.resource["keyword"] as { text: string }).text)).toEqual(["jobs", "near me"]);
    expect(ops.map((op) => (op.resource["keyword"] as { match_type: number }).match_type)).toEqual([
      enums.KeywordMatchType.PHRASE,
      enums.KeywordMatchType.BROAD,
    ]);
    expect(ops.every((op) => op.resource["campaign"] === CAMPAIGN_RN)).toBe(true);
  });

  it("no-ops when empty", async () => {
    const { client, calls } = makeFake();
    expect(await createNegativeKeywords(client, "123", CAMPAIGN_RN, [])).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe("createPriceAsset", () => {
  const priceAsset = {
    type: "SERVICES",
    languageCode: "en",
    currencyCode: "USD",
    offerings: [
      { header: "One Pack", description: "Branded SOW", priceMicros: 249_000_000, finalUrl: "https://www.example.com/x" },
      { header: "Three Pack", description: "Templates", priceMicros: 699_000_000, finalUrl: "https://www.example.com/x" },
      { header: "Eight Pack", description: "Controls", priceMicros: 1_499_000_000, finalUrl: "https://www.example.com/x" },
    ],
  };

  it("appends offerings with the singular final_url key", async () => {
    const { client, calls } = makeFake();
    const rns = await createPriceAsset(client, "123", briefFixture({ priceAsset }), CAMPAIGN_RN);
    const offerings = (calls[0]!.ops[0]!.resource["price_asset"] as {
      price_offerings: Array<{ header: string; final_url: string; price: { amount_micros: number } }>;
    }).price_offerings;
    expect(offerings).toHaveLength(3);
    expect(offerings[0]!.header).toBe("One Pack");
    expect(offerings[0]!.final_url).toBe("https://www.example.com/x");
    expect(offerings[0]!.price.amount_micros).toBe(249_000_000);
    expect(rns).toHaveLength(1);
  });
});

describe("createStructuredSnippet", () => {
  const structuredSnippet = { header: "SERVICE_CATALOG", values: ["SOW generator", "Guardrail page", "Closeout"] };

  it("maps the header to its API display string", async () => {
    const { client, calls } = makeFake();
    const rns = await createStructuredSnippet(client, "123", briefFixture({ structuredSnippet }), CAMPAIGN_RN);
    const asset = calls[0]!.ops[0]!.resource["structured_snippet_asset"] as { header: string; values: string[] };
    expect(asset.header).toBe("Service catalog");
    expect(asset.values).toEqual(["SOW generator", "Guardrail page", "Closeout"]);
    expect(rns).toHaveLength(1);
  });
});

describe("buildKeywordOps", () => {
  const ag = "customers/123/adGroups/9";

  it("builds create + remove + pause ops", () => {
    const adds: Keyword[] = [{ text: "brand voice ai", matchType: "PHRASE" }];
    const ops = buildKeywordOps(
      ag,
      adds,
      ["customers/123/adGroupCriteria/9~111"],
      ["customers/123/adGroupCriteria/9~222"],
    );
    expect(ops).toHaveLength(3);
    expect(ops[0]!.operation).toBe("create");
    expect(ops[0]!.resource["ad_group"]).toBe(ag);
    expect((ops[0]!.resource["keyword"] as { text: string }).text).toBe("brand voice ai");
    expect((ops[0]!.resource["keyword"] as { match_type: number }).match_type).toBe(enums.KeywordMatchType.PHRASE);
    expect(ops[1]!.operation).toBe("remove");
    expect(ops[1]!.resource["resource_name"]).toBe("customers/123/adGroupCriteria/9~111");
    expect(ops[2]!.operation).toBe("update");
    expect(ops[2]!.resource["status"]).toBe(enums.AdGroupCriterionStatus.PAUSED);
    expect(ops[2]!.resource["resource_name"]).toBe("customers/123/adGroupCriteria/9~222");
  });

  it("builds add-only ops", () => {
    const ops = buildKeywordOps("customers/1/adGroups/2", [{ text: "dtc customer service ai", matchType: "EXACT" }], [], []);
    expect(ops).toHaveLength(1);
    expect((ops[0]!.resource["keyword"] as { match_type: number }).match_type).toBe(enums.KeywordMatchType.EXACT);
  });
});

describe("buildLanguageOps", () => {
  const rn = "customers/123/campaigns/9";

  it("adds English when it isn't live (default all-languages -> English only)", () => {
    const ops = buildLanguageOps(rn, true, []);
    expect(ops).toHaveLength(1);
    expect(ops[0]!.operation).toBe("create");
    expect(ops[0]!.resource["campaign"]).toBe(rn);
    expect((ops[0]!.resource["language"] as { language_constant: string }).language_constant).toBe(
      ENGLISH_LANGUAGE_CONSTANT,
    );
  });

  it("is an idempotent no-op when English is already the sole language", () => {
    // English already live, nothing else to remove -> no ops (reported skipped upstream).
    expect(buildLanguageOps(rn, false, [])).toEqual([]);
  });

  it("removes the other live languages to make it English-exclusive", () => {
    // English absent + two other languages live: add English, remove both others.
    const ops = buildLanguageOps(rn, true, [
      "customers/123/campaignCriteria/9~1001",
      "customers/123/campaignCriteria/9~1003",
    ]);
    expect(ops.map((o) => o.operation)).toEqual(["create", "remove", "remove"]);
    expect(ops.slice(1).map((o) => o.resource["resource_name"])).toEqual([
      "customers/123/campaignCriteria/9~1001",
      "customers/123/campaignCriteria/9~1003",
    ]);
  });
});

describe("setCampaignStatus", () => {
  it("updates status without a manual mask", async () => {
    const { client, calls } = makeFake();
    const rn = await setCampaignStatus(client, "123", "9", "ENABLED");
    expect(calls[0]!.customerId).toBe("123");
    const op = calls[0]!.ops[0]!;
    expect(op.operation).toBe("update");
    expect(op.resource["resource_name"]).toBe("customers/123/campaigns/9");
    expect(op.resource["status"]).toBe(enums.CampaignStatus.ENABLED);
    expect(rn).toBe("rn/0");
  });

  it("uses the PAUSED enum when pausing", async () => {
    const { client, calls } = makeFake();
    await setCampaignStatus(client, "123", "9", "PAUSED");
    expect(calls[0]!.ops[0]!.resource["status"]).toBe(enums.CampaignStatus.PAUSED);
  });
});
