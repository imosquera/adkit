/**
 * Meta update: apply a Meta update plan (`ads.sh update <plan.yaml> [--apply]` with
 * `platform: meta`, plan D8) — budgets, statuses, ad set exclusions, Advantage+
 * creative enhancements and flexible-creative text pools.
 *
 * The Meta counterpart of `bin/apply-fixes.ts`, reached through its delegation
 * (plan D1) or run directly, and deliberately the same operator experience:
 *
 * 1. Parse the plan once ({@link parseMetaPlan}); read live state for the ids it
 *    references ({@link readLiveState}).
 * 2. Drop entries live already satisfies ({@link splitMetaPlan}); block the run on
 *    {@link validateMetaPlan} errors — `VALIDATION FAILED:` narration, exit 1.
 * 3. Stage the changes onto the `adbriefs/<slug>.yaml` briefs they belong to (located
 *    through `.meta-state.yaml`) and print each brief diff. Ids with no state record
 *    are reported, never fatal.
 * 4. Narrate planned actions plus one `WARNING:` line per {@link metaWarnings} risk.
 * 5. Dry run (default): the envelope with `applied: false`; zero Graph writes and zero
 *    file writes.
 * 6. `--apply`: {@link runMetaApply} (every entry isolated), then write the staged
 *    briefs of slugs no failed entry touches. Any failure → the same keys on an
 *    `ok: false` envelope with `errors[]`, exit 1.
 *
 * Exit codes mirror apply-fixes: 0 success (incl. dry run), 1 validation / Graph /
 * apply failure, 2 bad arguments or an unreadable / invalid plan file.
 *
 * `.meta-state.yaml` is not rewritten here: an update changes no name ↔ id mapping the
 * index reads (a creative swap replaces the creative id, which `runMetaApply` does not
 * report back, and which no reader of the index uses).
 *
 * Usage: adkit-update <plan.yaml> [--apply] [--ad-account <act_id>]
 */

