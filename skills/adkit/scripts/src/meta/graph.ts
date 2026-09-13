/**
 * zod schemas for Graph API (Marketing API) response bodies.
 *
 * `meta/client.ts` parses every 2xx body through one of these and every non-2xx
 * body through `GraphErrorSchema`, so downstream code only ever sees parsed,
 * branded values. Conventions:
 *
 * - Unknown extra keys are stripped (zod default) — except for the spec objects
 *   that `update` round-trips into a new creative or ad set (`targeting`,
 *   `object_story_spec`, `asset_feed_spec`, `degrees_of_freedom_spec`,
 *   `promoted_object`), which use `.passthrough()` so no live setting is lost.
 * - A key is required when Meta always returns it for the object *and* the
 *   callers' field lists (plan D3/D5–D8) request it; keys Meta omits when unset
 *   (budgets under the other budget mode, `promoted_object`, `learning_stage_info`
 *   on a new/paused ad set, insight metrics with no data) are optional.
 * - Graph sends money and metric values as decimal strings (`"12.34"`); they are
 *   coerced to numbers once here by `GraphNumberSchema`. Budgets stay in the
 *   account's minor units (see `meta/money.ts`).
 * - Open-ended Meta enums (`effective_status`, `objective`, …) are plain strings so a
 *   newly introduced value does not fail a whole read; closed documented enums
 *   (`learning_stage_info.status`, permission `status`) are literal unions.
 */

import { z } from "zod";

import {
  ImageHashSchema,
  MetaAdAccountIdSchema,
  MetaAdIdSchema,
  MetaAdSetIdSchema,
  MetaCampaignIdSchema,
  MetaCreativeIdSchema,
  MetaCustomAudienceIdSchema,
  MetaPageIdSchema,
  MetaPixelIdSchema,
  MetaVideoIdSchema,
} from "./ids.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Graph numeric value: a number or a non-blank decimal string, coerced to a finite number. */
export const GraphNumberSchema = z
  .union([z.number(), z.string().trim().min(1, "expected a numeric value")])
  .transform((v, ctx) => {
    const n = Number(v);
    if (!Number.isFinite(n)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `expected a numeric value, got ${JSON.stringify(v)}` });
      return z.NEVER;
    }
    return n;
  });

/** Loose Graph id (interest ids, user ids): digits as string or number, output string. */
const GraphIdStringSchema = z.union([z.string().trim().min(1), z.number().int()]).transform(String);

/** One page of an edge read: `{ data: [...], paging?: { next?, cursors? } }`. */
export const pageSchema = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    data: z.array(item),
    paging: z
      .object({
        next: z.string().optional(),
        previous: z.string().optional(),
        cursors: z.object({ before: z.string().optional(), after: z.string().optional() }).optional(),
      })
      .optional(),
  });

export type Page<T> = {
  data: T[];
  paging?: { next?: string; previous?: string; cursors?: { before?: string; after?: string } };
};

/** `?ids=a,b,c` multi-get response: an object keyed by the requested id. */
export const multiGetSchema = <T extends z.ZodTypeAny>(item: T) => z.record(z.string(), item);

// ---------------------------------------------------------------------------
// Errors & write acknowledgements
// ---------------------------------------------------------------------------

/** Non-2xx Graph error body. */
export const GraphErrorSchema = z.object({
  error: z.object({
    message: z.string(),
    type: z.string().optional(),
    code: z.number().int(),
    error_subcode: z.number().int().optional(),
    error_user_title: z.string().optional(),
    error_user_msg: z.string().optional(),
    fbtrace_id: z.string().optional(),
    is_transient: z.boolean().optional(),
  }),
});
export type GraphError = z.output<typeof GraphErrorSchema>;

/** `POST act_<id>/{campaigns,adsets,adcreatives,ads,advideos}` → `{ id }` (plain numeric id). */
export const CreatedIdSchema = z.object({ id: GraphIdStringSchema.pipe(z.string().regex(/^\d+$/)) });
export type CreatedId = z.output<typeof CreatedIdSchema>;

/** `{ id }` carrying the created object's brand, e.g. `createdIdSchema(MetaCampaignIdSchema)`. */
export const createdIdSchema = <T extends z.ZodTypeAny>(id: T) => z.object({ id });

/** `POST /<object-id>` update → `{ success: true }`. */
export const SuccessSchema = z.object({ success: z.boolean() });
export type Success = z.output<typeof SuccessSchema>;

