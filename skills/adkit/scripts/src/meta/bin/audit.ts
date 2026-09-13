/**
 * Meta audit: read-only scoring of live campaigns, ad sets and ads against the
 * `reference/meta/` playbook (plan D6).
 *
 * The Meta counterpart of `bin/audit.ts`, reached through its `--platform meta`
 * delegation (plan D1) or run directly. Flags: `--ad-account`, `--psi-key`,
 * `--days` (7 | 14 | 30, default 14) and `--result-action` (the insights
 * `action_type` counted as a result, default `lead`).
 *
 * Reads (never a write — every call is a `getAll`), all in parallel:
 * - `act_<id>/campaigns`, `act_<id>/adsets` (with `campaign{id,advantage_state_info}`),
 *   `act_<id>/ads` (with `creative{…}`), each limited to `ACTIVE` entities;
 * - `act_<id>/insights` at `level=ad` for the current window and the window of equal
 *   length immediately before it (creative fatigue), at `level=adset` with `actions`
 *   (event volume), and account breakdowns `publisher_platform,platform_position`
 *   and `age,gender` for the current window.
 *
 * The reads become `toAuditRows` → `scoreMetaAccount` → `renderMetaAudit` (stderr).
 * Landing pages are the unique ad destination links; with a PageSpeed Insights key
 * each is diagnosed once through the shared `lib/psi.ts` helpers, rendered with the
 * Google audit's `renderLandingPageHealth` / `renderPsi`.
 *
 * Success emits `{ ok: true, platform: "meta", adAccountId, window, campaigns:
 * [{ id, name, status, findings }], account, landingPageHealth, psi }`. Failures emit
 * `{ ok: false, message, step }`. Exit code 0 on success, 1 otherwise; stdout
 * carries only the envelope.
 */

import { parseArgs } from "node:util";

import { renderLandingPageHealth, renderPsi, emitLines } from "../../audit/render.js";
import type { LandingPageEntry, PsiResult } from "../../audit/types.js";
import { isMainModule } from "../../cli/entry.js";
import { emitJson, errorEnvelope, ok } from "../../cli/output.js";
import { dateWindow, priorWindow } from "../../gaql/builders.js";
import { buildPsiRequestUrl, parsePsiResponse } from "../../lib/psi.js";
import { renderMetaAudit } from "../audit/render.js";
import { toAuditRows, type AuditInput, type MetaAuditRaw } from "../audit/rows.js";
import { scoreMetaAccount, type MetaFinding, type MetaScore } from "../audit/scoring.js";
import type { MetaClient, Params } from "../client.js";
import { resolveMetaContextFromProcess, type MetaContext, type MetaContextFlags } from "../config.js";
import { formatMetaError } from "../errors.js";
import { AdSchema, AdSetSchema, CampaignSchema, InsightsRowSchema, type Campaign } from "../graph.js";
import type { MetaAdAccountId, Result } from "../ids.js";
import { defaultClientFactory, failureFrom } from "./preflight.js";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

export const AUDIT_DAYS = [7, 14, 30] as const;
export type AuditDays = (typeof AUDIT_DAYS)[number];
export const DEFAULT_AUDIT_DAYS: AuditDays = 14;
export const DEFAULT_RESULT_ACTION = "lead";

export interface MetaAuditArgs {
  readonly flags: MetaContextFlags;
  readonly days: AuditDays;
  readonly resultAction: string;
}

const isAuditDays = (n: number): n is AuditDays => AUDIT_DAYS.some((d) => d === n);

const stringFlag = (raw: unknown): string | null => (typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null);

