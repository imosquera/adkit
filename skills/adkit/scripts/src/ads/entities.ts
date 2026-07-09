/**
 * SDK entity builders for the publish/apply-fixes/create paths — one function per
 * Google Ads resource hit (budget, campaign, criteria, assets, ad groups, RSAs,
 * keywords) plus the lookup tables they share.
 *
 * Each builder constructs a batch of {@link AdsMutateOperation}s and applies it via
 * the narrow {@link AdsClient} abstraction (`search` + `mutate`), returning the
 * created/updated resource names. The two-step asset builders (sitelinks, callouts,
 * price, snippet) first mutate the asset op(s) to obtain resource names, then mutate
 * `campaign_asset` link op(s) referencing them with the right `AssetFieldType`.
 *
 * Ports `ads_skill/ads/entities.py`. The Python code built proto operations via
 * `client.get_type(...)` and per-service mutate calls; here everything is a plain
 * `{ entity, operation, resource }` record. Resource fields are snake_case (the SDK
 * derives the update mask from the fields present on an `update`).
 */

import { enums } from "google-ads-api";
import type { AdsClient, AdsMutateOperation } from "../lib/auth.js";
import type { AdGroup, Brief, Keyword } from "../lib/schema.js";
import { StepError, gaqlStringLiteral } from "./errors.js";

/**
 * United States (2840) + Canada (2124). Campaigns target these only; without this a
 * Search campaign serves worldwide by default.
 */
export const GEO_TARGETS = ["geoTargetConstants/2840", "geoTargetConstants/2124"] as const;

/** Every device the brief can target. "tv" = CONNECTED_TV (smart TVs/consoles). */
export const ALL_DEVICES = ["computer", "mobile", "tablet", "tv"] as const;

/** brief device name -> Device enum member. */
const DEVICE_ENUM = {
  computer: enums.Device.DESKTOP,
  mobile: enums.Device.MOBILE,
  tablet: enums.Device.TABLET,
  tv: enums.Device.CONNECTED_TV,
} as const;

/**
 * StructuredSnippetAsset.header is a free-text string Google validates against a
 * fixed predefined list — NOT an enum. Map the schema's enum-style names to the
 * exact header strings the API accepts.
 */
export const SNIPPET_HEADERS: Record<string, string> = {
  AMENITIES: "Amenities",
  BRANDS: "Brands",
  COURSES: "Courses",
  DEGREES: "Degree programs",
  DESTINATIONS: "Destinations",
  FEATURED_HOTELS: "Featured hotels",
  INSURANCE_COVERAGE: "Insurance coverage",
  MODELS: "Models",
  NEIGHBORHOODS: "Neighborhoods",
  SERVICE_CATALOG: "Service catalog",
  SHOWS: "Shows",
  STYLES: "Styles",
  TYPES: "Types",
};

/**
 * The bid-strategy resource fragment for a new campaign. New campaigns default to
 * Maximize Clicks (TargetSpend) to seed conversion data and avoid the Smart-Bidding
 * cold start; graduate to Maximize Conversions in the UI once ~15-30 conversions/30d
 * exist. `bidStrategy='maximize-conversions'` launches straight on Smart Bidding.
 * Only these two launch modes are supported; any other value falls back to Maximize
 * Clicks.
 */
export function bidStrategyFields(brief: Brief): Record<string, unknown> {
  if (brief.campaign.bidStrategy === "maximize-conversions") {
    return { maximize_conversions: { target_cpa_micros: 0 } };
  }
  const targetSpend: Record<string, unknown> = {};
  if (brief.campaign.cpcBidCeilingMicros) {
    targetSpend["cpc_bid_ceiling_micros"] = brief.campaign.cpcBidCeilingMicros;
  }
  return { target_spend: targetSpend };
}

/** Create the campaign budget; returns the budget resource name. */
export async function createCampaignBudget(
  client: AdsClient,
  customerId: string,
  brief: Brief,
): Promise<string> {
  const op: AdsMutateOperation = {
    entity: "campaign_budget",
    operation: "create",
    resource: {
      name: `${brief.campaign.name} Budget`,
      amount_micros: brief.campaign.budgetMicros,
      delivery_method: enums.BudgetDeliveryMethod.STANDARD,
      explicitly_shared: false,
    },
  };
  const result = await client.mutate(customerId, [op]);
  return result.results[0]!.resource_name;
}

/**
 * Find a live (non-removed) campaign by name, returning `[resourceName, budgetRn]`
 * (budget null when unset) or null when none exists. Throws a {@link StepError} on
 * more than one match.
 */
