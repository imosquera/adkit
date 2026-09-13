/**
 * Applying a Meta update plan (`ads.sh update <plan.yaml> [--apply]`, plan D8).
 *
 * I/O edge:
 * - {@link readLiveState} — batched `?ids=` multi-gets for exactly the campaigns, ad
 *   sets and ads a plan references (plus the ad sets whose delivery those changes
 *   affect, which the learning-reset warning needs), and the account currency.
 * - {@link applyStatus}, {@link applyBudget}, {@link applyExclusions},
 *   {@link applyCreativeSwap} — one Graph write per step; a creative swap merges an ad's
 *   enhancement and text-pool entries into one step of two writes (create, re-point).
 * - {@link runMetaApply} — a sequential fold over the ordered steps; every step is
 *   isolated, so one failure is recorded and the run continues (FR-015).
 *
 * Pure core:
 * - {@link planMetaApplySteps} — the write order: pause → budgets → exclusions →
 *   creative swaps → enable.
 * - {@link buildSwapCreativeParams} — the new creative derived from the live one.
 * - {@link resolveMetaPlanGroups} / {@link applyMetaPlanToBrief} — stage the plan
 *   onto the intent briefs it touches, located through `.meta-state.yaml`.
 *
 * Status changes are deliberately not staged into briefs: a brief is intent, and
 * `create` always publishes every object `PAUSED` (SC-003), so there is no brief
 * field a live status could round-trip into.
 */

import { z } from "zod";

import type { MetaClient } from "./client.js";
import type { Enhancements, MetaBrief } from "./brief.js";
import { MetaApiError, MetaConfigError, formatMetaError } from "./errors.js";
import {
  AdSchema,
  AdSetSchema,
  CampaignSchema,
  SuccessSchema,
  createdIdSchema,
  multiGetSchema,
  type AdCreative,
  type AdSet,
  type Campaign,
} from "./graph.js";
import {
  MetaCreativeIdSchema,
  err,
  ok,
  type MetaAdAccountId,
  type MetaAdId,
  type MetaCreativeId,
  type Result,
} from "./ids.js";
import { toMinorUnits } from "./money.js";
import type {
  MetaBudgetChange,
  MetaEnhancementChange,
  MetaExclusionChange,
  MetaLiveAd,
  MetaLiveState,
  MetaPlanSections,
  MetaStatusChange,
  MetaTextPoolChange,
} from "./plan.js";
import type { MetaCreativeSwap, MetaStateIndex, MetaStateLocator } from "./state.js";

// ---------- Live reads ----------

/** Graph caps `?ids=` multi-gets at 50 ids per request. */
export const MULTI_GET_MAX_IDS = 50;

export const CAMPAIGN_FIELDS =
  "id,name,objective,effective_status,status,daily_budget,lifetime_budget,bid_strategy,advantage_state_info";
export const AD_SET_FIELDS =
  "id,name,campaign_id,effective_status,status,optimization_goal,daily_budget,lifetime_budget,bid_strategy," +
  "targeting,learning_stage_info,campaign{id,advantage_state_info}";
export const AD_FIELDS =
  "id,name,adset_id,campaign_id,effective_status,status," +
  "creative{id,name,object_story_spec,asset_feed_spec,degrees_of_freedom_spec}";

/** Graph code 803: "some of the aliases you requested do not exist". */
const UNKNOWN_ALIAS_CODE = 803;
/** Graph code 100 is any invalid parameter; only with subcode 33 does it mean "object does not exist / not visible". */
const INVALID_PARAM_CODE = 100;
const OBJECT_NOT_FOUND_SUBCODE = 33;

/**
 * An error meaning "this id does not exist or is not visible" — 803, or 100/33. Every
 * other code 100 (a bad field, a permission problem) is a real failure and is rethrown.
 */
export const isMissingObject = (e: unknown): boolean =>
  e instanceof MetaApiError &&
  (e.code === UNKNOWN_ALIAS_CODE || (e.code === INVALID_PARAM_CODE && e.subcode === OBJECT_NOT_FOUND_SUBCODE));

