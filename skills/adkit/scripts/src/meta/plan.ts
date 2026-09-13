/**
 * The Meta update plan (`ads.sh update <plan.yaml>` with `platform: meta`, plan D8):
 * budgets, statuses, ad set audience exclusions, Advantage+ creative enhancements and
 * flexible-creative text pools, keyed by live Graph ids.
 *
 * This module is the pure core of `update`:
 * - {@link parseMetaPlan} is the single trust boundary (strict zod, the brief's text
 *   limits and enhancement keys). A `MetaPlan` is the proof downstream code relies on.
 * - {@link splitChanges} / {@link splitMetaPlan} drop entries the live state already
 *   satisfies (FR-013 skip-if-unchanged).
 * - {@link validateMetaPlan} rejects changes that cannot or must not be applied.
 * - {@link metaWarnings} flags spend, learning-reset and ignored-exclusion risks (FR-014).
 *
 * Plan budgets are decimal currency (`dailyBudget: 80`); live budgets are the
 * account's minor units, so every comparison converts through `meta/money.ts`.
 */

import { z, type ZodIssue } from "zod";

import { MAX_RAISE_PCT_CAP } from "../fixes/plan.js";
import { DescriptionsSchema, EnhancementsSchema, HeadlinesSchema, PrimaryTextsSchema } from "./brief.js";
import type { Ad, AdCreative, AdSet, Campaign } from "./graph.js";
import {
  err,
  MetaAdAccountIdSchema,
  MetaAdIdSchema,
  MetaAdSetIdSchema,
  MetaCampaignIdSchema,
  MetaCustomAudienceIdSchema,
  ok,
  type Result,
} from "./ids.js";
import { toMinorUnits } from "./money.js";

// ---------- Constants ----------

/** Budget raises above this percentage are rejected (mirrors Google's guardrail). */
export const META_MAX_BUDGET_RAISE_PCT = MAX_RAISE_PCT_CAP;

/** A budget change larger than this percentage on a learning ad set risks a learning reset. */
export const LEARNING_RESET_BUDGET_PCT = 20;

export const META_PLAN_STATUSES = ["ACTIVE", "PAUSED"] as const;
export type MetaPlanStatus = (typeof META_PLAN_STATUSES)[number];

// ---------- Section schemas ----------

export const MetaBudgetChangeSchema = z.discriminatedUnion("level", [
  z.object({ level: z.literal("campaign"), id: MetaCampaignIdSchema, dailyBudget: z.number().gt(0) }).strict(),
  z.object({ level: z.literal("adset"), id: MetaAdSetIdSchema, dailyBudget: z.number().gt(0) }).strict(),
]);
export type MetaBudgetChange = z.infer<typeof MetaBudgetChangeSchema>;

const status = z.enum(META_PLAN_STATUSES);

export const MetaStatusChangeSchema = z.discriminatedUnion("level", [
  z.object({ level: z.literal("campaign"), id: MetaCampaignIdSchema, status }).strict(),
  z.object({ level: z.literal("adset"), id: MetaAdSetIdSchema, status }).strict(),
  z.object({ level: z.literal("ad"), id: MetaAdIdSchema, status }).strict(),
]);
export type MetaStatusChange = z.infer<typeof MetaStatusChangeSchema>;

const audienceIds = z.array(MetaCustomAudienceIdSchema).default([]);

export const MetaExclusionChangeSchema = z
  .object({ adSetId: MetaAdSetIdSchema, add: audienceIds, remove: audienceIds })
  .strict()
  .refine((e) => e.add.length + e.remove.length > 0, { message: "exclusions entry needs add or remove" })
  .refine((e) => !e.add.some((id) => e.remove.includes(id)), {
    message: "an audience cannot be both added and removed",
  });
export type MetaExclusionChange = z.infer<typeof MetaExclusionChangeSchema>;

export const MetaEnhancementChangeSchema = z
  .object({ adId: MetaAdIdSchema, features: EnhancementsSchema })
  .strict()
  .refine((e) => Object.keys(e.features).length > 0, { message: "enhancements entry needs at least one feature" });
