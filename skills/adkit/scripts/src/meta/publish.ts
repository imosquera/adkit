/**
 * Publish a parsed {@link MetaBrief} to the Graph API (plan D7), resumably.
 *
 * Pure core:
 * - {@link campaignParams}, {@link adSetParams}, {@link creativeParams}, {@link adParams}
 *   build the JSON-ready POST bodies; every object is created `status: PAUSED`.
 * - {@link alignState} reshapes a (possibly older) state onto the brief's names.
 * - {@link planPublish} lists the objects a publish would create or skip (dry run).
 *
 * I/O shell: {@link publishMeta} is a sequence of steps `(state) => Promise<state>`
 * folded left over promises: `upload-media` (one step per media file) →
 * `create-campaign` → per ad set `create-ad-set` → per ad `create-creative` +
 * `create-ad`. `deps.saveState` runs after every step that changed the state, so a
 * crash mid-run leaves a state file that a re-run resumes from. A step whose id is
 * already in state is skipped; before creating an object with no state id, the
 * publisher looks it up live by exact name under its parent, which recovers from
 * "create succeeded, state write failed". The first failure stops the fold and
 * returns the last state that was saved.
 */

import type { z } from "zod";

import type { MediaFile, MetaClient, Params } from "./client.js";
import type { MetaAd, MetaAdSet, MetaBrief } from "./brief.js";
import { MetaApiError, MetaConfigError } from "./errors.js";
import { AdSchema, AdSetSchema, CampaignSchema, createdIdSchema } from "./graph.js";
import {
  MetaAdIdSchema,
  MetaAdSetIdSchema,
  MetaCampaignIdSchema,
  MetaCreativeIdSchema,
  type ImageHash,
  type MetaAdAccountId,
  type MetaAdSetId,
  type MetaCampaignId,
  type MetaCreativeId,
  type MetaPageId,
  type MetaVideoId,
} from "./ids.js";
import { toMinorUnits } from "./money.js";
import type { MetaAdSetState, MetaAdState, MetaMediaState, MetaState } from "./state.js";

// ---------- Types ----------

export type PublishStepName =
  | "upload-media"
  | "create-campaign"
  | "create-ad-set"
  | "create-creative"
  | "create-ad";

/**
 * What a publish needs beyond the brief, already resolved by the bin: the account
 * (brief `adAccountId` or config), the page (brief `pageId` or `meta_page_id`) and the
 * account currency (for minor units).
 */
export interface PublishContext {
  readonly adAccountId: MetaAdAccountId;
  readonly pageId: MetaPageId;
  readonly currency: string;
}

/** A local media file read once, with its content hash (reuse key). */
export interface LocalMedia extends MediaFile {
  readonly sha256: string;
}

export interface PublishDeps {
  /** Read a brief media path (resolved against the brief's directory by the caller). */
  readonly readMedia: (path: string) => LocalMedia | Promise<LocalMedia>;
  /** Persist the state; called after every step that changed it. */
  readonly saveState: (state: MetaState) => void | Promise<void>;
}

export interface PublishFailure {
  readonly step: string;
  readonly message: string;
  readonly code?: number | "schema";
}

export interface PublishResult {
  /** The last successfully saved state (the input state when nothing was saved). */
  readonly state: MetaState;
  readonly failure: PublishFailure | null;
}

/** One object a publish would touch, for the dry-run envelope. */
export interface PlannedObject {
  readonly step: PublishStepName;
  /** Object name (media: the brief path). */
  readonly name: string;
  /** Names of the enclosing campaign / ad set, outermost first. */
  readonly parents: readonly string[];
  /** Id already recorded in state, when any. */
  readonly existingId: string | null;
  /** `skip` when state already holds the id; `create` may still adopt a live object by name. */
  readonly action: "create" | "skip";
}

/** The media a creative references, after upload. */
export type CreativeMedia =
  | { readonly kind: "image"; readonly hash: ImageHash }
  | { readonly kind: "video"; readonly videoId: MetaVideoId; readonly thumbnailHash: ImageHash };