const uniqueIds = <T extends string>(ids: readonly T[]): T[] => [...new Set(ids)];

const chunks = <T>(xs: readonly T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(xs.length / size) }, (_, i) => xs.slice(i * size, (i + 1) * size));

/** Pure: the ids each entity type a plan references directly. */
export function referencedIds(plan: MetaPlanSections): { campaigns: string[]; adSets: string[]; ads: string[] } {
  const leveled = [...plan.budgets, ...plan.status];
  return {
    campaigns: uniqueIds(leveled.flatMap((e) => (e.level === "campaign" ? [e.id] : []))),
    adSets: uniqueIds([...leveled.flatMap((e) => (e.level === "adset" ? [e.id] : [])), ...plan.exclusions.map((e) => e.adSetId)]),
    ads: uniqueIds([
      ...plan.status.flatMap((e) => (e.level === "ad" ? [e.id] : [])),
      ...plan.enhancements.map((e) => e.adId),
      ...plan.textPools.map((e) => e.adId),
    ]),
  };
}

/**
 * Multi-get `ids` through `item`. Ids Graph does not know are left out of the
 * result (validation reports them): a multi-get that fails with a missing-object code
 * is retried one id at a time, skipping the ids that fail the same way.
 */
async function readMany<T>(
  client: MetaClient,
  ids: readonly string[],
  fields: string,
  item: z.ZodType<T, z.ZodTypeDef, unknown>,
  step: string,
): Promise<T[]> {
  const readChunk = async (chunk: readonly string[]): Promise<T[]> => {
    try {
      const res: Record<string, T | undefined> = await client.get("", { ids: chunk.join(","), fields }, multiGetSchema(item), {
        step,
      });
      return chunk.flatMap((id) => {
        const found = res[id];
        return found === undefined ? [] : [found];
      });
    } catch (e) {
      if (!isMissingObject(e)) throw e;
      return chunk.length === 1 ? [] : (await Promise.all(chunk.map((id) => readChunk([id])))).flat();
    }
  };
  const results = await Promise.all(chunks(ids, MULTI_GET_MAX_IDS).map(readChunk));
  return results.flat();
}

const byId = <T extends { id: string }>(xs: readonly T[]): ReadonlyMap<string, T> => new Map(xs.map((x) => [x.id, x]));

/**
 * Read the live state a plan needs: referenced ads (with their creative), campaigns,
 * ad sets — including the parent ad set of every referenced ad and the child ad sets
 * of every campaign whose budget changes (learning-reset warnings) — and the account
 * currency for minor-unit conversion.
 */
export async function readLiveState(
  client: MetaClient,
  plan: MetaPlanSections,
  adAccountId: MetaAdAccountId,
): Promise<MetaLiveState> {
  const ref = referencedIds(plan);
  const step = "read-live";
  const [account, ads, campaigns] = await Promise.all([
    client.get(adAccountId, { fields: "currency" }, z.object({ currency: z.string() }), { step }),
    readMany<MetaLiveAd>(client, ref.ads, AD_FIELDS, AdSchema, step),
    readMany<Campaign>(client, ref.campaigns, CAMPAIGN_FIELDS, CampaignSchema, step),
  ]);
  const budgetCampaigns = uniqueIds(plan.budgets.flatMap((e) => (e.level === "campaign" ? [e.id] : [])));
  const [directAdSets, childAdSets] = await Promise.all([
    readMany<AdSet>(client, uniqueIds([...ref.adSets, ...ads.map((a) => a.adset_id)]), AD_SET_FIELDS, AdSetSchema, step),
    Promise.all(
      budgetCampaigns
        .filter((id) => campaigns.some((c) => c.id === id))
        .map((id) => client.getAll(`${id}/adsets`, { fields: AD_SET_FIELDS, limit: 100 }, AdSetSchema, { step })),
    ),
  ]);
  return {
    campaigns: byId(campaigns),
    adSets: byId([...childAdSets.flat(), ...directAdSets]),
    ads: byId(ads),
    currency: account.currency,
  };
}

