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
import type {
  AdGroup,
  Brief,
  Campaign,
  DisplayAdGroup,
  DisplayBrief,
  Keyword,
  RadiusTarget,
  ResponsiveDisplayAd,
  ResponsiveSearchAd,
} from "../lib/schema.js";
import type { ImageLibrary } from "./images.js";
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
export function bidStrategyFields(brief: {
  campaign: Pick<Campaign, "bidStrategy" | "cpcBidCeilingMicros">;
}): Record<string, unknown> {
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
  brief: { campaign: Pick<Campaign, "name" | "budgetMicros"> },
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
  brief: { campaign: Pick<Campaign, "name"> },
  channel: "SEARCH" | "DISPLAY",
): Promise<[string, string | null] | null> {
  const query =
    "SELECT campaign.resource_name, campaign.campaign_budget, campaign.advertising_channel_type " +
    "FROM campaign " +
    `WHERE campaign.name = '${gaqlStringLiteral(brief.campaign.name)}' ` +
    "AND campaign.status != 'REMOVED'";
  const rows = await client.search<{
    campaign: { resource_name: string; campaign_budget?: string; advertising_channel_type?: string | number };
  }>(customerId, query);
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
  // Enums arrive numeric or pre-decoded depending on the field; the enum map is bidirectional.
  const liveChannel =
    typeof campaign.advertising_channel_type === "number"
      ? enums.AdvertisingChannelType[campaign.advertising_channel_type]
      : campaign.advertising_channel_type;
  if (liveChannel !== undefined && liveChannel !== channel) {
    throw new StepError(
      "find-existing-campaign",
      `campaign ${JSON.stringify(brief.campaign.name)} already exists as a ${liveChannel} campaign; ` +
        `a ${channel} brief cannot reuse it — rename the brief's campaign or pass --archive-existing`,
      null,
    );
  }
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
      // Search Partners follow the brief: "search-only" restricts serving to
      // Google Search results; "search-partners-display" also serves on Google's
      // search partner sites. Display (target_content_network) is always OFF.
      target_search_network: expanded,
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
    // Required on all new campaigns since 2025-09-03 — the API returns
    // FieldError.REQUIRED if omitted. These campaigns never carry EU political ads.
    contains_eu_political_advertising:
      enums.EuPoliticalAdvertisingStatus.DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING,
  };
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
 * Toggle a live campaign's Search Partners setting (network_settings.target_search_network).
 * Sends only that nested field — the SDK derives the update mask from the fields present, so
 * target_google_search/target_content_network are untouched. Returns the campaign resource name.
 */
