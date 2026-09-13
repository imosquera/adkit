/**
 * The Meta intent brief (`adbriefs/<slug>.yaml` with `type: meta`, plan D7): one
 * campaign → 1..10 ad sets → 1..6 ads each, every ad a flexible (asset-feed) creative
 * with text pools, one media file and explicit Advantage+ creative enhancements.
 *
 * Parse, don't validate: {@link parseMetaBrief} is the single trust boundary. It runs
 * the structural schema, the cross-field refinements (budget mode exclusivity, bid
 * amount presence, objective ↔ optimization goal, OFFSITE_CONVERSIONS ↔ conversion,
 * special-ad-category restrictions, unique names) and the media-file existence check,
 * and reports every issue at once, before any write (US4 AS4). A `MetaBrief` is the
 * proof: publish/plan code never re-checks these invariants.
 *
 * Media paths stay exactly as authored (relative to the brief file's directory). This
 * module never touches the filesystem: the caller passes `deps.fileExists`, which is
 * responsible for resolving a brief-relative path against the brief's directory.
 */

import { z, type ZodIssue } from "zod";

import { AD_NAME_PATTERN } from "../lib/schema.js";
import { err, MetaAdAccountIdSchema, MetaCustomAudienceIdSchema, MetaPageIdSchema, MetaPixelIdSchema, ok, type Result } from "./ids.js";

// ---------- Constants (shared with the update plan, src/meta/plan.ts) ----------

/** Hard Graph limits on flexible-creative text assets (rejected above these). */
export const PRIMARY_TEXT_MAX = 1024;
export const HEADLINE_MAX = 255;
export const DESCRIPTION_MAX = 255;

/** Recommended lengths before Meta truncates in most placements (soft warnings only). */
export const PRIMARY_TEXT_RECOMMENDED = 125;
export const HEADLINE_RECOMMENDED = 40;
export const DESCRIPTION_RECOMMENDED = 30;

/** Assets per text pool in a flexible creative. */
export const TEXT_POOL_MAX = 5;

export const MAX_AD_SETS = 10;
export const MAX_ADS_PER_AD_SET = 6;

/** Advantage+ creative feature keys (`degrees_of_freedom_spec.creative_features_spec`). */
export const ENHANCEMENT_FEATURE_KEYS = [
  "image_touchups",
  "text_optimizations",
  "add_text_overlay",
  "image_templates",
  "image_animation",
  "image_background_gen",
  "inline_comment",
  "text_translation",
  "enhance_cta",
  "image_uncrop",
] as const;
export type EnhancementFeatureKey = (typeof ENHANCEMENT_FEATURE_KEYS)[number];

export const ENHANCEMENT_STATUSES = ["OPT_IN", "OPT_OUT"] as const;
export type EnhancementStatus = (typeof ENHANCEMENT_STATUSES)[number];

export const META_OBJECTIVES = [
  "OUTCOME_LEADS",
  "OUTCOME_SALES",
  "OUTCOME_TRAFFIC",
  "OUTCOME_AWARENESS",
  "OUTCOME_ENGAGEMENT",
] as const;
export type MetaObjective = (typeof META_OBJECTIVES)[number];

export const SPECIAL_AD_CATEGORIES = ["CREDIT", "EMPLOYMENT", "HOUSING", "ISSUES_ELECTIONS_POLITICS"] as const;
export type SpecialAdCategory = (typeof SPECIAL_AD_CATEGORIES)[number];

/**
 * Categories whose audience targeting Meta restricts. Per the Marketing API "Special
 * Ad Category" doc (developers.facebook.com/docs/marketing-api/audiences/special-ad-category,
 * checked 2026-09): for housing, employment and credit / financial products ads, age is
 * fixed to 18–65+, gender cannot be chosen, behaviour/demographic/interest targeting is
 * limited, and "location selection must include all areas equal or larger than 15 mile
 * or 25 kilometer radius" (US/CA). ISSUES_ELECTIONS_POLITICS is not audience-restricted
 * by the `special_ad_categories` label, so it is absent here.
 */
