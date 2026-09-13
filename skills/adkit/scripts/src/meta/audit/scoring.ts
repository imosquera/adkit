/**
 * Meta audit scoring (plan D6): pure rules over `AuditInput` (see `rows.ts`), each
 * `(input) → MetaFinding[]`, plus `scoreMetaAccount` which runs them all and groups
 * the findings by campaign (account-wide findings — breakdown waste, account-wide
 * event volume — are kept apart, since they belong to no single campaign).
 *
 * Thresholds are named constants taken from `reference/meta/`; every finding links
 * the playbook section that explains it (`reference/meta/<file>.md#<anchor>`, anchors
 * derived GitHub-style from the real headings — `scoring.test.ts` checks they resolve).
 *
 * Pure: no I/O, inputs are never mutated.
 */

import type { AuditAd, AuditAdSet, AuditBreakdownRow, AuditCampaign, AuditInput } from "./rows.js";

// ---------------------------------------------------------------------------
// Thresholds (reference/meta/)
// ---------------------------------------------------------------------------

/** Optimization events per ad set per 7 days to exit learning (1-fundamentals, 3-account-structure). */
export const LEARNING_EXIT_WEEKLY_EVENTS = 50;
/** A campaign with at least this many active ad sets is a consolidation candidate. */
export const FRAGMENTED_MIN_ACTIVE_AD_SETS = 3;
/** Frequency at or above which an ad is considered saturated on its audience. */
export const FATIGUE_MIN_FREQUENCY = 3.5;
/** Relative link-CTR drop vs the previous window (0..1) that signals fatigue. */
export const FATIGUE_MIN_CTR_DROP = 0.25;
/** Breakdown segment spend share (0..1) worth acting on (6-analyze: "20%+ of spend"). */
export const BREAKDOWN_MIN_SPEND_SHARE = 0.2;
/** Segment cost per result at or above this multiple of the account's is bleed (6-analyze: "2x+"). */
export const BREAKDOWN_COST_MULTIPLE = 2;
/** Optimization goals that optimize for a pixel conversion event. */
export const CONVERSION_OPTIMIZATION_GOALS: readonly string[] = ["OFFSITE_CONVERSIONS", "VALUE"];
/**
 * Advantage+ creative enhancements whose B2B default is opt in (4-creative: visual
 * touch-ups only crop/resize) — enrolling them is not a finding.
 */
export const SAFE_ENHANCEMENTS: readonly string[] = ["image_touchups"];
/** `advantage_state` value for a campaign that is not Advantage+. */
export const ADVANTAGE_DISABLED = "DISABLED";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MetaIssue =
  | "learning_limited"
  | "still_learning_low_volume"
  | "fragmented_budget"
  | "creative_fatigue"
  | "wasted_breakdown_spend"
  | "missing_customer_exclusion"
  | "weak_conversion_signal"
  | "advantage_creative_enhancements_on";

export type MetaSeverity = "high" | "medium" | "low";

export type MetaFinding = {
  level: "account" | "campaign" | "adset" | "ad";
  entityId: string;
  entityName: string;
  issue: MetaIssue;
  severity: MetaSeverity;
  detail: string;
  evidence: Record<string, number | string>;
  fix: string;
  playbook: string;
};

export type MetaScore = {
  /** Every input campaign id → its findings, high → low severity (empty when clean). */
  campaigns: Record<string, readonly MetaFinding[]>;
  /** Findings not attributable to one campaign, high → low severity. */
  account: readonly MetaFinding[];
};

// ---------------------------------------------------------------------------
// Playbook links
// ---------------------------------------------------------------------------

export const PLAYBOOK = {
  learningPhase: "reference/meta/1-fundamentals.md#the-learning-phase",
  conversionTracking: "reference/meta/1-fundamentals.md#conversion-tracking",
  consolidation: "reference/meta/3-account-structure.md#consolidation-rules",
  advantageCreative: "reference/meta/4-creative.md#dynamic--advantage-creative",
  customerExclusions: "reference/meta/5-exclusions.md#existing-customers--converters",
  breakdownAudit: "reference/meta/6-analyze.md#breakdown-report-audit",
  creativeFatigue: "reference/meta/6-analyze.md#creative-fatigue",
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Round to at most 2 decimals for evidence values. */
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Human number: integers as-is, otherwise one decimal. */
const num = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/** Ratio 0..1 as a whole-number percent string. */
const pct = (ratio: number): string => `${Math.round(ratio * 100)}%`;

const money = (n: number): string => n.toFixed(2);

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length === 0
    ? 0
    : sorted.length % 2 === 1
      ? (sorted[mid] ?? 0)
      : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
};