import { accessSync, constants as fsConstants, existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { parse as yamlParse } from "yaml";

import { AdbriefsError, briefPathForCampaign, writeBrief, type BriefParser } from "../../adbriefs/store.js";
import { diffBriefs, type BriefDiff } from "../../adbriefs/diff.js";
import { isMainModule } from "../../cli/entry.js";
import { emitJson, errorEnvelope, ok as okEnvelope } from "../../cli/output.js";
import { resolveBriefsDir } from "../../lib/config.js";
import {
  applyMetaPlanToBrief,
  readLiveState,
  resolveMetaPlanGroups,
  runMetaApply,
  type MetaApplyError,
  type MetaPlanGroup,
} from "../apply.js";
import { parseMetaBrief, type MetaBrief } from "../brief.js";
import type { MetaClient } from "../client.js";
import { resolveMetaContextFromProcess, type MetaContext, type MetaContextFlags } from "../config.js";
import { MetaApiError, MetaConfigError, formatMetaError } from "../errors.js";
import { err, ok, type Result } from "../ids.js";
import { fromMinorUnits } from "../money.js";
import {
  leveledLiveMap,
  metaWarnings,
  parseMetaPlan,
  splitMetaPlan,
  validateMetaPlan,
  type MetaLiveState,
  type MetaPlan,
  type MetaPlanSections,
} from "../plan.js";
import { loadMetaStateIndex, type MetaStateIndex } from "../state.js";
import { defaultClientFactory } from "./preflight.js";

// ---------- Args ----------

export interface UpdateArgs {
  readonly planPath: string;
  readonly apply: boolean;
  readonly adAccount: string | null;
}

const AD_ACCOUNT = "--ad-account";

/** Parse `<plan.yaml> [--apply] [--ad-account <id>]`. Unknown `--flags` are ignored, as in apply-fixes. Pure. */
export const parseUpdateArgs = (argv: readonly string[]): Result<UpdateArgs> => {
  const flagIndex = argv.indexOf(AD_ACCOUNT);
  const spaceValue = flagIndex === -1 ? undefined : argv[flagIndex + 1];
  if (flagIndex !== -1 && (spaceValue === undefined || spaceValue.startsWith("--"))) {
    return err(`${AD_ACCOUNT} requires a value`);
  }
  const eqValue = argv.find((a) => a.startsWith(`${AD_ACCOUNT}=`))?.slice(AD_ACCOUNT.length + 1);
  const positionals = argv.filter((a, i) => !a.startsWith("--") && !(flagIndex !== -1 && i === flagIndex + 1));
  const planPath = positionals[0];
  if (planPath === undefined) return err("Provide a Meta update plan YAML path");
  const adAccount = (spaceValue ?? eqValue)?.trim();
  return ok({
    planPath,
    apply: argv.includes("--apply"),
    adAccount: adAccount === undefined || adAccount === "" ? null : adAccount,
  });
};

// ---------- Pure narration ----------

const LEVEL_LABEL = { campaign: "campaign", adset: "ad set", ad: "ad" } as const;

/** Pure: one `planned actions` line per change and per skip. */
export function plannedActionLines(split: { changes: MetaPlanSections; skips: MetaPlanSections }, live: MetaLiveState): string[] {
  const leveled = leveledLiveMap(live);
  const curBudget = (level: "campaign" | "adset", id: string): string => {
    const l = leveled.get(`${level}:${id}`);
    const minor = l !== undefined && "daily_budget" in l ? l.daily_budget : undefined;
    return minor === undefined ? "unset" : String(fromMinorUnits(minor, live.currency));
  };
  const curStatus = (level: "campaign" | "adset" | "ad", id: string): string => leveled.get(`${level}:${id}`)?.status ?? "UNKNOWN";
  const pools = (e: MetaPlanSections["textPools"][number]): string =>
    [
      e.primaryTexts === undefined ? null : `primaryTexts ${e.primaryTexts.length}`,
      e.headlines === undefined ? null : `headlines ${e.headlines.length}`,
      e.descriptions === undefined ? null : `descriptions ${e.descriptions.length}`,
    ]
      .filter((p): p is string => p !== null)
      .join(", ");
  const features = (e: MetaPlanSections["enhancements"][number]): string =>
    Object.entries(e.features)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
  const { changes, skips } = split;
  return [
    ...changes.budgets.map(
      (e) => `budget ${LEVEL_LABEL[e.level]} ${e.id}: ${curBudget(e.level, e.id)} -> ${e.dailyBudget} ${live.currency}/day`,
    ),
    ...skips.budgets.map((e) => `budget ${LEVEL_LABEL[e.level]} ${e.id}: already ${e.dailyBudget} ${live.currency}/day, skipped`),
    ...changes.status.map((e) => `${LEVEL_LABEL[e.level]} ${e.id}: status ${curStatus(e.level, e.id)} -> ${e.status}`),
    ...skips.status.map((e) => `${LEVEL_LABEL[e.level]} ${e.id}: status already ${e.status}, skipped`),
    ...changes.exclusions.map((e) => `exclusions ad set ${e.adSetId}: +${e.add.length} add, -${e.remove.length} remove`),
    ...skips.exclusions.map((e) => `exclusions ad set ${e.adSetId}: already applied, skipped`),
    ...changes.enhancements.map((e) => `enhancements ad ${e.adId}: ${features(e)} (new creative)`),
    ...skips.enhancements.map((e) => `enhancements ad ${e.adId}: already ${features(e)}, skipped`),
    ...changes.textPools.map((e) => `text pools ad ${e.adId}: ${pools(e)} (new creative)`),
    ...skips.textPools.map((e) => `text pools ad ${e.adId}: already ${pools(e)}, skipped`),
  ];
}

/** Pure: the brief slugs an apply failure touches — the entity's slug in whichever index knows it. */
export const slugsForEntity = (index: MetaStateIndex, entityId: string): string[] => [
  ...new Set(
    [index.byCampaignId, index.byAdSetId, index.byAdId].flatMap((m) => {
      const loc = m.get(entityId);
      return loc === undefined ? [] : [loc.slug];
    }),
  ),
];

// ---------- Brief staging (I/O edge: reads only) ----------

export type BriefStagingSkipReason = "missing-brief" | "invalid-brief";

/** One brief the plan touches: the on-disk brief, the staged proposal and their diff, or why staging was skipped. */
export type StagedMetaBrief =
  | {
      readonly slug: string;
      readonly path: string;
      readonly skipReason: null;
      readonly current: MetaBrief;
      readonly proposed: MetaBrief;
      readonly diff: BriefDiff;
    }
  | { readonly slug: string; readonly path: string; readonly skipReason: BriefStagingSkipReason; readonly message: string };

/** Real media check for a brief at `briefPath`: the path, resolved against the brief's directory, is readable. */
const mediaExists =
  (briefPath: string) =>
  (media: string): boolean => {
    try {
      accessSync(resolve(dirname(briefPath), media), fsConstants.R_OK);
      return true;
    } catch {
      return false;
    }
  };

/** Read + parse a Meta brief file; `err` names the file on bad YAML or a schema violation. */
const readMetaBrief = (path: string): Result<MetaBrief> => {
  const data = ((): Result<unknown> => {
    try {
      return ok(yamlParse(readFileSync(path, "utf8")));
    } catch (exc) {
      return err(`adbriefs brief ${path} is not valid YAML: ${exc instanceof Error ? exc.message.split("\n")[0] : String(exc)}`);
    }
  })();
  if (data.kind === "err") return data;
  const parsed = parseMetaBrief(data.value, { fileExists: mediaExists(path) });
  return parsed.kind === "ok" ? parsed : err(`adbriefs brief ${path} failed validation:\n${parsed.message}`);
};

/** The store's throwing parser for a Meta brief at `path` (used by `writeBrief`'s collision check). */
const metaBriefParser =
  (path: string): BriefParser<MetaBrief> =>
  (data) => {
    const parsed = parseMetaBrief(data, { fileExists: mediaExists(path) });
    if (parsed.kind === "err") throw new AdbriefsError(`adbriefs brief at ${path} failed validation:\n${parsed.message}`);
    return parsed.value;
  };

/** Stage each group onto its `<dir>/<slug>.yaml` brief. Reads the files; never writes. */
export function stageMetaBriefs(root: string, dir: string, groups: readonly MetaPlanGroup[]): StagedMetaBrief[] {
  return groups.map((group): StagedMetaBrief => {
    const path = join(root, dir, `${group.slug}.yaml`);
    if (!existsSync(path)) {
      return {
        slug: group.slug,
        path,
        skipReason: "missing-brief",
        message: `${dir}/${group.slug}.meta-state.yaml exists but ${dir}/${group.slug}.yaml does not — skipping brief staging for this campaign`,
      };
    }
    const current = readMetaBrief(path);
    if (current.kind === "err") return { slug: group.slug, path, skipReason: "invalid-brief", message: current.message };
    if (briefPathForCampaign(root, current.value, dir) !== path) {
      return {
        slug: group.slug,
        path,
        skipReason: "invalid-brief",
        message: `${path} describes campaign "${current.value.campaign.name}", which does not match slug ${group.slug}`,
      };
    }
    const proposed = applyMetaPlanToBrief(current.value, group);
    return { slug: group.slug, path, skipReason: null, current: current.value, proposed, diff: diffBriefs(current.value, proposed) };
  });
}

/** Pure: a staged brief's envelope entry. */
const briefEntry = (s: StagedMetaBrief, synced: boolean): Record<string, unknown> => ({
  slug: s.slug,
  briefPath: s.path,
  briefSynced: synced,
  briefDiff: s.skipReason === null ? { changed: s.diff.changed, added: s.diff.added, removed: s.diff.removed } : null,
  briefStagingSkipped: s.skipReason !== null,
  briefStagingSkipReason: s.skipReason,
});

// ---------- Main ----------

/** Injected effects: context resolution, client construction, clock, cwd and briefs dir. */
export interface UpdateDeps {
  readonly clientFactory: (ctx: MetaContext) => MetaClient;
  readonly resolveContext: (flags: MetaContextFlags) => Promise<MetaContext>;
  readonly now: () => Date;
  readonly cwd: () => string;
  readonly briefsDir: () => string;
}

interface StepFailure {
  readonly step: string;
  readonly message: string;
}

type StepResult<T> = { readonly kind: "ok"; readonly value: T } | { readonly kind: "err"; readonly failure: StepFailure };

/** Run one effect, turning a throw into a failure labelled `step` (Meta errors keep their own step). */
const runStep = async <T>(step: string, effect: () => Promise<T> | T): Promise<StepResult<T>> => {
  try {
    return { kind: "ok", value: await effect() };
  } catch (exc) {
    return {
      kind: "err",
      failure: {
        step: exc instanceof MetaApiError || exc instanceof MetaConfigError ? exc.step : step,
        message: formatMetaError(exc),
      },
    };
  }
};

const fail = (failure: StepFailure, code = 1): number => {
  emitJson(errorEnvelope(failure.message, { step: failure.step }));
  return code;
};

/** Read the plan file into `unknown`, then parse it once. */
const loadPlan = (path: string): Result<MetaPlan> => {
  const isFile = ((): boolean => {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  })();
  if (!isFile) return err(`plan file not found: ${path}`);
  const data = ((): Result<unknown> => {
    try {
      return ok(yamlParse(readFileSync(path, "utf8")));
    } catch (exc) {
      return err(`plan is not valid YAML: ${exc instanceof Error ? exc.message.split("\n")[0] : String(exc)}`);
    }
  })();
  if (data.kind === "err") return data;
  const plan = parseMetaPlan(data.value);
  return plan.kind === "ok" ? plan : err(`Meta plan failed validation:\n${plan.message}`);
};

/**
 * Run a Meta update plan. Returns the process exit code (0 on success incl. dry run,
 * 1 on validation / Graph / apply failure, 2 on bad arguments or plan).
 */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  deps: Partial<UpdateDeps> = {},
): Promise<number> {
  const clientFactory = deps.clientFactory ?? defaultClientFactory;
  const resolveContext = deps.resolveContext ?? ((flags: MetaContextFlags) => resolveMetaContextFromProcess(flags, env));
  const now = deps.now ?? (() => new Date());
  const cwd = deps.cwd ?? (() => process.cwd());
  const briefsDirOf = deps.briefsDir ?? (() => resolveBriefsDir());

  const args = parseUpdateArgs(argv);
  if (args.kind === "err") return fail({ step: "args", message: args.message }, 2);
  const { planPath, apply } = args.value;

  const loaded = loadPlan(resolve(cwd(), planPath));
  if (loaded.kind === "err") return fail({ step: "plan", message: loaded.message }, 2);
  const plan = loaded.value;

  // The plan's own adAccountId wins: a plan is generated against one specific account.
  const ctx = await runStep("credentials", () => resolveContext({ adAccount: plan.adAccountId ?? args.value.adAccount }));
  if (ctx.kind === "err") return fail(ctx.failure);
  const adAccountId = plan.adAccountId ?? ctx.value.adAccountId;

  const client = await runStep("credentials", () => clientFactory(ctx.value));
  if (client.kind === "err") return fail(client.failure);

  const live = await runStep("read-live", () => readLiveState(client.value, plan, adAccountId));
  if (live.kind === "err") return fail(live.failure);

  const split = splitMetaPlan(plan, live.value);
  const { changes, skips } = split;

  const errs = validateMetaPlan(changes, live.value);
  if (errs.length > 0) {
    console.log("VALIDATION FAILED:");
    errs.forEach((e) => console.log("  -", e));
    emitJson(errorEnvelope(`validation failed: ${errs.join("; ")}`, { step: "validate", errors: errs }));
    return 1;
  }

  const warnings = metaWarnings(changes, live.value);

  // ----- adbriefs staging: every run, dry run included; skipped entries never staged.
  const root = cwd();
  const briefsDir = briefsDirOf();
  const index = await runStep("state", () => loadMetaStateIndex(root, briefsDir));
  if (index.kind === "err") return fail(index.failure);
  const { groups, unresolvedPlanIds } = resolveMetaPlanGroups(changes, index.value);
  const staged = await runStep("stage-briefs", () => stageMetaBriefs(root, briefsDir, groups));
  if (staged.kind === "err") return fail(staged.failure);

  staged.value.forEach((s) =>
    s.skipReason !== null
      ? console.log(`WARNING: ${s.message}`)
      : s.diff.changed
        ? console.log(`\nadbriefs brief ${s.path} (+${s.diff.added}/-${s.diff.removed}):\n${s.diff.render}`)
        : console.log(`\nadbriefs brief ${s.path} unchanged`),
  );
  if (unresolvedPlanIds.length > 0) {
    console.log(
      `\nWARNING: plan references id(s) with no record in any ${briefsDir}/*.meta-state.yaml ` +
        "(brief staging skipped for these; live changes proceed unaffected):",
    );
    unresolvedPlanIds.forEach((id) => console.log(`  - ${id}`));
  }

  console.log("validation ok. planned actions:");
  plannedActionLines(split, live.value).forEach((line) => console.log("  -", line));
  warnings.lines.forEach((line) => console.log(`WARNING: ${line}`));

  const envelopeFields = (applied: boolean, briefs: readonly Record<string, unknown>[]): Record<string, unknown> => ({
    platform: "meta",
    applied,
    budgetChanges: changes.budgets,
    budgetSkipped: skips.budgets,
    statusChanges: changes.status,
    statusSkipped: skips.status,
    exclusionChanges: changes.exclusions,
    exclusionSkipped: skips.exclusions,
    enhancementChanges: changes.enhancements,
    enhancementSkipped: skips.enhancements,
    textPoolChanges: changes.textPools,
    textPoolSkipped: skips.textPools,
    enableStartsLiveSpend: warnings.enableStartsLiveSpend,
    budgetIncreases: warnings.budgetIncreases,
    learningResetRisk: warnings.learningResetRisk,
    exclusionIgnored: warnings.exclusionIgnored,
    briefs,
    unresolvedPlanIds,
  });

  if (!apply) {
    console.log("\nDry run. Re-run with --apply.");
    emitJson(okEnvelope({ ...envelopeFields(false, staged.value.map((s) => briefEntry(s, false))), errors: [] }));
    return 0;
  }

  // ===== live writes (I/O edge): each entry isolated, failures recorded and skipped past.
  const result = await runMetaApply(client.value, { adAccountId, live: live.value, now: now() }, changes);
  result.applied.forEach((a) => console.log(`  applied ${a.section} ${a.entityId}`));

  type SlugError = MetaApplyError & { readonly slugs: readonly string[] };
  const applyErrors: SlugError[] = result.errors.map((e) => ({ ...e, slugs: slugsForEntity(index.value, e.entityId) }));
  const failedSlugs = new Set(applyErrors.flatMap((e) => e.slugs));

  // Write briefs only after the live writes, and only for slugs no failure touched.
  const written = staged.value.map((s): { entry: Record<string, unknown>; error: SlugError | null } => {
    if (s.skipReason !== null || failedSlugs.has(s.slug)) return { entry: briefEntry(s, false), error: null };
    if (!s.diff.changed) return { entry: briefEntry(s, true), error: null };
    try {
      writeBrief(root, s.proposed, briefsDir, metaBriefParser(s.path));
      return { entry: briefEntry(s, true), error: null };
    } catch (exc) {
      return {
        entry: briefEntry(s, false),
        error: { step: "write-brief", entityId: s.slug, message: formatMetaError(exc), slugs: [s.slug] },
      };
    }
  });
  const errors = [...applyErrors, ...written.flatMap((w) => (w.error === null ? [] : [w.error]))];
  const briefs = written.map((w) => w.entry);

  if (errors.length === 0) {
    emitJson(okEnvelope({ ...envelopeFields(true, briefs), errors: [] }));
    return 0;
  }

  const allFailedSlugs = new Set(errors.flatMap((e) => e.slugs));
  console.log(
    "\nWARNING: local adbriefs brief(s) and the live account have diverged — " +
      `${errors.length} step(s) failed partway through this run:`,
  );
  errors.forEach((e) => {
    console.log(`  - ${e.step} ${e.entityId}: ${e.message}`);
    if (e.slugs.length > 0) console.log(`    affected brief(s): ${e.slugs.join(", ")}`);
  });
  staged.value
    .flatMap((s) => (s.skipReason === null && s.diff.changed && allFailedSlugs.has(s.slug) ? [s] : []))
    .forEach((s) => console.log(`  - ${s.path} NOT updated (would have changed +${s.diff.added}/-${s.diff.removed})`));
  emitJson(
    errorEnvelope(errors.map((e) => `${e.step} ${e.entityId}: ${e.message}`).join("; "), {
      ...envelopeFields(true, briefs),
      step: "apply",
      errors,
    }),
  );
  return 1;
}

// Run as a CLI entrypoint when invoked directly (not through bin/apply-fixes.ts).
if (isMainModule(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((exc: unknown) => {
      emitJson(errorEnvelope(formatMetaError(exc), { step: "unexpected" }));
      process.exitCode = 1;
    });
}