/** Two or more live objects share the name the publisher would adopt. */
export class DuplicateNameError extends Error {
  readonly step = "find-existing";
  constructor(message: string) {
    super(message);
    this.name = "DuplicateNameError";
  }
}

const PAUSED = "PAUSED";

// ---------- Pure builders ----------

const nonEmpty = <K extends string, T>(key: K, values: readonly T[]): Partial<Record<K, readonly T[]>> =>
  values.length > 0 ? ({ [key]: values } as Record<K, readonly T[]>) : {};

/** `POST act_<id>/campaigns`. CBO puts budget + bid strategy here; ABO disables budget sharing. */
export function campaignParams(brief: MetaBrief, currency: string): Params {
  const { campaign } = brief;
  return {
    name: campaign.name,
    objective: campaign.objective,
    status: PAUSED,
    special_ad_categories: campaign.specialAdCategories,
    buying_type: "AUCTION",
    ...(campaign.budget.mode === "campaign"
      ? { daily_budget: toMinorUnits(campaign.budget.dailyBudget, currency), bid_strategy: campaign.budget.bidStrategy }
      : { is_adset_budget_sharing_enabled: false }),
  };
}

const GENDER_CODES = { male: 1, female: 2 } as const;

/** Optimization goals whose ad set sends people to a website. */
const WEBSITE_GOALS: ReadonlySet<string> = new Set(["OFFSITE_CONVERSIONS", "LINK_CLICKS", "LANDING_PAGE_VIEWS"]);
const WEBSITE_OBJECTIVES: ReadonlySet<string> = new Set(["OUTCOME_TRAFFIC", "OUTCOME_LEADS", "OUTCOME_SALES"]);

/** Pure: the Graph `targeting` spec for an ad set (placements and Advantage+ audience included). */
export function targetingSpec(adSet: MetaAdSet): Record<string, unknown> {
  const a = adSet.audience;
  const p = adSet.placements;
  return {
    geo_locations: {
      ...nonEmpty("countries", a.countries),
      ...nonEmpty("regions", a.regions.map((r) => ({ key: r.key }))),
      ...nonEmpty(
        "cities",
        a.cities.map((c) => ({
          key: c.key,
          ...(c.radius === undefined ? {} : { radius: c.radius, distance_unit: c.distance_unit }),
        })),
      ),
    },
    age_min: a.ageMin,
    age_max: a.ageMax,
    ...nonEmpty("genders", [...new Set(a.genders)].map((g) => GENDER_CODES[g]).sort()),
    ...nonEmpty("locales", a.locales),
    ...nonEmpty("custom_audiences", a.customAudienceIds.map((id) => ({ id }))),
    ...nonEmpty("excluded_custom_audiences", a.excludedCustomAudienceIds.map((id) => ({ id }))),
    ...(a.interests.length > 0 ? { flexible_spec: [{ interests: a.interests.map((i) => ({ id: i.id, name: i.name })) }] } : {}),
    ...(p === "advantage"
      ? {}
      : {
          publisher_platforms: p.publisherPlatforms,
          ...nonEmpty("facebook_positions", p.facebookPositions),
          ...nonEmpty("instagram_positions", p.instagramPositions),
        }),
    targeting_automation: { advantage_audience: a.advantageAudience ? 1 : 0 },
  };
}

