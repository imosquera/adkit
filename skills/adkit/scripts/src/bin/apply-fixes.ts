/**
 * IO entry: apply a fixes plan (JSON) produced from an /adkit audit run.
 *
 * The model authors the plan (product-specific copy); this script validates it
 * against the same RSA rules /adkit create enforces, then mutates. Dry-run unless
 * `--apply`.
 *
 * Plan JSON shape (all sections optional):
 * {
 *   "customerId": "8911925499",
 *   "loginCustomerId": null,
 *   "landingUrl": "https://www.example.com/ideas/<slug>",   // default for new sitelinks
 *   "rewrites":  [{"adId": 123, "headlines": [<15>], "descriptions": [<4>]}],   // full replace
 *   "appendHeadlines": [{"adId": 123, "add": ["..."]}],      // merge with live, keep existing
 *   "sitelinks": [{"campaignId": 456, "add": [{"text","finalUrl","description1","description2"}]}],
 *   "callouts":  [{"campaignId": 456, "add": ["No new portal", "Live in 30 days"]}],
 *   "negatives": [{"campaignId": 456, "add": ["free", {"text": "talk to ai", "matchType": "PHRASE"}]}],
 *   "keywords":  [{"adGroupId": 789, "add": ["ai reply tool"], "remove": [...], "pause": [...]}],
 *   "budgets":   [{"campaignId": 456, "dailyMicros": 50000000, "maxRaisePct": 100}],
 *   "campaignStatus": [{"campaignId": "456", "status": "ENABLED"}],  // flip a campaign on/off
 *   "adGroupStatus": [{"adGroupId": "789", "status": "PAUSED"}]      // flip an ad group on/off
 * }
 *
 * Negative keywords block off-theme search terms. Each `add` item is a bare string
 * (defaults to PHRASE) or {"text","matchType"} with matchType EXACT/PHRASE/BROAD.
 * Negatives already present on the campaign are skipped (a plan is safe to re-run).
 *
 * Positive `keywords` edit an ad group's own keywords: ADD, REMOVE, PAUSE. Match
 * type is immutable on a live criterion, so a "change match type" is REMOVE(old) +
 * ADD(new) in one block. REMOVE/PAUSE of a keyword not on the ad group rejects the
 * whole plan; ADDs already live are skipped (idempotent).
 *
 * Budgets carry a hard guardrail: a raise above 50% over the current budget is
 * rejected (a plan's `maxRaisePct` can only lower that). Lowering is always allowed.
 * A budget shared by multiple campaigns is changed for all of them.
 *
 * campaignStatus / adGroupStatus flip on (ENABLED) / off (PAUSED). Idempotent — the
 * live status is read first and a no-op flip is reported as skipped, not mutated.
 * PAUSE is always allowed; ENABLE starts live spend, so it is surfaced loudly (a
 * warning line + a distinct key in the JSON envelope). The harness/permission layer
 * gates the live-spend action.
 *
 * Usage: ads.sh update plan.json [--apply]   (alias: ads.sh apply-fixes)
 */

import { readFileSync, statSync } from "node:fs";
import { isMainModule } from "../cli/entry.js";
import { formatGoogleAdsError } from "../ads/errors.js";

import { setAdGroupStatus, setCampaignStatus, buildKeywordOps, buildNegativeKeywordOps } from "../ads/entities.js";
import { emitJson, errorEnvelope, ok } from "../cli/output.js";
import {
  adGroupStatusPlan,
  campaignStatusPlan,
  coerceKeyword,
  newNegatives,
  newPositiveKeywords,
  posKey,
  validate,
  type StatusPlanEntry,
} from "../fixes/plan.js";
import {
  applyAdGroupStatusesQuery,
  applyBudgetsQuery,
  applyCampaignStatusesQuery,
  applyHeadlinesQuery,
  applyNegativesQuery,
  applyPositiveKeywordsQuery,
} from "../gaql/builders.js";
import { enums } from "google-ads-api";
import type { AdsClient, AdsMutateOperation } from "../lib/auth.js";
import { loadClient } from "../lib/auth.js";

// ---------------------------------------------------------------------------
// SDK row shapes — only the fields this shell reads. google-ads-api returns
// nested snake_case records; enum fields arrive as their STRING name already
// (so `row.campaign.status` === "ENABLED"), micros as numbers.
// ---------------------------------------------------------------------------

interface NegativeRow {
  campaign: { id: number };
  campaign_criterion: { keyword: { text: string; match_type: string } };
}