export const TARGETING_RESTRICTED_CATEGORIES: ReadonlySet<SpecialAdCategory> = new Set(["HOUSING", "EMPLOYMENT", "CREDIT"]);

/** Minimum city radius under a {@link TARGETING_RESTRICTED_CATEGORIES} category. */
export const RESTRICTED_MIN_RADIUS = { mile: 15, kilometer: 25 } as const;

export const META_BID_STRATEGIES = ["LOWEST_COST_WITHOUT_CAP", "COST_CAP", "LOWEST_COST_WITH_BID_CAP"] as const;
export type MetaBidStrategy = (typeof META_BID_STRATEGIES)[number];

/** Bid strategies that need an ad set `bidAmount` (the cap). */
export const BID_AMOUNT_STRATEGIES: ReadonlySet<MetaBidStrategy> = new Set(["COST_CAP", "LOWEST_COST_WITH_BID_CAP"]);

/**
 * Optimization goals a website-destination ad set (the only kind this brief
 * publishes: link + flexible creative) can use. Goals that need another destination
 * (instant forms `LEAD_GENERATION`/`QUALITY_LEAD`, calls, Messenger, page likes,
 * events, app installs) are deliberately absent.
 */
export const META_OPTIMIZATION_GOALS = [
  "OFFSITE_CONVERSIONS",
  "LINK_CLICKS",
  "LANDING_PAGE_VIEWS",
  "REACH",
  "IMPRESSIONS",
  "AD_RECALL_LIFT",
  "THRUPLAY",
  "TWO_SECOND_CONTINUOUS_VIDEO_VIEWS",
  "POST_ENGAGEMENT",
] as const;
export type MetaOptimizationGoal = (typeof META_OPTIMIZATION_GOALS)[number];

/**
 * Objective → allowed optimization goals, from Meta's Outcome-Driven Ads Experiences
 * mapping table (Marketing API reference, "Ad Campaign" → ODAX mapping), restricted
 * to {@link META_OPTIMIZATION_GOALS}.
 * ponytail: static copy of Meta's table; re-sync when Graph rejects a pairing listed here.
 */
export const OBJECTIVE_OPTIMIZATION_GOALS: Readonly<Record<MetaObjective, readonly MetaOptimizationGoal[]>> = {
  OUTCOME_AWARENESS: ["REACH", "IMPRESSIONS", "AD_RECALL_LIFT", "THRUPLAY", "TWO_SECOND_CONTINUOUS_VIDEO_VIEWS"],
  OUTCOME_TRAFFIC: ["LINK_CLICKS", "LANDING_PAGE_VIEWS", "REACH", "IMPRESSIONS"],
  OUTCOME_ENGAGEMENT: [
    "POST_ENGAGEMENT",
    "THRUPLAY",
    "TWO_SECOND_CONTINUOUS_VIDEO_VIEWS",
    "OFFSITE_CONVERSIONS",
    "LINK_CLICKS",
    "LANDING_PAGE_VIEWS",
    "REACH",
    "IMPRESSIONS",
  ],
  OUTCOME_LEADS: ["OFFSITE_CONVERSIONS", "LINK_CLICKS", "LANDING_PAGE_VIEWS", "REACH", "IMPRESSIONS"],
  OUTCOME_SALES: ["OFFSITE_CONVERSIONS", "LINK_CLICKS", "LANDING_PAGE_VIEWS", "REACH", "IMPRESSIONS"],
};

/** Pixel standard events usable as `promoted_object.custom_event_type`. */
export const CONVERSION_EVENTS = [
  "LEAD",
  "COMPLETE_REGISTRATION",
  "CONTACT",
  "SUBMIT_APPLICATION",
  "SCHEDULE",
  "START_TRIAL",
  "SUBSCRIBE",
  "PURCHASE",
  "ADD_TO_CART",
  "INITIATED_CHECKOUT",
  "ADD_PAYMENT_INFO",
  "ADD_TO_WISHLIST",
  "CONTENT_VIEW",
  "SEARCH",
  "FIND_LOCATION",
  "CUSTOMIZE_PRODUCT",
  "DONATE",
  "OTHER",
] as const;