// ---------------------------------------------------------------------------
// Identity & account (preflight, D4 currency read)
// ---------------------------------------------------------------------------

/** `GET /me?fields=id,name`. `name` is absent for some token types. */
export const MeSchema = z.object({ id: GraphIdStringSchema, name: z.string().optional() });
export type Me = z.output<typeof MeSchema>;

export const PermissionSchema = z.object({
  permission: z.string(),
  status: z.enum(["granted", "declined", "expired"]),
});
export type Permission = z.output<typeof PermissionSchema>;

/** `GET /me/permissions`. */
export const PermissionsSchema = pageSchema(PermissionSchema);
export type Permissions = z.output<typeof PermissionsSchema>;

/**
 * `GET act_<id>?fields=name,account_status,currency[,timezone_name,disable_reason]`.
 * `account_status` 1 = active; `disable_reason` 0 = none.
 */
export const AdAccountSchema = z.object({
  id: MetaAdAccountIdSchema,
  account_id: z.string().optional(),
  name: z.string(),
  account_status: z.number().int(),
  currency: z.string(),
  timezone_name: z.string().optional(),
  disable_reason: z.number().int().optional(),
});
export type AdAccount = z.output<typeof AdAccountSchema>;

// ---------------------------------------------------------------------------
// Campaign (Ad Campaign Group)
// ---------------------------------------------------------------------------

/** Campaign-level Advantage+ state (read-only flags). */
export const AdvantageStateInfoSchema = z.object({
  advantage_state: z.string(),
  advantage_budget_state: z.string().optional(),
  advantage_audience_state: z.string().optional(),
  advantage_placement_state: z.string().optional(),
});
export type AdvantageStateInfo = z.output<typeof AdvantageStateInfoSchema>;

/**
 * Campaign, as read by report (`id,name,effective_status,objective`) and audit
 * (adds budgets, `bid_strategy`, `special_ad_categories`). Budgets are minor units;
 * only the active budget mode's key is present.
 */
export const CampaignSchema = z.object({
  id: MetaCampaignIdSchema,
  name: z.string(),
  objective: z.string(),
  effective_status: z.string(),
  status: z.string().optional(),
  daily_budget: GraphNumberSchema.optional(),
  lifetime_budget: GraphNumberSchema.optional(),
  bid_strategy: z.string().optional(),
  buying_type: z.string().optional(),
  special_ad_categories: z.array(z.string()).optional(),
  advantage_state_info: AdvantageStateInfoSchema.optional(),
});
export type Campaign = z.output<typeof CampaignSchema>;

// ---------------------------------------------------------------------------
// Ad set (Ad Campaign)
// ---------------------------------------------------------------------------

const NamedAudienceSchema = z.object({ id: MetaCustomAudienceIdSchema, name: z.string().optional() });
const InterestSchema = z.object({ id: GraphIdStringSchema, name: z.string().optional() });

export const GeoLocationsSchema = z
  .object({
    countries: z.array(z.string()).optional(),
    regions: z.array(z.object({ key: GraphIdStringSchema, name: z.string().optional() }).passthrough()).optional(),
    cities: z
      .array(
        z
          .object({
            key: GraphIdStringSchema,
            name: z.string().optional(),
            radius: z.number().optional(),
            distance_unit: z.enum(["mile", "kilometer"]).optional(),
          })
          .passthrough(),
      )
      .optional(),
    location_types: z.array(z.string()).optional(),
  })
  .passthrough();

/** Ad set targeting spec; every key is optional on Meta's side. */
export const TargetingSchema = z
  .object({
    geo_locations: GeoLocationsSchema.optional(),
    excluded_geo_locations: GeoLocationsSchema.optional(),
    age_min: z.number().int().optional(),
    age_max: z.number().int().optional(),
    genders: z.array(z.number().int()).optional(),
    locales: z.array(z.number().int()).optional(),
    custom_audiences: z.array(NamedAudienceSchema).optional(),
    excluded_custom_audiences: z.array(NamedAudienceSchema).optional(),
    interests: z.array(InterestSchema).optional(),
    flexible_spec: z.array(z.object({ interests: z.array(InterestSchema).optional() }).passthrough()).optional(),
    publisher_platforms: z.array(z.string()).optional(),
    facebook_positions: z.array(z.string()).optional(),
    instagram_positions: z.array(z.string()).optional(),
    targeting_automation: z.object({ advantage_audience: z.number().int().optional() }).passthrough().optional(),
  })
  .passthrough();
export type Targeting = z.output<typeof TargetingSchema>;