interface CampaignStatusRow {
  campaign: { id: number; status: string };
}

interface AdGroupStatusRow {
  ad_group: { id: number; status: string };
}

interface BudgetRow {
  campaign: { id: number };
  campaign_budget: { resource_name: string; amount_micros: number };
}

interface PositiveKeywordRow {
  ad_group: { id: number };
  ad_group_criterion: {
    resource_name: string;
    keyword: { text: string; match_type: string };
  };
}

interface HeadlineRow {
  ad_group_ad: { ad: { id: number; responsive_search_ad: { headlines: Array<{ text: string }> } } };
}

/** Serialize a positive/negative keyword identity tuple into a map key. */
function identityKey(key: [string, string]): string {
  return `${key[0]} ${key[1]}`;
}

// ---------------------------------------------------------------------------
// Live-state fetchers — each builds a lookup map from the query rows via a
// functional reduce (mirrors the Python's recently-refactored `_live_*`).
// ---------------------------------------------------------------------------

/** campaignId -> Set of "text matchType" negative identities already on the campaign. */
export async function liveNegatives(
  client: AdsClient,
  customerId: string,
  campaignIds: ReadonlyArray<string | number>,
): Promise<Map<number, Set<string>>> {
  if (campaignIds.length === 0) {
    return new Map();
  }
  const rows = await client.search<NegativeRow>(customerId, applyNegativesQuery(campaignIds));
  return rows.reduce((acc, r) => {
    const set = acc.get(r.campaign.id) ?? new Set<string>();
    set.add(identityKey([r.campaign_criterion.keyword.text.toLowerCase(), r.campaign_criterion.keyword.match_type]));
    acc.set(r.campaign.id, set);
    return acc;
  }, new Map<number, Set<string>>());
}

/** campaignId -> current campaign.status name, so a no-op flip can be skipped. */
export async function liveCampaignStatuses(
  client: AdsClient,
  customerId: string,
  campaignIds: ReadonlyArray<string | number>,
): Promise<Map<number, string>> {
  if (campaignIds.length === 0) {
    return new Map();
  }
  const rows = await client.search<CampaignStatusRow>(customerId, applyCampaignStatusesQuery(campaignIds));
  return rows.reduce((acc, r) => acc.set(r.campaign.id, r.campaign.status), new Map<number, string>());
}

/** adGroupId -> current ad_group.status name, so a no-op flip can be skipped. */
export async function liveAdGroupStatuses(
  client: AdsClient,
  customerId: string,
  adGroupIds: ReadonlyArray<string | number>,
): Promise<Map<number, string>> {
  if (adGroupIds.length === 0) {
    return new Map();
  }
  const rows = await client.search<AdGroupStatusRow>(customerId, applyAdGroupStatusesQuery(adGroupIds));
  return rows.reduce((acc, r) => acc.set(r.ad_group.id, r.ad_group.status), new Map<number, string>());
}

/** campaignId -> {resource, amountMicros} for the campaign's current budget. */
export async function campaignBudgets(
  client: AdsClient,
  customerId: string,
  campaignIds: ReadonlyArray<string | number>,
): Promise<Map<number, { resource: string; amountMicros: number }>> {
  if (campaignIds.length === 0) {
    return new Map();
  }
  const rows = await client.search<BudgetRow>(customerId, applyBudgetsQuery(campaignIds));
  return rows.reduce(
    (acc, r) =>
      acc.set(r.campaign.id, {
        resource: r.campaign_budget.resource_name,
        amountMicros: r.campaign_budget.amount_micros,
      }),
    new Map<number, { resource: string; amountMicros: number }>(),
  );
}

/**
 * adGroupId -> {(text.lower matchType): criterionResource} for the live POSITIVE
 * keywords on each ad group — used to dedup ADDs and resolve REMOVE/PAUSE targets to
 * their criterion resource name.
 */
export async function livePositiveKeywords(
  client: AdsClient,
  customerId: string,
  adGroupIds: ReadonlyArray<string | number>,
): Promise<Map<number, Map<string, string>>> {
  if (adGroupIds.length === 0) {
    return new Map();
  }
  const rows = await client.search<PositiveKeywordRow>(customerId, applyPositiveKeywordsQuery(adGroupIds));
  return rows.reduce((acc, r) => {
    const inner = acc.get(r.ad_group.id) ?? new Map<string, string>();
    inner.set(
      identityKey(posKey(r.ad_group_criterion.keyword.text, r.ad_group_criterion.keyword.match_type)),
      r.ad_group_criterion.resource_name,
    );
    acc.set(r.ad_group.id, inner);
    return acc;
  }, new Map<number, Map<string, string>>());
}