export const CALL_TO_ACTIONS = [
  "LEARN_MORE",
  "SIGN_UP",
  "GET_QUOTE",
  "BOOK_NOW",
  "CONTACT_US",
  "DOWNLOAD",
  "SUBSCRIBE",
  "APPLY_NOW",
] as const;

export const PUBLISHER_PLATFORMS = ["facebook", "instagram", "messenger", "audience_network"] as const;
export const FACEBOOK_POSITIONS = [
  "feed",
  "right_hand_column",
  "marketplace",
  "video_feeds",
  "story",
  "search",
  "instream_video",
  "facebook_reels",
  "facebook_reels_overlay",
  "profile_feed",
  "notification",
] as const;
export const INSTAGRAM_POSITIONS = [
  "stream",
  "story",
  "explore",
  "explore_home",
  "reels",
  "profile_feed",
  "ig_search",
  "profile_reels",
] as const;

/** Age bounds Meta accepts, and the only bounds allowed under a special ad category. */
export const META_AGE_MIN = 18;
export const META_AGE_MAX = 65;

// ---------- Leaf schemas ----------

const httpsUrl = z.string().refine(
  (v) => {
    try {
      return new URL(v).protocol === "https:";
    } catch {
      return false;
    }
  },
  { message: "link must use https://" },
);

const money = z.number().gt(0);

/** A text pool: 1..5 (or `min`..5) non-empty, unique strings each at most `max` chars. */
const textPool = (label: string, max: number, min: number) =>
  z
    .array(z.string().trim().min(1).max(max, { message: `${label} may be at most ${max} characters` }))
    .min(min)
    .max(TEXT_POOL_MAX)
    .refine((ts) => new Set(ts).size === ts.length, { message: `${label} must be unique` });

export const PrimaryTextsSchema = textPool("primaryTexts", PRIMARY_TEXT_MAX, 1);
export const HeadlinesSchema = textPool("headlines", HEADLINE_MAX, 1);
export const DescriptionsSchema = textPool("descriptions", DESCRIPTION_MAX, 0);

/** Explicit per-key enhancement choices; unknown keys rejected, omitted keys left to Meta's default. */
export const EnhancementsSchema = z.record(z.enum(ENHANCEMENT_FEATURE_KEYS), z.enum(ENHANCEMENT_STATUSES));
export type Enhancements = z.infer<typeof EnhancementsSchema>;

const mediaPath = z.string().trim().min(1);

/** One media file per ad; paths are relative to the brief file's directory. */
export const MediaSchema = z.union([
  z.object({ image: mediaPath }).strict(),
  z.object({ video: mediaPath, thumbnail: mediaPath }).strict(),
]);
export type Media = z.infer<typeof MediaSchema>;

export const MetaAdSchema = z
  .object({
    name: z.string().min(1),
    link: httpsUrl,
    callToAction: z.enum(CALL_TO_ACTIONS),
    primaryTexts: PrimaryTextsSchema,
    headlines: HeadlinesSchema,
    descriptions: DescriptionsSchema.default([]),
    media: MediaSchema,
    enhancements: EnhancementsSchema.default({}),
  })
  .strict();
export type MetaAd = z.infer<typeof MetaAdSchema>;

const CitySchema = z
  .object({
    key: z.string().min(1),
    radius: z.number().gt(0).optional(),
    distance_unit: z.enum(["mile", "kilometer"]).optional(),
  })
  .strict()
  .refine((c) => (c.radius === undefined) === (c.distance_unit === undefined), {
    message: "city radius and distance_unit go together",
  });

