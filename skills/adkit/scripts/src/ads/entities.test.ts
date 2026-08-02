import { describe, expect, it } from "vitest";
import { enums } from "google-ads-api";
import type { AdsClient, AdsMutateOperation, MutateResult } from "../lib/auth.js";
import { parseBrief, type Keyword } from "../lib/schema.js";
import {
  ALL_DEVICES,
  ENGLISH_LANGUAGE_CONSTANT,
  GEO_TARGETS,
  buildAudienceSegmentOps,
  buildKeywordOps,
  buildLanguageOps,
  createAdGroup,
  createAudienceSegments,
  createCallouts,
  createNegativeKeywords,
  createPriceAsset,
  createResponsiveSearchAd,
  createSearchCampaign,
  createSitelinks,
  createStructuredSnippet,
  resolveAudienceSegment,
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

function briefFixture(
  campaignOverrides: Record<string, unknown>,
  adGroupOverrides: Record<string, unknown> = {},
): ReturnType<typeof parseBrief> {
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
        responsiveSearchAds: [
          {
            headlines: Array.from({ length: 15 }, (_, i) => ({ text: `H${i}` })),
            descriptions: Array.from({ length: 4 }, (_, i) => ({ text: `D${i}` })),
            finalUrl: "https://www.example.com/x",
          },
          {
            headlines: Array.from({ length: 15 }, (_, i) => ({ text: `H2-${i}` })),
            descriptions: Array.from({ length: 4 }, (_, i) => ({ text: `D2-${i}` })),
            finalUrl: "https://www.example.com/x",
          },
        ],
        keywords: [{ text: "kw", matchType: "PHRASE" }],
        ...adGroupOverrides,
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

  it("disables AI Max search-term matching by default (ad-group opt-out)", async () => {
    const { client, calls } = makeFake();
    const ag = briefFixture({}).adGroups[0]!;
    await createAdGroup(client, "123", ag, CAMPAIGN_RN);
    const setting = calls[0]!.ops[0]!.resource["ai_max_ad_group_setting"] as { disable_search_term_matching: boolean };
    expect(setting.disable_search_term_matching).toBe(true);
  });

  it("keeps AI Max search-term matching on when the ad group opts in (adGroup.aiMax)", async () => {
    const { client, calls } = makeFake();
    const ag = { ...briefFixture({}).adGroups[0]!, aiMax: true };
    await createAdGroup(client, "123", ag, CAMPAIGN_RN);
    const setting = calls[0]!.ops[0]!.resource["ai_max_ad_group_setting"] as { disable_search_term_matching: boolean };
    expect(setting.disable_search_term_matching).toBe(false);
  });
});