/** adId -> live RSA headline texts, for an appendHeadlines merge. */
export async function liveHeadlines(
  client: AdsClient,
  customerId: string,
  adIds: ReadonlyArray<string | number>,
): Promise<Map<number, string[]>> {
  if (adIds.length === 0) {
    return new Map();
  }
  const rows = await client.search<HeadlineRow>(customerId, applyHeadlinesQuery(adIds));
  return rows.reduce(
    (acc, r) => acc.set(r.ad_group_ad.ad.id, r.ad_group_ad.ad.responsive_search_ad.headlines.map((h) => h.text)),
    new Map<number, string[]>(),
  );
}

// ---------------------------------------------------------------------------
// Plan typing — the parsed plan is read ONCE at the top and threaded through as a
// typed structure. Sections are permissive (Record) because `validate` is the
// authority on shape; downstream code only touches sections it has validated.
// ---------------------------------------------------------------------------

/** The parsed fixes plan. All sections are optional. */
interface FixesPlan extends Record<string, unknown> {
  customerId?: unknown;
  loginCustomerId?: string | null;
  landingUrl?: string;
  rewrites?: Array<Record<string, unknown>>;
  appendHeadlines?: Array<Record<string, unknown>>;
  sitelinks?: Array<Record<string, unknown>>;
  callouts?: Array<Record<string, unknown>>;
  negatives?: Array<Record<string, unknown>>;
  keywords?: Array<Record<string, unknown>>;
  budgets?: Array<Record<string, unknown>>;
  campaignStatus?: Array<Record<string, unknown>>;
  adGroupStatus?: Array<Record<string, unknown>>;
}

/** A plan section as a typed array (empty when absent). */
function section(plan: FixesPlan, key: keyof FixesPlan): Array<Record<string, unknown>> {
  const value = plan[key];
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
}

/** Format micros as a $X.XX dollar amount (Python `${x/1e6:.2f}`). */
function dollars(micros: number): string {
  return `$${(micros / 1e6).toFixed(2)}`;
}