export async function findExistingCampaign(
  client: AdsClient,
  customerId: string,
  brief: Brief,
): Promise<[string, string | null] | null> {
  const query =
    "SELECT campaign.resource_name, campaign.campaign_budget " +
    "FROM campaign " +
    `WHERE campaign.name = '${gaqlStringLiteral(brief.campaign.name)}' ` +
    "AND campaign.status != 'REMOVED'";
  const rows = await client.search<{ campaign: { resource_name: string; campaign_budget?: string } }>(
    customerId,
    query,
  );
  if (rows.length === 0) {
    return null;
  }
  if (rows.length > 1) {
    throw new StepError(
      "find-existing-campaign",
      `multiple non-removed campaigns named ${JSON.stringify(brief.campaign.name)}; remove duplicates before retrying`,
      null,
    );
  }
  const campaign = rows[0]!.campaign;
  return [campaign.resource_name, campaign.campaign_budget || null];
}

/**
 * Create the paused Search campaign wired to `budgetRn`. Display Network is always
 * off; geo targeting is PRESENCE-only; AI Max follows the brief.
 */
export async function createSearchCampaign(
  client: AdsClient,
  customerId: string,
  brief: Brief,
  budgetRn: string,
): Promise<string> {
  // "search-only" = Google search results only. "search-partners-display" also
  // serves on Google search partner sites (target_search_network). The Display
  // Network (target_content_network) is intentionally always OFF.
  const expanded = brief.campaign.networkSettings !== "search-only";
  const resource: Record<string, unknown> = {
    name: brief.campaign.name,
    advertising_channel_type: enums.AdvertisingChannelType.SEARCH,
    status: enums.CampaignStatus.PAUSED,
    ...bidStrategyFields(brief),
    campaign_budget: budgetRn,
    network_settings: {
      target_google_search: true,
      target_search_network: true,
      target_content_network: false,
      target_partner_search_network: false,
    },
    // PRESENCE = serve only to people physically in the targeted locations.
    geo_target_type_setting: {
      positive_geo_target_type: enums.PositiveGeoTargetType.PRESENCE,
    },
    // AI Max: lets Google AI expand beyond exact/phrase keywords via broad-match
    // tech and match landing-page/asset content to more queries.
    ai_max_setting: { enable_ai_max: brief.campaign.aiMax },
  };
  // `expanded` documents the search-partners intent; target_search_network is on in
  // both modes (Display stays off regardless), matching the Python behavior.
  void expanded;
  const op: AdsMutateOperation = { entity: "campaign", operation: "create", resource };
  const result = await client.mutate(customerId, [op]);
  return result.results[0]!.resource_name;
}

/**
 * Flip a live campaign's serving status to ENABLED or PAUSED (an update; the SDK
 * derives the mask from the present `status` field). Returns the campaign resource
 * name.
 */
export async function setCampaignStatus(
  client: AdsClient,
  customerId: string,
  campaignId: string,
  status: "ENABLED" | "PAUSED",
): Promise<string> {
  const op: AdsMutateOperation = {
    entity: "campaign",
    operation: "update",
    resource: {
      resource_name: `customers/${customerId}/campaigns/${campaignId}`,
      status: enums.CampaignStatus[status],
    },
  };
  const result = await client.mutate(customerId, [op]);
  return result.results[0]!.resource_name;
}

/**
 * Flip a live ad group's serving status to ENABLED or PAUSED. Mirrors
 * {@link setCampaignStatus} one level down. Returns the ad group resource name.
 */
export async function setAdGroupStatus(
  client: AdsClient,
  customerId: string,
  adGroupId: string,
  status: "ENABLED" | "PAUSED",
): Promise<string> {
  const op: AdsMutateOperation = {
    entity: "ad_group",
    operation: "update",
    resource: {
      resource_name: `customers/${customerId}/adGroups/${adGroupId}`,
      status: enums.AdGroupStatus[status],
    },
  };
  const result = await client.mutate(customerId, [op]);
  return result.results[0]!.resource_name;
}

/**
 * Create each sitelink as a SitelinkAsset, then link all of them to the campaign via
 * CampaignAsset(field_type=SITELINK). Returns the CampaignAsset resource names.
 * No-op (returns []) when the brief carries no sitelinks.
 */