// ---------- Pure: creative swap parameters ----------

/** The change a creative swap applies; at least one of the two is present. */
export type CreativeSwapChange = {
  readonly features?: Enhancements;
  readonly textPools?: Pick<MetaTextPoolChange, "primaryTexts" | "headlines" | "descriptions">;
};

/** Body for `POST act_<id>/adcreatives`. */
export type SwapCreativeParams = {
  readonly name: string;
  readonly object_story_spec?: NonNullable<AdCreative["object_story_spec"]>;
  readonly asset_feed_spec?: NonNullable<AdCreative["asset_feed_spec"]>;
  readonly degrees_of_freedom_spec?: NonNullable<AdCreative["degrees_of_freedom_spec"]>;
};

const ADKIT_SUFFIX = / \(adkit \d{4}-\d{2}-\d{2}\)$/;

/** Pure: `<live name> (adkit <YYYY-MM-DD>)`, replacing an earlier adkit suffix instead of stacking. */
export const swapCreativeName = (liveName: string, now: Date): string =>
  `${liveName.replace(ADKIT_SUFFIX, "")} (adkit ${now.toISOString().slice(0, 10)})`;

const texts = (pool: readonly string[] | undefined): { text: string }[] | undefined => pool?.map((text) => ({ text }));

/**
 * Pure: the new creative for an ad — the live `object_story_spec` and `asset_feed_spec`
 * (given text pools replaced, omitted pools untouched) and `degrees_of_freedom_spec`
 * with the requested enroll statuses merged over the live ones. Fails when text pools
 * are requested for a creative that has no `asset_feed_spec` (not a flexible creative).
 */
export function buildSwapCreativeParams(
  ad: Pick<MetaLiveAd, "name" | "creative">,
  change: CreativeSwapChange,
  now: Date,
): Result<SwapCreativeParams> {
  const creative = ad.creative;
  if (creative === undefined) {
    return err(`ad "${ad.name}": live creative was not read`);
  }
  const feed = creative.asset_feed_spec;
  const pools = change.textPools;
  if (pools !== undefined && feed === undefined) {
    return err(`ad "${ad.name}": creative ${creative.id} has no asset_feed_spec; text pools apply only to flexible creatives`);
  }
  const newFeed =
    feed === undefined || pools === undefined
      ? feed
      : {
          ...feed,
          ...(pools.primaryTexts === undefined ? {} : { bodies: texts(pools.primaryTexts) }),
          ...(pools.headlines === undefined ? {} : { titles: texts(pools.headlines) }),
          ...(pools.descriptions === undefined ? {} : { descriptions: texts(pools.descriptions) }),
        };
  const dof = creative.degrees_of_freedom_spec;
  const features = change.features;
  const newDof =
    features === undefined
      ? dof
      : {
          ...dof,
          creative_features_spec: {
            ...dof?.creative_features_spec,
            ...Object.fromEntries(
              Object.entries(features).map(([k, v]) => [k, { ...dof?.creative_features_spec?.[k], enroll_status: v }]),
            ),
          },
        };
  return ok({
    name: swapCreativeName(creative.name ?? ad.name, now),
    ...(creative.object_story_spec === undefined ? {} : { object_story_spec: creative.object_story_spec }),
    ...(newFeed === undefined ? {} : { asset_feed_spec: newFeed }),
    ...(newDof === undefined ? {} : { degrees_of_freedom_spec: newDof }),
  });
}

/** Pure: the ad set's excluded audience ids after removing `remove` and appending new `add` ids. */
export const mergeExclusions = (live: readonly { id: string }[], change: MetaExclusionChange): string[] => {
  const kept = live.map((a) => a.id).filter((id) => !change.remove.some((r) => r === id));
  return [...kept, ...change.add.filter((id) => !kept.includes(id))];
};