/** `POST act_<id>/adsets`. ABO puts budget + bid strategy here. */
export function adSetParams(brief: MetaBrief, adSet: MetaAdSet, campaignId: MetaCampaignId, currency: string): Params {
  const { budget, objective, startTime } = brief.campaign;
  return {
    campaign_id: campaignId,
    name: adSet.name,
    status: PAUSED,
    optimization_goal: adSet.optimizationGoal,
    billing_event: "IMPRESSIONS",
    ...(WEBSITE_GOALS.has(adSet.optimizationGoal) || WEBSITE_OBJECTIVES.has(objective) ? { destination_type: "WEBSITE" } : {}),
    ...(budget.mode === "adset" && adSet.dailyBudget !== undefined
      ? { daily_budget: toMinorUnits(adSet.dailyBudget, currency), bid_strategy: budget.bidStrategy }
      : {}),
    ...(adSet.bidAmount === undefined ? {} : { bid_amount: toMinorUnits(adSet.bidAmount, currency) }),
    ...(adSet.conversion === undefined
      ? {}
      : { promoted_object: { pixel_id: adSet.conversion.pixelId, custom_event_type: adSet.conversion.event } }),
    targeting: targetingSpec(adSet),
    ...(startTime === undefined ? {} : { start_time: startTime }),
  };
}

/** `POST act_<id>/adcreatives`: a flexible (asset-feed) creative with explicit enhancements. */
export function creativeParams(brief: MetaBrief, ad: MetaAd, pageId: MetaPageId, media: CreativeMedia): Params {
  const features = Object.entries(ad.enhancements).map(([key, status]) => [key, { enroll_status: status }] as const);
  return {
    name: `${brief.campaign.name} / ${ad.name}`,
    object_story_spec: { page_id: pageId },
    asset_feed_spec: {
      bodies: ad.primaryTexts.map((text) => ({ text })),
      titles: ad.headlines.map((text) => ({ text })),
      ...nonEmpty("descriptions", ad.descriptions.map((text) => ({ text }))),
      link_urls: [{ website_url: ad.link }],
      call_to_action_types: [ad.callToAction],
      ...(media.kind === "image"
        ? { images: [{ hash: media.hash }], ad_formats: ["SINGLE_IMAGE"] }
        : { videos: [{ video_id: media.videoId, thumbnail_hash: media.thumbnailHash }], ad_formats: ["SINGLE_VIDEO"] }),
      optimization_type: "DEGREES_OF_FREEDOM",
    },
    ...(features.length > 0 ? { degrees_of_freedom_spec: { creative_features_spec: Object.fromEntries(features) } } : {}),
  };
}

/** `POST act_<id>/ads`. */
export function adParams(ad: MetaAd, adSetId: MetaAdSetId, creativeId: MetaCreativeId): Params {
  return { name: ad.name, adset_id: adSetId, creative: { creative_id: creativeId }, status: PAUSED };
}

// ---------- Pure state helpers ----------

type MediaRole = "image" | "video";

/** Pure: every distinct media path in brief order, with the upload kind it needs. */
export function mediaPaths(brief: MetaBrief): readonly { path: string; role: MediaRole }[] {
  const all = brief.adSets.flatMap((s) =>
    s.ads.flatMap((ad): { path: string; role: MediaRole }[] =>
      "image" in ad.media
        ? [{ path: ad.media.image, role: "image" }]
        : [
            { path: ad.media.video, role: "video" },
            { path: ad.media.thumbnail, role: "image" },
          ],
    ),
  );
  return all.filter((m, i) => all.findIndex((o) => o.path === m.path && o.role === m.role) === i);
}

const mediaId = (m: MetaMediaState | undefined, role: MediaRole): string | null =>
  (role === "image" ? m?.imageHash : m?.videoId) ?? null;

/**
 * Pure: `state` reshaped onto the brief's current ad set / ad names, carrying ids by
 * name, so a brief that gained objects since the last run publishes the new ones.
 */
export function alignState(brief: MetaBrief, state: MetaState): MetaState {
  return {
    ...state,
    campaign: { name: brief.campaign.name, campaignId: state.campaign.campaignId },
    adSets: brief.adSets.map((s): MetaAdSetState => {
      const prev = state.adSets.find((p) => p.name === s.name);
      return {
        name: s.name,
        adSetId: prev?.adSetId ?? null,
        ads: s.ads.map((ad): MetaAdState => {
          const prevAd = prev?.ads.find((p) => p.name === ad.name);
          return { name: ad.name, creativeId: prevAd?.creativeId ?? null, adId: prevAd?.adId ?? null };
        }),
      };
    }),
  };
}