/** What the ad set optimises toward; `pixel_id` + `custom_event_type` for conversions. */
export const PromotedObjectSchema = z
  .object({
    pixel_id: MetaPixelIdSchema.optional(),
    custom_event_type: z.string().optional(),
    page_id: MetaPageIdSchema.optional(),
  })
  .passthrough();
export type PromotedObject = z.output<typeof PromotedObjectSchema>;

/** `learning_stage_info` (AdCampaignLearningStageInfo). */
export const LearningStageInfoSchema = z.object({
  status: z.enum(["LEARNING", "SUCCESS", "FAIL"]),
  conversions: z.number().int().optional(),
  last_sig_edit_ts: z.number().int().optional(),
  attribution_windows: z.array(z.string()).optional(),
});
export type LearningStageInfo = z.output<typeof LearningStageInfoSchema>;

/**
 * Ad set, as read by audit (plan D6) and update live reads (D8). Reads must request
 * at least `id,name,campaign_id,effective_status,optimization_goal,targeting`.
 */
export const AdSetSchema = z.object({
  id: MetaAdSetIdSchema,
  name: z.string(),
  campaign_id: MetaCampaignIdSchema,
  effective_status: z.string(),
  status: z.string().optional(),
  optimization_goal: z.string(),
  billing_event: z.string().optional(),
  daily_budget: GraphNumberSchema.optional(),
  lifetime_budget: GraphNumberSchema.optional(),
  bid_amount: GraphNumberSchema.optional(),
  bid_strategy: z.string().optional(),
  promoted_object: PromotedObjectSchema.optional(),
  targeting: TargetingSchema,
  learning_stage_info: LearningStageInfoSchema.optional(),
  is_dynamic_creative: z.boolean().optional(),
  /**
   * Meta exposes `advantage_state_info` on the campaign only; ad set reads get it via
   * the `campaign{id,advantage_state_info}` field expansion.
   */
  campaign: z
    .object({ id: MetaCampaignIdSchema, advantage_state_info: AdvantageStateInfoSchema.optional() })
    .optional(),
});
export type AdSet = z.output<typeof AdSetSchema>;

// ---------------------------------------------------------------------------
// Ad creative
// ---------------------------------------------------------------------------