describe("createResponsiveSearchAd", () => {
  it("takes a single RSA (not the whole ad group) and creates one ad_group_ad", async () => {
    const { client, calls } = makeFake();
    const [rsa1, rsa2] = briefFixture({}).adGroups[0]!.responsiveSearchAds;
    await createResponsiveSearchAd(client, "123", rsa1!, "customers/123/adGroups/9");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.ops[0]!.entity).toBe("ad_group_ad");
    expect(calls[0]!.ops[0]!.resource["ad"]).toMatchObject({
      responsive_search_ad: { headlines: rsa1!.headlines.map((h) => ({ text: h.text })) },
    });

    await createResponsiveSearchAd(client, "123", rsa2!, "customers/123/adGroups/9");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.ops[0]!.resource["ad"]).toMatchObject({
      responsive_search_ad: { headlines: rsa2!.headlines.map((h) => ({ text: h.text })) },
    });
  });

  it("creates the ad PAUSED", async () => {
    const { client, calls } = makeFake();
    const rsa = briefFixture({}).adGroups[0]!.responsiveSearchAds[0]!;
    await createResponsiveSearchAd(client, "123", rsa, "customers/123/adGroups/9");
    expect(calls[0]!.ops[0]!.resource["status"]).toBe(enums.AdGroupAdStatus.PAUSED);
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

  it("honors networkSettings: Search Partners follow the brief, Display off except display-remarketing (SC-002)", async () => {
    const cases = [
      { networkSettings: "search-only", expectedSearchNetwork: false, expectedDisplay: false },
      { networkSettings: "search-partners-display", expectedSearchNetwork: true, expectedDisplay: false },
      { networkSettings: "display-remarketing", expectedSearchNetwork: true, expectedDisplay: true },
    ] as const;
    for (const { networkSettings, expectedSearchNetwork, expectedDisplay } of cases) {
      const { client, calls } = makeFake();
      const adGroupOverrides =
        networkSettings === "display-remarketing" ? { audienceSegments: [{ audienceId: 123 }] } : {};
      await createSearchCampaign(
        client,
        "123",
        briefFixture({ networkSettings }, adGroupOverrides),
        "customers/123/budgets/1",
      );
      const resource = campaignResource(calls[0]!.ops[0]!);
      const ns = resource["network_settings"] as {
        target_google_search: boolean;
        target_search_network: boolean;
        target_content_network: boolean;
      };
      expect(ns.target_google_search).toBe(true);
      expect(ns.target_search_network).toBe(expectedSearchNetwork);
      expect(ns.target_content_network).toBe(expectedDisplay);
      // advertising_channel_type stays SEARCH even for display-remarketing — the
      // existing RSA authoring pipeline is reused (Search Network with Display
      // Select), not a true Display-creative campaign type.
      expect(resource["advertising_channel_type"]).toBe(enums.AdvertisingChannelType.SEARCH);
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

/** A fake supporting configurable `search` results, keyed by the table name in the query. */
function makeFakeWithSearch(
  tableResults: Record<string, Array<Record<string, { resource_name: string }>>>,
): { client: AdsClient; calls: Array<{ customerId: string; ops: AdsMutateOperation[] }> } {
  const calls: Array<{ customerId: string; ops: AdsMutateOperation[] }> = [];
  const client: AdsClient = {
    search: async (_customerId, query) => {
      for (const table of Object.keys(tableResults)) {
        if (query.includes(`FROM ${table} `)) {
          return tableResults[table] as never[];
        }
      }
      return [];
    },
    searchStructured: async () => [],
    mutate: async (customerId, ops) => {
      calls.push({ customerId, ops });
      return { results: ops.map((_, i) => ({ resource_name: `rn/${i}` })) };
    },
  };
  return { client, calls };
}

describe("resolveAudienceSegment", () => {
  it("resolves a user_list-typed audienceId", async () => {
    const { client } = makeFakeWithSearch({
      user_list: [{ user_list: { resource_name: "customers/123/userLists/111" } }],
    });
    const resolved = await resolveAudienceSegment(client, "123", 111);
    expect(resolved).toEqual({ audienceId: 111, field: "user_list", resourceName: "customers/123/userLists/111" });
  });

  it("falls through to custom_audience when not a user_list", async () => {
    const { client } = makeFakeWithSearch({
      user_list: [],
      custom_audience: [{ custom_audience: { resource_name: "customers/123/customAudiences/222" } }],
    });
    const resolved = await resolveAudienceSegment(client, "123", 222);
    expect(resolved.field).toBe("custom_audience");
  });

  it("throws a clear error when the audienceId matches nothing", async () => {
    const { client } = makeFakeWithSearch({});
    await expect(resolveAudienceSegment(client, "123", 999)).rejects.toThrow(/no audience segment found/);
  });

  it("throws a clear ambiguity error when the same id matches more than one resource table", async () => {
    // A user_list and a custom_audience happen to share the same numeric id —
    // Google Ads IDs are only unique within their own resource type. Silently
    // picking the first match would attach the wrong criterion type.
    const { client } = makeFakeWithSearch({
      user_list: [{ user_list: { resource_name: "customers/123/userLists/111" } }],
      custom_audience: [{ custom_audience: { resource_name: "customers/123/customAudiences/111" } }],
    });
    await expect(resolveAudienceSegment(client, "123", 111)).rejects.toThrow(/is ambiguous/);
  });
});

describe("buildAudienceSegmentOps", () => {
  const rn = "customers/123/adGroups/9";

  it("builds a create op per resolved add, templating the oneof field name", () => {
    const ops = buildAudienceSegmentOps(
      rn,
      [
        { audienceId: 111, field: "user_list", resourceName: "customers/123/userLists/111" },
        { audienceId: 222, field: "custom_audience", resourceName: "customers/123/customAudiences/222" },
      ],
      [],
    );
    expect(ops).toHaveLength(2);
    expect(ops[0]!.operation).toBe("create");
    expect(ops[0]!.resource["user_list"]).toEqual({ user_list: "customers/123/userLists/111" });
    expect(ops[0]!.resource["negative"]).toBe(false);
    expect(ops[1]!.resource["custom_audience"]).toEqual({ custom_audience: "customers/123/customAudiences/222" });
  });

  it("builds a remove op per resource name", () => {
    const ops = buildAudienceSegmentOps(rn, [], ["customers/123/adGroupCriteria/9~111"]);
    expect(ops).toEqual([
      { entity: "ad_group_criterion", operation: "remove", resource: { resource_name: "customers/123/adGroupCriteria/9~111" } },
    ]);
  });

  it("is a no-op with no adds and no removes", () => {
    expect(buildAudienceSegmentOps(rn, [], [])).toEqual([]);
  });
});

describe("createAudienceSegments", () => {
  it("is a no-op when the ad group lists no audience segments", async () => {
    const { client, calls } = makeFakeWithSearch({});
    const rns = await createAudienceSegments(
      client,
      "123",
      briefFixture({}).adGroups[0]!,
      "customers/123/adGroups/9",
    );
    expect(rns).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("resolves and creates a criterion for each audienceSegments entry", async () => {
    const { client, calls } = makeFakeWithSearch({
      user_list: [{ user_list: { resource_name: "customers/123/userLists/111" } }],
    });
    const brief = briefFixture({}, { audienceSegments: [{ audienceId: 111 }] });
    const rns = await createAudienceSegments(client, "123", brief.adGroups[0]!, "customers/123/adGroups/9");
    expect(rns).toEqual(["rn/0"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.ops[0]!.resource["ad_group"]).toBe("customers/123/adGroups/9");
    expect(calls[0]!.ops[0]!.resource["user_list"]).toEqual({ user_list: "customers/123/userLists/111" });
  });
});