export async function createSitelinks(
  client: AdsClient,
  customerId: string,
  brief: Brief,
  campaignRn: string,
): Promise<string[]> {
  const sitelinks = brief.campaign.sitelinks;
  if (sitelinks.length === 0) {
    return [];
  }
  const assetOps: AdsMutateOperation[] = sitelinks.map((sl) => {
    const sitelinkAsset: Record<string, unknown> = { link_text: sl.text };
    if (sl.description1 !== undefined) {
      sitelinkAsset["description1"] = sl.description1;
      sitelinkAsset["description2"] = sl.description2;
    }
    return {
      entity: "asset",
      operation: "create",
      resource: { sitelink_asset: sitelinkAsset, final_urls: [String(sl.finalUrl)] },
    };
  });
  const assetRns = (await client.mutate(customerId, assetOps)).results.map((r) => r.resource_name);
  return linkAssetsToCampaign(client, customerId, campaignRn, assetRns, enums.AssetFieldType.SITELINK);
}

/**
 * Create each callout as a CalloutAsset, then link all of them to the campaign via
 * CampaignAsset(field_type=CALLOUT). Returns the CampaignAsset resource names. No-op
 * (returns []) when the brief carries no callouts.
 */
export async function createCallouts(
  client: AdsClient,
  customerId: string,
  brief: Brief,
  campaignRn: string,
): Promise<string[]> {
  const callouts = brief.campaign.callouts;
  if (callouts.length === 0) {
    return [];
  }
  const assetOps: AdsMutateOperation[] = callouts.map((text) => ({
    entity: "asset",
    operation: "create",
    resource: { callout_asset: { callout_text: text } },
  }));
  const assetRns = (await client.mutate(customerId, assetOps)).results.map((r) => r.resource_name);
  return linkAssetsToCampaign(client, customerId, campaignRn, assetRns, enums.AssetFieldType.CALLOUT);
}

/** Create and attach the brief's campaign-level PriceAsset, if present. */
export async function createPriceAsset(
  client: AdsClient,
  customerId: string,
  brief: Brief,
  campaignRn: string,
): Promise<string[]> {
  const priceAsset = brief.campaign.priceAsset;
  if (priceAsset === undefined) {
    return [];
  }
  const priceOfferings = priceAsset.offerings.map((offering) => ({
    header: offering.header,
    description: offering.description,
    price: {
      amount_micros: offering.priceMicros,
      currency_code: priceAsset.currencyCode,
    },
    final_url: String(offering.finalUrl),
  }));
  const assetOp: AdsMutateOperation = {
    entity: "asset",
    operation: "create",
    resource: {
      price_asset: {
        type: enums.PriceExtensionType[priceAsset.type as keyof typeof enums.PriceExtensionType],
        language_code: priceAsset.languageCode,
        price_offerings: priceOfferings,
      },
    },
  };
  const assetRn = (await client.mutate(customerId, [assetOp])).results[0]!.resource_name;
  return linkAssetsToCampaign(client, customerId, campaignRn, [assetRn], enums.AssetFieldType.PRICE);
}

/** Create and attach the brief's campaign-level StructuredSnippetAsset, if present. */
export async function createStructuredSnippet(
  client: AdsClient,
  customerId: string,
  brief: Brief,
  campaignRn: string,
): Promise<string[]> {
  const snippet = brief.campaign.structuredSnippet;
  if (snippet === undefined) {
    return [];
  }
  const assetOp: AdsMutateOperation = {
    entity: "asset",
    operation: "create",
    resource: {
      structured_snippet_asset: {
        header: SNIPPET_HEADERS[snippet.header],
        values: [...snippet.values],
      },
    },
  };
  const assetRn = (await client.mutate(customerId, [assetOp])).results[0]!.resource_name;
  return linkAssetsToCampaign(
    client,
    customerId,
    campaignRn,
    [assetRn],
    enums.AssetFieldType.STRUCTURED_SNIPPET,
  );
}

/**
 * Link already-created assets to a campaign via CampaignAsset ops with the given
 * field type; returns the CampaignAsset resource names. Shared by the asset builders.
 */
async function linkAssetsToCampaign(
  client: AdsClient,
  customerId: string,
  campaignRn: string,
  assetRns: string[],
  fieldType: number,
): Promise<string[]> {
  const linkOps: AdsMutateOperation[] = assetRns.map((assetRn) => ({
    entity: "campaign_asset",
    operation: "create",
    resource: { campaign: campaignRn, asset: assetRn, field_type: fieldType },
  }));
  return (await client.mutate(customerId, linkOps)).results.map((r) => r.resource_name);
}