// ---------- Appliers (one entry, I/O) ----------

export const APPLY_STEPS = {
  status: "status",
  budget: "budget",
  exclusions: "exclusions",
  creativeSwap: "creative-swap",
} as const;

/** `POST /<id> { status }`. */
export async function applyStatus(client: MetaClient, change: MetaStatusChange): Promise<void> {
  await client.post(change.id, { status: change.status }, SuccessSchema, { step: APPLY_STEPS.status });
}

/** `POST /<id> { daily_budget }` in the account currency's minor units. */
export async function applyBudget(client: MetaClient, change: MetaBudgetChange, currency: string): Promise<void> {
  await client.post(change.id, { daily_budget: toMinorUnits(change.dailyBudget, currency) }, SuccessSchema, {
    step: APPLY_STEPS.budget,
  });
}

/**
 * `POST /<ad-set-id> { targeting }` with the full live targeting and
 * `excluded_custom_audiences` replaced by the merged list (Graph replaces targeting
 * wholesale, so every other live key is sent back unchanged). An empty merged list
 * drops the key.
 */
export async function applyExclusions(client: MetaClient, change: MetaExclusionChange, adSet: AdSet): Promise<void> {
  const merged = mergeExclusions(adSet.targeting.excluded_custom_audiences ?? [], change);
  const { excluded_custom_audiences: _dropped, ...rest } = adSet.targeting;
  const targeting = merged.length === 0 ? rest : { ...rest, excluded_custom_audiences: merged.map((id) => ({ id })) };
  await client.post(change.adSetId, { targeting }, SuccessSchema, { step: APPLY_STEPS.exclusions });
}

/**
 * Create a new creative from the live one plus `change` (`POST act_<id>/adcreatives`),
 * then point the ad at it (`POST /<ad-id> { creative: { creative_id } }`). Returns the
 * new creative id. When the re-point fails, the rethrown error names the created
 * creative so the orphan is not lost.
 */
export async function applyCreativeSwap(
  client: MetaClient,
  adAccountId: MetaAdAccountId,
  ad: MetaLiveAd,
  change: CreativeSwapChange,
  now: Date,
): Promise<MetaCreativeId> {
  const step = APPLY_STEPS.creativeSwap;
  const params = buildSwapCreativeParams(ad, change, now);
  if (params.kind === "err") {
    throw new MetaApiError({ step, code: "schema", message: params.message });
  }
  const { id } = await client.post(`${adAccountId}/adcreatives`, params.value, createdIdSchema(MetaCreativeIdSchema), { step });
  try {
    await client.post(ad.id, { creative: { creative_id: id } }, SuccessSchema, { step });
  } catch (e) {
    if (!(e instanceof MetaApiError)) throw e;
    throw new MetaApiError({
      step: e.step,
      code: e.code,
      subcode: e.subcode,
      userTitle: e.userTitle,
      userMessage: e.userMessage,
      fbtraceId: e.fbtraceId,
      issues: e.issues,
      message: `created creative ${id} but could not attach it to ad ${ad.id}: ${e.message}`,
    });
  }
  return id;
}

// ---------- Orchestration ----------

export type MetaPlanSection = keyof MetaPlanSections;

export type MetaApplyStepKind = "pause-status" | "budget" | "exclusions" | "creative-swap" | "enable-status";

/** Default write order: pausing first and enabling last keeps spend from starting mid-plan. */
export const META_APPLY_ORDER: readonly MetaApplyStepKind[] = [
  "pause-status",
  "budget",
  "exclusions",
  "creative-swap",
  "enable-status",
];

/** One isolated write unit. A swap merges an ad's enhancement and text-pool changes into one new creative. */
export type MetaApplyStep =
  | { readonly kind: "pause-status" | "enable-status"; readonly change: MetaStatusChange }
  | { readonly kind: "budget"; readonly change: MetaBudgetChange }
  | { readonly kind: "exclusions"; readonly change: MetaExclusionChange }
  | {
      readonly kind: "creative-swap";
      readonly adId: MetaAdId;
      readonly enhancement?: MetaEnhancementChange;
      readonly textPool?: MetaTextPoolChange;
    };

