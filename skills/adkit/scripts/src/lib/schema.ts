/**
 * Brief schema + executor Failure types. Zod (the TypeScript analogue of the
 * original Pydantic v2 models); single source of truth.
 *
 * Publishes are not persisted to disk — the live Google Ads account and Google's
 * change history are the record of what exists (see /adkit audit to read live
 * state).
 *
 * Naming note: the Python package exposed these as Pydantic classes (`Brief`,
 * `Campaign`, …). Here each is a zod schema exported with a `Schema` suffix
 * (`BriefSchema`) plus an inferred type of the bare name (`Brief`), the idiomatic
 * zod split. `parseBrief(data)` mirrors Pydantic's `Brief.model_validate(data)`.
 */

import { z } from "zod";

export const AD_NAME_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;
export const CUSTOMER_ID_PATTERN = /^[0-9]{10}$/;
// One ad group per Keyword Theme. Cap the campaign at 10 ad groups — beyond that
// the shared budget is spread too thin to train Smart Bidding per group; /adkit
// create keeps only the top 10 themes by potential volume (gtm authors them in
// that order).
export const MAX_AD_GROUPS = 10;
// Max keywords per ad group (a STAG theme). Single source of truth: the scaffold's
// per-theme packing cap (parse.ts MAX_KEYWORDS_PER_THEME) derives from this, so a
// scaffolded brief can never exceed what validation accepts.
export const AD_GROUP_MAX_KEYWORDS = 30;

/** A validated `https://` URL string. Mirrors Pydantic's HttpUrl + https-only guard. */
const httpsUrl = z.string().refine(
  (v) => {
    try {
      return new URL(v).protocol === "https:";
    } catch {
      return false;
    }
  },
  { message: "finalUrl must use https://" },
);

// Pinning is disabled: it collapses Google's combinatorial asset testing and is
// the #1 silent ad-strength killer. `pin` stays in the schema (so historical
// records still load) but is locked to "NONE" — any attempt to pin is rejected.
export const HeadlineSchema = z
  .object({
    text: z.string().min(1).max(30),
    pin: z.literal("NONE").default("NONE"),
  })
  .strict();
export type Headline = z.infer<typeof HeadlineSchema>;

export const DescriptionSchema = z
  .object({
    text: z.string().min(1).max(90),
    pin: z.literal("NONE").default("NONE"),
  })
  .strict();
export type Description = z.infer<typeof DescriptionSchema>;

export const MATCH_TYPES = ["EXACT", "PHRASE", "BROAD"] as const;
export const KeywordSchema = z
  .object({
    text: z.string().min(1).max(80),
    matchType: z.enum(MATCH_TYPES).default("PHRASE"),
  })
  .strict();
export type Keyword = z.infer<typeof KeywordSchema>;

export const BID_STRATEGIES = [
  "manual-cpc",
  "maximize-clicks",
  "maximize-conversions",
  "maximize-conversion-value",
  "target-cpa",
  "target-roas",
] as const;
export type BidStrategy = (typeof BID_STRATEGIES)[number];

/**
 * Campaign-level sitelink asset. description1/description2 are both-or-neither per
 * Google Ads (a sitelink with one description line is rejected).
 */
export const SitelinkSchema = z
  .object({
    text: z.string().min(1).max(25),
    finalUrl: httpsUrl,
    description1: z.string().min(1).max(35).optional(),
    description2: z.string().min(1).max(35).optional(),
  })
  .strict()
  .refine((s) => (s.description1 === undefined) === (s.description2 === undefined), {
    message: "sitelink needs both description1 and description2, or neither",
  });
export type Sitelink = z.infer<typeof SitelinkSchema>;

export const PriceOfferingSchema = z
  .object({
    header: z.string().min(1).max(25),
    description: z.string().min(1).max(25),
    priceMicros: z.number().int().gt(0),
    finalUrl: httpsUrl,
  })
  .strict();
export type PriceOffering = z.infer<typeof PriceOfferingSchema>;

export const PRICE_ASSET_TYPES = [
  "BRANDS",
  "EVENTS",
  "LOCATION",
  "NEIGHBORHOODS",
  "PRODUCT_CATEGORIES",
  "PRODUCT_TIERS",
  "SERVICE_CATEGORIES",
  "SERVICE_TIERS",
  "SERVICES",
] as const;
export const PriceAssetSchema = z
  .object({
    type: z.enum(PRICE_ASSET_TYPES).default("SERVICES"),
    languageCode: z
      .string()
      .regex(/^[a-z]{2}$/)
      .default("en"),
    currencyCode: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .default("USD"),
    offerings: z.array(PriceOfferingSchema).min(3).max(8),
  })
  .strict();
export type PriceAsset = z.infer<typeof PriceAssetSchema>;

