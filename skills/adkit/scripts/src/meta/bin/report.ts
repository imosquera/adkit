/**
 * Meta report: pull Meta Ads performance for a trailing N-day window (or the
 * account's clamped all-time history) and write the raw report YAML under the
 * reports directory (plan D5).
 *
 * The Meta counterpart of `bin/report.ts`, reached through its `--platform meta`
 * delegation (plan D1) or run directly. It reuses the Google report's `parseArgs`
 * for `--days` / `--all-time` / `--include-paused`, its window helpers and its
 * report-path/YAML writer, so the two platforms' files line up.
 *
 * Output contract, mirroring the Google report: on success the report path is the
 * only thing on stdout, exit 0. On failure stdout carries a
 * `{ ok: false, message, step }` envelope (the Meta commands' shared error shape)
 * and the exit code is 1 — including the zero-campaign case, where nothing is
 * written.
 *
 * Usage: adkit-report --platform meta [--ad-account <act_id>] [--days 14]
 *                     [--all-time] [--include-paused]
 *                     [--result-action lead] [--attribution 7d_click,1d_view]
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { stringify as stringifyYaml } from "yaml";

import { ALL_TIME_START, parseArgs, reportPath, spanInDays, type ReportArgs } from "../../bin/report.js";
import { isMainModule } from "../../cli/entry.js";
import { emitJson, errorEnvelope } from "../../cli/output.js";
import { dateWindow } from "../../gaql/builders.js";
import { resolveReportsDir } from "../../lib/config.js";
import { metaClientFor, type MetaClient } from "../client.js";
import { resolveMetaContextFromProcess, type MetaContext, type MetaContextFlags } from "../config.js";
import { envelopeFailure, formatMetaError, type EnvelopeFailure } from "../errors.js";
import { AdAccountSchema } from "../graph.js";
import { err, ok, type Result } from "../ids.js";
import { clampAllTime, fetchMetaReportRows, parseAttribution } from "../report/fetch.js";
import { shapeMetaReport, type AttributionWindow, type MetaReport } from "../report/shape.js";
import { AD_ACCOUNT_FLAG, parseAdAccountFlag, parseResultAction } from "./args.js";

/** Meta-only flags this bin pulls out of argv before the Google `parseArgs` sees the rest. */
const META_FLAGS = ["--result-action", "--attribution", AD_ACCOUNT_FLAG] as const;
type MetaFlag = (typeof META_FLAGS)[number];

/** The raw Meta-only flag values plus the argv left for the Google parser. */
export interface SplitReportArgs {
  readonly rest: readonly string[];
  readonly values: Readonly<Partial<Record<MetaFlag, string>>>;
}

/** Fully parsed Meta report arguments. */
export interface MetaReportArgs {
  readonly window: Pick<ReportArgs, "days" | "allTime" | "includePaused">;
  readonly adAccount: string | null;
  readonly resultAction: string;
  readonly attribution: readonly AttributionWindow[];
}

type SplitState = { readonly rest: readonly string[]; readonly values: SplitReportArgs["values"]; readonly skip: boolean };

const isMetaFlag = (arg: string): arg is MetaFlag => (META_FLAGS as readonly string[]).includes(arg);

/**
 * Pull `--result-action`, `--attribution` and `--ad-account` (space or `=` form)
 * out of argv. A space-form flag with no value (end of argv or another `--flag`
 * next) is an error rather than a silent default. Pure.
 */
export const splitReportArgs = (argv: readonly string[]): Result<SplitReportArgs> => {
  const missing = argv.find((arg, i) => isMetaFlag(arg) && (argv[i + 1] === undefined || argv[i + 1]?.startsWith("--")));
  if (missing !== undefined) return err(`${missing} requires a value`);
  const state = argv.reduce<SplitState>(
    (acc, arg, i) => {
      if (acc.skip) return { ...acc, skip: false };
      if (isMetaFlag(arg)) return { ...acc, values: { ...acc.values, [arg]: argv[i + 1] }, skip: true };
      const eq = META_FLAGS.find((flag) => arg.startsWith(`${flag}=`));
      return eq === undefined
        ? { ...acc, rest: [...acc.rest, arg] }
        : { ...acc, values: { ...acc.values, [eq]: arg.slice(eq.length + 1) } };
    },
    { rest: [], values: {}, skip: false },
  );
  return ok({ rest: state.rest, values: state.values });
};

/**
 * Parse argv into {@link MetaReportArgs}: `--ad-account` / `--result-action` through
 * the shared `./args.ts` parsers, `--attribution`
 * through `parseAttribution` (so `7d_view` / `28d_view` are refused), the rest
 * through the Google `parseArgs`. Google account flags (`--customer`, `--manager`,
 * a positional id) are refused with a pointer to `--ad-account`. Pure.
 */