/** Pure: the plan's changes as isolated steps, ordered by `order` (plan order within a kind). */
export function planMetaApplySteps(
  changes: MetaPlanSections,
  order: readonly MetaApplyStepKind[] = META_APPLY_ORDER,
): MetaApplyStep[] {
  const swapAdIds = uniqueIds([...changes.enhancements.map((e) => e.adId), ...changes.textPools.map((e) => e.adId)]);
  const byKind: Record<MetaApplyStepKind, MetaApplyStep[]> = {
    "pause-status": changes.status.filter((c) => c.status === "PAUSED").map((change) => ({ kind: "pause-status", change })),
    budget: changes.budgets.map((change) => ({ kind: "budget", change })),
    exclusions: changes.exclusions.map((change) => ({ kind: "exclusions", change })),
    "creative-swap": swapAdIds.map((adId) => ({
      kind: "creative-swap",
      adId,
      enhancement: changes.enhancements.find((e) => e.adId === adId),
      textPool: changes.textPools.find((e) => e.adId === adId),
    })),
    "enable-status": changes.status.filter((c) => c.status === "ACTIVE").map((change) => ({ kind: "enable-status", change })),
  };
  return order.flatMap((kind) => byKind[kind]);
}

export type MetaApplyContext = {
  readonly adAccountId: MetaAdAccountId;
  readonly live: MetaLiveState;
  /** Clock for the swapped creative's name; injected for determinism. */
  readonly now: Date;
};

export type MetaApplied = { readonly section: MetaPlanSection; readonly entityId: string };
export type MetaApplyError = { readonly step: string; readonly entityId: string; readonly message: string };
export type MetaApplyResult = {
  readonly applied: MetaApplied[];
  readonly errors: MetaApplyError[];
  /** The new creative of every successful creative swap, for rewriting `.meta-state.yaml`. */
  readonly creativeSwaps: MetaCreativeSwap[];
};

const stepLabel = (s: MetaApplyStep): string =>
  s.kind === "pause-status" || s.kind === "enable-status" ? APPLY_STEPS.status : s.kind;

const stepEntityId = (s: MetaApplyStep): string =>
  s.kind === "creative-swap" ? s.adId : s.kind === "exclusions" ? s.change.adSetId : s.change.id;

const stepSections = (s: MetaApplyStep): MetaPlanSection[] =>
  s.kind === "creative-swap"
    ? [...(s.enhancement ? (["enhancements"] as const) : []), ...(s.textPool ? (["textPools"] as const) : [])]
    : s.kind === "budget"
      ? ["budgets"]
      : s.kind === "exclusions"
        ? ["exclusions"]
        : ["status"];

const missing = (step: string, what: string, id: string): MetaApiError =>
  new MetaApiError({ step, code: "schema", message: `${what} ${id} not found in live state` });

/** Execute one step (throws on failure); a creative swap returns the swap it made, other steps `null`. */
async function runStep(client: MetaClient, ctx: MetaApplyContext, s: MetaApplyStep): Promise<MetaCreativeSwap | null> {
  switch (s.kind) {
    case "pause-status":
    case "enable-status":
      await applyStatus(client, s.change);
      return null;
    case "budget":
      await applyBudget(client, s.change, ctx.live.currency);
      return null;
    case "exclusions": {
      const adSet = ctx.live.adSets.get(s.change.adSetId);
      if (adSet === undefined) throw missing(APPLY_STEPS.exclusions, "ad set", s.change.adSetId);
      await applyExclusions(client, s.change, adSet);
      return null;
    }
    case "creative-swap": {
      const ad = ctx.live.ads.get(s.adId);
      if (ad === undefined) throw missing(APPLY_STEPS.creativeSwap, "ad", s.adId);
      const creativeId = await applyCreativeSwap(
        client,
        ctx.adAccountId,
        ad,
        {
          ...(s.enhancement === undefined ? {} : { features: s.enhancement.features }),
          ...(s.textPool === undefined ? {} : { textPools: s.textPool }),
        },
        ctx.now,
      );
      return { adId: s.adId, creativeId };
    }
  }
}