const activeAdSets = (input: AuditInput): AuditAdSet[] => input.adSets.filter((s) => s.active);

const isConversionGoal = (s: AuditAdSet): boolean => CONVERSION_OPTIMIZATION_GOALS.includes(s.optimizationGoal);

/** Advantage+ when the reported state is present and not `DISABLED`. */
const isAdvantagePlus = (state: string | null): boolean => state !== null && state !== ADVANTAGE_DISABLED;

const campaignById = (input: AuditInput): Map<string, AuditCampaign> =>
  new Map<string, AuditCampaign>(input.campaigns.map((c) => [c.id, c]));

const adSetFinding = (
  s: AuditAdSet,
  f: Pick<MetaFinding, "issue" | "severity" | "detail" | "evidence" | "fix" | "playbook">,
): MetaFinding => ({ level: "adset", entityId: s.id, entityName: s.name, ...f });

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/** Active ad sets Meta reports as learning limited (`learning_stage_info.status = FAIL`). */
export const learningLimited = (input: AuditInput): MetaFinding[] =>
  activeAdSets(input)
    .filter((s) => s.learningStatus === "FAIL")
    .map((s) =>
      adSetFinding(s, {
        issue: "learning_limited",
        severity: "high",
        detail: `learning limited: ${num(s.weeklyResultEvents)} result events/week vs the ~${LEARNING_EXIT_WEEKLY_EVENTS} needed to exit learning`,
        evidence: {
          learningStatus: s.learningStatus,
          weeklyResultEvents: round2(s.weeklyResultEvents),
          threshold: LEARNING_EXIT_WEEKLY_EVENTS,
          spend: round2(s.spend),
        },
        fix: `Get this ad set to ${LEARNING_EXIT_WEEKLY_EVENTS}+ events/week: consolidate it with sibling ad sets, broaden the audience, raise budget, or optimize for a higher-volume event than ${s.customEventType ?? s.optimizationGoal}.`,
        playbook: PLAYBOOK.learningPhase,
      }),
    );

/** Active ad sets still in learning with fewer than 50 weekly result events. */
export const stillLearningLowVolume = (input: AuditInput): MetaFinding[] =>
  activeAdSets(input)
    .filter((s) => s.learningStatus === "LEARNING" && s.weeklyResultEvents < LEARNING_EXIT_WEEKLY_EVENTS)
    .map((s) =>
      adSetFinding(s, {
        issue: "still_learning_low_volume",
        severity: "medium",
        detail: `still learning on ${num(s.weeklyResultEvents)} result events/week (needs ~${LEARNING_EXIT_WEEKLY_EVENTS})`,
        evidence: {
          learningStatus: s.learningStatus,
          weeklyResultEvents: round2(s.weeklyResultEvents),
          threshold: LEARNING_EXIT_WEEKLY_EVENTS,
          spend: round2(s.spend),
        },
        fix: `Hold edits until learning ends; if it cannot reach ${LEARNING_EXIT_WEEKLY_EVENTS} events/week, size the daily budget to ~7x target cost per event or merge it into another ad set.`,
        playbook: PLAYBOOK.consolidation,
      }),
    );

/** Campaigns with ≥ 3 active ad sets whose median weekly result events is below 50. */
export const fragmentedBudget = (input: AuditInput): MetaFinding[] =>
  input.campaigns.flatMap((c) => {
    const sets = activeAdSets(input).filter((s) => s.campaignId === c.id);
    const med = median(sets.map((s) => s.weeklyResultEvents));
    return sets.length >= FRAGMENTED_MIN_ACTIVE_AD_SETS && med < LEARNING_EXIT_WEEKLY_EVENTS
      ? [
          {
            level: "campaign" as const,
            entityId: c.id,
            entityName: c.name,
            issue: "fragmented_budget" as const,
            severity: "medium" as const,
            detail: `${sets.length} active ad sets at a median of ${num(med)} result events/week each (needs ~${LEARNING_EXIT_WEEKLY_EVENTS})`,
            evidence: {
              activeAdSets: sets.length,
              medianWeeklyResultEvents: round2(med),
              threshold: LEARNING_EXIT_WEEKLY_EVENTS,
            },
            fix: `Consolidate the ${sets.length} ad sets into fewer, broader ones so each clears ${LEARNING_EXIT_WEEKLY_EVENTS} events/week.`,
            playbook: PLAYBOOK.consolidation,
          },
        ]
      : [];
  });

