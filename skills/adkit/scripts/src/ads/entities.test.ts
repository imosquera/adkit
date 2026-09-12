import { describe, expect, it } from "vitest";
import { enums } from "google-ads-api";
import type { AdsClient, AdsMutateOperation, MutateResult } from "../lib/auth.js";
import { RadiusTargetSchema, parseBrief, type Keyword } from "../lib/schema.js";
import {
  ALL_DEVICES,
  ENGLISH_LANGUAGE_CONSTANT,
  GEO_TARGETS,
  buildKeywordOps,
  buildLanguageOps,
  createAdGroup,
  createCallouts,
  createKeywords,
  createNegativeKeywords,
  createPriceAsset,
  createResponsiveSearchAd,
  createSearchCampaign,
  createSitelinks,
  createStructuredSnippet,
  findExistingCampaign,
  findMissingKeywords,
  findMissingResponsiveSearchAds,
  setCampaignStatus,
  effectiveLocations,
  proximityInfo,
  resolveLocations,
  targetRadius,
  targetDevices,
  targetLocations,
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

/** A fake whose `search` answers by query substring; mutates are recorded. */
function makeSearchFake(answer: (query: string) => unknown[]): ReturnType<typeof makeFake> {
  const fake = makeFake();
  return { ...fake, client: { ...fake.client, search: async <Row>(_c: string, q: string) => answer(q) as Row[] } };
}

describe("resolveLocations", () => {
  it("defaults to US + Canada without querying", async () => {
    const { client } = makeSearchFake(() => {
      throw new Error("should not query");
    });
    expect(await resolveLocations(client, "123", undefined)).toEqual([...GEO_TARGETS]);
  });

  it("resolves ids and canonical city names to resource names, in brief order", async () => {
    const queries: string[] = [];
    const { client } = makeSearchFake((q) => {
      queries.push(q);
      return q.includes("canonical_name IN")
        ? [{ geo_target_constant: { resource_name: "geoTargetConstants/1014221", id: 1014221, canonical_name: "Chicago,Illinois,United States" } }]
        : [{ geo_target_constant: { resource_name: "geoTargetConstants/9061285", id: "9061285", canonical_name: "Toronto,Ontario,Canada" } }];
    });
    expect(await resolveLocations(client, "123", ["Chicago,Illinois,United States", "9061285"])).toEqual([
      "geoTargetConstants/1014221",
      "geoTargetConstants/9061285",
    ]);
    expect(queries).toHaveLength(2);
  });

  it("fails naming every unknown location", async () => {
    const { client } = makeSearchFake(() => []);
    await expect(resolveLocations(client, "123", ["Chicgo,Illinois,United States"])).rejects.toThrow(/Chicgo/);
  });
});

describe("findExistingCampaign", () => {
  it("refuses to reuse a same-named campaign from another channel", async () => {
    const { client } = makeSearchFake(() => [
      { campaign: { resource_name: CAMPAIGN_RN, advertising_channel_type: enums.AdvertisingChannelType.SEARCH } },
    ]);
    await expect(findExistingCampaign(client, "123", { campaign: { name: "x" } }, "DISPLAY")).rejects.toThrow(
      /already exists as a SEARCH campaign/,
    );
    expect(await findExistingCampaign(client, "123", { campaign: { name: "x" } }, "SEARCH")).toEqual([CAMPAIGN_RN, null]);
  });
});

describe("targetLocations", () => {
  it("creates missing geos and removes live ones the brief dropped (country narrowed to a city)", async () => {
    const { client, calls } = makeSearchFake(() => [
      { campaign_criterion: { resource_name: "cc/us", location: { geo_target_constant: "geoTargetConstants/2840" } } },
      { campaign_criterion: { resource_name: "cc/dev", device: { type: 2 }, bid_modifier: 0 } },
    ]);
    await targetLocations(client, "123", CAMPAIGN_RN, ["geoTargetConstants/1014221"]);
    expect(calls[0]!.ops).toEqual([
      {
        entity: "campaign_criterion",
        operation: "create",
        resource: { campaign: CAMPAIGN_RN, location: { geo_target_constant: "geoTargetConstants/1014221" } },
      },
      { entity: "campaign_criterion", operation: "remove", resource: { resource_name: "cc/us" } },
    ]);
  });

  it("no-ops on a reused campaign already targeting exactly the brief's geos", async () => {
    const { client, calls } = makeSearchFake(() =>
      GEO_TARGETS.map((geo) => ({ campaign_criterion: { resource_name: geo, location: { geo_target_constant: geo } } })),
    );
    await targetLocations(client, "123", CAMPAIGN_RN, [...GEO_TARGETS]);
    expect(calls).toHaveLength(0);
  });

  it("sets both default geos on a fresh campaign", async () => {
    const { client, calls } = makeFake();
    await targetLocations(client, "123", CAMPAIGN_RN, [...GEO_TARGETS]);

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

  it("on a reused campaign, skips excluded devices and updates a live non-zero modifier", async () => {
    const { client, calls } = makeSearchFake(() => [
      { campaign_criterion: { resource_name: "cc/mobile", device: { type: "MOBILE" }, bid_modifier: 0 } },
      { campaign_criterion: { resource_name: "cc/tablet", device: { type: enums.Device.TABLET }, bid_modifier: 1.2 } },
    ]);
    await targetDevices(client, "123", CAMPAIGN_RN, ["computer", "tv"]);
    expect(calls[0]!.ops).toEqual([
      { entity: "campaign_criterion", operation: "update", resource: { resource_name: "cc/tablet", bid_modifier: 0 } },
    ]);
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

/** A fake AdsClient whose `search` returns canned rows, ignoring the query. */
function makeFakeWithSearchRows(rows: unknown[]): { client: AdsClient; calls: Array<{ customerId: string; ops: AdsMutateOperation[] }> } {
  const calls: Array<{ customerId: string; ops: AdsMutateOperation[] }> = [];
  const client: AdsClient = {
    search: async <Row = unknown>() => rows as Row[],
    searchStructured: async () => [],
    mutate: async (customerId, ops): Promise<MutateResult> => {
      calls.push({ customerId, ops });
      return { results: ops.map((_, i) => ({ resource_name: `rn/${i}` })) };
    },
  };
  return { client, calls };
}

const AD_GROUP_RN = "customers/123/adGroups/5";

describe("createKeywords", () => {
  it("creates the given keywords (enabled) on the ad group", async () => {
    const { client, calls } = makeFake();
    const kws: Keyword[] = [{ text: "widget", matchType: "PHRASE" }];
    const rns = await createKeywords(client, "123", kws, AD_GROUP_RN);
    expect(rns).toHaveLength(1);
    expect(calls[0]!.ops[0]!.resource["ad_group"]).toBe(AD_GROUP_RN);
    expect(calls[0]!.ops[0]!.resource["status"]).toBe(enums.AdGroupCriterionStatus.ENABLED);
  });

  it("no-ops (no mutate call) when given no keywords — e.g. everything was already live", async () => {
    const { client, calls } = makeFake();
    expect(await createKeywords(client, "123", [], AD_GROUP_RN)).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe("findMissingResponsiveSearchAds (bug 2: idempotent RSA creation)", () => {
  const briefRsas = briefFixture({}).adGroups[0]!.responsiveSearchAds;

  it("treats every brief RSA as missing when the ad group has none live", async () => {
    const { client } = makeFakeWithSearchRows([]);
    const missing = await findMissingResponsiveSearchAds(client, "123", AD_GROUP_RN, briefRsas);
    expect(missing).toEqual(briefRsas);
  });

  it("excludes a brief RSA whose exact headline/description content is already live", async () => {
    const live = briefRsas[0]!;
    const { client } = makeFakeWithSearchRows([
      {
        ad_group_ad: {
          ad: {
            responsive_search_ad: {
              headlines: live.headlines.map((h) => ({ text: h.text })),
              descriptions: live.descriptions.map((d) => ({ text: d.text })),
            },
          },
        },
      },
    ]);
    const missing = await findMissingResponsiveSearchAds(client, "123", AD_GROUP_RN, briefRsas);
    expect(missing).toEqual([briefRsas[1]]);
  });

  it("ignores headline/description ORDER when matching content (order-independent identity)", async () => {
    const live = briefRsas[0]!;
    const { client } = makeFakeWithSearchRows([
      {
        ad_group_ad: {
          ad: {
            responsive_search_ad: {
              headlines: [...live.headlines].reverse().map((h) => ({ text: h.text })),
              descriptions: [...live.descriptions].reverse().map((d) => ({ text: d.text })),
            },
          },
        },
      },
    ]);
    const missing = await findMissingResponsiveSearchAds(client, "123", AD_GROUP_RN, briefRsas);
    expect(missing).toEqual([briefRsas[1]]);
  });
});

describe("findMissingKeywords (bug 3: keyword creation on a reused ad group)", () => {
  const briefKeywords: Keyword[] = [
    { text: "widget", matchType: "PHRASE" },
    { text: "gadget", matchType: "EXACT" },
  ];

  it("treats every brief keyword as missing when the ad group has none live", async () => {
    const { client } = makeFakeWithSearchRows([]);
    const missing = await findMissingKeywords(client, "123", AD_GROUP_RN, briefKeywords);
    expect(missing).toEqual(briefKeywords);
  });

  it("excludes a brief keyword already live by text + match type, case-insensitively", async () => {
    const { client } = makeFakeWithSearchRows([
      { ad_group_criterion: { keyword: { text: "Widget", match_type: "PHRASE" } } },
    ]);
    const missing = await findMissingKeywords(client, "123", AD_GROUP_RN, briefKeywords);
    expect(missing).toEqual([briefKeywords[1]]);
  });

  it("does not treat the same text under a different match type as already live", async () => {
    const { client } = makeFakeWithSearchRows([
      { ad_group_criterion: { keyword: { text: "widget", match_type: "EXACT" } } },
    ]);
    const missing = await findMissingKeywords(client, "123", AD_GROUP_RN, briefKeywords);
    expect(missing).toEqual(briefKeywords); // "widget"/PHRASE still missing
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

describe("radius targeting", () => {
  const chicago = RadiusTargetSchema.parse({
    address: { streetAddress: "233 S Wacker Dr", cityName: "Chicago", provinceCode: "IL", countryCode: "US" },
    radius: 10,
    units: "miles",
  });
  const point = RadiusTargetSchema.parse({ latitude: 41.8789, longitude: -87.6359, radius: 15, units: "kilometers" });

  it("parses exactly one of address or lat/long, within Google's radius caps", () => {
    expect(() => RadiusTargetSchema.parse({ radius: 5, units: "miles" })).toThrow(/exactly one/);
    expect(() => RadiusTargetSchema.parse({ latitude: 1, radius: 5, units: "miles" })).toThrow(/go together/);
    expect(() => RadiusTargetSchema.parse({ ...point, radius: 900 })).toThrow(/max is 800/);
    expect(() =>
      RadiusTargetSchema.parse({ address: { streetAddress: "1 Main", countryCode: "US" }, radius: 5, units: "miles" }),
    ).toThrow(/cityName or postalCode/);
  });

  it("drops the US + Canada default when only radius targets are given", () => {
    expect(effectiveLocations({})).toBeUndefined();
    expect(effectiveLocations({ radiusTargets: [chicago] })).toEqual([]);
    expect(effectiveLocations({ locations: ["1014221"], radiusTargets: [chicago] })).toEqual(["1014221"]);
  });

  it("builds address and micro-degree geo point proximity infos", () => {
    expect(proximityInfo(chicago)).toEqual({
      radius: 10,
      radius_units: enums.ProximityRadiusUnits.MILES,
      address: { street_address: "233 S Wacker Dr", city_name: "Chicago", province_code: "IL", country_code: "US" },
    });
    expect(proximityInfo(point)).toEqual({
      radius: 15,
      radius_units: enums.ProximityRadiusUnits.KILOMETERS,
      geo_point: { latitude_in_micro_degrees: 41878900, longitude_in_micro_degrees: -87635900 },
    });
  });

  it("no-ops when the live radius targets already match (Google's added geo point ignored)", async () => {
    const { client, calls } = makeSearchFake(() => [
      {
        campaign_criterion: {
          resource_name: "cc/p1",
          proximity: {
            ...proximityInfo(chicago),
            radius_units: "MILES",
            geo_point: { latitude_in_micro_degrees: 41878000, longitude_in_micro_degrees: -87636000 },
          },
        },
      },
    ]);
    await targetRadius(client, "123", CAMPAIGN_RN, [chicago]);
    expect(calls).toHaveLength(0);
  });

  it("replaces live radius targets that differ from the brief", async () => {
    const { client, calls } = makeSearchFake(() => [
      { campaign_criterion: { resource_name: "cc/old", proximity: { ...proximityInfo(chicago), radius: 25 } } },
    ]);
    await targetRadius(client, "123", CAMPAIGN_RN, [chicago, point]);
    expect(calls[0]!.ops.map((op) => op.operation)).toEqual(["remove", "create", "create"]);
    expect(calls[0]!.ops[0]!.resource).toEqual({ resource_name: "cc/old" });
  });
});