export type MetaEnhancementChange = z.infer<typeof MetaEnhancementChangeSchema>;

/** Omitted pools are left unchanged; at least one pool must be given. */
export const MetaTextPoolChangeSchema = z
  .object({
    adId: MetaAdIdSchema,
    primaryTexts: PrimaryTextsSchema.optional(),
    headlines: HeadlinesSchema.optional(),
    descriptions: DescriptionsSchema.optional(),
  })
  .strict()
  .refine((e) => e.primaryTexts !== undefined || e.headlines !== undefined || e.descriptions !== undefined, {
    message: "textPools entry needs primaryTexts, headlines or descriptions",
  });
export type MetaTextPoolChange = z.infer<typeof MetaTextPoolChangeSchema>;

// ---------- Keys (shared by duplicate detection and live lookup) ----------

/** Live-map key for a leveled entity: `campaign:123`, `adset:456`, `ad:789`. */
export const levelKey = (level: "campaign" | "adset" | "ad", id: string): string => `${level}:${id}`;

export const budgetKey = (e: MetaBudgetChange): string => levelKey(e.level, e.id);
export const statusKey = (e: MetaStatusChange): string => levelKey(e.level, e.id);
export const exclusionKey = (e: MetaExclusionChange): string => e.adSetId;
export const enhancementKey = (e: MetaEnhancementChange): string => e.adId;
export const textPoolKey = (e: MetaTextPoolChange): string => e.adId;

/** Section array that rejects two entries for the same entity (ambiguous intent). */
const uniqueSection = <S extends z.ZodTypeAny>(item: S, label: string, key: (e: z.output<S>) => string) =>
  z
    .array(item)
    .default([])
    .superRefine((entries: z.output<S>[], ctx) =>
      entries
        .map(key)
        .flatMap((k, i, keys) => (keys.indexOf(k) < i ? [{ k, i }] : []))
        .forEach(({ k, i }) =>
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i], message: `duplicate ${label} entry for ${k}` }),
        ),
    );

export const MetaPlanSchema = z
  .object({
    platform: z.literal("meta"),
    adAccountId: MetaAdAccountIdSchema.optional(),
    budgets: uniqueSection(MetaBudgetChangeSchema, "budgets", budgetKey),
    status: uniqueSection(MetaStatusChangeSchema, "status", statusKey),
    exclusions: uniqueSection(MetaExclusionChangeSchema, "exclusions", exclusionKey),
    enhancements: uniqueSection(MetaEnhancementChangeSchema, "enhancements", enhancementKey),
    textPools: uniqueSection(MetaTextPoolChangeSchema, "textPools", textPoolKey),
  })
  .strict();
export type MetaPlan = z.infer<typeof MetaPlanSchema>;

/** The five change sections of a plan (also the shape of changes/skips after splitting). */
export type MetaPlanSections = Pick<MetaPlan, "budgets" | "status" | "exclusions" | "enhancements" | "textPools">;

const formatIssue = (i: Pick<ZodIssue, "path" | "message">): string =>
  `${i.path.length > 0 ? i.path.join(".") : "(root)"}: ${i.message}`;

/** Parse a raw Meta plan; every issue is reported, one `path: message` per line. */
export function parseMetaPlan(data: unknown): Result<MetaPlan> {
  const parsed = MetaPlanSchema.safeParse(data);
  return parsed.success ? ok(parsed.data) : err(parsed.error.issues.map(formatIssue).join("\n"));
}

// ---------- Live state ----------

/** An ad as read live; `creative` is present when the read expanded `creative{…}`. */
export type MetaLiveAd = Omit<Ad, "creative"> & { creative?: AdCreative };

/** Parsed live Graph objects referenced by a plan, keyed by id string. */
export type MetaLiveState = {
  readonly campaigns: ReadonlyMap<string, Campaign>;
  readonly adSets: ReadonlyMap<string, AdSet>;
  readonly ads: ReadonlyMap<string, MetaLiveAd>;
  /** Ad account currency (ISO code) for minor-unit conversion. */
  readonly currency: string;
};

/** A live campaign, ad set or ad: the fields budget/status comparisons need. */
export type MetaLiveEntity = Campaign | AdSet | MetaLiveAd;