export const parseMetaReportArgs = (argv: readonly string[]): Result<MetaReportArgs> => {
  const adAccount = parseAdAccountFlag(argv);
  if (adAccount.kind === "err") return adAccount;
  const split = splitReportArgs(argv);
  if (split.kind === "err") return split;
  const { rest, values } = split.value;
  const attribution = parseAttribution(values["--attribution"]);
  if (attribution.kind === "err") return attribution;
  const resultAction = parseResultAction(values["--result-action"]);
  if (resultAction.kind === "err") return resultAction;
  const google = parseGoogleArgs(rest);
  if (google.kind === "err") return google;
  if (google.value.customer !== null || google.value.manager !== null) {
    return err("--customer / --manager / a positional id are Google Ads flags; use --ad-account <act_id> for Meta");
  }
  return ok({
    window: { days: google.value.days, allTime: google.value.allTime, includePaused: google.value.includePaused },
    adAccount: adAccount.value,
    resultAction: resultAction.value,
    attribution: attribution.value,
  });
};

/** The Google parser throws on a bad `--days`; turn that into a Result. */
const parseGoogleArgs = (rest: readonly string[]): Result<ReportArgs> => {
  try {
    return ok(parseArgs([...rest]));
  } catch (exc) {
    return err(exc instanceof Error ? exc.message.replace(/^error: /, "") : String(exc));
  }
};

/** The report window for `today`: trailing `days`, or all-time clamped to Meta's 37 months. Pure. */
export const reportWindow = (
  args: Pick<ReportArgs, "days" | "allTime">,
  today: Date,
): MetaReport["window"] => {
  const [start, end] = args.allTime
    ? [clampAllTime(ALL_TIME_START, today), dateWindow(today, 1)[1]]
    : dateWindow(today, args.days);
  // Report the span actually queried (the clamped one under --all-time).
  const days = args.allTime ? spanInDays(start, end) : args.days;
  return { start, end, days, partial_day: today.toISOString().slice(0, 10) };
};

/** Injected effects: context resolution, client construction, clock, cwd and reports dir. */
export interface ReportDeps {
  readonly clientFactory: (ctx: MetaContext) => MetaClient;
  readonly resolveContext: (flags: MetaContextFlags) => Promise<MetaContext>;
  readonly now: () => Date;
  readonly cwd: () => string;
  readonly reportsDir: () => string;
}

type StepFailure = EnvelopeFailure;

type StepResult<T> = { readonly kind: "ok"; readonly value: T } | { readonly kind: "err"; readonly failure: StepFailure };

/** Run one effect, turning a throw into a failure labelled `step` (Meta errors keep their own step). */
const runStep = async <T>(step: string, effect: () => Promise<T> | T): Promise<StepResult<T>> => {
  try {
    return { kind: "ok", value: await effect() };
  } catch (exc) {
    return { kind: "err", failure: envelopeFailure(exc, step) };
  }
};

const fail = (failure: StepFailure): number => {
  emitJson(errorEnvelope(failure.message, { step: failure.step }));
  return 1;
};

/**
 * Run the Meta report. Returns the process exit code (0 when the YAML was written
 * and its path printed; 1 otherwise, with an error envelope on stdout).
 */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  deps: Partial<ReportDeps> = {},
): Promise<number> {
  const clientFactory = deps.clientFactory ?? metaClientFor;
  const resolveContext = deps.resolveContext ?? ((flags: MetaContextFlags) => resolveMetaContextFromProcess(flags, env));
  const now = deps.now ?? (() => new Date());
  const cwd = deps.cwd ?? (() => process.cwd());
  const reportsDir = deps.reportsDir ?? (() => resolveReportsDir());

  const args = parseMetaReportArgs(argv);
  if (args.kind === "err") return fail({ step: "args", message: args.message });
  const { window: windowArgs, adAccount, resultAction, attribution } = args.value;

  const ctx = await runStep("credentials", () => resolveContext({ adAccount }));
  if (ctx.kind === "err") return fail(ctx.failure);
  const { adAccountId } = ctx.value;

  const client = await runStep("credentials", () => clientFactory(ctx.value));
  if (client.kind === "err") return fail(client.failure);

  const account = await runStep("report-account", () =>
    client.value.get(adAccountId, { fields: ["id", "name", "account_status", "currency"] }, AdAccountSchema, {
      step: "report-account",
    }),
  );
  if (account.kind === "err") return fail(account.failure);

  // The one clock read.
  const today = now();
  const window = reportWindow(windowArgs, today);
  const rows = await runStep("report-insights", () =>
    fetchMetaReportRows(client.value, ctx.value, window, {
      includePaused: windowArgs.includePaused,
      attribution,
      resultAction,
    }),
  );
  if (rows.kind === "err") return fail(rows.failure);

  const generatedAt = window.partial_day;
  const report = shapeMetaReport(rows.value, {
    adAccountId,
    currency: account.value.currency,
    attribution,
    resultAction,
    window,
    generatedAt,
  });

  if (report.campaigns.length === 0) {
    const which = windowArgs.includePaused ? "campaigns" : "ACTIVE campaigns";
    return fail({
      step: "report",
      message: `no ${which} with activity in ${adAccountId} between ${window.start} and ${window.end}; nothing written.`,
    });
  }

  const written = await runStep("write", () => {
    const outPath = reportPath(cwd(), generatedAt, adAccountId, reportsDir());
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, stringifyYaml(report, { sortMapEntries: false }));
    return outPath;
  });
  if (written.kind === "err") return fail(written.failure);

  process.stdout.write(`${written.value}\n`);
  return 0;
}

// Run as a CLI entrypoint when invoked directly (not through bin/report.ts).
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
