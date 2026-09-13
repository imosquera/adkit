/**
 * Meta create: parse a `type: meta` brief, stage it under `adbriefs/<slug>.yaml`,
 * then publish it to the Graph API resumably (plan D7).
 *
 * The Meta counterpart of `bin/create.ts`, reached through its delegation (plan D1)
 * or run directly. Flow:
 *
 * 1. `brief` — the brief YAML is parsed once by {@link parseMetaBrief}; every issue
 *    (schema, cross-field, missing media) is reported together and nothing else
 *    runs. {@link softWarnings} (text lengths, exclusions under Advantage+ audience)
 *    go to stderr as `warning:` lines and into the envelope's `warnings`.
 * 2. `url-check` — every ad `link` must resolve (skipped with `--skip-url-check`).
 * 3. `credentials` / `page` — the account is the brief's `adAccountId` or the
 *    resolved context's; the page is the brief's `pageId` or `meta_page_id`.
 * 4. `adbriefs` — the staged path is under `resolveBriefsDir()`; the brief's media
 *    paths are rebased from the input brief's directory onto the staged copy's. A slug
 *    collision with a different campaign is refused; the diff against the staged brief
 *    goes to stderr.
 * 5. `state` — the existing `.meta-state.yaml` is read (or an empty state built).
 *    State entries whose names left the brief are `orphaned`: one `WARNING:` line each
 *    on stderr, listed in the envelope, never deleted.
 * 6. Dry run: `{ ok, platform, dryRun, adAccountId, pageId, briefPath, briefDiff,
 *    planned, warnings, orphaned, willWriteBrief, willWriteState }`, and zero client
 *    calls (not even the currency read).
 * 7. Publish: build the client and read the account currency (`account`), and only
 *    then write the brief — so a credentials/account failure leaves adbriefs untouched
 *    — run {@link publishMeta} (which saves `.meta-state.yaml` after every step), emit
 *    `{ ok, platform, adAccountId, created, failure, briefPath, statePath, briefDiff,
 *    briefSynced, stateSynced, warnings, orphaned, note }`; exit 1 on failure.
 *
 * Failures before publish emit the Meta `{ ok: false, message, step }` envelope and
 * exit 1. stdout carries only the envelope; narration goes to stderr.
 *
 * Usage: ads.sh create <brief.yaml> [--dry-run] [--skip-url-check]
 */