/** Pure: every live entity keyed by {@link levelKey}, for the leveled sections. */
export const leveledLiveMap = (live: MetaLiveState): ReadonlyMap<string, MetaLiveEntity> =>
  new Map<string, MetaLiveEntity>([
    ...[...live.campaigns].map(([id, c]): [string, MetaLiveEntity] => [levelKey("campaign", id), c]),
    ...[...live.adSets].map(([id, s]): [string, MetaLiveEntity] => [levelKey("adset", id), s]),
    ...[...live.ads].map(([id, a]): [string, MetaLiveEntity] => [levelKey("ad", id), a]),
  ]);

/** Live daily budget (minor units) of a campaign or ad set; undefined for ads or when unset. */
const liveDailyBudget = (l: MetaLiveEntity): number | undefined =>
  "daily_budget" in l ? l.daily_budget : undefined;

// ---------- Skip-if-unchanged ----------

/**
 * Pure, generic: partition `entries` into those that would change live state and
 * those already satisfied. An entry whose entity is missing from `live` is a change
 * (validation reports the unknown id). Order is preserved in both lists.
 */
export function splitChanges<E, L>(
  entries: readonly E[],
  live: ReadonlyMap<string, L>,
  key: (e: E) => string,
  equals: (e: E, l: L) => boolean,
): { changes: E[]; skips: E[] } {
  const isSkip = (e: E): boolean => {
    const l = live.get(key(e));
    return l !== undefined && equals(e, l);
  };
  return { changes: entries.filter((e) => !isSkip(e)), skips: entries.filter(isSkip) };
}

/** Budget already at the target after decimal → minor-unit conversion. */
export const budgetEquals =
  (currency: string) =>
  (e: MetaBudgetChange, l: MetaLiveEntity): boolean =>
    liveDailyBudget(l) === toMinorUnits(e.dailyBudget, currency);

/** Configured status (`status`, not `effective_status`) already matches. */
export const statusEquals = (e: MetaStatusChange, l: MetaLiveEntity): boolean => l.status === e.status;

const excludedAudienceIds = (s: AdSet): ReadonlySet<string> =>
  new Set((s.targeting.excluded_custom_audiences ?? []).map((a) => a.id));

/** Every `add` audience already excluded and every `remove` audience already absent. */
export const exclusionEquals = (e: MetaExclusionChange, s: AdSet): boolean => {
  const live = excludedAudienceIds(s);
  return e.add.every((id) => live.has(id)) && e.remove.every((id) => !live.has(id));
};

/** Every requested feature already has that `enroll_status` on the live creative. */
export const enhancementEquals = (e: MetaEnhancementChange, a: MetaLiveAd): boolean => {
  const spec = a.creative?.degrees_of_freedom_spec?.creative_features_spec ?? {};
  return Object.entries(e.features).every(([k, v]) => spec[k]?.enroll_status === v);
};

const sameTexts = (want: readonly string[] | undefined, live: readonly { text: string }[] | undefined): boolean =>
  want === undefined ||
  (want.length === (live ?? []).length && want.every((t, i) => (live ?? [])[i]?.text === t));

/** Every given pool equals the live `asset_feed_spec` texts as an ordered list. */
export const textPoolEquals = (e: MetaTextPoolChange, a: MetaLiveAd): boolean => {
  const feed = a.creative?.asset_feed_spec;
  return (
    sameTexts(e.primaryTexts, feed?.bodies) &&
    sameTexts(e.headlines, feed?.titles) &&
    sameTexts(e.descriptions, feed?.descriptions)
  );
};

export type MetaPlanSplit = { readonly changes: MetaPlanSections; readonly skips: MetaPlanSections };