/**
 * Apply a fixes plan. Dry-run by default; `--apply` mutates. Returns a process exit
 * code: 0 on success (incl. dry-run), 1 on validation failure, 2 on bad args.
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const apply = argv.includes("--apply");
  const paths = argv.filter((a) => !a.startsWith("--"));
  if (paths.length === 0) {
    emitJson(errorEnvelope("Provide a fixes plan JSON path"));
    return 2;
  }
  const planPath = paths[0]!;
  const isFile = (() => {
    try {
      return statSync(planPath).isFile();
    } catch {
      return false;
    }
  })();
  if (!isFile) {
    emitJson(errorEnvelope(`plan file not found: ${planPath}`));
    return 2;
  }
  // PARSE, DON'T VALIDATE: read + parse the plan JSON ONCE into a typed structure.
  const plan = JSON.parse(readFileSync(planPath, "utf8")) as FixesPlan;
  if (!("customerId" in plan) || plan.customerId === undefined) {
    emitJson(errorEnvelope("plan is missing required 'customerId'"));
    return 2;
  }
  const customer = String(plan.customerId);
  // Mirror the Python `plan.get("loginCustomerId")`: always an explicit value (null
  // when absent), so load_client clears the MCC header for direct-access accounts.
  const login = plan.loginCustomerId ?? null;
  const defaultUrl = plan.landingUrl;

  const client = loadClient(login);

  // Fetch every live-state map the plan touches (pure builders above).
  const live = await liveHeadlines(
    client,
    customer,
    section(plan, "appendHeadlines").map((a) => a.adId as string | number),
  );
  const budgets = await campaignBudgets(
    client,
    customer,
    section(plan, "budgets").map((b) => b.campaignId as string | number),
  );
  const liveNeg = await liveNegatives(
    client,
    customer,
    section(plan, "negatives").map((n) => n.campaignId as string | number),
  );
  const livePos = await livePositiveKeywords(
    client,
    customer,
    section(plan, "keywords").map((k) => k.adGroupId as string | number),
  );
  const liveStatus = await liveCampaignStatuses(
    client,
    customer,
    section(plan, "campaignStatus").map((c) => c.campaignId as string | number),
  );
  const liveAgStatus = await liveAdGroupStatuses(
    client,
    customer,
    section(plan, "adGroupStatus").map((g) => g.adGroupId as string | number),
  );

  const errs = validate(plan, live, budgets, livePos);
  if (errs.length > 0) {
    console.log("VALIDATION FAILED:");
    for (const e of errs) {
      console.log("  -", e);
    }
    return 1;
  }

  const [statusChanges, statusSkips] = campaignStatusPlan(section(plan, "campaignStatus"), liveStatus);
  const enableChanges = statusChanges.filter((c) => c.status === "ENABLED");
  const [agStatusChanges, agStatusSkips] = adGroupStatusPlan(section(plan, "adGroupStatus"), liveAgStatus);
  const agEnableChanges = agStatusChanges.filter((g) => g.status === "ENABLED");

  /**
   * Surface the campaign/ad-group on/off plan as a machine-readable envelope so the
   * changes/skips (and any live-spend ENABLE) are never lost in narration.
   */
  const emitStatusEnvelope = (applied: boolean): void => {
    if (!(section(plan, "campaignStatus").length > 0 || section(plan, "adGroupStatus").length > 0)) {
      return;
    }
    emitJson(
      ok({
        applied,
        campaignStatusChanges: statusChanges,
        campaignStatusSkipped: statusSkips,
        enableStartsLiveSpend: enableChanges.map((c) => c.campaignId),
        adGroupStatusChanges: agStatusChanges,
        adGroupStatusSkipped: agStatusSkips,
        adGroupEnableStartsLiveSpend: agEnableChanges.map((g) => g.adGroupId),
      }),
    );
  };

  const actions: string[] = [
    ...section(plan, "rewrites").map((r) => `rewrite ad ${strOf(r.adId)} -> 15H/4D`),
    ...section(plan, "appendHeadlines").map((a) => {
      const cur = live.get(asId(a.adId)) ?? [];
      const add = Array.isArray(a.add) ? (a.add as string[]) : [];
      return `append ${add.filter((h) => !cur.includes(h)).length} headlines to ad ${strOf(a.adId)}`;
    }),
    ...section(plan, "sitelinks").map((s) => `+${lenOf(s.add)} sitelinks on campaign ${strOf(s.campaignId)}`),
    ...section(plan, "callouts").map((c) => `+${lenOf(c.add)} callouts on campaign ${strOf(c.campaignId)}`),
    ...section(plan, "negatives").map((n) => {
      const fresh = newNegatives(n, liveNeg).length;
      return (
        `+${fresh} negative keywords on campaign ${strOf(n.campaignId)}` +
        ` (${lenOf(n.add) - fresh} already present)`
      );
    }),
    ...section(plan, "keywords").map((k) => {
      const fresh = newPositiveKeywords(k, livePos).length;
      return (
        `keywords adGroup ${strOf(k.adGroupId)}: +${fresh} add` +
        ` (${lenOf(k.add) - fresh} already present),` +
        ` -${lenOf(k.remove)} remove, ~${lenOf(k.pause)} pause`
      );
    }),
    ...section(plan, "budgets").map((b) => {
      const cur = budgets.get(asId(b.campaignId))!.amountMicros;
      return `budget campaign ${strOf(b.campaignId)}: ${dollars(cur)} -> ${dollars(b.dailyMicros as number)}/day`;
    }),
    ...statusChanges.map((c) => `campaign ${strOf(c.campaignId)}: status ${strOf(c.current)} -> ${strOf(c.status)}`),
    ...statusSkips.map((c) => `campaign ${strOf(c.campaignId)}: status already ${strOf(c.status)}, skipped`),
    ...agStatusChanges.map((g) => `adGroup ${strOf(g.adGroupId)}: status ${strOf(g.current)} -> ${strOf(g.status)}`),
    ...agStatusSkips.map((g) => `adGroup ${strOf(g.adGroupId)}: status already ${strOf(g.status)}, skipped`),
  ];
  console.log("validation ok. planned actions:");
  for (const a of actions) {
    console.log("  -", a);
  }
  if (enableChanges.length > 0) {
    // ENABLE starts live spend — make it impossible to miss (the permission layer
    // gates the actual mutation; this just guarantees it is never silent).
    console.log(
      "WARNING: ENABLE starts live spend on campaign(s): " +
        enableChanges.map((c) => String(c.campaignId)).join(", "),
    );
  }
  if (agEnableChanges.length > 0) {
    // Enabling an ad group resumes live spend on its keywords — same loud surface.
    console.log(
      "WARNING: ENABLE resumes live spend on ad group(s): " +
        agEnableChanges.map((g) => String(g.adGroupId)).join(", "),
    );
  }
  if (!apply) {
    console.log("\nDry run. Re-run with --apply.");
    emitStatusEnvelope(false);
    return 0;
  }

  // ===== mutation sequence (IO edge — imperative, print-as-you-go) =====

  // 1) RSA rewrites + appends
  const adOps: AdsMutateOperation[] = [];
  for (const rw of section(plan, "rewrites")) {
    adOps.push(rsaUpdateOp(customer, rw.adId, rw.headlines as string[], rw.descriptions as string[]));
  }
  for (const ap of section(plan, "appendHeadlines")) {
    const cur = live.get(asId(ap.adId)) ?? [];
    const add = Array.isArray(ap.add) ? (ap.add as string[]) : [];
    const full = [...cur, ...add.filter((h) => !cur.includes(h))];
    adOps.push(rsaUpdateOp(customer, ap.adId, full, null));
  }
  if (adOps.length > 0) {
    for (const r of (await client.mutate(customer, adOps)).results) {
      console.log("  mutated", r.resource_name);
    }
  }

  // 2) sitelinks
  for (const sl of section(plan, "sitelinks")) {
    const add = Array.isArray(sl.add) ? (sl.add as Array<Record<string, unknown>>) : [];
    for (const s of add) {
      const sitelinkAsset: Record<string, unknown> = { link_text: s.text };
      if (s.description1) {
        sitelinkAsset["description1"] = s.description1;
      }
      if (s.description2) {
        sitelinkAsset["description2"] = s.description2;
      }
      const assetOp: AdsMutateOperation = {
        entity: "asset",
        operation: "create",
        resource: { sitelink_asset: sitelinkAsset, final_urls: [(s.finalUrl as string) || (defaultUrl as string)] },
      };
      const arn = (await client.mutate(customer, [assetOp])).results[0]!.resource_name;
      const linkOp: AdsMutateOperation = {
        entity: "campaign_asset",
        operation: "create",
        resource: {
          campaign: `customers/${customer}/campaigns/${strOf(sl.campaignId)}`,
          asset: arn,
          field_type: enums.AssetFieldType.SITELINK,
        },
      };
      await client.mutate(customer, [linkOp]);
      console.log(`  sitelink ${pyRepr(s.text)} -> campaign ${strOf(sl.campaignId)}`);
    }
  }

  // 3) callouts
  for (const co of section(plan, "callouts")) {
    const add = Array.isArray(co.add) ? (co.add as string[]) : [];
    for (const text of add) {
      const assetOp: AdsMutateOperation = {
        entity: "asset",
        operation: "create",
        resource: { callout_asset: { callout_text: text } },
      };
      const arn = (await client.mutate(customer, [assetOp])).results[0]!.resource_name;
      const linkOp: AdsMutateOperation = {
        entity: "campaign_asset",
        operation: "create",
        resource: {
          campaign: `customers/${customer}/campaigns/${strOf(co.campaignId)}`,
          asset: arn,
          field_type: enums.AssetFieldType.CALLOUT,
        },
      };
      await client.mutate(customer, [linkOp]);
      console.log(`  callout ${pyRepr(text)} -> campaign ${strOf(co.campaignId)}`);
    }
  }

  // 4) negative keywords (dedup against live, then add as campaign criteria)
  for (const ng of section(plan, "negatives")) {
    const cid = ng.campaignId;
    const kws = newNegatives(ng, liveNeg);
    if (kws.length === 0) {
      console.log(`  negatives campaign ${strOf(cid)}: all ${lenOf(ng.add)} already present, skipped`);
      continue;
    }
    const ops = buildNegativeKeywordOps(`customers/${customer}/campaigns/${strOf(cid)}`, kws);
    await client.mutate(customer, ops);
    console.log(
      `  +${kws.length} negative keywords -> campaign ${strOf(cid)}: ` +
        kws.map((k) => `${k.text}[${k.matchType[0]}]`).join(", "),
    );
  }

  // 4b) positive keyword edits (add / remove / pause on ad-group criteria)
  for (const kb of section(plan, "keywords")) {
    const agid = kb.adGroupId;
    const adds = newPositiveKeywords(kb, livePos);
    const liveKeys = livePos.get(asId(agid)) ?? new Map<string, string>();
    const rn = (item: unknown): string => {
      const [kw] = coerceKeyword(item);
      return liveKeys.get(identityKey(posKey(kw!.text, kw!.matchType)))!;
    };
    const removeRns = (Array.isArray(kb.remove) ? kb.remove : []).map(rn);
    const pauseRns = (Array.isArray(kb.pause) ? kb.pause : []).map(rn);
    const ops = buildKeywordOps(`customers/${customer}/adGroups/${strOf(agid)}`, adds, removeRns, pauseRns);
    if (ops.length === 0) {
      console.log(`  keywords adGroup ${strOf(agid)}: nothing to do (all adds already present)`);
      continue;
    }
    await client.mutate(customer, ops);
    console.log(
      `  keywords adGroup ${strOf(agid)}: +${adds.length} add, -${removeRns.length} remove, ~${pauseRns.length} pause`,
    );
  }

  // 5) budgets (guardrail already enforced in validate)
  for (const b of section(plan, "budgets")) {
    const cid = b.campaignId;
    const op: AdsMutateOperation = {
      entity: "campaign_budget",
      operation: "update",
      resource: {
        resource_name: budgets.get(asId(cid))!.resource,
        amount_micros: b.dailyMicros,
      },
    };
    await client.mutate(customer, [op]);
    console.log(`  budget campaign ${strOf(cid)} -> ${dollars(b.dailyMicros as number)}/day`);
  }

  // 6) campaign on/off. No-op flips were already filtered into statusSkips and never
  // reach the mutate (idempotent). PAUSE is always safe; ENABLE was surfaced loudly.
  for (const c of statusChanges) {
    await setCampaignStatus(client, customer, String(c.campaignId), c.status as "ENABLED" | "PAUSED");
    console.log(`  campaign ${strOf(c.campaignId)}: status ${strOf(c.current)} -> ${strOf(c.status)}`);
  }
  for (const c of statusSkips) {
    console.log(`  campaign ${strOf(c.campaignId)}: status already ${strOf(c.status)}, skipped`);
  }

  // 7) ad group on/off. Same idempotent + loud-ENABLE contract, one level down.
  for (const g of agStatusChanges) {
    await setAdGroupStatus(client, customer, String(g.adGroupId), g.status as "ENABLED" | "PAUSED");
    console.log(`  adGroup ${strOf(g.adGroupId)}: status ${strOf(g.current)} -> ${strOf(g.status)}`);
  }
  for (const g of agStatusSkips) {
    console.log(`  adGroup ${strOf(g.adGroupId)}: status already ${strOf(g.status)}, skipped`);
  }
  emitStatusEnvelope(true);
  return 0;
}