/** Parse the audit flags once. `--days` outside 7/14/30 or a blank `--result-action` is an error. Pure. */
export function parseMetaAuditArgs(argv: readonly string[]): Result<MetaAuditArgs> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      "ad-account": { type: "string" },
      "psi-key": { type: "string" },
      days: { type: "string" },
      "result-action": { type: "string" },
    },
    allowPositionals: true,
    strict: false,
  });
  const rawDays = values["days"];
  const days = rawDays === undefined ? DEFAULT_AUDIT_DAYS : Number(rawDays);
  if (!isAuditDays(days)) {
    return { kind: "err", message: `--days must be one of ${AUDIT_DAYS.join(", ")}, got ${String(rawDays)}` };
  }
  const rawAction = values["result-action"];
  const resultAction = rawAction === undefined ? DEFAULT_RESULT_ACTION : stringFlag(rawAction);
  if (resultAction === null) {
    return { kind: "err", message: "--result-action needs an action_type (e.g. lead, offsite_conversion.fb_pixel_purchase)" };
  }
  return {
    kind: "ok",
    value: {
      flags: { adAccount: stringFlag(values["ad-account"]), psiKey: stringFlag(values["psi-key"]) },
      days,
      resultAction,
    },
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface DateRange {
  readonly start: string;
  readonly end: string;
}

/** The current window (last `days` complete days) and the one of equal length before it. */
export interface AuditWindows {
  readonly days: AuditDays;
  readonly current: DateRange;
  readonly previous: DateRange;
}

/** Both windows as of `now`, ending yesterday (UTC). Pure. */
export const auditWindows = (now: Date, days: AuditDays): AuditWindows => {
  const [start, end] = dateWindow(now, days);
  const [prevStart, prevEnd] = priorWindow(now, days);
  return { days, current: { start, end }, previous: { start: prevStart, end: prevEnd } };
};

const ACTIVE_ONLY = ["ACTIVE"] as const;

export const AUDIT_CAMPAIGN_FIELDS = [
  "id",
  "name",
  "objective",
  "effective_status",
  "daily_budget",
  "lifetime_budget",
  "bid_strategy",
  "special_ad_categories",
  "advantage_state_info",
] as const;

export const AUDIT_ADSET_FIELDS = [
  "id",
  "name",
  "campaign_id",
  "effective_status",
  "daily_budget",
  "optimization_goal",
  "promoted_object",
  "targeting",
  "learning_stage_info",
  "is_dynamic_creative",
  "campaign{id,advantage_state_info}",
] as const;

export const AUDIT_AD_FIELDS = [
  "id",
  "name",
  "adset_id",
  "campaign_id",
  "effective_status",
  "creative{id,degrees_of_freedom_spec,asset_feed_spec,object_story_spec}",
] as const;

const AD_INSIGHTS_FIELDS = [
  "campaign_id",
  "adset_id",
  "ad_id",
  "ad_name",
  "spend",
  "impressions",
  "reach",
  "frequency",
  "inline_link_clicks",
  "inline_link_click_ctr",
] as const;

const ADSET_INSIGHTS_FIELDS = ["campaign_id", "adset_id", "adset_name", "spend", "impressions", "actions"] as const;

const BREAKDOWN_FIELDS = ["spend", "impressions", "actions"] as const;

const entityParams = (fields: readonly string[]): Params => ({
  fields,
  filtering: [{ field: "effective_status", operator: "IN", value: ACTIVE_ONLY }],
});

/** Params for one insights read over `range`. Pure. */
export const auditInsightsParams = (range: DateRange, extra: Params): Params => ({
  time_range: { since: range.start, until: range.end },
  filtering: [{ field: "campaign.effective_status", operator: "IN", value: ACTIVE_ONLY }],
  ...extra,
});

/**
 * Issue the eight audit reads in parallel and return them as {@link MetaAuditRaw}.
 * Rejects with the first `MetaApiError` (its `step` names the read).
 */
export const fetchMetaAuditRaw = async (
  client: MetaClient,
  account: MetaAdAccountId,
  windows: AuditWindows,
  resultAction: string,
): Promise<MetaAuditRaw> => {
  const insights = (range: DateRange, extra: Params, step: string) =>
    client.getAll(`${account}/insights`, auditInsightsParams(range, extra), InsightsRowSchema, { step });
  const [campaigns, adSets, ads, adSetInsights, adInsightsCurrent, adInsightsPrevious, placementBreakdown, demographicBreakdown] =
    await Promise.all([
      client.getAll(`${account}/campaigns`, entityParams(AUDIT_CAMPAIGN_FIELDS), CampaignSchema, { step: "audit-campaigns" }),
      client.getAll(`${account}/adsets`, entityParams(AUDIT_ADSET_FIELDS), AdSetSchema, { step: "audit-adsets" }),
      client.getAll(`${account}/ads`, entityParams(AUDIT_AD_FIELDS), AdSchema, { step: "audit-ads" }),
      insights(windows.current, { level: "adset", fields: ADSET_INSIGHTS_FIELDS }, "audit-insights-adset"),
      insights(windows.current, { level: "ad", fields: AD_INSIGHTS_FIELDS }, "audit-insights-ad"),
      insights(windows.previous, { level: "ad", fields: AD_INSIGHTS_FIELDS }, "audit-insights-ad-previous"),
      insights(
        windows.current,
        { level: "account", fields: BREAKDOWN_FIELDS, breakdowns: "publisher_platform,platform_position" },
        "audit-insights-placements",
      ),
      insights(
        windows.current,
        { level: "account", fields: BREAKDOWN_FIELDS, breakdowns: "age,gender" },
        "audit-insights-demographics",
      ),
    ]);
  return {
    campaigns,
    adSets,
    ads,
    adSetInsights,
    adInsightsCurrent,
    adInsightsPrevious,
    placementBreakdown,
    demographicBreakdown,
    windowDays: windows.days,
    resultAction,
  };
};

// ---------------------------------------------------------------------------
// Landing pages + PageSpeed Insights
// ---------------------------------------------------------------------------

/** Largest Contentful Paint above this is "poor" per Core Web Vitals. */
export const POOR_LCP_MS = 4000;

export interface PsiRun {
  /** Non-null when PSI was intentionally not run (reason for the report). */
  readonly skipped: string | null;
  readonly results: PsiResult[];
}

export const PSI_NO_KEY_REASON =
  "no credential — set PAGESPEED_API_KEY, pass --psi-key, or set psi_api_key in .adkit.secrets.yaml to diagnose the ads' landing pages";

/** Each campaign id → its ads' unique destination links, first-seen order. Pure. */
export const landingPagesByCampaign = (input: AuditInput): Record<string, readonly string[]> =>
  Object.fromEntries(
    input.campaigns.map((c) => [
      c.id,
      [...new Set(input.ads.filter((a) => a.campaignId === c.id).flatMap((a) => a.destinationLinks))],
    ]),
  );

/** Every unique destination link across campaigns. Pure. */
export const uniqueLandingPages = (byCampaign: Record<string, readonly string[]>): string[] => [
  ...new Set(Object.values(byCampaign).flat()),
];

/** One PSI HTTP call; a failure degrades to a per-URL error result, never a throw. */
const fetchPsi = async (doFetch: typeof fetch, url: string, apiKey: string): Promise<PsiResult> => {
  try {
    const resp = await doFetch(buildPsiRequestUrl(url, apiKey));
    return resp.ok ? parsePsiResponse(url, await resp.json()) : { ok: false, url, error: `PSI HTTP ${resp.status}` };
  } catch (e) {
    return { ok: false, url, error: e instanceof Error ? e.message : String(e) };
  }
};

/** Diagnose each URL once; no URLs → no calls, no key → skipped with a reason. */
export const runMetaPsi = async (urls: readonly string[], apiKey: string | null, doFetch: typeof fetch): Promise<PsiRun> =>
  urls.length === 0
    ? { skipped: null, results: [] }
    : apiKey === null
      ? { skipped: PSI_NO_KEY_REASON, results: [] }
      : { skipped: null, results: await Promise.all(urls.map((u) => fetchPsi(doFetch, u, apiKey))) };

/** Landing-page issues for one diagnosed URL (currently: poor mobile LCP). Pure. */
const landingPageEntries = (result: PsiResult): LandingPageEntry[] =>
  result.ok && result.lcpMs !== null && result.lcpMs > POOR_LCP_MS
    ? [
        {
          url: result.url,
          issue: "slow_mobile_lcp",
          detail: `mobile LCP ${Math.round(result.lcpMs)}ms (poor is > ${POOR_LCP_MS}ms) — ${result.renderBlocking.length} render-blocking, ${result.unusedJs.length} unused-JS opportunities`,
          lcpMs: result.lcpMs,
        },
      ]
    : [];

/** Campaign id → landing-page issues for its destination links; clean campaigns are omitted. Pure. */
export const metaLandingPageHealth = (
  byCampaign: Record<string, readonly string[]>,
  psi: PsiRun,
): Record<string, LandingPageEntry[]> => {
  const byUrl = new Map(psi.results.map((r) => [r.url, landingPageEntries(r)] as const));
  return Object.fromEntries(
    Object.entries(byCampaign)
      .map(([id, urls]) => [id, urls.flatMap((u) => byUrl.get(u) ?? [])] as const)
      .filter(([, entries]) => entries.length > 0),
  );
};

/**
 * Lines for the shared `renderLandingPageHealth`, which keys campaigns by number.
 * Meta ids exceed `Number.MAX_SAFE_INTEGER`, so campaigns are keyed by position and
 * the label carries the real id. Pure.
 */
export const renderMetaLandingPageHealth = (
  campaigns: readonly Pick<Campaign, "id" | "name">[],
  health: Record<string, LandingPageEntry[]>,
): string[] => {
  const present = campaigns.filter((c) => health[c.id] !== undefined);
  return renderLandingPageHealth(
    Object.fromEntries(present.map((c, i) => [i, health[c.id] ?? []])),
    Object.fromEntries(present.map((c, i) => [i, `${c.name} (${c.id})`])),
  );
};

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

export interface MetaAuditCampaign {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly findings: readonly MetaFinding[];
}

/** Per-campaign findings in input order. Pure. */
export const auditCampaigns = (input: AuditInput, score: MetaScore): MetaAuditCampaign[] =>
  input.campaigns.map((c) => ({ id: c.id, name: c.name, status: c.status, findings: score.campaigns[c.id] ?? [] }));

// ---------------------------------------------------------------------------
// IO shell
// ---------------------------------------------------------------------------

/** Injected effects: context resolution, client construction, PSI `fetch`, clock. */
export interface MetaAuditDeps {
  readonly clientFactory: (ctx: MetaContext) => MetaClient;
  readonly resolveContext: (flags: MetaContextFlags) => Promise<MetaContext>;
  readonly fetch: typeof fetch;
  readonly now: () => Date;
}

interface StepFailure {
  readonly step: string;
  readonly message: string;
}

type StepResult<T> = { readonly kind: "ok"; readonly value: T } | { readonly kind: "err"; readonly failure: StepFailure };

/** Run one step's effect, turning a throw into a {@link StepFailure} labelled `step`. */
const runStep = async <T>(step: string, effect: () => Promise<T>): Promise<StepResult<T>> => {
  try {
    return { kind: "ok", value: await effect() };
  } catch (exc) {
    return { kind: "err", failure: failureFrom(exc, step) };
  }
};

const fail = (failure: StepFailure): number => {
  emitJson(errorEnvelope(failure.message, { step: failure.step }));
  return 1;
};

/**
 * Run the Meta audit: human report on stderr, JSON envelope on stdout. Returns the
 * exit code. `deps` is injectable so tests run without config files or the network.
 */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  deps: Partial<MetaAuditDeps> = {},
): Promise<number> {
  const clientFactory = deps.clientFactory ?? defaultClientFactory;
  const resolveContext = deps.resolveContext ?? ((flags: MetaContextFlags) => resolveMetaContextFromProcess(flags, env));
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? (() => new Date());

  const args = parseMetaAuditArgs(argv);
  if (args.kind === "err") return fail({ step: "args", message: args.message });
  const { flags, days, resultAction } = args.value;

  const ctx = await runStep("credentials", () => resolveContext(flags));
  if (ctx.kind === "err") return fail(ctx.failure);
  const { adAccountId, psiApiKey } = ctx.value;

  const client = await runStep("credentials", async () => clientFactory(ctx.value));
  if (client.kind === "err") return fail(client.failure);

  const windows = auditWindows(now(), days);
  const raw = await runStep("audit-read", () => fetchMetaAuditRaw(client.value, adAccountId, windows, resultAction));
  if (raw.kind === "err") return fail(raw.failure);

  const input = toAuditRows(raw.value);
  const score = scoreMetaAccount(input);
  emitLines(renderMetaAudit({ campaigns: input.campaigns, score, windowDays: days }));

  const pages = landingPagesByCampaign(input);
  const psi = await runMetaPsi(uniqueLandingPages(pages), psiApiKey, doFetch);
  const landingPageHealth = metaLandingPageHealth(pages, psi);
  emitLines(renderMetaLandingPageHealth(input.campaigns, landingPageHealth));
  emitLines(renderPsi(psi));

  emitJson(
    ok({
      platform: "meta",
      adAccountId,
      window: { ...windows.current, days, previous: windows.previous },
      resultAction,
      campaigns: auditCampaigns(input, score),
      account: score.account,
      landingPageHealth,
      psi: { skipped: psi.skipped, results: psi.results },
    }),
  );
  return 0;
}

// Run as a CLI entrypoint when invoked directly (not through bin/audit.ts).
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