/** Pure: the objects a publish of `brief` over `state` would create or skip, in publish order. */
export function planPublish(brief: MetaBrief, state: MetaState): PlannedObject[] {
  const s = alignState(brief, state);
  const planned = (
    step: PublishStepName,
    name: string,
    parents: readonly string[],
    existingId: string | null,
    done: boolean = existingId !== null,
  ): PlannedObject => ({ step, name, parents, existingId, action: done ? "skip" : "create" });
  const campaign = brief.campaign.name;
  return [
    ...mediaPaths(brief).map((m) => planned("upload-media", m.path, [], mediaId(s.media[m.path], m.role))),
    planned("create-campaign", campaign, [], s.campaign.campaignId),
    ...s.adSets.flatMap((adSet) => [
      planned("create-ad-set", adSet.name, [campaign], adSet.adSetId),
      ...adSet.ads.flatMap((ad) => [
        // An existing ad means its creative exists too (ad ids are saved only after both).
        planned("create-creative", ad.name, [campaign, adSet.name], ad.creativeId, ad.creativeId !== null || ad.adId !== null),
        planned("create-ad", ad.name, [campaign, adSet.name], ad.adId),
      ]),
    ]),
  ];
}

const updateAdSet = (s: MetaState, name: string, f: (a: MetaAdSetState) => MetaAdSetState): MetaState => ({
  ...s,
  adSets: s.adSets.map((a) => (a.name === name ? f(a) : a)),
});

const updateAd = (s: MetaState, adSetName: string, adName: string, f: (a: MetaAdState) => MetaAdState): MetaState =>
  updateAdSet(s, adSetName, (a) => ({ ...a, ads: a.ads.map((ad) => (ad.name === adName ? f(ad) : ad)) }));

/** Internal invariant: earlier steps succeeded, so the id they record is present. */
const required = <T>(value: T | null | undefined, what: string): T => {
  if (value === null || value === undefined) {
    throw new Error(`internal: ${what} missing from state after its step succeeded`);
  }
  return value;
};

const failureOf = (step: string, exc: unknown): PublishFailure =>
  exc instanceof MetaApiError
    ? { step: exc.step, message: exc.message, code: exc.code }
    : exc instanceof MetaConfigError || exc instanceof DuplicateNameError
      ? { step: exc.step, message: exc.message }
      : { step, message: exc instanceof Error ? exc.message : String(exc) };

// ---------- I/O shell ----------

type Step = { readonly name: string; readonly run: (state: MetaState) => Promise<MetaState> };

const NON_LIVE = new Set(["DELETED", "ARCHIVED"]);

// Status is filtered client-side only: Meta already omits DELETED/ARCHIVED by default and
// a `NOT_IN` operator on effective_status is not documented for these edges.
const nameFilter = (name: string): Params => ({
  filtering: [{ field: "name", operator: "EQUAL", value: name }],
});

const CampaignLookupSchema = CampaignSchema.pick({ id: true, name: true, effective_status: true });
const AdSetLookupSchema = AdSetSchema.pick({ id: true, name: true, effective_status: true });
const AdLookupSchema = AdSchema.pick({ id: true, name: true, effective_status: true }).extend({
  creative: AdSchema.shape.creative.pick({ id: true }),
});

/**
 * Find the single live object named exactly `name` under `parentPath`; `null` when none.
 * Filters again client-side (exact name, not DELETED/ARCHIVED) so a loose server match
 * never adopts the wrong object.
 */
const findByName = async <T extends { id: string; name: string; effective_status: string }>(
  client: MetaClient,
  parentPath: string,
  name: string,
  fields: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  kind: string,
): Promise<T | null> => {
  const rows = await client.getAll(parentPath, { fields, ...nameFilter(name) }, schema, { step: "find-existing" });
  const live = rows.filter((r) => r.name === name && !NON_LIVE.has(r.effective_status));
  if (live.length > 1) {
    throw new DuplicateNameError(
      `${live.length} live ${kind}s named "${name}" under ${parentPath} (ids ${live.map((r) => r.id).join(", ")}); ` +
        "rename or delete the duplicates, then re-run",
    );
  }
  return live[0] ?? null;
};

