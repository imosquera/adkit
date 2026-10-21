/**
 * Display brand assets — the pure half of the `brand_assets_missing` check (#85).
 *
 * A responsive display ad carries its business name in the ad itself, but Google
 * also needs the business name and logo as linked BRAND assets (a `campaign_asset`
 * or `customer_asset` with field type BUSINESS_NAME / BUSINESS_LOGO). Without
 * them the ads are reported "Incomplete" and the campaign serves nothing, while
 * campaign, ad group and ads all read ENABLED / ELIGIBLE / APPROVED through the
 * API. Both the audit finding and the serving-diagnosis blocker are derived here
 * so they always agree.
 */

import { enums } from "google-ads-api";
import { enumName } from "../ads/enums.js";

export const BRAND_ASSET_FIELDS = ["BUSINESS_NAME", "BUSINESS_LOGO"] as const;
export type BrandAssetField = (typeof BRAND_ASSET_FIELDS)[number];

/** At least one missing field — the only shape the finding/blocker text accepts. */
export type MissingBrandAssets = readonly [BrandAssetField, ...BrandAssetField[]];

type Enum = string | number | null | undefined;

/** A live campaign-level brand-asset link (wire shape). */
export interface RawCampaignBrandAssetRow {
  campaign: { id: number };
  campaign_asset: { field_type?: Enum };
}

/** A live account-level brand-asset link (wire shape). */
export interface RawCustomerBrandAssetRow {
  customer_asset: { field_type?: Enum };
}

/** The brand-asset links one campaign can draw on: its own plus the account's. */
export interface BrandAssetRows {
  campaign: readonly RawCampaignBrandAssetRow[];
  customer: readonly RawCustomerBrandAssetRow[];
}

const LABEL: Record<BrandAssetField, string> = {
  BUSINESS_NAME: "business name",
  BUSINESS_LOGO: "business logo",
};

const isBrandField = (x: string | null): x is BrandAssetField =>
  (BRAND_ASSET_FIELDS as readonly (string | null)[]).includes(x);

/**
 * The brand fields linked at neither campaign nor account level, or `null` when
 * both are present. Field types are decoded here (the SDK returns the raw ordinal).
 */
export function missingBrandAssets(rows: BrandAssetRows): MissingBrandAssets | null {
  const linked = new Set(
    [
      ...rows.campaign.map((r) => r.campaign_asset.field_type),
      ...rows.customer.map((r) => r.customer_asset.field_type),
    ]
      .map((ft) => enumName(enums.AssetFieldType, ft))
      .filter(isBrandField),
  );
  const [first, ...rest] = BRAND_ASSET_FIELDS.filter((f) => !linked.has(f));
  return first === undefined ? null : [first, ...rest];
}

export const BRAND_ASSETS_MISSING = "brand_assets_missing";

export function brandAssetsDetail(missing: MissingBrandAssets): string {
  return (
    `no ${missing.map((f) => `${LABEL[f]} (${f})`).join(" or ")} brand asset linked at campaign or account level — ` +
    "Google marks the responsive display ads Incomplete and serves them almost nowhere"
  );
}

export const BRAND_ASSETS_FIX =
  "Republish with `/adkit create`, which now links the business name and logo as campaign brand assets, " +
  "or add them in the Ads UI → Assets (Business name / Business logo) at campaign or account level.";