/** Pure: split every plan section against live state. */
export function splitMetaPlan(plan: MetaPlanSections, live: MetaLiveState): MetaPlanSplit {
  const leveled = leveledLiveMap(live);
  const budgets = splitChanges(plan.budgets, leveled, budgetKey, budgetEquals(live.currency));
  const status = splitChanges(plan.status, leveled, statusKey, statusEquals);
  const exclusions = splitChanges(plan.exclusions, live.adSets, exclusionKey, exclusionEquals);
  const enhancements = splitChanges(plan.enhancements, live.ads, enhancementKey, enhancementEquals);
  const textPools = splitChanges(plan.textPools, live.ads, textPoolKey, textPoolEquals);
  return {
    changes: {
      budgets: budgets.changes,
      status: status.changes,
      exclusions: exclusions.changes,
      enhancements: enhancements.changes,
      textPools: textPools.changes,
    },
    skips: {
      budgets: budgets.skips,
      status: status.skips,
      exclusions: exclusions.skips,
      enhancements: enhancements.skips,
      textPools: textPools.skips,
    },
  };
}

// ---------- Validation ----------

const LEVEL_LABEL = { campaign: "campaign", adset: "ad set", ad: "ad" } as const;

const unknownId = (section: string, level: keyof typeof LEVEL_LABEL, id: string): string =>
  `${section}: ${LEVEL_LABEL[level]} ${id} not found in ad account`;

/** Budget-mode and guardrail errors for one budget change whose entity exists. */
const budgetErrors = (e: MetaBudgetChange, l: Campaign | AdSet, currency: string): string[] => {
  const where = `budgets: ${LEVEL_LABEL[e.level]} ${e.id}`;
  const cur = l.daily_budget;
  const target = toMinorUnits(e.dailyBudget, currency);
  const cap = cur === undefined ? 0 : cur * (1 + META_MAX_BUDGET_RAISE_PCT / 100);
  return cur !== undefined
    ? target > cap
      ? [
          `${where}: dailyBudget ${e.dailyBudget} ${currency} exceeds guardrail ` +
            `(${cur} +${META_MAX_BUDGET_RAISE_PCT}% = ${Math.floor(cap)} minor units)`,
        ]
      : []
    : l.lifetime_budget !== undefined
      ? [`${where}: uses a lifetime budget; dailyBudget cannot be set`]
      : e.level === "campaign"
        ? [`${where}: campaign uses ad set budgets (ABO); set the budget with level: adset`]
        : [`${where}: campaign uses a campaign budget (CBO); set the budget with level: campaign`];
};

/**
 * Pure: errors that block the plan — unknown ids, budget raises above
 * {@link META_MAX_BUDGET_RAISE_PCT}%, and budget level vs budget mode mismatches
 * (CBO/ABO, lifetime). Text limits are already enforced by {@link parseMetaPlan}.
 */
export function validateMetaPlan(changes: MetaPlanSections, live: MetaLiveState): string[] {
  const budgetEntity = (e: MetaBudgetChange): Campaign | AdSet | undefined =>
    e.level === "campaign" ? live.campaigns.get(e.id) : live.adSets.get(e.id);
  const statusExists = (e: MetaStatusChange): boolean =>
    e.level === "campaign" ? live.campaigns.has(e.id) : e.level === "adset" ? live.adSets.has(e.id) : live.ads.has(e.id);
  return [
    ...changes.budgets.flatMap((e) => {
      const l = budgetEntity(e);
      return l === undefined ? [unknownId("budgets", e.level, e.id)] : budgetErrors(e, l, live.currency);
    }),
    ...changes.status.flatMap((e) => (statusExists(e) ? [] : [unknownId("status", e.level, e.id)])),
    ...changes.exclusions.flatMap((e) => (live.adSets.has(e.adSetId) ? [] : [unknownId("exclusions", "adset", e.adSetId)])),
    ...changes.enhancements.flatMap((e) => (live.ads.has(e.adId) ? [] : [unknownId("enhancements", "ad", e.adId)])),
    ...changes.textPools.flatMap((e) => (live.ads.has(e.adId) ? [] : [unknownId("textPools", "ad", e.adId)])),
  ];
}

// ---------- Warnings ----------

