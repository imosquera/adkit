/**
 * IO entry: apply a fixes plan (YAML) produced from an /adkit audit run.
 *
 * The model authors the plan (product-specific copy); this script validates it
 * against the same RSA rules /adkit create enforces, then mutates. Dry-run unless
 * `--apply`.
 *
 * The plan is authored in YAML — the same format `/adkit create` and the
 * `adbriefs/<slug>.yaml` source of truth use, so there is one config format across
 * the toolkit. JSON is a subset of YAML, so a legacy `.json` plan still parses
 * through the same front door (`loadPlan`); there is no second parser or schema.
 *
 * Plan shape (all sections optional):
 * {
 *   "customerId": "1111111111",
 *   "loginCustomerId": null,
 *   "landingUrl": "https://www.example.com/ideas/<slug>",   // default for new sitelinks
 *   "rewrites":  [{"adId": 123, "headlines": [<15>], "descriptions": [<4>], "path1"?: "demo", "path2"?: "trial", "finalUrl"?: "https://..."}],   // full replace; optional display-path change / URL repoint
 *   "appendHeadlines": [{"adId": 123, "add": ["..."]}],      // merge with live, keep existing
 *   "sitelinks": [{"campaignId": 456, "add": [{"text","finalUrl","description1","description2"}]}],
 *   "callouts":  [{"campaignId": 456, "add": ["No new portal", "Live in 30 days"]}],
 *   "negatives": [{"campaignId": 456, "add": ["free", {"text": "talk to ai", "matchType": "PHRASE"}]}],
 *   "keywords":  [{"adGroupId": 789, "add": ["ai reply tool"], "remove": [...], "pause": [...]}],
 *   "budgets":   [{"campaignId": 456, "dailyMicros": 50000000, "maxRaisePct": 100}],
 *   "campaignStatus": [{"campaignId": "456", "status": "ENABLED"}],  // flip a campaign on/off
 *   "adGroupStatus": [{"adGroupId": "789", "status": "PAUSED"}],     // flip an ad group on/off
 *   "adStatus": [{"adId": "123", "status": "ENABLED"}],             // flip a single ad on/off (e.g. enable a new group's PAUSED ad)
 *   "adGroups":  [{"campaignId": 456, "adGroup": {<brief ad group: name, defaultBidMicros, responsiveSearchAds (exactly 2), keywords>}}],  // add a new ad group
 *   "languages": [{"campaignId": 456}]                               // make the campaign English-only
 * }
 *
 * languages makes a campaign serve in English only: it adds the English language
 * criterion and removes any other live language criteria (Google's default is an
 * implicit "all languages"). Idempotent — an already-English campaign is reported
 * skipped, never duplicated.
 *
 * A new ad group (`adGroups`) is authored in the same shape a /adkit create brief ad
 * group uses (full 15/4 RSA + 1–30 keywords), validated by the same AdGroupSchema.
 * Its RSA is created PAUSED (won't serve until enabled), and a name already live in
 * the campaign is skipped — re-running never duplicates a group.
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
 * Usage: ads.sh update plan.yaml [--apply]   (alias: ads.sh apply-fixes)
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as yamlParse, YAMLParseError } from "yaml";
import { z } from "zod";
import { isMainModule } from "../cli/entry.js";
import { formatGoogleAdsError } from "../ads/errors.js";
import { ADBRIEFS_DIR, AdbriefsError, writeBrief } from "../adbriefs/store.js";
import { diffBriefs, type BriefDiff } from "../adbriefs/diff.js";
import { loadStateIndex } from "../adbriefs/state.js";
import {
  applyPlanToBrief,
  resolvePlanGroups,
  type ApplyPlanComputed,
  type ResolvedPlanGroup,
} from "../adbriefs/apply-plan.js";
import { parseBrief, type Brief } from "../lib/schema.js";

import {
  createAdGroup,
  createKeywords,
  createResponsiveSearchAd,
  setAdGroupStatus,
  setAdGroupAdStatus,
  setCampaignStatus,
  setSearchPartners,
  buildKeywordOps,
  buildLanguageOps,
  buildNegativeKeywordOps,
  ENGLISH_LANGUAGE_CONSTANT,
} from "../ads/entities.js";
import { emitJson, errorEnvelope, ok } from "../cli/output.js";
import { pyRepr, pyStr } from "../cli/py-format.js";
import {
  addAdGroupsPlan,
  adGroupStatusPlan,
  adStatusPlan,
  biddingPlan,
  campaignStatusPlan,
  coerceKeyword,
  keyStr,
  negKey,
  newNegatives,
  newPositiveKeywords,
  posKey,
  searchPartnersPlan,
  validate,
  type AdGroupCreatePlanEntry,
  type SearchPartnersPlanEntry,
  type StatusPlanEntry,
} from "../fixes/plan.js";
import {
  applyAdGroupNamesQuery,
  applyAdGroupStatusesQuery,
  applyAdStatusesQuery,
  applyBiddingGuardQuery,
  applyBudgetsQuery,
  applyCampaignStatusesQuery,
  applyHeadlinesQuery,
  applyLanguagesQuery,
  applyNegativesQuery,
  applyPositiveKeywordsQuery,
  applySearchPartnersQuery,
} from "../gaql/builders.js";
import { enums } from "google-ads-api";
import { matchTypeName } from "../ads/enums.js";
import type { AdsClient, AdsMutateOperation } from "../lib/auth.js";
import { loadClient } from "../lib/auth.js";

// ---------------------------------------------------------------------------
// SDK row shapes — only the fields this shell reads. google-ads-api returns
// nested snake_case records and micros as numbers. Enum fields are NOT uniform:
// some (e.g. `campaign.status`) arrive as their STRING name, but keyword
// `match_type` arrives as the RAW NUMERIC enum (e.g. 3). It is typed
// `string | number` here and decoded via `matchTypeName` at the read site.
// ---------------------------------------------------------------------------

interface NegativeRow {
  campaign: { id: number };
  campaign_criterion: { keyword: { text: string; match_type: string | number } };
}

interface CampaignStatusRow {
  campaign: { id: number; status: string };
}

interface AdGroupStatusRow {
  ad_group: { id: number; status: string };
}

interface AdStatusRow {
  ad_group: { id: number };
  // ad_group_ad.status arrives as the raw numeric enum (decoded via adGroupAdStatusName).
  ad_group_ad: { ad: { id: number }; status: string | number };
}

// network_settings is optional here (not `{ target_search_network: boolean }`
// outright) because the API omits an empty embedded message from the response;
// liveSearchPartners below treats a missing row/field as "unknown" rather than
// dereferencing it and crashing (mirrors how audit.ts treats quality_info).
interface SearchPartnersRow {
  campaign: {
    id: number;
    network_settings?: { target_search_network?: boolean; target_google_search?: boolean };
  };
}

interface BudgetRow {
  campaign: { id: number };
  campaign_budget: { resource_name: string; amount_micros: number };
}

interface BiddingGuardRow {
  campaign: {
    id: number;
    bidding_strategy_type: string;
    target_cpa?: { target_cpa_micros?: number };
    target_roas?: { target_roas?: number };
    target_spend?: { cpc_bid_ceiling_micros?: number };
  };
  metrics: { conversions: number; average_cpc: number };
}

/**
 * Normalize a campaign's live target/ceiling value to whichever field its live bid
 * strategy actually uses — target_cpa_micros on TARGET_CPA, target_roas on
 * TARGET_ROAS, cpc_bid_ceiling_micros on TARGET_SPEND (maximize-clicks), undefined
 * for MAXIMIZE_CONVERSIONS (no comparable value) or when the API omits the nested
 * oneof branch. Used only for the idempotent-skip comparison in apply-fixes.ts —
 * without it, a maximize-clicks entry that only changes cpcBidCeilingMicros would be
 * indistinguishable from a true no-op (both strategy and this value would otherwise
 * read as undefined/undefined). Never consulted by biddingErrors.
 */