export const SNIPPET_HEADERS = [
  "AMENITIES",
  "BRANDS",
  "COURSES",
  "DEGREES",
  "DESTINATIONS",
  "FEATURED_HOTELS",
  "INSURANCE_COVERAGE",
  "MODELS",
  "NEIGHBORHOODS",
  "SERVICE_CATALOG",
  "SHOWS",
  "STYLES",
  "TYPES",
] as const;
export const StructuredSnippetAssetSchema = z
  .object({
    header: z.enum(SNIPPET_HEADERS).default("SERVICE_CATALOG"),
    values: z.array(z.string().min(1).max(25)).min(3).max(10),
  })
  .strict()
  .refine((s) => new Set(s.values.map((v) => v.toLowerCase())).size === s.values.length, {
    message: "structured snippet values must be unique",
  });
export type StructuredSnippetAsset = z.infer<typeof StructuredSnippetAssetSchema>;

export const NETWORK_SETTINGS = ["search-only", "search-partners-display"] as const;
export const DEVICES = ["computer", "mobile", "tablet", "tv"] as const;

export const CampaignSchema = z
  .object({
    name: z.string().min(1),
    budgetMicros: z.number().int().gt(0),
    // "search-partners-display" serves on Google search + search partner sites.
    // (Despite the name, the Display Network is always disabled — see entities.ts.)
    // "search-only" restricts to Google search results only.
    networkSettings: z.enum(NETWORK_SETTINGS).default("search-partners-display"),
    // New campaigns launch on Maximize Clicks to escape the Smart-Bidding cold
    // start; graduate to maximize-conversions in the UI after ~15-30 conv/30d.
    bidStrategy: z.enum(BID_STRATEGIES).default("maximize-clicks"),
    // Optional max CPC ceiling (micros) for maximize-clicks — caps warm-up spend.
    cpcBidCeilingMicros: z.number().int().gt(0).optional(),
    // AI Max for Search: broad-match expansion + Google-AI asset/landing-page
    // matching. On by default (Google's recommended posture).
    aiMax: z.boolean().default(true),
    // Device targeting. Undefined => default brief: mobile excluded at -100%.
    devices: z.array(z.enum(DEVICES)).optional(),
    // Campaign-level negative keywords — shared across all ad groups.
    negativeKeywords: z.array(KeywordSchema).default([]),
    targetCpaMicros: z.number().int().gt(0).optional(),
    targetRoas: z.number().gt(0).optional(),
    // Every campaign requires six sitelinks for complete Search ad coverage.
    sitelinks: z.array(SitelinkSchema).max(6).default([]),
    // Callout assets (campaign-level): at least 4, or none. Each ≤25 chars.
    callouts: z.array(z.string().min(1).max(25)).max(20).default([]),
    priceAsset: PriceAssetSchema.optional(),
    structuredSnippet: StructuredSnippetAssetSchema.optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.sitelinks.length > 0 && c.sitelinks.length !== 6) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "provide exactly 6 sitelinks", path: ["sitelinks"] });
    }
    if (c.callouts.length > 0 && c.callouts.length < 4) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "provide at least 4 callouts (max 20), or none",
        path: ["callouts"],
      });
    }
    if (c.devices !== undefined) {
      if (c.devices.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "devices: omit the field for all-device targeting; an empty list would exclude every device",
          path: ["devices"],
        });
      } else if (new Set(c.devices).size !== c.devices.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "devices: no duplicates", path: ["devices"] });
      }
    }
    const s = c.bidStrategy;
    if (c.targetCpaMicros !== undefined && s !== "target-cpa") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `targetCpaMicros only valid when bidStrategy='target-cpa' (got '${s}')`,
        path: ["targetCpaMicros"],
      });
    }
    if (c.targetRoas !== undefined && s !== "target-roas") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `targetRoas only valid when bidStrategy='target-roas' (got '${s}')`,
        path: ["targetRoas"],
      });
    }
    if (s === "target-cpa" && c.targetCpaMicros === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "bidStrategy='target-cpa' requires targetCpaMicros",
        path: ["targetCpaMicros"],
      });
    }
    if (s === "target-roas" && c.targetRoas === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "bidStrategy='target-roas' requires targetRoas",
        path: ["targetRoas"],
      });
    }
    if (c.cpcBidCeilingMicros !== undefined && s !== "maximize-clicks") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `cpcBidCeilingMicros only valid when bidStrategy='maximize-clicks' (got '${s}')`,
        path: ["cpcBidCeilingMicros"],
      });
    }
  });
export type Campaign = z.infer<typeof CampaignSchema>;

/** Lowercase a display path (or pass through undefined). */
const displayPath = z
  .string()
  .max(15)
  .transform((v) => v.toLowerCase())
  .optional();

/**
 * Full RSA asset sets are mandatory: Google can only optimize combinations when all
 * available headline and description slots are populated.
 */