/**
 * Restrict serving to `devices` by setting a -100% (bid_modifier=0) criterion on
 * every device NOT listed. `undefined` (field omitted) => default brief, which
 * excludes mobile at -100% (computer/tablet/tv serve). List every device to serve
 * everywhere. Exclusion via bid_modifier=0 is honored even under Smart Bidding.
 */
export async function targetDevices(
  client: AdsClient,
  customerId: string,
  campaignRn: string,
  devices: string[] | undefined,
): Promise<void> {
  const targeted = devices ?? ALL_DEVICES.filter((d) => d !== "mobile"); // default: mobile -100%
  const excluded = ALL_DEVICES.filter((d) => !targeted.includes(d));
  if (excluded.length === 0) {
    return;
  }
  const ops: AdsMutateOperation[] = excluded.map((d) => ({
    entity: "campaign_criterion",
    operation: "create",
    resource: {
      campaign: campaignRn,
      device: { type: DEVICE_ENUM[d] },
      bid_modifier: 0.0, // -100% = device excluded
    },
  }));
  await client.mutate(customerId, ops);
}

/**
 * Build CampaignCriterion ops for campaign-level negative keywords. `negatives` is
 * any list of items exposing `.text`/`.matchType`. Shared by the create publish path
 * and the audit apply-fixes path; the caller mutates. Pure.
 */
export function buildNegativeKeywordOps(campaignRn: string, negatives: Keyword[]): AdsMutateOperation[] {
  return negatives.map((kw) => ({
    entity: "campaign_criterion",
    operation: "create",
    resource: {
      campaign: campaignRn,
      negative: true,
      keyword: { text: kw.text, match_type: enums.KeywordMatchType[kw.matchType] },
    },
  }));
}

/**
 * Build AdGroupCriterion ops for a positive-keyword edit on one ad group: create
 * each ADD keyword, remove each REMOVE criterion (by resource name), and pause each
 * PAUSE criterion (update status=PAUSED). `adds` exposes .text/.matchType;
 * remove/pause are live criterion resource names already resolved by the shell. Pure
 * op-construction (no mutate). Match type is immutable on a live criterion, so a
 * 'change match type' arrives here as a REMOVE + an ADD, never an update.
 */
export function buildKeywordOps(
  adGroupRn: string,
  adds: Keyword[],
  removeResources: string[],
  pauseResources: string[],
): AdsMutateOperation[] {
  const addOps: AdsMutateOperation[] = adds.map((kw) => ({
    entity: "ad_group_criterion",
    operation: "create",
    resource: {
      ad_group: adGroupRn,
      keyword: { text: kw.text, match_type: enums.KeywordMatchType[kw.matchType] },
    },
  }));
  const removeOps: AdsMutateOperation[] = removeResources.map((rn) => ({
    entity: "ad_group_criterion",
    operation: "remove",
    resource: { resource_name: rn },
  }));
  const pauseOps: AdsMutateOperation[] = pauseResources.map((rn) => ({
    entity: "ad_group_criterion",
    operation: "update",
    resource: { resource_name: rn, status: enums.AdGroupCriterionStatus.PAUSED },
  }));
  return [...addOps, ...removeOps, ...pauseOps];
}

/**
 * Campaign-level negative keywords — shared across every ad group. Blocks
 * close-variant / broad-match (incl. AI Max) expansion onto off-theme queries. No-op
 * when the brief lists none. Returns the created criterion resource names.
 */
export async function createNegativeKeywords(
  client: AdsClient,
  customerId: string,
  campaignRn: string,
  negatives: Keyword[],
): Promise<string[]> {
  if (negatives.length === 0) {
    return [];
  }
  const ops = buildNegativeKeywordOps(campaignRn, negatives);
  return (await client.mutate(customerId, ops)).results.map((r) => r.resource_name);
}

/** Target the US + Canada geo constants on the campaign. */
export async function targetUsCanada(
  client: AdsClient,
  customerId: string,
  campaignRn: string,
): Promise<void> {
  const ops: AdsMutateOperation[] = GEO_TARGETS.map((geo) => ({
    entity: "campaign_criterion",
    operation: "create",
    resource: { campaign: campaignRn, location: { geo_target_constant: geo } },
  }));
  await client.mutate(customerId, ops);
}

/**
 * Find a live (non-removed) ad group by name within `campaignRn`, returning its
 * resource name or null. Throws a {@link StepError} on more than one match.
 */