const CallToActionSchema = z
  .object({
    type: z.string(),
    value: z.object({ link: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();

export const ObjectStorySpecSchema = z
  .object({
    page_id: MetaPageIdSchema,
    instagram_user_id: GraphIdStringSchema.optional(),
    link_data: z
      .object({
        link: z.string().optional(),
        message: z.string().optional(),
        name: z.string().optional(),
        description: z.string().optional(),
        image_hash: ImageHashSchema.optional(),
        picture: z.string().optional(),
        call_to_action: CallToActionSchema.optional(),
      })
      .passthrough()
      .optional(),
    video_data: z
      .object({
        video_id: MetaVideoIdSchema.optional(),
        image_url: z.string().optional(),
        image_hash: ImageHashSchema.optional(),
        message: z.string().optional(),
        title: z.string().optional(),
        link_description: z.string().optional(),
        call_to_action: CallToActionSchema.optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type ObjectStorySpec = z.output<typeof ObjectStorySpecSchema>;

const TextAssetSchema = z.object({ text: z.string() }).passthrough();

export const AssetFeedSpecSchema = z
  .object({
    bodies: z.array(TextAssetSchema).optional(),
    titles: z.array(TextAssetSchema).optional(),
    descriptions: z.array(TextAssetSchema).optional(),
    link_urls: z
      .array(z.object({ website_url: z.string(), display_url: z.string().optional() }).passthrough())
      .optional(),
    call_to_action_types: z.array(z.string()).optional(),
    images: z.array(z.object({ hash: ImageHashSchema, url: z.string().optional() }).passthrough()).optional(),
    videos: z
      .array(
        z
          .object({
            video_id: MetaVideoIdSchema,
            thumbnail_url: z.string().optional(),
            thumbnail_hash: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
    ad_formats: z.array(z.string()).optional(),
    optimization_type: z.string().optional(),
  })
  .passthrough();
export type AssetFeedSpec = z.output<typeof AssetFeedSpecSchema>;

/** `creative_features_spec` keyed by feature (`enhance_cta`, `text_optimizations`, …). */
export const DegreesOfFreedomSpecSchema = z
  .object({
    creative_features_spec: z
      .record(z.string(), z.object({ enroll_status: z.string() }).passthrough())
      .optional(),
  })
  .passthrough();
export type DegreesOfFreedomSpec = z.output<typeof DegreesOfFreedomSpecSchema>;

/** Ad creative, standalone or expanded as `ad.creative{id,…}` (where `name` is usually not requested). */
export const AdCreativeSchema = z.object({
  id: MetaCreativeIdSchema,
  name: z.string().optional(),
  object_story_spec: ObjectStorySpecSchema.optional(),
  asset_feed_spec: AssetFeedSpecSchema.optional(),
  degrees_of_freedom_spec: DegreesOfFreedomSpecSchema.optional(),
});
export type AdCreative = z.output<typeof AdCreativeSchema>;

// ---------------------------------------------------------------------------
// Ad (Ad Group)
// ---------------------------------------------------------------------------

/** Ad with its creative expanded: `id,name,adset_id,effective_status,creative{…}`. */
export const AdSchema = z.object({
  id: MetaAdIdSchema,
  name: z.string(),
  adset_id: MetaAdSetIdSchema,
  campaign_id: MetaCampaignIdSchema.optional(),
  effective_status: z.string(),
  status: z.string().optional(),
  creative: AdCreativeSchema,
});
export type Ad = z.output<typeof AdSchema>;

// ---------------------------------------------------------------------------
// Insights
// ---------------------------------------------------------------------------

/** `actions` / `cost_per_action_type` entry; per-window keys appear when attribution windows are requested. */
export const ActionValueSchema = z.object({
  action_type: z.string(),
  value: GraphNumberSchema,
  "1d_click": GraphNumberSchema.optional(),
  "7d_click": GraphNumberSchema.optional(),
  "28d_click": GraphNumberSchema.optional(),
  "1d_view": GraphNumberSchema.optional(),
  "1d_ev": GraphNumberSchema.optional(),
});
export type ActionValue = z.output<typeof ActionValueSchema>;

/**
 * One `act_<id>/insights` row. Entity ids/names depend on `level`; breakdown keys on
 * `breakdowns`; Meta omits ratio metrics and `actions` when there is no data.
 */
export const InsightsRowSchema = z.object({
  date_start: z.string(),
  date_stop: z.string(),
  campaign_id: MetaCampaignIdSchema.optional(),
  campaign_name: z.string().optional(),
  adset_id: MetaAdSetIdSchema.optional(),
  adset_name: z.string().optional(),
  ad_id: MetaAdIdSchema.optional(),
  ad_name: z.string().optional(),
  spend: GraphNumberSchema,
  impressions: GraphNumberSchema,
  reach: GraphNumberSchema.optional(),
  frequency: GraphNumberSchema.optional(),
  clicks: GraphNumberSchema.optional(),
  inline_link_clicks: GraphNumberSchema.optional(),
  ctr: GraphNumberSchema.optional(),
  inline_link_click_ctr: GraphNumberSchema.optional(),
  cpm: GraphNumberSchema.optional(),
  cpc: GraphNumberSchema.optional(),
  actions: z.array(ActionValueSchema).optional(),
  cost_per_action_type: z.array(ActionValueSchema).optional(),
  publisher_platform: z.string().optional(),
  platform_position: z.string().optional(),
  age: z.string().optional(),
  gender: z.string().optional(),
  country: z.string().optional(),
  region: z.string().optional(),
});
export type InsightsRow = z.output<typeof InsightsRowSchema>;

// ---------------------------------------------------------------------------
// Media uploads
// ---------------------------------------------------------------------------

/** `POST act_<id>/adimages` → `{ images: { <file name>: { hash, url } } }`. */
export const ImageUploadSchema = z.object({
  images: z.record(z.string(), z.object({ hash: ImageHashSchema, url: z.string().optional() })),
});
export type ImageUpload = z.output<typeof ImageUploadSchema>;

const PhaseSchema = z.object({ status: z.string() }).passthrough();

/** `GET /<video-id>?fields=status`; `video_status` is `ready` once processing finishes. */
export const VideoStatusSchema = z.object({
  id: MetaVideoIdSchema.optional(),
  status: z.object({
    video_status: z.string(),
    uploading_phase: PhaseSchema.optional(),
    processing_phase: z
      .object({
        status: z.string(),
        errors: z.array(z.object({ code: z.number().optional(), message: z.string() })).optional(),
      })
      .passthrough()
      .optional(),
    publishing_phase: PhaseSchema.optional(),
  }),
});
export type VideoStatus = z.output<typeof VideoStatusSchema>;