export async function setSearchPartners(
  client: AdsClient,
  customerId: string,
  campaignId: string,
  enabled: boolean,
): Promise<string> {
  const op: AdsMutateOperation = {
    entity: "campaign",
    operation: "update",
    resource: {
      resource_name: `customers/${customerId}/campaigns/${campaignId}`,
      network_settings: { target_search_network: enabled },
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
 * Flip a single ad's (ad_group_ad) serving status to ENABLED or PAUSED. The
 * resource name is `adGroupAds/{adGroupId}~{adId}`, so both ids are required.
 * The lever for turning on the PAUSED ad a new ad group ships with. Mirrors
 * {@link setAdGroupStatus} one level down. Returns the ad_group_ad resource name.
 */
export async function setAdGroupAdStatus(
  client: AdsClient,
  customerId: string,
  adGroupId: string,
  adId: string,
  status: "ENABLED" | "PAUSED",
): Promise<string> {
  const op: AdsMutateOperation = {
    entity: "ad_group_ad",
    operation: "update",
    resource: {
      resource_name: `customers/${customerId}/adGroupAds/${adGroupId}~${adId}`,
      status: enums.AdGroupAdStatus[status],
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

/** One live campaign_criterion row, as returned by {@link liveCampaignCriteria}. */
interface CampaignCriterionRow {
  campaign_criterion?: {
    resource_name: string;
    bid_modifier?: number;
    device?: { type?: string | number };
    location?: { geo_target_constant?: string };
    proximity?: {
      radius?: number;
      radius_units?: string | number;
      geo_point?: { latitude_in_micro_degrees?: number; longitude_in_micro_degrees?: number };
      address?: Record<string, string | undefined>;
    };
  };
}

/** The campaign's live device + location criteria — what the targeting reconcilers diff against. */
async function liveCampaignCriteria(
  client: AdsClient,
  customerId: string,
  campaignRn: string,
): Promise<NonNullable<CampaignCriterionRow["campaign_criterion"]>[]> {
  const query =
    "SELECT campaign_criterion.resource_name, campaign_criterion.bid_modifier, " +
    "campaign_criterion.device.type, campaign_criterion.location.geo_target_constant, " +
    "campaign_criterion.proximity.radius, campaign_criterion.proximity.radius_units, " +
    "campaign_criterion.proximity.geo_point.latitude_in_micro_degrees, " +
    "campaign_criterion.proximity.geo_point.longitude_in_micro_degrees, " +
    "campaign_criterion.proximity.address.street_address, campaign_criterion.proximity.address.city_name, " +
    "campaign_criterion.proximity.address.province_code, campaign_criterion.proximity.address.postal_code, " +
    "campaign_criterion.proximity.address.country_code " +
    "FROM campaign_criterion " +
    `WHERE campaign_criterion.campaign = '${gaqlStringLiteral(campaignRn)}' ` +
    "AND campaign_criterion.type IN ('DEVICE', 'LOCATION', 'PROXIMITY') AND campaign_criterion.negative = FALSE";
  const rows = await client.search<CampaignCriterionRow>(customerId, query);
  return rows.flatMap((r) => (r.campaign_criterion ? [r.campaign_criterion] : []));
}

/**
 * Restrict serving to `devices` by setting a -100% (bid_modifier=0) criterion on
 * every device NOT listed. `undefined` (field omitted) => default brief, which
 * excludes mobile at -100% (computer/tablet/tv serve). List every device to serve
 * everywhere. Exclusion via bid_modifier=0 is honored even under Smart Bidding.
 *
 * Reconciles against the live campaign, so it is safe on a reused campaign (a rerun
 * after a partial publish): a device already excluded is skipped, a live device
 * criterion with a non-zero modifier is updated to 0, and only absent ones are created.
 * It only ever adds exclusions — it never re-enables a device.
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
  const live = await liveCampaignCriteria(client, customerId, campaignRn);
  const liveDevice = (d: (typeof ALL_DEVICES)[number]) =>
    live.find((c) => {
      const t = c.device?.type;
      return t !== undefined && (typeof t === "number" ? t : enums.Device[t as keyof typeof enums.Device]) === DEVICE_ENUM[d];
    });
  const ops: AdsMutateOperation[] = excluded.flatMap((d): AdsMutateOperation[] => {
    const existing = liveDevice(d);
    if (existing === undefined) {
      return [
        {
          entity: "campaign_criterion",
          operation: "create",
          resource: { campaign: campaignRn, device: { type: DEVICE_ENUM[d] }, bid_modifier: 0.0 }, // -100% = excluded
        },
      ];
    }
    return existing.bid_modifier === 0
      ? []
      : [{ entity: "campaign_criterion", operation: "update", resource: { resource_name: existing.resource_name, bid_modifier: 0.0 } }];
  });
  if (ops.length > 0) {
    await client.mutate(customerId, ops);
  }
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

/** English language criterion — the only language the update lever targets. */
export const ENGLISH_LANGUAGE_CONSTANT = "languageConstants/1000";

/**
 * Build CampaignCriterion ops to make a campaign English-only: create the English
 * language criterion (when `addEnglish`) and remove each live non-English language
 * criterion (by resource name). Pure op-construction (no mutate); mirrors
 * {@link buildKeywordOps}. Returns [] when English is already the sole language.
 */
export function buildLanguageOps(
  campaignRn: string,
  addEnglish: boolean,
  removeResources: string[],
): AdsMutateOperation[] {
  const addOps: AdsMutateOperation[] = addEnglish
    ? [
        {
          entity: "campaign_criterion",
          operation: "create",
          resource: { campaign: campaignRn, language: { language_constant: ENGLISH_LANGUAGE_CONSTANT } },
        },
      ]
    : [];
  const removeOps: AdsMutateOperation[] = removeResources.map((rn) => ({
    entity: "campaign_criterion",
    operation: "remove",
    resource: { resource_name: rn },
  }));
  return [...addOps, ...removeOps];
}

/**
 * Pure: the `locations` to resolve for a campaign. Omitted locations default to US +
 * Canada (`undefined`) — except alongside radius targets, where a country default would
 * swamp the radius, so it becomes "no location criteria" (`[]`).
 */
export function effectiveLocations(campaign: {
  locations?: readonly string[];
  radiusTargets?: readonly RadiusTarget[];
}): readonly string[] | undefined {
  return campaign.locations ?? (campaign.radiusTargets !== undefined ? [] : undefined);
}

/**
 * Resolve brief `locations` (ids or canonical names) to geo target constant resource
 * names, in brief order. `undefined` => {@link GEO_TARGETS} (US + Canada). Read-only —
 * run before any mutation so a typo fails the publish before anything is created.
 * Throws a {@link StepError} naming every location Google doesn't know.
 */
export async function resolveLocations(
  client: AdsClient,
  customerId: string,
  locations: readonly string[] | undefined,
): Promise<string[]> {
  if (locations === undefined) {
    return [...GEO_TARGETS];
  }
  if (locations.length === 0) {
    return [];
  }
  const ids = locations.filter((l) => /^[0-9]+$/.test(l));
  const names = locations.filter((l) => !/^[0-9]+$/.test(l));
  const select =
    "SELECT geo_target_constant.resource_name, geo_target_constant.id, geo_target_constant.canonical_name " +
    "FROM geo_target_constant WHERE geo_target_constant.status = 'ENABLED' AND ";
  type Row = { geo_target_constant: { resource_name: string; id: string | number; canonical_name: string } };
  const rows = [
    ...(ids.length > 0 ? await client.search<Row>(customerId, `${select}geo_target_constant.id IN (${ids.join(", ")})`) : []),
    ...(names.length > 0
      ? await client.search<Row>(
          customerId,
          `${select}geo_target_constant.canonical_name IN (${names.map((n) => `'${gaqlStringLiteral(n)}'`).join(", ")})`,
        )
      : []),
  ];
  const byKey = new Map(
    rows.flatMap((r) => [
      [String(r.geo_target_constant.id), r.geo_target_constant.resource_name],
      [r.geo_target_constant.canonical_name, r.geo_target_constant.resource_name],
    ]),
  );
  const unknown = locations.filter((l) => !byKey.has(l));
  if (unknown.length > 0) {
    throw new StepError(
      "resolve-locations",
      `unknown location(s): ${unknown.map((l) => JSON.stringify(l)).join(", ")} — use a geo target id or the exact ` +
        "canonical name from https://developers.google.com/google-ads/api/data/geotargets",
      null,
    );
  }
  return locations.map((l) => byKey.get(l)!);
}

/** Pure: a radius target's ProximityInfo resource fragment. */
export function proximityInfo(target: RadiusTarget): Record<string, unknown> {
  const a = target.address;
  return {
    radius: target.radius,
    radius_units: target.units === "miles" ? enums.ProximityRadiusUnits.MILES : enums.ProximityRadiusUnits.KILOMETERS,
    ...(a === undefined
      ? {
          geo_point: {
            latitude_in_micro_degrees: Math.round(target.latitude! * 1e6),
            longitude_in_micro_degrees: Math.round(target.longitude! * 1e6),
          },
        }
      : {
          address: Object.fromEntries(
            Object.entries({
              street_address: a.streetAddress,
              city_name: a.cityName,
              province_code: a.provinceCode,
              postal_code: a.postalCode,
              country_code: a.countryCode,
            }).filter(([, v]) => v !== undefined),
          ),
        }),
  };
}

/**
 * Pure: comparable identity for a ProximityInfo (brief-built or live row). Address-based
 * targets compare by address — Google also fills in the geocoded point on those, which the
 * brief never has.
 */
function proximityKey(p: NonNullable<NonNullable<CampaignCriterionRow["campaign_criterion"]>["proximity"]>): string {
  const units = typeof p.radius_units === "number" ? enums.ProximityRadiusUnits[p.radius_units] : p.radius_units;
  const where =
    p.address?.city_name !== undefined || p.address?.postal_code !== undefined
      ? ["street_address", "city_name", "province_code", "postal_code", "country_code"].map((k) =>
          (p.address?.[k] ?? "").toLowerCase(),
        )
      : [p.geo_point?.latitude_in_micro_degrees, p.geo_point?.longitude_in_micro_degrees];
  return JSON.stringify([Number(p.radius), units, where]);
}

/**
 * Make the campaign's radius targeting exactly `targets`. When the live set already
 * matches, nothing changes; otherwise every live radius target is replaced — a
 * wholesale swap is simpler than a per-target diff and converges the same way.
 */
export async function targetRadius(
  client: AdsClient,
  customerId: string,
  campaignRn: string,
  targets: readonly RadiusTarget[],
): Promise<void> {
  const live = (await liveCampaignCriteria(client, customerId, campaignRn)).filter((c) => c.proximity?.radius !== undefined);
  const wanted = targets.map((t) => proximityInfo(t) as Parameters<typeof proximityKey>[0]);
  const sortedKeys = (ps: Array<Parameters<typeof proximityKey>[0]>) => JSON.stringify(ps.map(proximityKey).sort());
  if (sortedKeys(live.map((c) => c.proximity!)) === sortedKeys(wanted)) {
    return;
  }
  const ops: AdsMutateOperation[] = [
    ...live.map((c): AdsMutateOperation => ({
      entity: "campaign_criterion",
      operation: "remove",
      resource: { resource_name: c.resource_name },
    })),
    ...targets.map((t): AdsMutateOperation => ({
      entity: "campaign_criterion",
      operation: "create",
      resource: { campaign: campaignRn, proximity: proximityInfo(t) },
    })),
  ];
  await client.mutate(customerId, ops);
}

/**
 * Make the campaign's positive location targeting exactly `geoTargets` (resource
 * names from {@link resolveLocations}): create the missing ones, remove live ones the
 * brief no longer lists. Safe on a reused campaign — a rerun after a partial publish,
 * or a brief narrowed from a country to a city, converges instead of leaving the old
 * wider targeting in place.
 */
export async function targetLocations(
  client: AdsClient,
  customerId: string,
  campaignRn: string,
  geoTargets: readonly string[],
): Promise<void> {
  const live = (await liveCampaignCriteria(client, customerId, campaignRn)).filter(
    (c) => c.location?.geo_target_constant !== undefined,
  );
  const liveGeos = new Set(live.map((c) => c.location!.geo_target_constant));
  const creates: AdsMutateOperation[] = geoTargets
    .filter((geo) => !liveGeos.has(geo))
    .map((geo) => ({
      entity: "campaign_criterion",
      operation: "create",
      resource: { campaign: campaignRn, location: { geo_target_constant: geo } },
    }));
  const removes: AdsMutateOperation[] = live
    .filter((c) => !geoTargets.includes(c.location!.geo_target_constant!))
    .map((c) => ({ entity: "campaign_criterion", operation: "remove", resource: { resource_name: c.resource_name } }));
  const ops = [...creates, ...removes];
  if (ops.length > 0) {
    await client.mutate(customerId, ops);
  }
}

/**
 * Find a live (non-removed) ad group by name within `campaignRn`, returning its
 * resource name or null. Throws a {@link StepError} on more than one match.
 */
export async function findExistingAdGroup(
  client: AdsClient,
  customerId: string,
  adGroup: Pick<AdGroup, "name">,
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

/**
 * Create the standard-search ad group under `campaignRn`. Returns its resource name.
 *
 * `status` defaults to ENABLED — the /adkit create flow builds ad groups inside a
 * PAUSED campaign, so the group's own status is moot. When ADDING an ad group to an
 * already-live campaign (the update `adGroups` path), pass "PAUSED" so the new group
 * cannot serve until it is explicitly enabled (its RSA is created PAUSED too).
 */
export async function createAdGroup(
  client: AdsClient,
  customerId: string,
  adGroup: AdGroup,
  campaignRn: string,
  status: "ENABLED" | "PAUSED" = "ENABLED",
): Promise<string> {
  const op: AdsMutateOperation = {
    entity: "ad_group",
    operation: "create",
    resource: {
      name: adGroup.name,
      campaign: campaignRn,
      status: enums.AdGroupStatus[status],
      type: enums.AdGroupType.SEARCH_STANDARD,
      cpc_bid_micros: adGroup.defaultBidMicros,
      // AI Max search-term matching is disabled per ad group unless the ad group
      // opts in (adGroup.aiMax). Even under a campaign running AI Max, ad groups
      // stay on strict keyword matching by default. No-op when campaign AI Max is off.
      ai_max_ad_group_setting: { disable_search_term_matching: !adGroup.aiMax },
    },
  };
  const result = await client.mutate(customerId, [op]);
  return result.results[0]!.resource_name;
}

/**
 * Order-independent identity for one RSA's copy: its headline and description text,
 * sorted so word order in the brief doesn't matter. Two RSAs sharing an identity are
 * the same ad. Used by {@link findMissingResponsiveSearchAds} to tell a brief RSA
 * that's already live from one that still needs creating.
 */
function rsaContentKey(headlines: readonly string[], descriptions: readonly string[]): string {
  return JSON.stringify([[...headlines].sort(), [...descriptions].sort()]);
}

/** One `ad_group_ad` row's RSA text, as returned by the {@link findMissingResponsiveSearchAds} query. */
interface ExistingRsaRow {
  ad_group_ad: {
    ad: {
      responsive_search_ad: {
        headlines: Array<{ text: string }>;
        descriptions: Array<{ text: string }>;
      };
    };
  };
}

/**
 * The subset of `briefRsas` that is NOT already live (by content — see
 * {@link rsaContentKey}) on `adGroupRn`, in brief order.
 *
 * A freshly-created ad group has no live RSAs, so this is a no-op filter (every
 * brief RSA is "missing", matching the old always-create-both behavior). A reused
 * ad group left mid-populated by a prior failed run — e.g. a
 * `CONCURRENT_MODIFICATION` rejection on one of two concurrent creates — gets only
 * the RSA(s) it's still short of, instead of a duplicate stacked on top of the
 * orphan that already landed.
 */
export async function findMissingResponsiveSearchAds(
  client: AdsClient,
  customerId: string,
  adGroupRn: string,
  briefRsas: readonly ResponsiveSearchAd[],
): Promise<ResponsiveSearchAd[]> {
  const query =
    "SELECT ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions " +
    "FROM ad_group_ad " +
    `WHERE ad_group_ad.ad_group = '${gaqlStringLiteral(adGroupRn)}' ` +
    "AND ad_group_ad.status != 'REMOVED'";
  const rows = await client.search<ExistingRsaRow>(customerId, query);
  const existingKeys = new Set(
    rows.map((r) => {
      const rsa = r.ad_group_ad.ad.responsive_search_ad;
      return rsaContentKey(
        rsa.headlines.map((h) => h.text),
        rsa.descriptions.map((d) => d.text),
      );
    }),
  );
  return briefRsas.filter(
    (rsa) =>
      !existingKeys.has(
        rsaContentKey(
          rsa.headlines.map((h) => h.text),
          rsa.descriptions.map((d) => d.text),
        ),
      ),
  );
}

/**
 * Create one paused Responsive Search Ad on the ad group. No headline/description is
 * ever pinned (pinning is disabled skill-wide) so Google can test every combination.
 * Returns the AdGroupAd resource name. Called once per RSA in an ad group's
 * `responsiveSearchAds` (RSAS_PER_AD_GROUP per ad group) — takes a single RSA, not
 * the whole ad group, so callers control fan-out (see publishV1 / apply-fixes).
 */
export async function createResponsiveSearchAd(
  client: AdsClient,
  customerId: string,
  rsa: ResponsiveSearchAd,
  adGroupRn: string,
): Promise<string> {
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

/** Create the given positive keywords (enabled) on an ad group. Returns their criterion resource names. */
export async function createKeywords(
  client: AdsClient,
  customerId: string,
  keywords: readonly Keyword[],
  adGroupRn: string,
): Promise<string[]> {
  if (keywords.length === 0) {
    return [];
  }
  const ops: AdsMutateOperation[] = keywords.map((kw) => ({
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

/** Order-independent identity for one live/brief keyword: its text (case-folded) and match type. */
function keywordKey(text: string, matchType: string): string {
  return `${text.trim().toLowerCase()}::${matchType}`;
}

/** One `ad_group_criterion` row's keyword, as returned by the {@link findMissingKeywords} query. */
interface ExistingKeywordRow {
  ad_group_criterion: { keyword: { text: string; match_type: string } };
}

/**
 * The subset of `keywords` that is NOT already a live (non-removed) keyword
 * criterion on `adGroupRn`, in brief order.
 *
 * A freshly-created ad group has no live keywords, so this is a no-op filter
 * (every brief keyword is "missing", matching the old always-create behavior). A
 * reused ad group that survived a prior run which died before reaching keyword
 * creation — e.g. an earlier RSA-creation failure — gets the keywords it's still
 * missing instead of being skipped forever just because the ad group already
 * existed.
 */
export async function findMissingKeywords(
  client: AdsClient,
  customerId: string,
  adGroupRn: string,
  keywords: readonly Keyword[],
): Promise<Keyword[]> {
  const query =
    "SELECT ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type " +
    "FROM ad_group_criterion " +
    `WHERE ad_group_criterion.ad_group = '${gaqlStringLiteral(adGroupRn)}' ` +
    "AND ad_group_criterion.type = 'KEYWORD' " +
    "AND ad_group_criterion.status != 'REMOVED'";
  const rows = await client.search<ExistingKeywordRow>(customerId, query);
  const existingKeys = new Set(
    rows.map((r) => keywordKey(r.ad_group_criterion.keyword.text, r.ad_group_criterion.keyword.match_type)),
  );
  return keywords.filter((kw) => !existingKeys.has(keywordKey(kw.text, kw.matchType)));
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

// ---------- Display (responsive display ads) ----------

/** Create the paused Display campaign wired to `budgetRn`. Serves on the Display Network only. */
export async function createDisplayCampaign(
  client: AdsClient,
  customerId: string,
  brief: DisplayBrief,
  budgetRn: string,
): Promise<string> {
  const op: AdsMutateOperation = {
    entity: "campaign",
    operation: "create",
    resource: {
      name: brief.campaign.name,
      advertising_channel_type: enums.AdvertisingChannelType.DISPLAY,
      status: enums.CampaignStatus.PAUSED,
      ...bidStrategyFields(brief),
      campaign_budget: budgetRn,
      geo_target_type_setting: { positive_geo_target_type: enums.PositiveGeoTargetType.PRESENCE },
      contains_eu_political_advertising:
        enums.EuPoliticalAdvertisingStatus.DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING,
    },
  };
  return (await client.mutate(customerId, [op])).results[0]!.resource_name;
}

/**
 * Upload each image as an IMAGE asset, returning url → asset resource name. Google
 * dedupes image assets by content, so a rerun re-resolves the same assets.
 */
export async function createImageAssets(
  client: AdsClient,
  customerId: string,
  images: ImageLibrary,
): Promise<Map<string, string>> {
  const library = [...images.values()];
  if (library.length === 0) {
    return new Map();
  }
  const ops: AdsMutateOperation[] = library.map((img) => ({
    entity: "asset",
    operation: "create",
    resource: {
      name: decodeURIComponent(new URL(img.url).pathname.split("/").pop()!),
      type: enums.AssetType.IMAGE,
      image_asset: { data: Buffer.from(img.bytes).toString("base64") },
    },
  }));
  const rns = (await client.mutate(customerId, ops)).results.map((r) => r.resource_name);
  return new Map(library.map((img, i) => [img.url, rns[i]!]));
}

/**
 * Create the display ad group under `campaignRn`. Audience criteria restrict reach
 * (`bid_only: false`) unless the brief puts them in observation mode.
 */
export async function createDisplayAdGroup(
  client: AdsClient,
  customerId: string,
  adGroup: DisplayAdGroup,
  campaignRn: string,
): Promise<string> {
  const op: AdsMutateOperation = {
    entity: "ad_group",
    operation: "create",
    resource: {
      name: adGroup.name,
      campaign: campaignRn,
      status: enums.AdGroupStatus.ENABLED,
      type: enums.AdGroupType.DISPLAY_STANDARD,
      cpc_bid_micros: adGroup.defaultBidMicros,
      optimized_targeting_enabled: adGroup.optimizedTargeting,
      targeting_setting: {
        target_restrictions: [
          {
            targeting_dimension: enums.TargetingDimension.AUDIENCE,
            bid_only: adGroup.audiences.mode === "observation",
          },
        ],
      },
    },
  };
  return (await client.mutate(customerId, [op])).results[0]!.resource_name;
}

/** Pure: the brief's audiences as [criterion field, nested field, resource name] triples. */
export function audienceCriteria(customerId: string, adGroup: DisplayAdGroup): Array<[string, string, string]> {
  const a = adGroup.audiences;
  return [
    ...a.customAudiences.map((id): [string, string, string] => ["custom_audience", "custom_audience", `customers/${customerId}/customAudiences/${id}`]),
    ...a.userInterests.map((id): [string, string, string] => ["user_interest", "user_interest_category", `customers/${customerId}/userInterests/${id}`]),
    ...a.userLists.map((id): [string, string, string] => ["user_list", "user_list", `customers/${customerId}/userLists/${id}`]),
  ];
}

/** Attach the ad group's audiences it doesn't already have live. Returns the created criterion resource names. */
export async function createMissingAudiences(
  client: AdsClient,
  customerId: string,
  adGroup: DisplayAdGroup,
  adGroupRn: string,
): Promise<string[]> {
  const query =
    "SELECT ad_group_criterion.custom_audience.custom_audience, " +
    "ad_group_criterion.user_interest.user_interest_category, ad_group_criterion.user_list.user_list " +
    "FROM ad_group_criterion " +
    `WHERE ad_group_criterion.ad_group = '${gaqlStringLiteral(adGroupRn)}' ` +
    "AND ad_group_criterion.status != 'REMOVED'";
  const rows = await client.search<{ ad_group_criterion: Record<string, Record<string, string> | undefined> }>(
    customerId,
    query,
  );
  const live = new Set(rows.flatMap((r) => Object.values(r.ad_group_criterion).flatMap((v) => Object.values(v ?? {}))));
  const ops: AdsMutateOperation[] = audienceCriteria(customerId, adGroup)
    .filter(([, , rn]) => !live.has(rn))
    .map(([field, nested, rn]) => ({
      entity: "ad_group_criterion",
      operation: "create",
      resource: { ad_group: adGroupRn, status: enums.AdGroupCriterionStatus.ENABLED, [field]: { [nested]: rn } },
    }));
  return ops.length === 0 ? [] : (await client.mutate(customerId, ops)).results.map((r) => r.resource_name);
}

/** Every serving field of a responsive display ad, with images as asset resource names. */
interface RdaIdentity {
  marketingImages: readonly string[];
  squareMarketingImages: readonly string[];
  logoImages: readonly string[];
  squareLogoImages: readonly string[];
  headlines: readonly string[];
  longHeadline: string;
  descriptions: readonly string[];
  businessName: string;
  finalUrl: string;
}

/**
 * Order-independent identity over every serving field — images, copy, business name
 * and destination — so changing any of them in the brief makes the ad "missing" and a
 * rerun creates the new version instead of silently keeping the old creative.
 */
function rdaContentKey(ad: RdaIdentity): string {
  const sorted = (xs: readonly string[]) => [...xs].sort();
  return JSON.stringify([
    sorted(ad.marketingImages),
    sorted(ad.squareMarketingImages),
    sorted(ad.logoImages),
    sorted(ad.squareLogoImages),
    sorted(ad.headlines),
    ad.longHeadline,
    sorted(ad.descriptions),
    ad.businessName,
    ad.finalUrl,
  ]);
}

/**
 * The brief ads NOT already live (by every serving field — see {@link rdaContentKey})
 * on `adGroupRn`, in brief order. `assets` maps image url → asset resource name (image
 * assets dedupe by content, so a re-uploaded image resolves to the live ad's asset).
 * Mirrors {@link findMissingResponsiveSearchAds}.
 */
export async function findMissingResponsiveDisplayAds(
  client: AdsClient,
  customerId: string,
  adGroupRn: string,
  briefAds: readonly ResponsiveDisplayAd[],
  assets: ReadonlyMap<string, string>,
): Promise<ResponsiveDisplayAd[]> {
  const query =
    "SELECT ad_group_ad.ad.final_urls, ad_group_ad.ad.responsive_display_ad.marketing_images, " +
    "ad_group_ad.ad.responsive_display_ad.square_marketing_images, ad_group_ad.ad.responsive_display_ad.logo_images, " +
    "ad_group_ad.ad.responsive_display_ad.square_logo_images, ad_group_ad.ad.responsive_display_ad.business_name, " +
    "ad_group_ad.ad.responsive_display_ad.headlines, ad_group_ad.ad.responsive_display_ad.long_headline, " +
    "ad_group_ad.ad.responsive_display_ad.descriptions " +
    "FROM ad_group_ad " +
    `WHERE ad_group_ad.ad_group = '${gaqlStringLiteral(adGroupRn)}' ` +
    "AND ad_group_ad.status != 'REMOVED'";
  type AssetRefs = Array<{ asset: string }> | undefined;
  type Row = {
    ad_group_ad: {
      ad: {
        final_urls?: string[];
        responsive_display_ad?: {
          marketing_images?: AssetRefs;
          square_marketing_images?: AssetRefs;
          logo_images?: AssetRefs;
          square_logo_images?: AssetRefs;
          headlines?: Array<{ text: string }>;
          long_headline?: { text: string };
          descriptions?: Array<{ text: string }>;
          business_name?: string;
        };
      };
    };
  };
  const rows = await client.search<Row>(customerId, query);
  const refs = (xs: AssetRefs) => (xs ?? []).map((x) => x.asset);
  const live = new Set(
    rows.flatMap((r) => {
      const rda = r.ad_group_ad.ad.responsive_display_ad;
      return rda
        ? [
            rdaContentKey({
              marketingImages: refs(rda.marketing_images),
              squareMarketingImages: refs(rda.square_marketing_images),
              logoImages: refs(rda.logo_images),
              squareLogoImages: refs(rda.square_logo_images),
              headlines: (rda.headlines ?? []).map((h) => h.text),
              longHeadline: rda.long_headline?.text ?? "",
              descriptions: (rda.descriptions ?? []).map((d) => d.text),
              businessName: rda.business_name ?? "",
              finalUrl: r.ad_group_ad.ad.final_urls?.[0] ?? "",
            }),
          ]
        : [];
    }),
  );
  const assetRns = (urls: readonly string[]) => urls.map((u) => assets.get(u)!);
  return briefAds.filter(
    (ad) =>
      !live.has(
        rdaContentKey({
          marketingImages: assetRns(ad.marketingImages),
          squareMarketingImages: assetRns(ad.squareMarketingImages),
          logoImages: assetRns(ad.logoImages),
          squareLogoImages: assetRns(ad.squareLogoImages),
          headlines: ad.headlines.map((h) => h.text),
          longHeadline: ad.longHeadline.text,
          descriptions: ad.descriptions.map((d) => d.text),
          businessName: ad.businessName,
          finalUrl: ad.finalUrl,
        }),
      ),
  );
}

/** Create one paused responsive display ad; `assets` maps image url → asset resource name. */
export async function createResponsiveDisplayAd(
  client: AdsClient,
  customerId: string,
  ad: ResponsiveDisplayAd,
  adGroupRn: string,
  assets: ReadonlyMap<string, string>,
): Promise<string> {
  const refs = (urls: readonly string[]) => urls.map((url) => ({ asset: assets.get(url)! }));
  const op: AdsMutateOperation = {
    entity: "ad_group_ad",
    operation: "create",
    resource: {
      ad_group: adGroupRn,
      status: enums.AdGroupAdStatus.PAUSED,
      ad: {
        final_urls: [ad.finalUrl],
        responsive_display_ad: {
          marketing_images: refs(ad.marketingImages),
          square_marketing_images: refs(ad.squareMarketingImages),
          logo_images: refs(ad.logoImages),
          square_logo_images: refs(ad.squareLogoImages),
          headlines: ad.headlines.map((h) => ({ text: h.text })),
          long_headline: { text: ad.longHeadline.text },
          descriptions: ad.descriptions.map((d) => ({ text: d.text })),
          business_name: ad.businessName,
        },
      },
    },
  };
  return (await client.mutate(customerId, [op])).results[0]!.resource_name;
}