/** Ads with spend, frequency ≥ 3.5 and link CTR down ≥ 25% vs the previous window. */
export const creativeFatigue = (input: AuditInput): MetaFinding[] =>
  input.ads.flatMap((a: AuditAd) => {
    const prev = a.previous;
    if (prev === null || prev.linkCtr <= 0 || a.current.spend <= 0) return [];
    const drop = (prev.linkCtr - a.current.linkCtr) / prev.linkCtr;
    return a.current.frequency >= FATIGUE_MIN_FREQUENCY && drop >= FATIGUE_MIN_CTR_DROP
      ? [
          {
            level: "ad" as const,
            entityId: a.id,
            entityName: a.name,
            issue: "creative_fatigue" as const,
            severity: "high" as const,
            detail: `frequency ${a.current.frequency.toFixed(1)} and link CTR down ${pct(drop)} (${a.current.linkCtr.toFixed(2)}% vs ${prev.linkCtr.toFixed(2)}% last window)`,
            evidence: {
              frequency: round2(a.current.frequency),
              linkCtr: round2(a.current.linkCtr),
              previousLinkCtr: round2(prev.linkCtr),
              ctrDropPct: Math.round(drop * 100),
              spend: round2(a.current.spend),
            },
            fix: `Replace "${a.name}" with a new concept (new hook, proof point or format), not a recolor of the same image.`,
            playbook: PLAYBOOK.creativeFatigue,
          },
        ]
      : [];
  });

/**
 * Breakdown segments with ≥ 20% of their dimension's spend and either no results or a
 * cost per result ≥ 2× the account's. Skipped when the account itself has no results
 * (no baseline to compare against — `weak_conversion_signal` covers that case).
 */
export const wastedBreakdownSpend = (input: AuditInput): MetaFinding[] => {
  const accountCpr = input.account.costPerResult;
  if (accountCpr === null) return [];
  return input.breakdowns
    .filter(
      (b: AuditBreakdownRow) =>
        b.spendShare >= BREAKDOWN_MIN_SPEND_SHARE &&
        (b.costPerResult === null || b.costPerResult >= BREAKDOWN_COST_MULTIPLE * accountCpr),
    )
    .map((b) => ({
      level: "account" as const,
      entityId: `${b.dimension}:${b.segment}`,
      entityName: `${b.dimension} ${b.segment}`,
      issue: "wasted_breakdown_spend" as const,
      severity: "medium" as const,
      detail:
        b.costPerResult === null
          ? `${b.segment} took ${pct(b.spendShare)} of ${b.dimension} spend (${money(b.spend)}) with 0 results`
          : `${b.segment} took ${pct(b.spendShare)} of ${b.dimension} spend at ${money(b.costPerResult)}/result, ${num(round2(b.costPerResult / accountCpr))}x the account's ${money(accountCpr)}`,
      evidence: {
        dimension: b.dimension,
        segment: b.segment,
        spend: round2(b.spend),
        spendSharePct: Math.round(b.spendShare * 100),
        results: b.results,
        costPerResult: b.costPerResult === null ? "none" : round2(b.costPerResult),
        accountCostPerResult: round2(accountCpr),
      },
      fix:
        b.dimension === "placement"
          ? `Build creative made for ${b.segment} first; exclude the placement only if that fails. Check lead quality in the CRM before acting.`
          : `Check CRM lead quality for ${b.segment} before narrowing targeting — act only if it doesn't match your ICP.`,
      playbook: PLAYBOOK.breakdownAudit,
    }));
};

/**
 * Active prospecting ad sets (no included custom audience) with no excluded custom
 * audience. Ad sets in Advantage+ campaigns are skipped: Meta ignores exclusions there.
 */
export const missingCustomerExclusion = (input: AuditInput): MetaFinding[] => {
  const campaigns = campaignById(input);
  return activeAdSets(input)
    .filter(
      (s) =>
        s.includedAudienceIds.length === 0 &&
        s.excludedAudienceIds.length === 0 &&
        !isAdvantagePlus(s.advantageState ?? campaigns.get(s.campaignId)?.advantageState ?? null),
    )
    .map((s) =>
      adSetFinding(s, {
        issue: "missing_customer_exclusion",
        severity: "medium",
        detail: `prospecting ad set excludes 0 custom audiences — it pays to reach existing customers and converters`,
        evidence: { includedAudiences: 0, excludedAudiences: 0, spend: round2(s.spend) },
        fix: "Exclude custom audiences of paying customers, trial/signup converters and submitted leads, with a retention window matching the sales cycle.",
        playbook: PLAYBOOK.customerExclusions,
      }),
    );
};

/**
 * Weak conversion signal: an active conversion-optimized ad set without a pixel (per
 * ad set), or fewer than 50 weekly result events account-wide while any active ad set
 * optimizes for a conversion (one account finding).
 */