export async function findExistingAdGroup(
  client: AdsClient,
  customerId: string,
  adGroup: AdGroup,
  campaignRn: string,
): Promise<string | null> {
  const query =
    "SELECT ad_group.resource_name " +
    "FROM ad_group " +
    `WHERE campaign.resource_name = '${gaqlStringLiteral(campaignRn)}' ` +
    `AND ad_group.name = '${gaqlStringLiteral(adGroup.name)}' ` +
    "AND ad_group.status != 'REMOVED'";
  const rows = await client.search<{ ad_group: { resource_name: string } }>(customerId, query);
  if (rows.length === 0) {
    return null;
  }
  if (rows.length > 1) {
    throw new StepError(
      "find-existing-ad-group",
      `multiple non-removed ad groups named ${JSON.stringify(adGroup.name)} in campaign ${campaignRn}`,
      null,
      adGroup.name,
    );
  }
  return rows[0]!.ad_group.resource_name;
}

/** Create the (enabled) standard-search ad group under `campaignRn`. Returns its resource name. */
export async function createAdGroup(
  client: AdsClient,
  customerId: string,
  adGroup: AdGroup,
  campaignRn: string,
): Promise<string> {
  const op: AdsMutateOperation = {
    entity: "ad_group",
    operation: "create",
    resource: {
      name: adGroup.name,
      campaign: campaignRn,
      status: enums.AdGroupStatus.ENABLED,
      type: enums.AdGroupType.SEARCH_STANDARD,
      cpc_bid_micros: adGroup.defaultBidMicros,
    },
  };
  const result = await client.mutate(customerId, [op]);
  return result.results[0]!.resource_name;
}

/**
 * Create the paused Responsive Search Ad for the ad group. No headline/description is
 * ever pinned (pinning is disabled skill-wide) so Google can test every combination.
 * Returns the AdGroupAd resource name.
 */
export async function createResponsiveSearchAd(
  client: AdsClient,
  customerId: string,
  adGroup: AdGroup,
  adGroupRn: string,
): Promise<string> {
  const rsa = adGroup.responsiveSearchAd;
  const responsiveSearchAd: Record<string, unknown> = {
    headlines: rsa.headlines.map((h) => ({ text: h.text })),
    descriptions: rsa.descriptions.map((d) => ({ text: d.text })),
  };
  // Display-URL paths: the shown URL is the finalUrl host + these keyword-rich
  // segments, independent of the (long, tracking-heavy) finalUrl that is clicked.
  if (rsa.path1 !== undefined) {
    responsiveSearchAd["path1"] = rsa.path1;
  }
  if (rsa.path2 !== undefined) {
    responsiveSearchAd["path2"] = rsa.path2;
  }
  const op: AdsMutateOperation = {
    entity: "ad_group_ad",
    operation: "create",
    resource: {
      ad_group: adGroupRn,
      status: enums.AdGroupAdStatus.PAUSED,
      ad: {
        responsive_search_ad: responsiveSearchAd,
        final_urls: [String(rsa.finalUrl)],
      },
    },
  };
  const result = await client.mutate(customerId, [op]);
  return result.results[0]!.resource_name;
}

/** Create the ad group's positive keywords (enabled). Returns their criterion resource names. */
export async function createKeywords(
  client: AdsClient,
  customerId: string,
  adGroup: AdGroup,
  adGroupRn: string,
): Promise<string[]> {
  const ops: AdsMutateOperation[] = adGroup.keywords.map((kw) => ({
    entity: "ad_group_criterion",
    operation: "create",
    resource: {
      ad_group: adGroupRn,
      status: enums.AdGroupCriterionStatus.ENABLED,
      keyword: { text: kw.text, match_type: enums.KeywordMatchType[kw.matchType] },
    },
  }));
  return (await client.mutate(customerId, ops)).results.map((r) => r.resource_name);
}

/**
 * Remove (soft-delete) every live campaign with this name. Idempotent: returns []
 * when no match. Used by --archive-existing to clear a prior identically-named
 * campaign before a v1-fresh publish.
 */
export async function archiveCampaignsByName(
  client: AdsClient,
  customerId: string,
  name: string,
): Promise<string[]> {
  const query =
    "SELECT campaign.resource_name FROM campaign " +
    `WHERE campaign.name = '${gaqlStringLiteral(name)}' AND campaign.status != 'REMOVED'`;
  const rows = await client.search<{ campaign: { resource_name: string } }>(customerId, query);
  const resourceNames = rows.map((row) => row.campaign.resource_name);
  if (resourceNames.length === 0) {
    return [];
  }
  const ops: AdsMutateOperation[] = resourceNames.map((rn) => ({
    entity: "campaign",
    operation: "remove",
    resource: { resource_name: rn },
  }));
  await client.mutate(customerId, ops);
  return resourceNames;
}