/** A failure that belongs to one entry (Graph or config); anything else is a programming error. */
const isEntryFailure = (e: unknown): boolean => e instanceof MetaApiError || e instanceof MetaConfigError;

/**
 * Apply `changes` in `order`, one step at a time. Each step is isolated: a Meta API or
 * config failure is recorded as `{ step, entityId, message }` and the fold moves on to
 * the next step; any other exception propagates.
 * Every successful creative swap is also reported as `{ adId, creativeId }`.
 */
export async function runMetaApply(
  client: MetaClient,
  ctx: MetaApplyContext,
  changes: MetaPlanSections,
  order: readonly MetaApplyStepKind[] = META_APPLY_ORDER,
): Promise<MetaApplyResult> {
  return planMetaApplySteps(changes, order).reduce<Promise<MetaApplyResult>>(async (prev, s) => {
    const acc = await prev;
    const entityId = stepEntityId(s);
    try {
      const swap = await runStep(client, ctx, s);
      return {
        ...acc,
        applied: [...acc.applied, ...stepSections(s).map((section) => ({ section, entityId }))],
        creativeSwaps: swap === null ? acc.creativeSwaps : [...acc.creativeSwaps, swap],
      };
    } catch (e) {
      if (!isEntryFailure(e)) throw e;
      return { ...acc, errors: [...acc.errors, { step: stepLabel(s), entityId, message: formatMetaError(e) }] };
    }
  }, Promise.resolve({ applied: [], errors: [], creativeSwaps: [] }));
}

// ---------- Staging onto briefs ----------

type Located<E> = { readonly entry: E; readonly locator: MetaStateLocator };

/** The brief-relevant plan entries that live in one brief (`adbriefs/<slug>.yaml`). */
export type MetaPlanGroup = {
  readonly slug: string;
  readonly budgets: readonly Located<MetaBudgetChange>[];
  readonly exclusions: readonly Located<MetaExclusionChange>[];
  readonly enhancements: readonly Located<MetaEnhancementChange>[];
  readonly textPools: readonly Located<MetaTextPoolChange>[];
};

export type MetaPlanGroups = {
  readonly groups: MetaPlanGroup[];
  /** Plan ids with no `.meta-state.yaml` entry (objects not created by adkit); reported, not fatal. */
  readonly unresolvedPlanIds: string[];
};

/**
 * Pure: group the brief-relevant sections (budgets, exclusions, enhancements, text
 * pools) by the brief slug their live id maps to. Status entries are not grouped:
 * statuses are not stored in briefs (see module doc).
 */
export function resolveMetaPlanGroups(plan: MetaPlanSections, index: MetaStateIndex): MetaPlanGroups {
  const locate = <E>(entries: readonly E[], lookup: (e: E) => [ReadonlyMap<string, MetaStateLocator>, string]) =>
    entries.map((entry) => {
      const [map, id] = lookup(entry);
      return { entry, id, locator: map.get(id) };
    });
  const budgets = locate(plan.budgets, (e) => [e.level === "campaign" ? index.byCampaignId : index.byAdSetId, e.id]);
  const exclusions = locate(plan.exclusions, (e) => [index.byAdSetId, e.adSetId]);
  const enhancements = locate(plan.enhancements, (e) => [index.byAdId, e.adId]);
  const textPools = locate(plan.textPools, (e) => [index.byAdId, e.adId]);

  const all = [...budgets, ...exclusions, ...enhancements, ...textPools];
  const inSlug =
    <E>(slug: string) =>
    (xs: readonly { entry: E; locator: MetaStateLocator | undefined }[]): Located<E>[] =>
      xs.flatMap((x) => (x.locator?.slug === slug ? [{ entry: x.entry, locator: x.locator }] : []));
  const slugs = uniqueIds(all.flatMap((x) => (x.locator === undefined ? [] : [x.locator.slug])));
  return {
    groups: slugs.map((slug) => ({
      slug,
      budgets: inSlug<MetaBudgetChange>(slug)(budgets),
      exclusions: inSlug<MetaExclusionChange>(slug)(exclusions),
      enhancements: inSlug<MetaEnhancementChange>(slug)(enhancements),
      textPools: inSlug<MetaTextPoolChange>(slug)(textPools),
    })),
    unresolvedPlanIds: uniqueIds(all.flatMap((x) => (x.locator === undefined ? [x.id] : []))),
  };
}