function liveBiddingTargetValue(campaign: BiddingGuardRow["campaign"]): number | undefined {
  if (campaign.bidding_strategy_type === "TARGET_CPA") {
    return campaign.target_cpa?.target_cpa_micros;
  }
  if (campaign.bidding_strategy_type === "TARGET_ROAS") {
    return campaign.target_roas?.target_roas;
  }
  if (campaign.bidding_strategy_type === "TARGET_SPEND") {
    return campaign.target_spend?.cpc_bid_ceiling_micros;
  }
  return undefined;
}

interface PositiveKeywordRow {
  ad_group: { id: number };
  ad_group_criterion: {
    resource_name: string;
    keyword: { text: string; match_type: string | number };
  };
}

interface HeadlineRow {
  ad_group_ad: { ad: { id: number; responsive_search_ad: { headlines: Array<{ text: string }> } } };
}

interface AdGroupNameRow {
  campaign: { id: number };
  ad_group: { name: string };
}

interface LanguageRow {
  campaign: { id: number };
  campaign_criterion: { resource_name: string; language: { language_constant: string } };
}

// Live-state maps are keyed with plan.ts's `keyStr` (imported above) so the
// keys this shell builds are byte-identical to the ones plan.ts's `validate`
// and dedup helpers look them up by. Match types are decoded to their string
// name first (`matchTypeName`), since the plan side always speaks the name.

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
  const rows = await client.searchStructured<NegativeRow>(customerId, applyNegativesQuery(campaignIds));
  return rows.reduce((acc, r) => {
    const set = acc.get(r.campaign.id) ?? new Set<string>();
    set.add(keyStr(negKey(r.campaign_criterion.keyword.text, matchTypeName(r.campaign_criterion.keyword.match_type))));
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
  const rows = await client.searchStructured<CampaignStatusRow>(customerId, applyCampaignStatusesQuery(campaignIds));
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
  const rows = await client.searchStructured<AdGroupStatusRow>(customerId, applyAdGroupStatusesQuery(adGroupIds));
  return rows.reduce((acc, r) => acc.set(r.ad_group.id, r.ad_group.status), new Map<number, string>());
}

/**
 * adId -> {status, adGroupId}. The status map drives the idempotent no-op skip; the
 * adGroup map resolves the ad_group_ad resource name at apply time (it needs both
 * ids, but an adStatus block only carries the adId).
 */
export async function liveAdStatuses(
  client: AdsClient,
  customerId: string,
  adIds: ReadonlyArray<string | number>,
): Promise<{ status: Map<number, string>; adGroup: Map<number, number> }> {
  if (adIds.length === 0) {
    return { status: new Map(), adGroup: new Map() };
  }
  const rows = await client.search<AdStatusRow>(customerId, applyAdStatusesQuery(adIds));
  return rows.reduce(
    (acc, r) => {
      acc.status.set(r.ad_group_ad.ad.id, adGroupAdStatusName(r.ad_group_ad.status));
      acc.adGroup.set(r.ad_group_ad.ad.id, r.ad_group.id);
      return acc;
    },
    { status: new Map<number, string>(), adGroup: new Map<number, number>() },
  );
}

/**
 * ad_group_ad.status arrives as the RAW NUMERIC enum (e.g. 3), unlike campaign.status
 * and ad_group.status which arrive as their string name. Decode to the name so the
 * idempotent no-op skip in adStatusPlan compares like-for-like ("ENABLED"/"PAUSED").
 */
function adGroupAdStatusName(status: string | number): string {
  return typeof status === "number" ? (enums.AdGroupAdStatus[status] ?? String(status)) : status;
}

/**
 * campaignId -> {enabled, googleSearchEnabled} read from network_settings, so a
 * no-op flip can be skipped and an ENABLE against a campaign with
 * target_google_search=false can be rejected up front (Google Ads rejects that
 * combination server-side). A campaign whose network_settings (or either boolean
 * inside it) is absent from the response is omitted from the map entirely rather
 * than defaulted — it falls into the existing "no live data" (unknown) handling in
 * searchPartnersPlan/searchPartnersPreconditionErrors instead of throwing.
 */
export async function liveSearchPartners(
  client: AdsClient,
  customerId: string,
  campaignIds: ReadonlyArray<string | number>,
): Promise<Map<number, { enabled: boolean; googleSearchEnabled: boolean }>> {
  if (campaignIds.length === 0) {
    return new Map();
  }
  const rows = await client.searchStructured<SearchPartnersRow>(customerId, applySearchPartnersQuery(campaignIds));
  return rows.reduce((acc, r) => {
    const ns = r.campaign.network_settings;
    if (ns?.target_search_network === undefined || ns?.target_google_search === undefined) {
      return acc;
    }
    acc.set(r.campaign.id, { enabled: ns.target_search_network, googleSearchEnabled: ns.target_google_search });
    return acc;
  }, new Map<number, { enabled: boolean; googleSearchEnabled: boolean }>());
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
  const rows = await client.searchStructured<BudgetRow>(customerId, applyBudgetsQuery(campaignIds));
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
 * campaignId -> {biddingStrategyType, conversions30d, avgCpcMicros30d, targetValue}
 * over a fixed trailing 30 days, for the bidding guardrail (refuse a risky
 * maximize-conversions -> maximize-clicks downgrade), the idempotent-skip check
 * (targetValue), and the ceiling-sanity warning. Fixed to 30 days regardless of any
 * other setting — there is no --days flag on update.
 */
export async function biddingGuardState(
  client: AdsClient,
  customerId: string,
  campaignIds: ReadonlyArray<string | number>,
): Promise<
  Map<number, { biddingStrategyType: string; conversions30d: number; avgCpcMicros30d: number; targetValue?: number }>
> {
  if (campaignIds.length === 0) {
    return new Map();
  }
  const rows = await client.searchStructured<BiddingGuardRow>(customerId, applyBiddingGuardQuery(campaignIds));
  return rows.reduce(
    (acc, r) =>
      acc.set(r.campaign.id, {
        biddingStrategyType: r.campaign.bidding_strategy_type,
        conversions30d: r.metrics.conversions,
        avgCpcMicros30d: r.metrics.average_cpc,
        targetValue: liveBiddingTargetValue(r.campaign),
      }),
    new Map<
      number,
      { biddingStrategyType: string; conversions30d: number; avgCpcMicros30d: number; targetValue?: number }
    >(),
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
  const rows = await client.searchStructured<PositiveKeywordRow>(customerId, applyPositiveKeywordsQuery(adGroupIds));
  return rows.reduce((acc, r) => {
    const inner = acc.get(r.ad_group.id) ?? new Map<string, string>();
    inner.set(
      keyStr(posKey(r.ad_group_criterion.keyword.text, matchTypeName(r.ad_group_criterion.keyword.match_type))),
      r.ad_group_criterion.resource_name,
    );
    acc.set(r.ad_group.id, inner);
    return acc;
  }, new Map<number, Map<string, string>>());
}

/**
 * campaignId -> Set of lowercased live (non-removed) ad-group names, so an
 * `adGroups` (add-ad-group) block can skip a name that already exists in the target
 * campaign (the add is idempotent — re-running never creates a duplicate group).
 */
export async function liveAdGroupNames(
  client: AdsClient,
  customerId: string,
  campaignIds: ReadonlyArray<string | number>,
): Promise<Map<number, Set<string>>> {
  if (campaignIds.length === 0) {
    return new Map();
  }
  const rows = await client.searchStructured<AdGroupNameRow>(customerId, applyAdGroupNamesQuery(campaignIds));
  return rows.reduce((acc, r) => {
    const set = acc.get(r.campaign.id) ?? new Set<string>();
    set.add(r.ad_group.name.toLowerCase());
    acc.set(r.campaign.id, set);
    return acc;
  }, new Map<number, Set<string>>());
}

/** campaignId -> Map<languageConstantRn, criterionRn> of live language criteria. */
export async function liveLanguages(
  client: AdsClient,
  customerId: string,
  campaignIds: ReadonlyArray<string | number>,
): Promise<Map<number, Map<string, string>>> {
  if (campaignIds.length === 0) {
    return new Map();
  }
  const rows = await client.searchStructured<LanguageRow>(customerId, applyLanguagesQuery(campaignIds));
  return rows.reduce((acc, r) => {
    const inner = acc.get(r.campaign.id) ?? new Map<string, string>();
    inner.set(r.campaign_criterion.language.language_constant, r.campaign_criterion.resource_name);
    acc.set(r.campaign.id, inner);
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
  const rows = await client.searchStructured<HeadlineRow>(customerId, applyHeadlinesQuery(adIds));
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
export interface FixesPlan extends Record<string, unknown> {
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
  bidding?: Array<Record<string, unknown>>;
  campaignStatus?: Array<Record<string, unknown>>;
  adGroupStatus?: Array<Record<string, unknown>>;
  adStatus?: Array<Record<string, unknown>>;
  searchPartners?: Array<Record<string, unknown>>;
  adGroups?: Array<Record<string, unknown>>;
  languages?: Array<Record<string, unknown>>;
}

/**
 * Read + parse an update plan file into the loose {@link FixesPlan} structure. The
 * plan is authored in YAML (the format `/adkit create` and `adbriefs/<slug>.yaml`
 * use); JSON is a subset of YAML, so a legacy `.json` plan parses through this same
 * front door with no second parser. `validate` (zod) remains the sole authority on
 * shape — this only turns text into an object.
 */
export function loadPlan(path: string): FixesPlan {
  return yamlParse(readFileSync(path, "utf8")) as FixesPlan;
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

// ---------------------------------------------------------------------------
// adbriefs staging (US1-US4) — resolve the plan's ids to their owning brief slug
// (via the state-file reverse index), stage the already-computed changes into a
// proposed copy of that brief, diff it against disk, and (on --apply, only after
// the live mutation completes) persist it. No section here duplicates plan.ts's
// change-list decisions — it only reuses their already-computed outputs.
// ---------------------------------------------------------------------------

/** Path to `adbriefs/<slug>.yaml`, given a slug already resolved via the state index. */
function briefPathForSlug(root: string, slug: string): string {
  return join(root, ADBRIEFS_DIR, `${slug}.yaml`);
}

/**
 * Read + parse `adbriefs/<slug>.yaml`, or `null` if it doesn't exist. Mirrors
 * `adbriefs/store.ts`'s brief-parse contract (throws {@link AdbriefsError} on bad
 * YAML/schema) without needing a {@link Brief} in hand to derive the path — `update`
 * already knows the slug from the state index, unlike `create` which derives it from a
 * freshly-authored brief (store.ts's `loadBriefIfExists` is not reusable here for
 * exactly that reason, and store.ts is otherwise unchanged by this feature).
 */
function loadBriefAtSlug(root: string, slug: string): Brief | null {
  const path = briefPathForSlug(root, slug);
  if (!existsSync(path)) {
    return null;
  }
  let data: unknown;
  try {
    data = yamlParse(readFileSync(path, "utf8"));
  } catch (exc) {
    if (exc instanceof YAMLParseError) {
      const where = exc.linePos?.[0] ? ` (line ${exc.linePos[0].line})` : "";
      throw new AdbriefsError(`adbriefs brief is not valid YAML${where}: ${exc.message.split("\n")[0]}`);
    }
    throw exc;
  }
  try {
    return parseBrief(data);
  } catch (exc) {
    if (exc instanceof z.ZodError) {
      const lines = exc.errors.map((e) => `  - ${e.path.map((p) => String(p)).join(".")}: ${e.message}`);
      throw new AdbriefsError(`adbriefs brief at ${path} failed validation:\n${lines.join("\n")}`);
    }
    throw exc;
  }
}

/** Every reason brief staging can be skipped for a resolved slug, never a silent drop. */
type BriefStagingSkipReason = "collision" | "missing-brief" | "invalid-brief" | "invalid-result";

/** One resolved slug's staged brief: the diff against disk, and why staging was skipped, if it was. */
interface StagedBrief {
  slug: string;
  current: Brief | null;
  proposed: Brief | null;
  diff: BriefDiff | null;
  /** null when staging succeeded; otherwise the reason no diff/write happened for this slug. */
  skipReason: BriefStagingSkipReason | null;
  message?: string;
}

/**
 * Stage every resolved plan group into its on-disk brief and diff it (FR-002, FR-003).
 * A slug whose on-disk brief names a *different* campaign than the state index expects
 * is refused (FR-007, mirrors `create`'s `assertNoForeignBrief`) rather than silently
 * staged against the wrong campaign; a slug with a state file but no brief on disk
 * (deleted by hand) is skipped with an explicit reason, never fabricated. A slug whose
 * on-disk brief fails to parse (corrupt YAML / schema violation) is skipped the same
 * way rather than crashing the whole run — an unrelated resolved campaign in the same
 * plan must still get staged. The `applyPlanToBrief` result is re-parsed through
 * `parseBrief` before it is trusted: `store.ts`'s `writeBrief` does NOT re-validate
 * before writing, so a proposed brief that would violate `BriefSchema` (e.g. more than
 * 15 headlines after a dedup-survives append, or an empty `keywords` after a
 * remove-only edit) must never reach the diff/write path — it is skipped instead of
 * silently corrupting `adbriefs/<slug>.yaml`.
 */
function stageResolvedGroups(root: string, groups: ResolvedPlanGroup[], computed: ApplyPlanComputed): StagedBrief[] {
  return groups
    .filter((g) => g.slug !== "")
    .map((group) => {
      let current: Brief | null;
      try {
        current = loadBriefAtSlug(root, group.slug);
      } catch (exc) {
        if (exc instanceof AdbriefsError) {
          return {
            slug: group.slug,
            current: null,
            proposed: null,
            diff: null,
            skipReason: "invalid-brief" as const,
            message:
              `adbriefs brief ${briefPathForSlug(root, group.slug)} could not be parsed — ` +
              `${exc.message.split("\n")[0]}. Skipping brief staging for this campaign.`,
          };
        }
        throw exc;
      }
      if (current === null) {
        return { slug: group.slug, current: null, proposed: null, diff: null, skipReason: "missing-brief" as const };
      }
      if (current.campaign.name !== group.campaignName) {
        return {
          slug: group.slug,
          current,
          proposed: null,
          diff: null,
          skipReason: "collision" as const,
          message:
            `adbriefs collision: ${briefPathForSlug(root, group.slug)} already describes campaign ` +
            `"${current.campaign.name}", but the plan's state index resolved it as "${group.campaignName}". ` +
            "Refusing to stage — rename one campaign or move the brief.",
        };
      }
      const candidate = applyPlanToBrief(current, group, computed);
      let proposed: Brief;
      try {
        proposed = parseBrief(candidate);
      } catch (exc) {
        if (exc instanceof z.ZodError) {
          const lines = exc.errors.map((e) => `  - ${e.path.map((p) => String(p)).join(".")}: ${e.message}`);
          return {
            slug: group.slug,
            current,
            proposed: null,
            diff: null,
            skipReason: "invalid-result" as const,
            message:
              `adbriefs staging for ${briefPathForSlug(root, group.slug)} produced a brief that violates its ` +
              `schema:\n${lines.join("\n")}\nSkipping — nothing written for this campaign.`,
          };
        }
        throw exc;
      }
      const diff = diffBriefs(current, proposed);
      return { slug: group.slug, current, proposed, diff, skipReason: null };
    });
}

/**
 * Slugs (deduped, order-preserving) that `ids` resolve to via a {@link StateIndex} id
 * map — used to conservatively attribute a per-step/per-entry mutation failure to the
 * brief(s) it touched, via the SAME reverse index already loaded for staging (no new
 * query). An id with no record in `indexMap` (unresolved, or resolved to no brief)
 * contributes nothing — a failure never gets attributed to a slug that was never
 * staged in the first place.
 */
function slugsForIds(ids: ReadonlyArray<unknown>, indexMap: Map<string, { slug: string }>): string[] {
  return [...new Set(ids.map((id) => indexMap.get(String(id))?.slug).filter((s): s is string => s !== undefined))];
}

/** One mutation step (or one entry within it) that failed — the error plus the brief slug(s)
 * it's conservatively attributed to (possibly none, if none of its ids resolved to a brief). */
interface StepFailure {
  step: string;
  error: unknown;
  slugs: string[];
}

/** Envelope entry for one staged brief (FR-009). */
function briefEnvelopeEntry(
  root: string,
  s: StagedBrief,
  synced: boolean,
  writtenPath: string | null,
): Record<string, unknown> {
  return {
    slug: s.slug,
    briefPath: writtenPath ?? (s.skipReason === null ? briefPathForSlug(root, s.slug) : null),
    briefSynced: synced,
    briefDiff: s.diff ? { changed: s.diff.changed, added: s.diff.added, removed: s.diff.removed } : null,
    briefStagingSkipped: s.skipReason !== null,
    briefStagingSkipReason: s.skipReason,
  };
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
  // PARSE, DON'T VALIDATE: read + parse the plan YAML ONCE into a typed structure.
  let plan: FixesPlan;
  try {
    plan = loadPlan(planPath);
  } catch (exc) {
    if (exc instanceof YAMLParseError) {
      const where = exc.linePos?.[0] ? ` (line ${exc.linePos[0].line})` : "";
      emitJson(errorEnvelope(`plan is not valid YAML${where}: ${exc.message.split("\n")[0]}`));
      return 2;
    }
    throw exc;
  }
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
  const bidding = await biddingGuardState(
    client,
    customer,
    section(plan, "bidding").map((b) => b.campaignId as string | number),
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
  const liveAdSt = await liveAdStatuses(
    client,
    customer,
    section(plan, "adStatus").map((a) => a.adId as string | number),
  );
  const liveSp = await liveSearchPartners(
    client,
    customer,
    section(plan, "searchPartners").map((s) => s.campaignId as string | number),
  );
  const liveAgNames = await liveAdGroupNames(
    client,
    customer,
    section(plan, "adGroups").map((g) => g.campaignId as string | number),
  );
  const liveLangs = await liveLanguages(
    client,
    customer,
    section(plan, "languages").map((l) => l.campaignId as string | number),
  );
  // Split into the two plain boolean maps the pure plan.ts functions expect:
  // current target_search_network (searchPartnersPlan's no-op-skip check) and
  // current target_google_search (searchPartnersPreconditionErrors' ENABLE guard).
  const liveSpEnabled = new Map([...liveSp].map(([id, v]) => [id, v.enabled]));
  const liveSpGoogleSearch = new Map([...liveSp].map(([id, v]) => [id, v.googleSearchEnabled]));

  // Idempotent-skip partition (spec.md 048 FR-002/FR-003): a bidding block whose
  // strategy and comparable target value already match the campaign's live state is
  // a no-op skip, computed ahead of validate() so a skip never reaches the downgrade
  // guardrail or issues a mutate call — mirrors campaignStatus's statusChanges/
  // statusSkips split below, just computed earlier since validate() needs it.
  const [biddingChanges, biddingSkips] = biddingPlan(section(plan, "bidding"), bidding);

  const errs = validate(plan, live, budgets, livePos, liveSpGoogleSearch, liveAdSt.adGroup, bidding, biddingChanges);
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
  const [adStatusChanges, adStatusSkips] = adStatusPlan(section(plan, "adStatus"), liveAdSt.status);
  const adEnableChanges = adStatusChanges.filter((a) => a.status === "ENABLED");
  const [spChanges, spSkips] = searchPartnersPlan(section(plan, "searchPartners"), liveSpEnabled);
  const spEnableChanges = spChanges.filter((c) => c.enabled === true);
  const [agCreates, agCreateSkips] = addAdGroupsPlan(section(plan, "adGroups"), liveAgNames);
  // languages: make each listed campaign English-only — add English if absent, remove
  // every other live language criterion. Idempotent: no ops when already English.
  const languageActions = section(plan, "languages").map((l) => {
    const live = liveLangs.get(asId(l.campaignId)) ?? new Map<string, string>();
    const addEnglish = !live.has(ENGLISH_LANGUAGE_CONSTANT);
    const remove = [...live].filter(([lc]) => lc !== ENGLISH_LANGUAGE_CONSTANT).map(([, rn]) => rn);
    return { campaignId: l.campaignId, addEnglish, remove };
  });

  // ----- adbriefs staging: resolve this plan's ids to their brief(s) via the state
  // index, stage the already-computed changes above into a proposed copy, and diff
  // against disk — on EVERY run, dry-run included (FR-001, FR-002, FR-003, FR-010).
  const adbriefsRoot = process.cwd();
  const stateIndex = loadStateIndex(adbriefsRoot);
  const noStateFileAtAll =
    stateIndex.byCampaignId.size === 0 && stateIndex.byAdGroupId.size === 0 && stateIndex.byAdId.size === 0;
  // A skipped bidding entry (biddingSkips) must never reach brief staging either — the
  // adbrief must not be rewritten to reflect a "change" that never actually happened
  // live (spec.md 048 FR-002). resolvePlanGroups reads plan.bidding directly, so a
  // stagingPlan with only biddingChanges substituted is passed in place of the raw
  // plan; every other section is staged from the plan unchanged.
  const stagingPlan = { ...plan, bidding: biddingChanges };
  const planGroups = resolvePlanGroups(stagingPlan, stateIndex);
  const unresolvedIds = planGroups.find((g) => g.slug === "")?.unresolvedIds ?? [];
  const staged = stageResolvedGroups(adbriefsRoot, planGroups, { defaultLandingUrl: defaultUrl, adGroupCreates: agCreates });

  for (const s of staged) {
    if (s.skipReason === "collision") {
      console.log(`WARNING: ${s.message}`);
      continue;
    }
    if (s.skipReason === "missing-brief") {
      console.log(
        `WARNING: adbriefs/${s.slug}.state.yaml exists but adbriefs/${s.slug}.yaml does not — ` +
          "skipping brief staging for this campaign",
      );
      continue;
    }
    if (s.skipReason === "invalid-brief" || s.skipReason === "invalid-result") {
      console.log(`WARNING: ${s.message}`);
      continue;
    }
    const path = briefPathForSlug(adbriefsRoot, s.slug);
    if (s.diff!.changed) {
      console.log(`\nadbriefs brief ${path} (+${s.diff!.added}/-${s.diff!.removed}):`);
      console.log(s.diff!.render);
    } else {
      console.log(`\nadbriefs brief ${path} unchanged`);
    }
  }
  if (unresolvedIds.length > 0) {
    console.log(
      "\nWARNING: plan references id(s) with no record in any adbriefs/*.state.yaml " +
        "(brief staging skipped for these; live mutation proceeds unaffected):",
    );
    for (const u of unresolvedIds) {
      console.log(`  - ${u.kind} ${u.id}`);
    }
  }
  const briefStagingSkipReason: "no-state-file" | "unresolvable-id" | BriefStagingSkipReason | null =
    unresolvedIds.length > 0
      ? noStateFileAtAll
        ? "no-state-file"
        : "unresolvable-id"
      : (staged.find((s) => s.skipReason !== null)?.skipReason ?? null);
  const briefStagingSkipped = unresolvedIds.length > 0 || staged.some((s) => s.skipReason !== null);

  /**
   * Surface the campaign/ad-group on/off plan (and the searchPartners toggle), plus the
   * adbriefs staging outcome, as a machine-readable envelope so the changes/skips (and
   * any live-spend/reach-increasing ENABLE, or brief-staging skip) are never lost in
   * narration (FR-009). Always emitted — brief-sync status must be reported on every run.
   */
  const emitStatusEnvelope = (applied: boolean, briefResults: Array<Record<string, unknown>>): void => {
    emitJson(
      ok({
        applied,
        campaignStatusChanges: statusChanges,
        campaignStatusSkipped: statusSkips,
        enableStartsLiveSpend: enableChanges.map((c) => c.campaignId),
        adGroupStatusChanges: agStatusChanges,
        adGroupStatusSkipped: agStatusSkips,
        adGroupEnableStartsLiveSpend: agEnableChanges.map((g) => g.adGroupId),
        adStatusChanges,
        adStatusSkipped: adStatusSkips,
        adEnableStartsLiveSpend: adEnableChanges.map((a) => a.adId),
        searchPartnersChanges: spChanges,
        searchPartnersSkipped: spSkips,
        searchPartnersEnableIncreasesReach: spEnableChanges.map((c) => c.campaignId),
        biddingChanges,
        biddingSkipped: biddingSkips,
        bidStrategyChangeAffectsSpend: bidStrategyChangeAffectsSpendIds,
        briefs: briefResults,
        briefStagingSkipped,
        briefStagingSkipReason,
        unresolvedPlanIds: unresolvedIds,
      }),
    );
  };

  const actions: string[] = [
    ...section(plan, "rewrites").map((r) => {
      const hasCopy = Array.isArray(r.headlines) || Array.isArray(r.descriptions);
      const paths = [r.path1, r.path2].filter((p): p is string => typeof p === "string");
      const pathNote = paths.length > 0 ? `display path /${paths.map((p) => p.toLowerCase()).join("/")}` : null;
      const parts = [hasCopy ? "15H/4D" : null, r.finalUrl != null ? "finalUrl" : null, pathNote].filter(Boolean);
      return `rewrite ad ${pyStr(r.adId)} -> ${parts.join(" + ")}`;
    }),
    ...section(plan, "appendHeadlines").map((a) => {
      const cur = live.get(asId(a.adId)) ?? [];
      const add = Array.isArray(a.add) ? (a.add as string[]) : [];
      return `append ${add.filter((h) => !cur.includes(h)).length} headlines to ad ${pyStr(a.adId)}`;
    }),
    ...section(plan, "sitelinks").map((s) => `+${lenOf(s.add)} sitelinks on campaign ${pyStr(s.campaignId)}`),
    ...section(plan, "callouts").map((c) => `+${lenOf(c.add)} callouts on campaign ${pyStr(c.campaignId)}`),
    ...section(plan, "negatives").map((n) => {
      const fresh = newNegatives(n, liveNeg).length;
      return (
        `+${fresh} negative keywords on campaign ${pyStr(n.campaignId)}` +
        ` (${lenOf(n.add) - fresh} already present)`
      );
    }),
    ...section(plan, "keywords").map((k) => {
      const fresh = newPositiveKeywords(k, livePos).length;
      return (
        `keywords adGroup ${pyStr(k.adGroupId)}: +${fresh} add` +
        ` (${lenOf(k.add) - fresh} already present),` +
        ` -${lenOf(k.remove)} remove, ~${lenOf(k.pause)} pause`
      );
    }),
    ...section(plan, "budgets").map((b) => {
      const cur = budgets.get(asId(b.campaignId))!.amountMicros;
      return `budget campaign ${pyStr(b.campaignId)}: ${dollars(cur)} -> ${dollars(b.dailyMicros as number)}/day`;
    }),
    ...biddingChanges.map((b) => {
      const cur = bidding.get(asId(b.campaignId))?.biddingStrategyType ?? "UNKNOWN";
      const ceiling = typeof b.cpcBidCeilingMicros === "number" ? ` (ceiling ${dollars(b.cpcBidCeilingMicros)})` : "";
      const targetCpa = typeof b.targetCpaMicros === "number" ? ` (target CPA ${dollars(b.targetCpaMicros)})` : "";
      const targetRoas = typeof b.targetRoas === "number" ? ` (target ROAS ${b.targetRoas}x)` : "";
      return `bidding campaign ${pyStr(b.campaignId)}: ${cur} -> ${pyStr(b.strategy)}${ceiling}${targetCpa}${targetRoas}`;
    }),
    ...biddingSkips.map((b) => `bidding campaign ${pyStr(b.campaignId)}: already ${pyStr(b.strategy)}, skipped`),
    ...statusChanges.map((c) => `campaign ${pyStr(c.campaignId)}: status ${pyStr(c.current)} -> ${pyStr(c.status)}`),
    ...statusSkips.map((c) => `campaign ${pyStr(c.campaignId)}: status already ${pyStr(c.status)}, skipped`),
    ...agStatusChanges.map((g) => `adGroup ${pyStr(g.adGroupId)}: status ${pyStr(g.current)} -> ${pyStr(g.status)}`),
    ...agStatusSkips.map((g) => `adGroup ${pyStr(g.adGroupId)}: status already ${pyStr(g.status)}, skipped`),
    ...adStatusChanges.map((a) => `ad ${pyStr(a.adId)}: status ${pyStr(a.current)} -> ${pyStr(a.status)}`),
    ...adStatusSkips.map((a) => `ad ${pyStr(a.adId)}: status already ${pyStr(a.status)}, skipped`),
    ...spChanges.map(
      (c) => `campaign ${pyStr(c.campaignId)}: search partners ${pyStr(c.current)} -> ${pyStr(c.enabled)}`,
    ),
    ...spSkips.map((c) => `campaign ${pyStr(c.campaignId)}: search partners already ${pyStr(c.enabled)}, skipped`),
    ...agCreates.map(
      (g) =>
        `+ ad group ${pyRepr(g.name)} -> campaign ${pyStr(g.campaignId)} ` +
        `(RSA 15H/4D + ${g.adGroup.keywords.length} keywords, ad PAUSED)`,
    ),
    ...agCreateSkips.map((g) => `ad group ${pyRepr(g.name)} already in campaign ${pyStr(g.campaignId)}, skipped`),
    ...languageActions.map((l) =>
      l.addEnglish || l.remove.length > 0
        ? `languages campaign ${pyStr(l.campaignId)}: English only (+${l.addEnglish ? 1 : 0} add, -${l.remove.length} remove)`
        : `languages campaign ${pyStr(l.campaignId)}: already English only, skipped`,
    ),
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
  if (adEnableChanges.length > 0) {
    // Enabling an ad makes it eligible to serve (live spend) — same loud surface.
    console.log(
      "WARNING: ENABLE starts live serving of ad(s): " +
        adEnableChanges.map((a) => String(a.adId)).join(", "),
    );
  }
  if (spEnableChanges.length > 0) {
    // Turning Search Partners ON increases reach (and spend) — loud surface, same as
    // ENABLE. Turning it OFF only narrows reach, so it never warns.
    console.log(
      "WARNING: search partners ON increases reach on campaign(s): " +
        spEnableChanges.map((c) => String(c.campaignId)).join(", "),
    );
  }
  // Ceiling-sanity warning (FR-006): non-blocking, deliberately outside validate()/
  // biddingErrors — a low ceiling is a self-inflicted misconfiguration risk, not a
  // reason to refuse the change.
  for (const b of biddingChanges) {
    const ceiling = b.cpcBidCeilingMicros;
    if (typeof ceiling !== "number") {
      continue;
    }
    const avgCpc = bidding.get(asId(b.campaignId))?.avgCpcMicros30d;
    if (typeof avgCpc === "number" && ceiling < avgCpc) {
      console.log(
        `WARNING: cpcBidCeilingMicros for campaign ${pyStr(b.campaignId)} (${dollars(ceiling)}) is below its ` +
          `trailing-30-day average CPC (${dollars(avgCpc)}) — this may starve the campaign of traffic.`,
      );
    }
  }
  // Spend-affecting bid-strategy warning (spec.md 048 FR-004): loud, non-blocking —
  // any REAL change (biddingChanges, never biddingSkips) into a strategy that lets the
  // platform optimize toward spend/conversions rather than clicks gets a WARNING: line
  // plus a campaign-ID entry in the bidStrategyChangeAffectsSpend envelope key, same
  // loud-not-silent treatment as enableStartsLiveSpend/
  // searchPartnersEnableIncreasesReach. Downgrading to maximize-clicks is excluded by
  // construction (never in this set) — mirrors PAUSE-is-always-safe elsewhere.
  const SPEND_AFFECTING_STRATEGIES = new Set(["maximize-conversions", "target-cpa", "target-roas"]);
  const bidStrategyChangeAffectsSpendIds = biddingChanges
    .filter((b) => SPEND_AFFECTING_STRATEGIES.has(b.strategy as string))
    .map((b) => b.campaignId);
  if (bidStrategyChangeAffectsSpendIds.length > 0) {
    console.log(
      "WARNING: bid strategy change affects spend optimization on campaign(s): " +
        bidStrategyChangeAffectsSpendIds.map((id) => pyStr(id)).join(", "),
    );
  }
  if (!apply) {
    console.log("\nDry run. Re-run with --apply.");
    // Dry-run NEVER writes adbriefs/ (FR-004) — every staged brief reports unsynced,
    // carrying only the preview diff computed above.
    emitStatusEnvelope(
      false,
      staged.map((s) => briefEnvelopeEntry(adbriefsRoot, s, false, null)),
    );
    return 0;
  }

  // ===== mutation sequence (IO edge — imperative, print-as-you-go) =====
  // Each numbered step (or, where a step already loops per section/campaign entry,
  // each entry within it) runs in its OWN try/catch: a thrown/rejected mutation is
  // caught, recorded against the brief slug(s) it's attributed to via `stateIndex`
  // (the same reverse index staging already resolved against), and the sequence
  // CONTINUES to the next independent step/entry rather than aborting the whole run.
  // This isolates a failure to the campaign(s)/brief(s) it actually touches (FR-006,
  // FR-010) instead of marking every staged brief across the whole run unsynced.
  const stepFailures: StepFailure[] = [];
  const recordFailure = (step: string, error: unknown, slugs: string[]): void => {
    stepFailures.push({ step, error, slugs });
    console.log(`  FAILED: ${step}: ${formatGoogleAdsError(error)}`);
  };

  // 1) RSA rewrites + appends — one batched mutate across every rewrite/append in the
  // plan, so a failure here cannot be isolated below the whole step (documented
  // conservative fallback): attribute it to every slug either section touches.
  try {
    const adOps: AdsMutateOperation[] = [];
    for (const rw of section(plan, "rewrites")) {
      // A rewrite may carry headlines/descriptions, a finalUrl, a display path, or a mix.
      // Absent asset arrays pass as null so a URL-only / path-only repoint leaves the live
      // RSA copy untouched.
      const hs = Array.isArray(rw.headlines) ? (rw.headlines as string[]) : null;
      const ds = Array.isArray(rw.descriptions) ? (rw.descriptions as string[]) : null;
      adOps.push(
        rsaUpdateOp(customer, rw.adId, hs, ds, {
          finalUrl: rw.finalUrl as string | undefined,
          path1: rw.path1,
          path2: rw.path2,
        }),
      );
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
  } catch (exc) {
    const ids = [
      ...section(plan, "rewrites").map((r) => r.adId),
      ...section(plan, "appendHeadlines").map((a) => a.adId),
    ];
    recordFailure("RSA rewrites/appendHeadlines", exc, slugsForIds(ids, stateIndex.byAdId));
  }

  // 2) sitelinks — one campaign's sitelinks failing does not block another's.
  for (const sl of section(plan, "sitelinks")) {
    try {
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
            campaign: `customers/${customer}/campaigns/${pyStr(sl.campaignId)}`,
            asset: arn,
            field_type: enums.AssetFieldType.SITELINK,
          },
        };
        await client.mutate(customer, [linkOp]);
        console.log(`  sitelink ${pyRepr(s.text)} -> campaign ${pyStr(sl.campaignId)}`);
      }
    } catch (exc) {
      recordFailure(`sitelinks (campaign ${pyStr(sl.campaignId)})`, exc, slugsForIds([sl.campaignId], stateIndex.byCampaignId));
    }
  }

  // 3) callouts — same per-campaign isolation as sitelinks.
  for (const co of section(plan, "callouts")) {
    try {
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
            campaign: `customers/${customer}/campaigns/${pyStr(co.campaignId)}`,
            asset: arn,
            field_type: enums.AssetFieldType.CALLOUT,
          },
        };
        await client.mutate(customer, [linkOp]);
        console.log(`  callout ${pyRepr(text)} -> campaign ${pyStr(co.campaignId)}`);
      }
    } catch (exc) {
      recordFailure(`callouts (campaign ${pyStr(co.campaignId)})`, exc, slugsForIds([co.campaignId], stateIndex.byCampaignId));
    }
  }

  // 4) negative keywords (dedup against live, then add as campaign criteria)
  for (const ng of section(plan, "negatives")) {
    const cid = ng.campaignId;
    try {
      const kws = newNegatives(ng, liveNeg);
      if (kws.length === 0) {
        console.log(`  negatives campaign ${pyStr(cid)}: all ${lenOf(ng.add)} already present, skipped`);
        continue;
      }
      const ops = buildNegativeKeywordOps(`customers/${customer}/campaigns/${pyStr(cid)}`, kws);
      await client.mutate(customer, ops);
      console.log(
        `  +${kws.length} negative keywords -> campaign ${pyStr(cid)}: ` +
          kws.map((k) => `${k.text}[${k.matchType[0]}]`).join(", "),
      );
    } catch (exc) {
      recordFailure(`negatives (campaign ${pyStr(cid)})`, exc, slugsForIds([cid], stateIndex.byCampaignId));
    }
  }

  // 4b) positive keyword edits (add / remove / pause on ad-group criteria)
  for (const kb of section(plan, "keywords")) {
    const agid = kb.adGroupId;
    try {
      const adds = newPositiveKeywords(kb, livePos);
      const liveKeys = livePos.get(asId(agid)) ?? new Map<string, string>();
      const rn = (item: unknown): string => {
        const [kw] = coerceKeyword(item);
        return liveKeys.get(keyStr(posKey(kw!.text, kw!.matchType)))!;
      };
      const removeRns = (Array.isArray(kb.remove) ? kb.remove : []).map(rn);
      const pauseRns = (Array.isArray(kb.pause) ? kb.pause : []).map(rn);
      const ops = buildKeywordOps(`customers/${customer}/adGroups/${pyStr(agid)}`, adds, removeRns, pauseRns);
      if (ops.length === 0) {
        console.log(`  keywords adGroup ${pyStr(agid)}: nothing to do (all adds already present)`);
        continue;
      }
      await client.mutate(customer, ops);
      console.log(
        `  keywords adGroup ${pyStr(agid)}: +${adds.length} add, -${removeRns.length} remove, ~${pauseRns.length} pause`,
      );
    } catch (exc) {
      recordFailure(`keywords (adGroup ${pyStr(agid)})`, exc, slugsForIds([agid], stateIndex.byAdGroupId));
    }
  }

  // 5) budgets (guardrail already enforced in validate)
  for (const b of section(plan, "budgets")) {
    const cid = b.campaignId;
    try {
      const op: AdsMutateOperation = {
        entity: "campaign_budget",
        operation: "update",
        resource: {
          resource_name: budgets.get(asId(cid))!.resource,
          amount_micros: b.dailyMicros,
        },
      };
      await client.mutate(customer, [op]);
      console.log(`  budget campaign ${pyStr(cid)} -> ${dollars(b.dailyMicros as number)}/day`);
    } catch (exc) {
      recordFailure(`budgets (campaign ${pyStr(cid)})`, exc, slugsForIds([cid], stateIndex.byCampaignId));
    }
  }

  // 5b) bidding (guardrail already enforced in validate; idempotent skips already
  // filtered out of biddingChanges, so every entry here is a real change — spec.md
  // 048 FR-002). maximize-clicks sets target_spend (with the ceiling, if given);
  // target-cpa/target-roas set their own oneof branch with the plan's target value;
  // maximize-conversions sets maximize_conversions with no companion field — the API
  // models bid strategy as a oneof, so sending one branch clears whichever the
  // campaign previously had.
  for (const b of biddingChanges) {
    const cid = b.campaignId;
    try {
      const resource: Record<string, unknown> = {
        resource_name: `customers/${customer}/campaigns/${pyStr(cid)}`,
      };
      if (b.strategy === "maximize-clicks") {
        resource["target_spend"] =
          typeof b.cpcBidCeilingMicros === "number" ? { cpc_bid_ceiling_micros: b.cpcBidCeilingMicros } : {};
      } else if (b.strategy === "target-cpa") {
        resource["target_cpa"] = { target_cpa_micros: b.targetCpaMicros };
      } else if (b.strategy === "target-roas") {
        resource["target_roas"] = { target_roas: b.targetRoas };
      } else {
        resource["maximize_conversions"] = {};
      }
      const op: AdsMutateOperation = { entity: "campaign", operation: "update", resource };
      await client.mutate(customer, [op]);
      console.log(`  bidding campaign ${pyStr(cid)} -> ${pyStr(b.strategy)}`);
    } catch (exc) {
      recordFailure(`bidding (campaign ${pyStr(cid)})`, exc, slugsForIds([cid], stateIndex.byCampaignId));
    }
  }

  // 6) campaign on/off. No-op flips were already filtered into statusSkips and never
  // reach the mutate (idempotent). PAUSE is always safe; ENABLE was surfaced loudly.
  for (const c of statusChanges) {
    try {
      await setCampaignStatus(client, customer, String(c.campaignId), c.status as "ENABLED" | "PAUSED");
      console.log(`  campaign ${pyStr(c.campaignId)}: status ${pyStr(c.current)} -> ${pyStr(c.status)}`);
    } catch (exc) {
      recordFailure(`campaignStatus (campaign ${pyStr(c.campaignId)})`, exc, slugsForIds([c.campaignId], stateIndex.byCampaignId));
    }
  }
  for (const c of statusSkips) {
    console.log(`  campaign ${pyStr(c.campaignId)}: status already ${pyStr(c.status)}, skipped`);
  }

  // 7) ad group on/off. Same idempotent + loud-ENABLE contract, one level down.
  for (const g of agStatusChanges) {
    try {
      await setAdGroupStatus(client, customer, String(g.adGroupId), g.status as "ENABLED" | "PAUSED");
      console.log(`  adGroup ${pyStr(g.adGroupId)}: status ${pyStr(g.current)} -> ${pyStr(g.status)}`);
    } catch (exc) {
      recordFailure(`adGroupStatus (adGroup ${pyStr(g.adGroupId)})`, exc, slugsForIds([g.adGroupId], stateIndex.byAdGroupId));
    }
  }
  for (const g of agStatusSkips) {
    console.log(`  adGroup ${pyStr(g.adGroupId)}: status already ${pyStr(g.status)}, skipped`);
  }

  // 7b) individual ad on/off. Resolve the parent adGroupId from live state (the
  // ad_group_ad resource name needs both ids). Same idempotent + loud-ENABLE contract.
  for (const a of adStatusChanges) {
    try {
      const adGroupId = liveAdSt.adGroup.get(asId(a.adId));
      await setAdGroupAdStatus(client, customer, String(adGroupId), String(a.adId), a.status as "ENABLED" | "PAUSED");
      console.log(`  ad ${pyStr(a.adId)}: status ${pyStr(a.current)} -> ${pyStr(a.status)}`);
    } catch (exc) {
      recordFailure(`adStatus (ad ${pyStr(a.adId)})`, exc, slugsForIds([a.adId], stateIndex.byAdId));
    }
  }
  for (const a of adStatusSkips) {
    console.log(`  ad ${pyStr(a.adId)}: status already ${pyStr(a.status)}, skipped`);
  }

  // 8) search partners on/off. No-op flips were already filtered into spSkips and
  // never reach the mutate (idempotent). OFF is always safe; ON was surfaced loudly.
  for (const c of spChanges) {
    try {
      await setSearchPartners(client, customer, String(c.campaignId), c.enabled as boolean);
      console.log(`  campaign ${pyStr(c.campaignId)}: search partners ${pyStr(c.current)} -> ${pyStr(c.enabled)}`);
    } catch (exc) {
      recordFailure(`searchPartners (campaign ${pyStr(c.campaignId)})`, exc, slugsForIds([c.campaignId], stateIndex.byCampaignId));
    }
  }
  for (const c of spSkips) {
    console.log(`  campaign ${pyStr(c.campaignId)}: search partners already ${pyStr(c.enabled)}, skipped`);
  }

  // 8c) language targeting: make each listed campaign English-only. Idempotent — an
  // already-English campaign yields no ops and is reported skipped.
  for (const l of languageActions) {
    try {
      const ops = buildLanguageOps(`customers/${customer}/campaigns/${pyStr(l.campaignId)}`, l.addEnglish, l.remove);
      if (ops.length === 0) {
        console.log(`  languages campaign ${pyStr(l.campaignId)}: already English only, skipped`);
        continue;
      }
      await client.mutate(customer, ops);
      console.log(
        `  languages campaign ${pyStr(l.campaignId)}: English only (+${l.addEnglish ? 1 : 0} add, -${l.remove.length} remove)`,
      );
    } catch (exc) {
      recordFailure(`languages (campaign ${pyStr(l.campaignId)})`, exc, slugsForIds([l.campaignId], stateIndex.byCampaignId));
    }
  }

  // 9) new ad groups. A name already live in the campaign was filtered into
  // agCreateSkips (idempotent — never a duplicate group). Each create mirrors the
  // /adkit create sequence one ad group at a time: ad group (ENABLED) -> RSAs
  // (PAUSED) -> keywords (ENABLED). The PAUSED ads mean the group cannot serve until
  // they're enabled, so adding a group to a live campaign starts no spend on its own.
  for (const g of agCreates) {
    try {
      const campaignRn = `customers/${customer}/campaigns/${pyStr(g.campaignId)}`;
      const agRn = await createAdGroup(client, customer, g.adGroup, campaignRn);
      // allSettled (not Promise.all): if one RSA create fails after the other
      // already succeeded live in Ads, still let the surviving id be created —
      // Promise.all would abort/discard on the first rejection, and since a rerun
      // always re-creates RSAs (no findExisting for them, unlike the ad group), a
      // silently-dropped success would mean the next run creates yet another RSA
      // on top of the orphan, drifting past RSAS_PER_AD_GROUP. See publish.ts.
      const rsaOutcomes = await Promise.allSettled(
        g.adGroup.responsiveSearchAds.map((rsa) => createResponsiveSearchAd(client, customer, rsa, agRn)),
      );
      const failedRsa = rsaOutcomes.find((o): o is PromiseRejectedResult => o.status === "rejected");
      if (failedRsa) {
        throw failedRsa.reason;
      }
      const kwRns = await createKeywords(client, customer, g.adGroup, agRn);
      console.log(
        `  + ad group ${pyRepr(g.name)} -> campaign ${pyStr(g.campaignId)}: ` +
          `${g.adGroup.responsiveSearchAds.length}x RSA 15H/4D + ${kwRns.length} keywords (ad PAUSED)`,
      );
    } catch (exc) {
      recordFailure(`adGroups (new group in campaign ${pyStr(g.campaignId)})`, exc, slugsForIds([g.campaignId], stateIndex.byCampaignId));
    }
  }
  for (const g of agCreateSkips) {
    console.log(`  ad group ${pyRepr(g.name)} already in campaign ${pyStr(g.campaignId)}, skipped`);
  }

  // Persist each staged brief ONLY after the live mutation sequence above completed
  // (FR-005) — mutate-then-write. A slug touched by ANY step's failure (`failedSlugs`)
  // is left unwritten and reported unsynced (FR-006); a slug untouched by any failure
  // is written/reported synced independently, even in the SAME run as a failing slug
  // (FR-010 — one campaign's failure never blocks another's brief from syncing). A
  // no-op diff is never rewritten (FR-011).
  const failedSlugs = new Set(stepFailures.flatMap((f) => f.slugs));
  // Each write runs in its OWN try/catch: writeBrief can throw (foreign-brief race,
  // AdbriefsError, EACCES/ENOSPC/etc), and a thrown write for one slug must never
  // abort this .map() — every OTHER slug's already-successful mutation still needs
  // to be written and reported, or the operator loses the whole envelope (not just
  // the one failing slug) while debugging a live run. A write failure is recorded via
  // `recordFailure` (same mechanism as a mutation-step failure) so it surfaces in the
  // "diverged" warning and the error envelope alongside any mutation failures.
  const writeFailedSlugs = new Set<string>();
  const briefResults = staged.map((s) => {
    if (s.skipReason !== null || s.diff === null || failedSlugs.has(s.slug)) {
      return briefEnvelopeEntry(adbriefsRoot, s, false, null);
    }
    if (!s.diff.changed) {
      return briefEnvelopeEntry(adbriefsRoot, s, true, null);
    }
    try {
      const path = writeBrief(adbriefsRoot, s.proposed!);
      return briefEnvelopeEntry(adbriefsRoot, s, true, path);
    } catch (exc) {
      writeFailedSlugs.add(s.slug);
      recordFailure(`writeBrief (adbriefs/${s.slug}.yaml)`, exc, [s.slug]);
      return briefEnvelopeEntry(adbriefsRoot, s, false, null);
    }
  });
  const allFailedSlugs = new Set([...failedSlugs, ...writeFailedSlugs]);

  if (stepFailures.length > 0) {
    console.log(
      "\nWARNING: local adbriefs brief(s) and the live account have diverged — " +
        `${stepFailures.length} mutation step(s) failed partway through this run:`,
    );
    for (const f of stepFailures) {
      console.log(`  - ${f.step}: ${formatGoogleAdsError(f.error)}`);
      if (f.slugs.length > 0) {
        console.log(`    affected brief(s): ${f.slugs.join(", ")}`);
      }
    }
    for (const s of staged) {
      if (s.skipReason === null && s.diff && s.diff.changed && allFailedSlugs.has(s.slug)) {
        console.log(`  - adbriefs/${s.slug}.yaml NOT updated (would have changed +${s.diff.added}/-${s.diff.removed})`);
      }
    }
    const syncedSlugs = staged
      .filter((s) => s.skipReason === null && s.diff !== null && !allFailedSlugs.has(s.slug))
      .map((s) => s.slug);
    if (syncedSlugs.length > 0) {
      console.log(`  brief(s) synced successfully despite the above failure(s): ${syncedSlugs.join(", ")}`);
    }
    emitJson(
      errorEnvelope(stepFailures.map((f) => `${f.step}: ${formatGoogleAdsError(f.error)}`).join("; "), {
        briefs: briefResults,
        briefStagingSkipped: true,
        briefStagingSkipReason: briefStagingSkipReason ?? "live-mutation-failed",
        unresolvedPlanIds: unresolvedIds,
        errors: stepFailures.map((f) => ({
          step: f.step,
          message: formatGoogleAdsError(f.error),
          slugs: f.slugs,
        })),
      }),
    );
    return 1;
  }

  emitStatusEnvelope(true, briefResults);
  return 0;
}

// ---------------------------------------------------------------------------
// Small formatting/coercion helpers (kept local — pure, no IO).
// ---------------------------------------------------------------------------

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

/**
 * Build the RSA update op. google-ads-api derives the update mask from the fields
 * present on the `responsive_search_ad` resource. `headlines`/`descriptions` are set
 * only when non-null (an append passes descriptions === null to leave them untouched).
 * `path1`/`path2` (the display-URL segments) are set only when provided, so a
 * copy-only rewrite leaves the ad's existing display path untouched; they are
 * lowercased to match /adkit create. `finalUrl` repoints the ad's landing URL and
 * lives on the Ad resource (sibling of responsive_search_ad), set only when present.
 * Values are already boundary-validated by `rewritesErrors` (displayPathPairErrors)
 * before this builder runs.
 */
export function rsaUpdateOp(
  customerId: string,
  adId: unknown,
  headlines: string[] | null,
  descriptions: string[] | null,
  opts?: { finalUrl?: string | null; path1?: unknown; path2?: unknown },
): AdsMutateOperation {
  const rsa: Record<string, unknown> = {};
  if (headlines !== null) {
    rsa["headlines"] = headlines.map((text) => ({ text }));
  }
  if (descriptions !== null) {
    rsa["descriptions"] = descriptions.map((text) => ({ text }));
  }
  if (typeof opts?.path1 === "string") {
    rsa["path1"] = opts.path1.toLowerCase();
  }
  if (typeof opts?.path2 === "string") {
    rsa["path2"] = opts.path2.toLowerCase();
  }
  const resource: Record<string, unknown> = {
    resource_name: `customers/${customerId}/ads/${pyStr(adId)}`,
  };
  // Only mask responsive_search_ad when we actually change an asset or display path —
  // an empty {} makes Google derive a field mask over the whole submessage (FIELD_HAS_SUBFIELDS).
  if (Object.keys(rsa).length > 0) {
    resource["responsive_search_ad"] = rsa;
  }
  // final_urls lives on the Ad resource (sibling of responsive_search_ad); set it
  // only when the rewrite asks to repoint the ad, so headline-only rewrites are unchanged.
  if (opts?.finalUrl != null) {
    resource["final_urls"] = [opts.finalUrl];
  }
  return { entity: "ad", operation: "update", resource };
}

// Re-export types used by tests asserting on the status/searchPartners/adGroup plan entries.
export type { AdGroupCreatePlanEntry, SearchPartnersPlanEntry, StatusPlanEntry };

if (isMainModule(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      emitJson(errorEnvelope(formatGoogleAdsError(err)));
      process.exit(1);
    });
}