import { createHash } from "node:crypto";
import { accessSync, constants, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

import { parse as yamlParse } from "yaml";

import { diffBriefs, type BriefDiff } from "../../adbriefs/diff.js";
import { AdbriefsError, assertNoForeignBrief, briefPathForCampaign, loadBriefIfExists, writeBrief } from "../../adbriefs/store.js";
import { isMainModule } from "../../cli/entry.js";
import { emitJson, errorEnvelope, ok } from "../../cli/output.js";
import { urlUnreachableReason } from "../../ideas/urls.js";
import { resolveBriefsDir } from "../../lib/config.js";
import { parseMetaBrief, softWarnings, type MetaBrief } from "../brief.js";
import { metaClientFor, type MetaClient } from "../client.js";
import { resolveMetaContextFromProcess, type MetaContext, type MetaContextFlags } from "../config.js";
import { envelopeFailure, formatMetaError, type EnvelopeFailure } from "../errors.js";
import { AdAccountSchema } from "../graph.js";
import { err, ok as okResult, type MetaPageId, type Result } from "../ids.js";
import { orphanedEntries, planPublish, publishMeta, type LocalMedia, type OrphanedObject, type PublishFailure } from "../publish.js";
import { emptyMetaState, metaStatePath, readMetaState, writeMetaState, type MetaState } from "../state.js";

export const USAGE = "usage: ads.sh create <brief.yaml> [--dry-run] [--skip-url-check]";

/** Parsed `create` arguments. */
export interface CreateArgs {
  readonly briefPath: string;
  readonly dryRun: boolean;
  readonly skipUrlCheck: boolean;
}

const KNOWN_FLAGS: ReadonlySet<string> = new Set(["--dry-run", "--skip-url-check"]);

/** Parse argv: exactly one positional brief path plus the two boolean flags. Pure. */
export const parseCreateArgs = (argv: readonly string[]): Result<CreateArgs> => {
  const unknown = argv.filter((a) => a.startsWith("--") && !KNOWN_FLAGS.has(a));
  const positionals = argv.filter((a) => !a.startsWith("--"));
  return unknown.length > 0
    ? err(`unknown flag(s): ${unknown.join(", ")}. ${USAGE}`)
    : positionals.length !== 1
      ? err(USAGE)
      : okResult({ briefPath: positionals[0]!, dryRun: argv.includes("--dry-run"), skipUrlCheck: argv.includes("--skip-url-check") });
};

/** Pure: every distinct ad destination URL in brief order. */
export const metaFinalUrls = (brief: MetaBrief): string[] => [
  ...new Set(brief.adSets.flatMap((s) => s.ads.map((ad) => ad.link))),
];

/** Pure: a brief media path resolved against the brief file's directory. */
export const resolveMediaPath = (briefDir: string, path: string): string => (isAbsolute(path) ? path : resolve(briefDir, path));

/** Pure: one media path re-expressed relative to `toDir` (absolute paths stay absolute). */
const rebasePath = (fromDir: string, toDir: string, path: string): string =>
  isAbsolute(path) ? path : relative(toDir, resolve(fromDir, path));

/**
 * Pure: the brief with every media path relative to `toDir` instead of `fromDir`. The
 * staged `adbriefs/` copy is re-read later (re-runs, `update`) from its own directory, so
 * its media paths must resolve from there. Idempotent when `fromDir === toDir`, which
 * keeps state media keys stable whether create runs on the original or the staged brief.
 */
export const rebaseMediaPaths = (brief: MetaBrief, fromDir: string, toDir: string): MetaBrief => ({
  ...brief,
  adSets: brief.adSets.map((adSet) => ({
    ...adSet,
    ads: adSet.ads.map((ad) => ({
      ...ad,
      media:
        "image" in ad.media
          ? { image: rebasePath(fromDir, toDir, ad.media.image) }
          : { video: rebasePath(fromDir, toDir, ad.media.video), thumbnail: rebasePath(fromDir, toDir, ad.media.thumbnail) },
    })),
  })),
});

/** Pure: the publish page — brief `pageId` first, then `meta_page_id`. */
export const resolvePageId = (brief: MetaBrief, ctx: MetaContext): Result<MetaPageId> => {
  const pageId = brief.pageId ?? ctx.pageId;
  return pageId === null
    ? err("no Facebook page to publish ads from: set pageId in the brief or meta_page_id in adkit.yaml (run `ads.sh init`).")
    : okResult(pageId);
};

/** Pure: the created-ids summary for the publish envelope. */
export const createdSummary = (state: MetaState) => ({
  campaignId: state.campaign.campaignId,
  adSets: state.adSets.map((s) => ({
    name: s.name,
    adSetId: s.adSetId,
    ads: s.ads.map((ad) => ({ name: ad.name, creativeId: ad.creativeId, adId: ad.adId })),
  })),
});

/** Pure: the stderr line for one orphaned state entry. */
export const orphanWarning = (o: OrphanedObject): string =>
  o.kind === "ad-set"
    ? `ad set "${o.name}" is no longer in the brief but state holds adSetId ${o.adSetId ?? "null"}` +
      (o.ads.length > 0 ? ` and ads ${o.ads.map((a) => `"${a.name}" (adId ${a.adId ?? "null"}, creativeId ${a.creativeId ?? "null"})`).join(", ")}` : "") +
      "; the live objects were left untouched (rename it back, or pause/delete them in Ads Manager)"
    : `ad "${o.name}" in ad set "${o.adSetName}" is no longer in the brief but state holds adId ${o.adId ?? "null"}, creativeId ${o.creativeId ?? "null"}; ` +
      "the live objects were left untouched (rename it back, or pause/delete them in Ads Manager)";

const diffSummary = (d: BriefDiff) => ({ changed: d.changed, added: d.added, removed: d.removed });

/** Injected effects, so tests run without a terminal, config files, the network or a real cwd. */
export interface CreateDeps {
  readonly clientFactory: (ctx: MetaContext) => MetaClient;
  readonly resolveContext: (flags: MetaContextFlags) => Promise<MetaContext>;
  /** `null` when the URL resolves, else a short reason. */
  readonly checkUrl: (url: string) => Promise<string | null>;
  /** Root under which `adbriefs/` lives. */
  readonly cwd: () => string;
  readonly briefsDir: () => string;
}

type StepFailure = EnvelopeFailure;

type StepResult<T> = { readonly kind: "ok"; readonly value: T } | { readonly kind: "err"; readonly failure: StepFailure };

/** Run one effect, turning a throw into a failure labelled `step` (Meta errors keep their own step). */
const runStep = async <T>(step: string, effect: () => Promise<T> | T): Promise<StepResult<T>> => {
  try {
    return { kind: "ok", value: await effect() };
  } catch (exc) {
    const failure = envelopeFailure(exc, step);
    return { kind: "err", failure: exc instanceof AdbriefsError ? { ...failure, message: exc.message } : failure };
  }
};

const fail = (failure: StepFailure): number => {
  process.stderr.write(`error: ${failure.message}\n`);
  emitJson(errorEnvelope(failure.message, { step: failure.step }));
  return 1;
};

const readYaml = (path: string): unknown => yamlParse(readFileSync(path, "utf8"));

const isReadable = (path: string): boolean => {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
};

/** Read a media file once, with its sha256 (the upload reuse key). */
const readMediaFile = (fullPath: string): LocalMedia => {
  const bytes = readFileSync(fullPath);
  return { name: basename(fullPath), bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
};

/**
 * Parser for the already-staged `adbriefs/` copy (collision check + diff). Media
 * existence was checked on the input brief, so it is not re-checked here.
 */
const parseStagedBrief = (data: unknown): MetaBrief => {
  const parsed = parseMetaBrief(data, { fileExists: () => true });
  if (parsed.kind === "err") throw new AdbriefsError(`staged adbriefs brief failed validation:\n${parsed.message}`);
  return parsed.value;
};

const stateSyncedAfter = (failure: PublishFailure | null): boolean => failure?.step !== "save-state";

/**
 * Run Meta create. Returns the process exit code: 0 on a successful publish or dry
 * run, 1 on any failure (with an envelope on stdout).
 */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  deps: Partial<CreateDeps> = {},
): Promise<number> {
  const clientFactory = deps.clientFactory ?? metaClientFor;
  const resolveContext = deps.resolveContext ?? ((flags: MetaContextFlags) => resolveMetaContextFromProcess(flags, env));
  const checkUrl = deps.checkUrl ?? urlUnreachableReason;
  const cwd = deps.cwd ?? (() => process.cwd());
  const briefsDirOf = deps.briefsDir ?? (() => resolveBriefsDir());

  const args = parseCreateArgs(argv);
  if (args.kind === "err") return fail({ step: "args", message: args.message });
  const { briefPath, dryRun, skipUrlCheck } = args.value;
  const briefDir = dirname(resolve(cwd(), briefPath));
  const fullBriefPath = resolve(cwd(), briefPath);

  // 1. Parse the brief once; every issue together, before anything else runs.
  const raw = await runStep("brief", () => readYaml(fullBriefPath));
  if (raw.kind === "err") return fail(raw.failure);
  const parsed = parseMetaBrief(raw.value, { fileExists: (p) => isReadable(resolveMediaPath(briefDir, p)) });
  if (parsed.kind === "err") return fail({ step: "brief", message: `brief failed validation:\n${parsed.message}` });
  const warnings = softWarnings(parsed.value);
  warnings.forEach((w) => process.stderr.write(`warning: ${w}\n`));

  // 2. Every ad destination must resolve.
  if (!skipUrlCheck) {
    const probed = await Promise.all(metaFinalUrls(parsed.value).map(async (url) => [url, await checkUrl(url)] as const));
    const failures = probed.filter(([, reason]) => reason !== null);
    if (failures.length > 0) {
      return fail({
        step: "url-check",
        message:
          "final URL check failed — these destinations don't resolve (fix the brief, or pass --skip-url-check to bypass):\n" +
          failures.map(([url, reason]) => `  - ${url} → ${reason}`).join("\n"),
      });
    }
  }

  // 3. Account and page.
  const ctx = await runStep("credentials", () => resolveContext({ adAccount: parsed.value.adAccountId ?? null }));
  if (ctx.kind === "err") return fail(ctx.failure);
  const adAccountId = parsed.value.adAccountId ?? ctx.value.adAccountId;
  const pageId = resolvePageId(parsed.value, ctx.value);
  if (pageId.kind === "err") return fail({ step: "page", message: pageId.message });

  // 4. Stage under the briefs dir: refuse a foreign slug occupant, show the diff. From here on
  //    the brief's media paths are relative to the staged copy's directory.
  const root = cwd();
  const briefsDir = briefsDirOf();
  const adbriefsPath = briefPathForCampaign(root, parsed.value, briefsDir);
  const stagedDir = dirname(adbriefsPath);
  const brief = rebaseMediaPaths(parsed.value, briefDir, stagedDir);
  const statePath = metaStatePath(root, brief, briefsDir);
  const existing = await runStep("adbriefs", () => {
    assertNoForeignBrief(root, brief, briefsDir, parseStagedBrief);
    return loadBriefIfExists(root, brief, briefsDir, parseStagedBrief);
  });
  if (existing.kind === "err") return fail(existing.failure);
  const briefDiff = diffBriefs(existing.value, brief);
  process.stderr.write(
    briefDiff.changed
      ? `${existing.value === null ? "new" : "changed"} adbriefs brief ${adbriefsPath} (+${briefDiff.added}/-${briefDiff.removed}):\n${briefDiff.render}\n`
      : `adbriefs brief ${adbriefsPath} unchanged\n`,
  );

  // 5. State: resume ids, and warn about entries whose names left the brief.
  const loaded = await runStep("state", () => readMetaState(statePath));
  if (loaded.kind === "err") return fail(loaded.failure);
  const state = loaded.value ?? emptyMetaState(brief, adAccountId);
  const orphaned = orphanedEntries(brief, state);
  orphaned.forEach((o) => process.stderr.write(`WARNING: ${orphanWarning(o)}\n`));

  // 6. Dry run: no client is even built.
  if (dryRun) {
    emitJson(
      ok({
        platform: "meta",
        dryRun: true,
        adAccountId,
        pageId: pageId.value,
        briefPath: adbriefsPath,
        briefDiff: diffSummary(briefDiff),
        planned: planPublish(brief, state),
        warnings,
        orphaned,
        willWriteBrief: adbriefsPath,
        willWriteState: statePath,
      }),
    );
    return 0;
  }

  // 7. Publish. The brief is written only once the account read succeeds.
  const client = await runStep("credentials", () => clientFactory(ctx.value));
  if (client.kind === "err") return fail(client.failure);

  const account = await runStep("account", () =>
    client.value.get(adAccountId, { fields: ["currency"] }, AdAccountSchema.pick({ currency: true }), { step: "account" }),
  );
  if (account.kind === "err") return fail(account.failure);

  const written = await runStep("adbriefs", () => writeBrief(root, brief, briefsDir, parseStagedBrief));
  if (written.kind === "err") return fail(written.failure);

  const outcome = await publishMeta(
    client.value,
    { adAccountId, pageId: pageId.value, currency: account.value.currency },
    brief,
    state,
    {
      readMedia: (path) => readMediaFile(resolveMediaPath(stagedDir, path)),
      saveState: (next) => writeMetaState(statePath, next),
    },
  );

  if (outcome.failure !== null) {
    process.stderr.write(`error: publish failed at ${outcome.failure.step}: ${outcome.failure.message}\n`);
  }
  emitJson({
    ok: outcome.failure === null,
    platform: "meta",
    adAccountId,
    created: createdSummary(outcome.state),
    failure: outcome.failure,
    briefPath: adbriefsPath,
    statePath,
    briefDiff: diffSummary(briefDiff),
    // The brief was written before publish; on failure `failure` marks the brief ↔ live gap.
    briefSynced: outcome.failure === null,
    // State is saved after every successful step, so it lags live only when a save failed.
    stateSynced: stateSyncedAfter(outcome.failure),
    warnings,
    orphaned: outcome.orphaned,
    note: `Campaign, ad sets and ads created PAUSED. Re-run the same command to resume a partial publish.`,
  });
  return outcome.failure === null ? 0 : 1;
}

// Run as a CLI entrypoint when invoked directly (not through bin/create.ts).
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