export type MetaWarnings = {
  /** Human-readable lines, printed as `WARNING: <line>`. */
  readonly lines: string[];
  /** Campaign / ad set / ad ids being set ACTIVE (starts live spend). */
  readonly enableStartsLiveSpend: string[];
  /** Campaign / ad set ids whose daily budget goes up. */
  readonly budgetIncreases: string[];
  /** Ad set ids in `LEARNING` touched by a budget change above {@link LEARNING_RESET_BUDGET_PCT}%, a targeting change or a creative swap. */
  readonly learningResetRisk: string[];
  /** Ad set ids whose exclusions Meta ignores (Advantage+ audience on the campaign). */
  readonly exclusionIgnored: string[];
};

const unique = (ids: readonly string[]): string[] => [...new Set(ids)];

const isLearning = (s: AdSet | undefined): boolean => s?.learning_stage_info?.status === "LEARNING";

/**
 * Pure: spend and delivery-risk warnings (FR-014) for changes that passed
 * validation. Entities missing from `live` are ignored (validation reports them).
 */
export function metaWarnings(changes: MetaPlanSections, live: MetaLiveState): MetaWarnings {
  const enable = changes.status.filter((e) => e.status === "ACTIVE");

  const budgetDeltas = changes.budgets.flatMap((e) => {
    const l = e.level === "campaign" ? live.campaigns.get(e.id) : live.adSets.get(e.id);
    const cur = l?.daily_budget;
    return cur === undefined ? [] : [{ e, cur, target: toMinorUnits(e.dailyBudget, live.currency) }];
  });
  const increases = budgetDeltas.filter((d) => d.target > d.cur);

  /** Ad sets whose delivery a budget change on `e` affects. */
  const budgetAdSets = (e: MetaBudgetChange): AdSet[] =>
    e.level === "adset"
      ? [live.adSets.get(e.id)].filter((s): s is AdSet => s !== undefined)
      : [...live.adSets.values()].filter((s) => s.campaign_id === e.id);
  const bigBudgetLearning = budgetDeltas
    .filter((d) => d.cur > 0 && (Math.abs(d.target - d.cur) / d.cur) * 100 > LEARNING_RESET_BUDGET_PCT)
    .flatMap((d) =>
      budgetAdSets(d.e)
        .filter(isLearning)
        .map((s) => ({
          adSetId: s.id,
          why: `budget change on ${LEVEL_LABEL[d.e.level]} ${d.e.id} > ${LEARNING_RESET_BUDGET_PCT}%`,
        })),
    );
  const exclusionLearning = changes.exclusions
    .filter((e) => isLearning(live.adSets.get(e.adSetId)))
    .map((e) => ({ adSetId: e.adSetId, why: "targeting change (exclusions)" }));
  const swapLearning = [...changes.enhancements, ...changes.textPools].flatMap((e) => {
    const setId = live.ads.get(e.adId)?.adset_id;
    return setId !== undefined && isLearning(live.adSets.get(setId))
      ? [{ adSetId: setId, why: `creative swap on ad ${e.adId}` }]
      : [];
  });
  const learning = [...bigBudgetLearning, ...exclusionLearning, ...swapLearning];

  const ignored = changes.exclusions.filter((e) => {
    const s = live.adSets.get(e.adSetId);
    const state = (s?.campaign?.advantage_state_info ?? (s && live.campaigns.get(s.campaign_id)?.advantage_state_info))
      ?.advantage_state;
    return state !== undefined && state !== "DISABLED";
  });

  const lines = [
    ...enable.map((e) => `enabling ${LEVEL_LABEL[e.level]} ${e.id} starts live spend`),
    ...increases.map(
      (d) =>
        `raising daily budget of ${LEVEL_LABEL[d.e.level]} ${d.e.id} to ${d.e.dailyBudget} ${live.currency} increases spend`,
    ),
    ...learning.map((r) => `ad set ${r.adSetId} is in LEARNING; ${r.why} may reset learning`),
    ...ignored.map(
      (e) => `ad set ${e.adSetId} uses Advantage+ audience; custom audience exclusions may be ignored`,
    ),
  ];

  return {
    lines,
    enableStartsLiveSpend: unique(enable.map((e) => e.id)),
    budgetIncreases: unique(increases.map((d) => d.e.id)),
    learningResetRisk: unique(learning.map((r) => r.adSetId)),
    exclusionIgnored: unique(ignored.map((e) => e.adSetId)),
  };
}