export const weakConversionSignal = (input: AuditInput): MetaFinding[] => {
  const conversionSets = activeAdSets(input).filter(isConversionGoal);
  const noPixel = conversionSets
    .filter((s) => s.pixelId === null)
    .map((s) =>
      adSetFinding(s, {
        issue: "weak_conversion_signal",
        severity: "high",
        detail: `optimizes for ${s.optimizationGoal} but has no pixel in promoted_object`,
        evidence: { optimizationGoal: s.optimizationGoal, pixelId: "missing", spend: round2(s.spend) },
        fix: "Set promoted_object.pixel_id and the conversion event; run Pixel plus Conversions API, deduplicated with a shared event_id.",
        playbook: PLAYBOOK.conversionTracking,
      }),
    );
  const weekly = input.account.weeklyResultEvents;
  const lowVolume =
    conversionSets.length > 0 && weekly < LEARNING_EXIT_WEEKLY_EVENTS
      ? [
          {
            level: "account" as const,
            entityId: "account",
            entityName: "Ad account",
            issue: "weak_conversion_signal" as const,
            severity: "high" as const,
            detail: `${num(round2(weekly))} ${input.resultAction} events/week account-wide across ${conversionSets.length} conversion-optimized ad sets (needs ~${LEARNING_EXIT_WEEKLY_EVENTS} per ad set)`,
            evidence: {
              resultAction: input.resultAction,
              weeklyResultEvents: round2(weekly),
              conversionAdSets: conversionSets.length,
              threshold: LEARNING_EXIT_WEEKLY_EVENTS,
            },
            fix: `Optimize for a higher-volume event than ${input.resultAction} (e.g. Lead or CompleteRegistration), add Conversions API to recover lost events, and send hashed email to raise Event Match Quality.`,
            playbook: PLAYBOOK.conversionTracking,
          },
        ]
      : [];
  return [...noPixel, ...lowVolume];
};

/** Ads with Advantage+ creative enhancements opted in (beyond the safe visual touch-ups). */
export const advantageCreativeEnhancementsOn = (input: AuditInput): MetaFinding[] =>
  input.ads.flatMap((a) => {
    const on = a.enhancements
      .filter((e) => e.enrollStatus === "OPT_IN" && !SAFE_ENHANCEMENTS.includes(e.feature))
      .map((e) => e.feature);
    return on.length > 0
      ? [
          {
            level: "ad" as const,
            entityId: a.id,
            entityName: a.name,
            issue: "advantage_creative_enhancements_on" as const,
            severity: "low" as const,
            detail: `${on.length} Advantage+ creative enhancement${on.length === 1 ? "" : "s"} opted in: ${on.join(", ")}`,
            evidence: { optedIn: on.join(","), count: on.length },
            fix: `Set enroll_status OPT_OUT for ${on.join(", ")} in degrees_of_freedom_spec.creative_features_spec unless you've previewed and approved their output.`,
            playbook: PLAYBOOK.advantageCreative,
          },
        ]
      : [];
  });

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export const RULES: readonly ((input: AuditInput) => MetaFinding[])[] = [
  learningLimited,
  stillLearningLowVolume,
  fragmentedBudget,
  creativeFatigue,
  wastedBreakdownSpend,
  missingCustomerExclusion,
  weakConversionSignal,
  advantageCreativeEnhancementsOn,
];

const SEVERITY_RANK: Record<MetaSeverity, number> = { high: 0, medium: 1, low: 2 };

/** Stable sort high → medium → low (rule order kept within a severity). */
export const bySeverity = (findings: readonly MetaFinding[]): MetaFinding[] =>
  [...findings].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);

/**
 * Run every rule and group findings by campaign. Ad set findings go to the ad set's
 * campaign, ad findings to the ad's campaign; `account`-level findings are returned
 * separately. Every input campaign gets a key.
 */
export const scoreMetaAccount = (input: AuditInput): MetaScore => {
  const findings = RULES.flatMap((rule) => rule(input));
  const adSetCampaign = new Map<string, string>(input.adSets.map((s) => [s.id, s.campaignId]));
  const adCampaign = new Map<string, string>(input.ads.map((a) => [a.id, a.campaignId]));
  const campaignOf = (f: MetaFinding): string | undefined =>
    f.level === "campaign"
      ? f.entityId
      : f.level === "adset"
        ? adSetCampaign.get(f.entityId)
        : f.level === "ad"
          ? adCampaign.get(f.entityId)
          : undefined;
  return {
    campaigns: Object.fromEntries(
      input.campaigns.map((c) => [c.id, bySeverity(findings.filter((f) => f.level !== "account" && campaignOf(f) === c.id))]),
    ),
    account: bySeverity(findings.filter((f) => f.level === "account")),
  };
};
