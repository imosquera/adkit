/**
 * Display ads Google can't generate — the pure half of the `ads_not_generated`
 * check (#86).
 *
 * A responsive display ad whose assets don't satisfy Google (too few/too long
 * headlines, no description, a business name Google won't accept, no square
 * logo, ...) is shown as "Incomplete" in the Ads UI and never serves, while its
 * status reads ENABLED and its policy verdict APPROVED through the API. The API
 * exposes it as `ad_group_ad.ad_strength = NO_ADS` and/or
 * `ad_group_ad.primary_status_reasons` containing AD_GROUP_AD_NO_ADS, with
 * Google's own remedies in `ad_group_ad.action_items`. Both the audit finding and
 * the serving-diagnosis blocker are derived here so they always agree.
 */

import { enums } from "google-ads-api";
import { enumName } from "../ads/enums.js";

type Enum = string | number | null | undefined;

/** The ad_group_ad fields this check reads (wire shape). */
export interface RawAdGenerationFields {
  status?: Enum;
  ad_strength?: Enum;
  primary_status?: Enum;
  primary_status_reasons?: Enum[];
  action_items?: string[] | null;
}

/** One ad's generation signals, enums decoded to their names. */
export interface AdGeneration {
  status: string | null;
  adStrength: string | null;
  primaryStatus: string | null;
  primaryStatusReasons: string[];
  actionItems: string[];
}

/** At least one ad Google can't generate — the only shape the finding/blocker text accepts. */
export type NotGeneratedAds = readonly [AdGeneration, ...AdGeneration[]];

/** Decode the raw fields once, at the boundary (the SDK returns ordinals or names). */
export function parseAdGeneration(raw: RawAdGenerationFields): AdGeneration {
  return {
    status: enumName(enums.AdGroupAdStatus, raw.status),
    adStrength: enumName(enums.AdStrength, raw.ad_strength),
    primaryStatus: enumName(enums.AdGroupAdPrimaryStatus, raw.primary_status),
    primaryStatusReasons: (raw.primary_status_reasons ?? [])
      .map((x) => enumName(enums.AdGroupAdPrimaryStatusReason, x))
      .filter((x): x is string => x !== null),
    actionItems: (raw.action_items ?? []).filter((x) => x.trim() !== ""),
  };
}

export const isNotGenerated = (a: AdGeneration): boolean =>
  a.status !== "REMOVED" &&
  (a.adStrength === "NO_ADS" || a.primaryStatusReasons.includes("AD_GROUP_AD_NO_ADS"));

/** The live ads Google can't build an ad from, or `null` when there are none. */
export function notGeneratedAds(ads: readonly AdGeneration[]): NotGeneratedAds | null {
  const [first, ...rest] = ads.filter(isNotGenerated);
  return first === undefined ? null : [first, ...rest];
}

export const ADS_NOT_GENERATED = "ads_not_generated";

/** Google's action items across the affected ads, deduped, verbatim. */
export function actionItemsOf(affected: NotGeneratedAds): string[] {
  return [...new Set(affected.flatMap((a) => a.actionItems))];
}

export function adsNotGeneratedDetail(affected: NotGeneratedAds): string {
  const items = actionItemsOf(affected);
  return (
    `${affected.length} responsive display ad(s) Google can't generate (ad strength NO_ADS / AD_GROUP_AD_NO_ADS — ` +
    'the Ads UI shows them "Incomplete"); Google\'s action items: ' +
    (items.length > 0 ? items.map((i) => `"${i}"`).join("; ") : "none reported")
  );
}

export const ADS_NOT_GENERATED_FIX =
  "Google can't build this ad from its assets — follow the action items above (commonly: ≥2 headlines with " +
  "one ≤30 chars, ≥1 description, a business name matching the verified advertiser name or landing domain, " +
  "a square logo). Edit the brief's responsiveDisplayAds and rerun `/adkit create`.";