export const AudienceSchema = z
  .object({
    countries: z.array(z.string().regex(/^[A-Z]{2}$/, { message: "countries: 2-letter ISO codes, e.g. US" })).default([]),
    regions: z.array(z.object({ key: z.string().min(1) }).strict()).default([]),
    cities: z.array(CitySchema).default([]),
    ageMin: z.number().int().gte(META_AGE_MIN).lte(META_AGE_MAX).default(META_AGE_MIN),
    ageMax: z.number().int().gte(META_AGE_MIN).lte(META_AGE_MAX).default(META_AGE_MAX),
    genders: z.array(z.enum(["male", "female"])).default([]), // [] = all
    locales: z.array(z.number().int().nonnegative()).default([]),
    customAudienceIds: z.array(MetaCustomAudienceIdSchema).default([]), // includes lookalikes
    excludedCustomAudienceIds: z.array(MetaCustomAudienceIdSchema).default([]),
    interests: z.array(z.object({ id: z.string().regex(/^\d+$/), name: z.string().min(1) }).strict()).default([]),
    advantageAudience: z.boolean().default(false),
  })
  .strict()
  .superRefine((a, ctx) => {
    if (a.countries.length + a.regions.length + a.cities.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "audience needs at least one location (countries, regions or cities)",
      });
    }
    if (a.ageMin > a.ageMax) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "ageMin may not exceed ageMax", path: ["ageMin"] });
    }
  });
export type Audience = z.infer<typeof AudienceSchema>;

export const PlacementsSchema = z.union([
  z.literal("advantage"),
  z
    .object({
      publisherPlatforms: z.array(z.enum(PUBLISHER_PLATFORMS)).min(1),
      facebookPositions: z.array(z.enum(FACEBOOK_POSITIONS)).default([]),
      instagramPositions: z.array(z.enum(INSTAGRAM_POSITIONS)).default([]),
    })
    .strict()
    .superRefine((p, ctx) => {
      if (p.facebookPositions.length > 0 && !p.publisherPlatforms.includes("facebook")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "facebookPositions require 'facebook' in publisherPlatforms",
          path: ["facebookPositions"],
        });
      }
      if (p.instagramPositions.length > 0 && !p.publisherPlatforms.includes("instagram")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "instagramPositions require 'instagram' in publisherPlatforms",
          path: ["instagramPositions"],
        });
      }
    }),
]);
export type Placements = z.infer<typeof PlacementsSchema>;

export const MetaAdSetSchema = z
  .object({
    name: z.string().min(1),
    dailyBudget: money.optional(),
    bidAmount: money.optional(),
    optimizationGoal: z.enum(META_OPTIMIZATION_GOALS),
    conversion: z.object({ pixelId: MetaPixelIdSchema, event: z.enum(CONVERSION_EVENTS) }).strict().optional(),
    audience: AudienceSchema,
    placements: PlacementsSchema.default("advantage"),
    ads: z.array(MetaAdSchema).min(1).max(MAX_ADS_PER_AD_SET),
  })
  .strict()
  .superRefine((s, ctx) => {
    const names = s.ads.map((a) => a.name);
    if (new Set(names).size !== names.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "ads[].name must be unique within an ad set", path: ["ads"] });
    }
    if (s.optimizationGoal === "OFFSITE_CONVERSIONS" && s.conversion === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "optimizationGoal OFFSITE_CONVERSIONS requires conversion { pixelId, event }",
        path: ["conversion"],
      });
    }
    if (s.optimizationGoal !== "OFFSITE_CONVERSIONS" && s.conversion !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `conversion is only valid with optimizationGoal OFFSITE_CONVERSIONS (got ${s.optimizationGoal})`,
        path: ["conversion"],
      });
    }
  });
export type MetaAdSet = z.infer<typeof MetaAdSetSchema>;

export const CampaignBudgetSchema = z.discriminatedUnion("mode", [
  // Campaign budget optimization (CBO): the budget lives here, never on ad sets.
  z.object({ mode: z.literal("campaign"), dailyBudget: money, bidStrategy: z.enum(META_BID_STRATEGIES) }).strict(),
  // Ad set budgets (ABO): every ad set carries its own dailyBudget.
  z.object({ mode: z.literal("adset"), bidStrategy: z.enum(META_BID_STRATEGIES) }).strict(),
]);
export type CampaignBudget = z.infer<typeof CampaignBudgetSchema>;