const mediaSteps = (client: MetaClient, ctx: PublishContext, brief: MetaBrief, deps: PublishDeps): Step[] =>
  mediaPaths(brief).map(({ path, role }) => ({
    name: "upload-media",
    run: async (s) => {
      const local = await deps.readMedia(path);
      const current = s.media[path];
      const sameFile = current?.sha256 === local.sha256 ? current : undefined;
      if (mediaId(sameFile, role) !== null) return s;
      const reused = Object.values(s.media).find((m) => m.sha256 === local.sha256 && mediaId(m, role) !== null);
      const file: MediaFile = { name: local.name, bytes: local.bytes };
      const ids: Partial<MetaMediaState> =
        role === "image"
          ? { imageHash: reused?.imageHash ?? (await client.uploadImage(ctx.adAccountId, file, { step: "upload-media" })) }
          : { videoId: reused?.videoId ?? (await client.uploadVideo(ctx.adAccountId, file, { step: "upload-media" })) };
      return { ...s, media: { ...s.media, [path]: { ...sameFile, sha256: local.sha256, ...ids } } };
    },
  }));

const campaignStep = (client: MetaClient, ctx: PublishContext, brief: MetaBrief): Step => ({
  name: "create-campaign",
  run: async (s) => {
    if (s.campaign.campaignId !== null) return s;
    const found = await findByName(client, `${ctx.adAccountId}/campaigns`, brief.campaign.name, "id,name,effective_status", CampaignLookupSchema, "campaign");
    const id =
      found?.id ??
      (await client.post(`${ctx.adAccountId}/campaigns`, campaignParams(brief, ctx.currency), createdIdSchema(MetaCampaignIdSchema), {
        step: "create-campaign",
      })).id;
    return { ...s, campaign: { ...s.campaign, campaignId: id } };
  },
});

const adSetStep = (client: MetaClient, ctx: PublishContext, brief: MetaBrief, adSet: MetaAdSet): Step => ({
  name: "create-ad-set",
  run: async (s) => {
    const entry = required(s.adSets.find((a) => a.name === adSet.name), `ad set "${adSet.name}"`);
    if (entry.adSetId !== null) return s;
    const campaignId = required(s.campaign.campaignId, "campaign id");
    const found = await findByName(client, `${campaignId}/adsets`, adSet.name, "id,name,effective_status", AdSetLookupSchema, "ad set");
    const id =
      found?.id ??
      (await client.post(`${ctx.adAccountId}/adsets`, adSetParams(brief, adSet, campaignId, ctx.currency), createdIdSchema(MetaAdSetIdSchema), {
        step: "create-ad-set",
      })).id;
    return updateAdSet(s, adSet.name, (a) => ({ ...a, adSetId: id }));
  },
});

const creativeMedia = (s: MetaState, ad: MetaAd): CreativeMedia =>
  "image" in ad.media
    ? { kind: "image", hash: required(s.media[ad.media.image]?.imageHash, `image hash for ${ad.media.image}`) }
    : {
        kind: "video",
        videoId: required(s.media[ad.media.video]?.videoId, `video id for ${ad.media.video}`),
        thumbnailHash: required(s.media[ad.media.thumbnail]?.imageHash, `image hash for ${ad.media.thumbnail}`),
      };