export const ResponsiveSearchAdSchema = z
  .object({
    headlines: z.array(HeadlineSchema).length(15),
    descriptions: z.array(DescriptionSchema).length(4),
    finalUrl: httpsUrl,
    // Display-URL "pretty URL" paths (≤15 chars, no spaces or "/", lower-cased).
    path1: displayPath,
    path2: displayPath,
  })
  .strict()
  .superRefine((rsa, ctx) => {
    const headlineText = rsa.headlines.map((h) => h.text.toLowerCase());
    const descriptionText = rsa.descriptions.map((d) => d.text.toLowerCase());
    if (new Set(headlineText).size !== headlineText.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "RSA headlines must be unique", path: ["headlines"] });
    }
    if (new Set(descriptionText).size !== descriptionText.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "RSA descriptions must be unique",
        path: ["descriptions"],
      });
    }
    for (const [name, value] of [
      ["path1", rsa.path1],
      ["path2", rsa.path2],
    ] as const) {
      if (value === undefined) {
        continue;
      }
      if (value.trim() === "") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${name} must be non-empty when provided (omit it instead)`,
          path: [name],
        });
      }
      if (/\s/.test(value) || value.includes("/")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${name} may not contain spaces or '/' (got ${JSON.stringify(value)})`,
          path: [name],
        });
      }
      if (value.toLowerCase().includes("todo")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${name} still holds a scaffold placeholder (${JSON.stringify(value)}); fill it or omit it`,
          path: [name],
        });
      }
    }
    if (rsa.path2 !== undefined && rsa.path1 === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "path2 requires path1 (Google fills the display path in order)",
        path: ["path2"],
      });
    }
  });
export type ResponsiveSearchAd = z.infer<typeof ResponsiveSearchAdSchema>;

export const AdGroupSchema = z
  .object({
    name: z.string().min(1),
    // max $15.00 CPC — guards against a fat-fingered micros value draining budget.
    defaultBidMicros: z.number().int().gt(0).max(15_000_000),
    responsiveSearchAd: ResponsiveSearchAdSchema,
    keywords: z.array(KeywordSchema).min(1).max(AD_GROUP_MAX_KEYWORDS),
  })
  .strict();
export type AdGroup = z.infer<typeof AdGroupSchema>;

export const BriefSchema = z
  .object({
    name: z.string().regex(AD_NAME_PATTERN, {
      message: "must be kebab-case, 2–64 chars, starting with a letter",
    }),
    version: z.number().int().gte(1),
    customerId: z
      .string()
      .regex(CUSTOMER_ID_PATTERN, { message: "must be 10 digits" })
      .optional(),
    campaign: CampaignSchema,
    adGroups: z.array(AdGroupSchema).min(1).max(MAX_AD_GROUPS),
  })
  .strict()
  .superRefine((b, ctx) => {
    const names = b.adGroups.map((ag) => ag.name);
    if (new Set(names).size !== names.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "adGroups[].name must be unique within a brief",
        path: ["adGroups"],
      });
    }
  });
export type Brief = z.infer<typeof BriefSchema>;

/** Parse + validate a brief, throwing a `ZodError` on failure (mirrors `Brief.model_validate`). */
export function parseBrief(data: unknown): Brief {
  return BriefSchema.parse(data);
}

// ---- fixes-plan models (apply path; see bin/apply-fixes.ts) ----
// coerce_numbers_to_str: plan JSON may carry the id as a number; coerce so the
// digits-only string pattern validates it.
export const CampaignStatusChangeSchema = z
  .object({
    campaignId: z.coerce.string().regex(/^[0-9]+$/),
    status: z.enum(["ENABLED", "PAUSED"]),
  })
  .strict();
export type CampaignStatusChange = z.infer<typeof CampaignStatusChangeSchema>;

export const AdGroupStatusChangeSchema = z
  .object({
    adGroupId: z.coerce.string().regex(/^[0-9]+$/),
    status: z.enum(["ENABLED", "PAUSED"]),
  })
  .strict();
export type AdGroupStatusChange = z.infer<typeof AdGroupStatusChangeSchema>;

// An adStatus block flips a single ad (ad_group_ad) on/off — the lever for the
// PAUSED ad a freshly-created ad group ships with. Keyed by adId alone; the ad's
// parent adGroupId is resolved from live state (an ad_group_ad resource name needs
// both, but the operator only knows the adId from the audit).
export const AdStatusChangeSchema = z
  .object({
    adId: z.coerce.string().regex(/^[0-9]+$/),
    status: z.enum(["ENABLED", "PAUSED"]),
  })
  .strict();
export type AdStatusChange = z.infer<typeof AdStatusChangeSchema>;

/** A searchPartners fixes-plan block: toggle campaign.network_settings.target_search_network. */
export const SearchPartnersChangeSchema = z
  .object({
    campaignId: z.coerce.string().regex(/^[0-9]+$/),
    enabled: z.boolean(),
  })
  .strict();
export type SearchPartnersChange = z.infer<typeof SearchPartnersChangeSchema>;

export const FAILURE_STEPS = [
  "validate-brief",
  "preflight",
  "archive-existing-campaign",
  "find-existing-campaign",
  "find-existing-ad-group",
  "create-campaign-budget",
  "create-search-campaign",
  "target-location",
  "target-devices",
  "create-negative-keywords",
  "create-sitelinks",
  "create-callouts",
  "create-price-asset",
  "create-structured-snippet",
  "create-ad-group",
  "create-responsive-search-ad",
  "create-keywords",
] as const;
export type FailureStep = (typeof FAILURE_STEPS)[number];

export interface Failure {
  step: FailureStep;
  message: string;
  adGroupName?: string | null;
  raw?: unknown;
}