export const MetaCampaignSchema = z
  .object({
    name: z.string().min(1),
    objective: z.enum(META_OBJECTIVES),
    specialAdCategories: z
      .array(z.enum(SPECIAL_AD_CATEGORIES))
      .default([])
      .refine((cs) => new Set(cs).size === cs.length, { message: "specialAdCategories: no duplicates" }),
    budget: CampaignBudgetSchema,
    startTime: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
export type MetaCampaign = z.infer<typeof MetaCampaignSchema>;

// ---------- Cross-field refinements ----------

type Issue = { message: string; path: (string | number)[] };

/** Pure: every cross-field issue in a structurally valid brief. */
const crossFieldIssues = (b: {
  campaign: MetaCampaign;
  adSets: readonly MetaAdSet[];
}): Issue[] => {
  const { budget, objective, specialAdCategories } = b.campaign;
  const allowedGoals = OBJECTIVE_OPTIMIZATION_GOALS[objective];
  const needsBid = BID_AMOUNT_STRATEGIES.has(budget.bidStrategy);
  const restricted = specialAdCategories.some((c) => TARGETING_RESTRICTED_CATEGORIES.has(c));
  const names = b.adSets.map((s) => s.name);

  const perAdSet = b.adSets.flatMap((s, i): Issue[] => {
    const at = (...rest: (string | number)[]) => ["adSets", i, ...rest];
    const a = s.audience;
    const narrowedGenders = a.genders.length > 0 && new Set(a.genders).size < 2;
    return [
      ...(budget.mode === "campaign" && s.dailyBudget !== undefined
        ? [{ message: "dailyBudget is forbidden on ad sets when campaign.budget.mode is 'campaign'", path: at("dailyBudget") }]
        : []),
      ...(budget.mode === "adset" && s.dailyBudget === undefined
        ? [{ message: "dailyBudget is required on every ad set when campaign.budget.mode is 'adset'", path: at("dailyBudget") }]
        : []),
      ...(needsBid && s.bidAmount === undefined
        ? [{ message: `bidStrategy ${budget.bidStrategy} requires bidAmount on every ad set`, path: at("bidAmount") }]
        : []),
      ...(!needsBid && s.bidAmount !== undefined
        ? [{ message: `bidAmount is only valid with COST_CAP or LOWEST_COST_WITH_BID_CAP (got ${budget.bidStrategy})`, path: at("bidAmount") }]
        : []),
      ...(allowedGoals.includes(s.optimizationGoal)
        ? []
        : [
            {
              message: `optimizationGoal ${s.optimizationGoal} is not valid for objective ${objective} (allowed: ${allowedGoals.join(", ")})`,
              path: at("optimizationGoal"),
            },
          ]),
      ...(restricted
        ? [
            ...(a.ageMin > META_AGE_MIN
              ? [{ message: `special ad categories require ageMin ${META_AGE_MIN}`, path: at("audience", "ageMin") }]
              : []),
            ...(a.ageMax < META_AGE_MAX
              ? [{ message: `special ad categories require ageMax ${META_AGE_MAX}`, path: at("audience", "ageMax") }]
              : []),
            ...(narrowedGenders
              ? [{ message: "special ad categories forbid gender targeting (use genders: [])", path: at("audience", "genders") }]
              : []),
            ...(a.interests.length > 0
              ? [{ message: "special ad categories forbid interest targeting", path: at("audience", "interests") }]
              : []),
            ...a.cities.flatMap((c, k) =>
              c.radius !== undefined && c.distance_unit !== undefined && c.radius < RESTRICTED_MIN_RADIUS[c.distance_unit]
                ? [
                    {
                      message: `special ad categories require a city radius of at least ${RESTRICTED_MIN_RADIUS.mile} miles / ${RESTRICTED_MIN_RADIUS.kilometer} km (got ${c.radius} ${c.distance_unit})`,
                      path: at("audience", "cities", k, "radius"),
                    },
                  ]
                : [],
            ),
          ]
        : []),
    ];
  });

  return [
    ...(new Set(names).size !== names.length
      ? [{ message: "adSets[].name must be unique within a brief", path: ["adSets"] }]
      : []),
    ...perAdSet,
  ];
};

const addIssues = (issues: readonly Issue[], ctx: z.RefinementCtx): void =>
  issues.forEach((i) => ctx.addIssue({ code: z.ZodIssueCode.custom, message: i.message, path: i.path }));

/** The structural + cross-field Meta brief schema (no filesystem checks). */
export const MetaBriefSchema = z
  .object({
    type: z.literal("meta"),
    name: z.string().regex(AD_NAME_PATTERN, { message: "must be kebab-case, 2–64 chars, starting with a letter" }),
    adAccountId: MetaAdAccountIdSchema.optional(),
    pageId: MetaPageIdSchema.optional(),
    campaign: MetaCampaignSchema,
    adSets: z.array(MetaAdSetSchema).min(1).max(MAX_AD_SETS),
  })
  .strict()
  .superRefine((b, ctx) => addIssues(crossFieldIssues(b), ctx));
export type MetaBrief = z.infer<typeof MetaBriefSchema>;

// ---------- Boundary ----------

export type MetaBriefDeps = {
  /**
   * True when the media file exists and is readable. Receives the path exactly as
   * written in the brief; the implementation resolves it relative to the brief
   * file's directory.
   */
  readonly fileExists: (path: string) => boolean;
};

const formatIssue = (i: Pick<ZodIssue, "path" | "message">): string =>
  `${i.path.length > 0 ? i.path.join(".") : "(root)"}: ${i.message}`;

/** Pure: every media path in the raw data, with its location, tolerant of malformed input. */
const rawMediaPaths = (data: unknown): { file: string; path: (string | number)[] }[] => {
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const rec = (v: unknown): Record<string, unknown> =>
    v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  return arr(rec(data).adSets).flatMap((s, i) =>
    arr(rec(s).ads).flatMap((ad, j) =>
      (["image", "video", "thumbnail"] as const).flatMap((k) => {
        const p = rec(rec(ad).media)[k];
        return typeof p === "string" && p.trim() !== ""
          ? [{ file: p.trim(), path: ["adSets", i, "ads", j, "media", k] }]
          : [];
      }),
    ),
  );
};

/**
 * Parse a raw Meta brief. Collects every schema, cross-field and missing-media issue
 * into one newline-separated message (`path: message` per line). Media existence is
 * checked through `deps.fileExists`, which resolves brief-relative paths.
 */
export function parseMetaBrief(data: unknown, deps: MetaBriefDeps): Result<MetaBrief> {
  const parsed = MetaBriefSchema.safeParse(data);
  const missing = rawMediaPaths(data)
    .filter((m) => !deps.fileExists(m.file))
    .map((m) => ({ path: m.path, message: `media file not found or unreadable: ${m.file}` }));
  const issues = [...(parsed.success ? [] : parsed.error.issues), ...missing].map(formatIssue);
  return issues.length === 0 && parsed.success ? ok(parsed.data) : err(issues.join("\n"));
}

/**
 * Pure: non-blocking warnings — recommended text lengths (Meta truncates beyond these in
 * most placements) and custom-audience exclusions combined with Advantage+ audience,
 * which Meta may not honour (spec edge case).
 */
export function softWarnings(brief: MetaBrief): string[] {
  const pool = (where: string, label: string, texts: readonly string[], limit: number): string[] =>
    texts.flatMap((t, k) =>
      t.length > limit ? [`${where} ${label}[${k}] is ${t.length} chars (recommended ≤ ${limit}; may be truncated)`] : [],
    );
  return brief.adSets.flatMap((s) => [
    ...(s.audience.advantageAudience && s.audience.excludedCustomAudienceIds.length > 0
      ? [`ad set "${s.name}": excludedCustomAudienceIds with advantageAudience: true — exclusions may not apply under Advantage+ audience`]
      : []),
    ...s.ads.flatMap((ad) => {
      const where = `ad set "${s.name}" ad "${ad.name}":`;
      return [
        ...pool(where, "primaryTexts", ad.primaryTexts, PRIMARY_TEXT_RECOMMENDED),
        ...pool(where, "headlines", ad.headlines, HEADLINE_RECOMMENDED),
        ...pool(where, "descriptions", ad.descriptions, DESCRIPTION_RECOMMENDED),
      ];
    }),
  ]);
}