const adSteps = (client: MetaClient, ctx: PublishContext, brief: MetaBrief, adSet: MetaAdSet, ad: MetaAd): Step[] => {
  const entry = (s: MetaState): MetaAdState =>
    required(s.adSets.find((a) => a.name === adSet.name)?.ads.find((a) => a.name === ad.name), `ad "${ad.name}"`);
  const adSetId = (s: MetaState): MetaAdSetId => required(s.adSets.find((a) => a.name === adSet.name)?.adSetId, `ad set id for "${adSet.name}"`);
  return [
    {
      // Look the ad up first: a live ad (create-ad succeeded, save failed) carries its creative id too.
      name: "create-creative",
      run: async (s) => {
        const current = entry(s);
        if (current.adId !== null || current.creativeId !== null) return s;
        const found = await findByName(client, `${adSetId(s)}/ads`, ad.name, "id,name,effective_status,creative{id}", AdLookupSchema, "ad");
        if (found !== null) {
          return updateAd(s, adSet.name, ad.name, (a) => ({ ...a, adId: found.id, creativeId: found.creative.id }));
        }
        const { id } = await client.post(
          `${ctx.adAccountId}/adcreatives`,
          creativeParams(brief, ad, ctx.pageId, creativeMedia(s, ad)),
          createdIdSchema(MetaCreativeIdSchema),
          { step: "create-creative" },
        );
        return updateAd(s, adSet.name, ad.name, (a) => ({ ...a, creativeId: id }));
      },
    },
    {
      name: "create-ad",
      run: async (s) => {
        const current = entry(s);
        if (current.adId !== null) return s;
        const creativeId = required(current.creativeId, `creative id for "${ad.name}"`);
        const found = await findByName(client, `${adSetId(s)}/ads`, ad.name, "id,name,effective_status,creative{id}", AdLookupSchema, "ad");
        const id =
          found?.id ??
          (await client.post(`${ctx.adAccountId}/ads`, adParams(ad, adSetId(s), creativeId), createdIdSchema(MetaAdIdSchema), {
            step: "create-ad",
          })).id;
        return updateAd(s, adSet.name, ad.name, (a) => ({ ...a, adId: id }));
      },
    },
  ];
};

/** Pure: the ordered publish steps for `brief`. */
const publishSteps = (client: MetaClient, ctx: PublishContext, brief: MetaBrief, deps: PublishDeps): Step[] => [
  ...mediaSteps(client, ctx, brief, deps),
  campaignStep(client, ctx, brief),
  ...brief.adSets.flatMap((adSet) => [
    adSetStep(client, ctx, brief, adSet),
    ...adSet.ads.flatMap((ad) => adSteps(client, ctx, brief, adSet, ad)),
  ]),
];

/**
 * Publish `brief` over `state`, saving state after every step that changed it. Never
 * throws for a step failure: the first one stops the run and is returned alongside the
 * last saved state.
 */
export async function publishMeta(
  client: MetaClient,
  ctx: PublishContext,
  brief: MetaBrief,
  state: MetaState,
  deps: PublishDeps,
): Promise<PublishResult> {
  if (state.adAccountId !== ctx.adAccountId) {
    return {
      state,
      failure: {
        step: "state",
        message: `state belongs to ad account ${state.adAccountId}, but this publish targets ${ctx.adAccountId}`,
      },
    };
  }
  const runStep = async (step: Step, s: MetaState): Promise<PublishResult> => {
    const outcome = await step.run(s).then(
      (next) => ({ kind: "ok", next }) as const,
      (exc: unknown) => ({ kind: "err", failure: failureOf(step.name, exc) }) as const,
    );
    if (outcome.kind === "err") return { state: s, failure: outcome.failure };
    const { next } = outcome;
    if (next === s) return { state: s, failure: null };
    return Promise.resolve()
      .then(() => deps.saveState(next))
      .then(
      (): PublishResult => ({ state: next, failure: null }),
      (exc: unknown): PublishResult => ({ state: s, failure: failureOf("save-state", exc) }),
    );
  };
  return publishSteps(client, ctx, brief, deps).reduce<Promise<PublishResult>>(
    (acc, step) => acc.then((r) => (r.failure !== null ? r : runStep(step, r.state))),
    Promise.resolve({ state: alignState(brief, state), failure: null }),
  );
}