// ---------------------------------------------------------------------------
// Small formatting/coercion helpers (kept local — pure, no IO).
// ---------------------------------------------------------------------------

/** Render an id/value for a `{x}` (str) slot; None for null/undefined. */
function strOf(value: unknown): string {
  if (value === undefined || value === null) {
    return "None";
  }
  return String(value);
}

/** Length of a value that may not be an array (0 when absent). */
function lenOf(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/** Coerce an id to the integer key the live-state maps are keyed by. */
function asId(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }
  return Number.parseInt(String(value), 10);
}

/** Python `repr` for a string value used in a print line (single-quoted). */
function pyRepr(value: unknown): string {
  if (typeof value === "string") {
    return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  }
  return String(value);
}

/**
 * Build the RSA update op. google-ads-api derives the update mask from the fields
 * present on the `responsive_search_ad` resource. `headlines`/`descriptions` are set
 * only when non-null (an append passes descriptions === null to leave them untouched).
 */
function rsaUpdateOp(
  customerId: string,
  adId: unknown,
  headlines: string[] | null,
  descriptions: string[] | null,
): AdsMutateOperation {
  const rsa: Record<string, unknown> = {};
  if (headlines !== null) {
    rsa["headlines"] = headlines.map((text) => ({ text }));
  }
  if (descriptions !== null) {
    rsa["descriptions"] = descriptions.map((text) => ({ text }));
  }
  return {
    entity: "ad",
    operation: "update",
    resource: {
      resource_name: `customers/${customerId}/ads/${strOf(adId)}`,
      responsive_search_ad: rsa,
    },
  };
}

// Re-export a type used by tests asserting on the status plan entries.
export type { StatusPlanEntry };

if (isMainModule(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      emitJson(errorEnvelope(formatGoogleAdsError(err)));
      process.exit(1);
    });
}