type AdSetEdit = (s: MetaBrief["adSets"][number]) => MetaBrief["adSets"][number];
type AdEdit = (a: MetaBrief["adSets"][number]["ads"][number]) => MetaBrief["adSets"][number]["ads"][number];

const editAdSet = (brief: MetaBrief, adSetName: string | undefined, edit: AdSetEdit): MetaBrief => ({
  ...brief,
  adSets: brief.adSets.map((s) => (s.name === adSetName ? edit(s) : s)),
});

const editAd = (brief: MetaBrief, loc: MetaStateLocator, edit: AdEdit): MetaBrief =>
  editAdSet(brief, loc.adSetName, (s) => ({ ...s, ads: s.ads.map((a) => (a.name === loc.adName ? edit(a) : a)) }));

/**
 * Pure: `brief` with a group's changes written back as intent — campaign (CBO) or ad
 * set (ABO) daily budgets, ad set excluded audiences, ad enhancement choices (merged
 * per key) and replaced text pools — matched by the names in each entry's locator.
 * Entries whose names are absent from the brief, or whose budget level contradicts the
 * brief's budget mode, leave it unchanged. Statuses are never stored (module doc).
 */
export function applyMetaPlanToBrief(brief: MetaBrief, group: MetaPlanGroup): MetaBrief {
  const budgetEdits = group.budgets.map(
    ({ entry, locator }) =>
      (b: MetaBrief): MetaBrief =>
        entry.level === "campaign"
          ? b.campaign.budget.mode === "campaign"
            ? { ...b, campaign: { ...b.campaign, budget: { ...b.campaign.budget, dailyBudget: entry.dailyBudget } } }
            : b
          : b.campaign.budget.mode === "adset"
            ? editAdSet(b, locator.adSetName, (s) => ({ ...s, dailyBudget: entry.dailyBudget }))
            : b,
  );
  const exclusionEdits = group.exclusions.map(
    ({ entry, locator }) =>
      (b: MetaBrief): MetaBrief =>
        editAdSet(b, locator.adSetName, (s) => {
          const kept = s.audience.excludedCustomAudienceIds.filter((id) => !entry.remove.includes(id));
          return {
            ...s,
            audience: {
              ...s.audience,
              excludedCustomAudienceIds: [...kept, ...entry.add.filter((id) => !kept.includes(id))],
            },
          };
        }),
  );
  const enhancementEdits = group.enhancements.map(
    ({ entry, locator }) =>
      (b: MetaBrief): MetaBrief =>
        editAd(b, locator, (a) => ({ ...a, enhancements: { ...a.enhancements, ...entry.features } })),
  );
  const textPoolEdits = group.textPools.map(
    ({ entry, locator }) =>
      (b: MetaBrief): MetaBrief =>
        editAd(b, locator, (a) => ({
          ...a,
          primaryTexts: entry.primaryTexts ?? a.primaryTexts,
          headlines: entry.headlines ?? a.headlines,
          descriptions: entry.descriptions ?? a.descriptions,
        })),
  );
  return [...budgetEdits, ...exclusionEdits, ...enhancementEdits, ...textPoolEdits].reduce((b, edit) => edit(b), brief);
}
