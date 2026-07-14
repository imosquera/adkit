/**
 * Pure validation/coercion for an /adkit audit fixes plan — no SDK, no stdout.
 *
 * These functions take plain objects/arrays (the parsed plan plus live state
 * already fetched by the I/O shell) and return results: coerced keywords, dedup
 * identities, or a list of human-readable validation error strings. The shell in
 * `bin/apply-fixes.ts` runs the GAQL queries and mutations and prints; this module
 * holds the rules /adkit create also enforces, so they can be unit-tested without a
 * google-ads client.
 */

import type { ZodIssue } from "zod";
import {
  AdGroupSchema,
  AdGroupStatusChangeSchema,
  CampaignStatusChangeSchema,
  KeywordSchema,
  SearchPartnersChangeSchema,
  type AdGroup,
  type Keyword,
} from "../lib/schema.js";

export const H_MAX = 30;
export const D_MAX = 90;
export const H_TARGET = 15;
export const D_TARGET = 4;
export const SITELINK_TEXT_MAX = 25;
export const CALLOUT_MAX = 25;
export const SITELINK_DESC_MAX = 35;
// hard ceiling: a budget raise beyond this % over current is refused
// (a plan's maxRaisePct can only lower this, never exceed it)
export const MAX_RAISE_PCT_CAP = 50;

/** Plain-object guard (excludes arrays and null). */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Python `repr` for the values that flow through the error strings: single-quoted
 * strings, bare numbers/booleans/None. The tests assert on substrings produced by
 * `f"...{x!r}..."`, so match Python's quoting.
 */
function pyRepr(value: unknown): string {
  if (typeof value === "string") {
    return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  }
  if (value === null || value === undefined) {
    return "None";
  }
  if (value === true) {
    return "True";
  }
  if (value === false) {
    return "False";
  }
  return String(value);
}

/** Python `type(item).__name__` for the coercion error message. */
function pyTypeName(value: unknown): string {
  if (value === null || value === undefined) {
    return "NoneType";
  }
  if (typeof value === "boolean") {
    return "bool";
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? "int" : "float";
  }
  if (typeof value === "string") {
    return "str";
  }
  if (Array.isArray(value)) {
    return "list";
  }
  return "dict";
}

/** True when a value stringifies to digits only (Python `str(x).isdigit()`). */
function isDigitString(value: unknown): boolean {
  const s = String(value);
  return s.length > 0 && /^[0-9]+$/.test(s);
}

/**
 * Normalize a plan negative-keyword entry to a schema Keyword.
 *
 * A bare string defaults to PHRASE match; an object is {text, matchType} with
 * matchType case-insensitive. Validation (length, allowed match type) is the same
 * Keyword model /adkit create uses. Returns [Keyword, null] or [null, error].
 */
export function coerceKeyword(item: unknown): [Keyword | null, string | null] {
  if (typeof item === "string") {
    const parsed = KeywordSchema.safeParse({ text: item });
    if (parsed.success) {
      return [parsed.data, null];
    }
    return [null, parsed.error.issues[0].message];
  }
  if (isObject(item)) {
    const data: Record<string, unknown> = { ...item };
    const mt = data.matchType;
    if (typeof mt === "string") {
      data.matchType = mt.toUpperCase();
    }
    const parsed = KeywordSchema.safeParse(data);
    if (parsed.success) {
      return [parsed.data, null];
    }
    return [null, parsed.error.issues[0].message];
  }
  return [null, `must be a string or object, got ${pyTypeName(item)}`];
}

/** Identity of a negative keyword for dedup: case-insensitive text + match type. */
export function negKey(text: string, matchType: string): [string, string] {
  return [text.toLowerCase(), matchType];
}

/** Identity of a POSITIVE keyword for dedup/existence: case-insensitive text + match type. */
export function posKey(text: string, matchType: string): [string, string] {
  return [text.toLowerCase(), matchType];
}

/**
 * Serialize an identity tuple into a Set-comparable key. The separator is the
 * ASCII Unit Separator (U+001F) — a control char that cannot occur in ad text
 * or a match-type name, so `text` and `matchType` can never collide across the
 * boundary. Written as an escape (not a literal control byte) so the file stays
 * plain text; a literal NUL here previously made BSD grep treat plan.ts as
 * binary. apply-fixes.ts imports THIS function for its live-state maps so the
 * two sides never drift apart on separator.
 */
export function keyStr(key: [string, string]): string {
  return `${key[0]}\x1f${key[1]}`;
}

/**
 * Best-effort numeric coercion for an id used as a live-state map key. Returns
 * null for non-numeric (validation flags it separately).
 */
function asInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "string" && /^[+-]?[0-9]+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }
  return null;
}

/** Live-state maps: {id -> Set of keyStr("text", "matchType") identity keys}. */
/**
 * The live keyword identities per id. The I/O shell may hand this in several shapes:
 * a `Set` of already-joined identity strings, a `Map` keyed by identity string (whose
 * values resolve to criterion resource names — the shell keeps those for REMOVE/PAUSE),
 * or an iterable of `[text, matchType]` pairs. Only the identity KEYS matter here.
 */
type LiveIdentities = ReadonlySet<string> | ReadonlyMap<string, unknown> | Iterable<[string, string]>;
type LiveKeywordMap = ReadonlyMap<number, LiveIdentities> | Record<number, LiveIdentities>;

/** Read a live keyword identity set for an id from a Map/record of any supported shape. */
function liveKeysFor(map: LiveKeywordMap | null | undefined, id: number | null): Set<string> {
  const out = new Set<string>();
  if (map === null || map === undefined || id === null) {
    return out;
  }
  const raw = map instanceof Map ? map.get(id) : (map as Record<number, LiveIdentities>)[id];
  if (raw === undefined || raw === null) {
    return out;
  }
  // A Map's identities are its keys (the values are resolved resource names).
  if (raw instanceof Map) {
    for (const key of raw.keys()) {
      out.add(String(key));
    }
    return out;
  }
  for (const entry of raw as Iterable<unknown>) {
    if (Array.isArray(entry)) {
      out.add(keyStr([String(entry[0]), String(entry[1])]));
    } else {
      out.add(String(entry));
    }
  }
  return out;
}

/**
 * Coerced negatives in a plan group that are not already on the campaign and not
 * repeated within the group. Dedup is case-insensitive on (text, matchType), so the
 * batch handed to Google never contains duplicate criteria. Invalid items are
 * dropped here (already surfaced by validate, which gates mutation).
 */
export function newNegatives(group: Record<string, unknown>, liveNegatives: LiveKeywordMap): Keyword[] {
  const cid = asInt((group as { campaignId?: unknown }).campaignId);
  const seen = liveKeysFor(liveNegatives, cid);
  const out: Keyword[] = [];
  const add = Array.isArray(group.add) ? group.add : [];
  for (const item of add) {
    const [kw] = coerceKeyword(item);
    if (kw === null) {
      continue;
    }
    const key = keyStr(negKey(kw.text, kw.matchType));
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(kw);
  }
  return out;
}

/**
 * Coerced ADD keywords in a `keywords` group that are not already on the ad group
 * and not repeated within the group. Mirrors newNegatives but is keyed per ad group
 * and includes the match type, so re-running an already-applied plan adds nothing
 * and creates no duplicate criteria. Invalid items are dropped here (already
 * surfaced by validate, which gates mutation).
 */
export function newPositiveKeywords(group: Record<string, unknown>, livePositive: LiveKeywordMap): Keyword[] {
  const agid = asInt((group as { adGroupId?: unknown }).adGroupId);
  const seen = liveKeysFor(livePositive, agid);
  const out: Keyword[] = [];
  const add = Array.isArray(group.add) ? group.add : [];
  for (const item of add) {
    const [kw] = coerceKeyword(item);
    if (kw === null) {
      continue;
    }
    const key = keyStr(posKey(kw.text, kw.matchType));
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(kw);
  }
  return out;
}

/** A status-change plan entry carrying the target and current (live) status. */
export interface StatusPlanEntry {
  status: unknown;
  current: unknown;
  campaignId?: unknown;
  adGroupId?: unknown;
}

/** Live status maps: {id -> statusName}. */
type LiveStatusMap = Map<number, string> | Record<number, string>;

function liveStatusFor(map: LiveStatusMap, id: number | null): string | undefined {
  if (id === null) {
    return undefined;
  }
  if (map instanceof Map) {
    return map.get(id);
  }
  const v = (map as Record<number, string>)[id];
  return v === undefined ? undefined : v;
}

/**
 * Split status-change blocks into [changes, skips] against live state. A block
 * whose target status already matches the live status is a skip (an idempotent
 * no-op, never mutated); everything else is a change. Each returned entry carries
 * the original id, the target status, and the current status (for reporting).
 */
function statusPlan(
  blocks: Array<Record<string, unknown>>,
  liveStatuses: LiveStatusMap,
  idKey: "campaignId" | "adGroupId",
): [StatusPlanEntry[], StatusPlanEntry[]] {
  const entries: StatusPlanEntry[] = blocks.map((b) => {
    const current = liveStatusFor(liveStatuses, asInt(b[idKey]));
    return { [idKey]: b[idKey], status: b.status, current: current === undefined ? null : current };
  });
  const changes = entries.filter((e) => e.current !== e.status);
  const skips = entries.filter((e) => e.current === e.status);
  return [changes, skips];
}

export function campaignStatusPlan(
  blocks: Array<Record<string, unknown>>,
  liveStatuses: LiveStatusMap,
): [StatusPlanEntry[], StatusPlanEntry[]] {
  return statusPlan(blocks, liveStatuses, "campaignId");
}

export function adGroupStatusPlan(
  blocks: Array<Record<string, unknown>>,
  liveStatuses: LiveStatusMap,
): [StatusPlanEntry[], StatusPlanEntry[]] {
  return statusPlan(blocks, liveStatuses, "adGroupId");
}

/** A searchPartners-change plan entry carrying the target and current (live) boolean. */
export interface SearchPartnersPlanEntry {
  campaignId: unknown;
  enabled: unknown;
  current: unknown;
}

/** Live searchPartners map: {campaignId -> current target_search_network boolean}. */
type LiveBoolMap = Map<number, boolean> | Record<number, boolean>;

function liveBoolFor(map: LiveBoolMap, id: number | null): boolean | undefined {
  if (id === null) {
    return undefined;
  }
  if (map instanceof Map) {
    return map.get(id);
  }
  const v = (map as Record<number, boolean>)[id];
  return v === undefined ? undefined : v;
}

/**
 * Split searchPartners blocks into [changes, skips] against live state. A block whose
 * target `enabled` already matches the live setting is a skip (idempotent no-op,
 * never mutated); everything else is a change.
 */
export function searchPartnersPlan(
  blocks: Array<Record<string, unknown>>,
  liveSettings: LiveBoolMap,
): [SearchPartnersPlanEntry[], SearchPartnersPlanEntry[]] {
  const entries: SearchPartnersPlanEntry[] = blocks.map((b) => {
    const current = liveBoolFor(liveSettings, asInt(b.campaignId));
    return { campaignId: b.campaignId, enabled: b.enabled, current: current === undefined ? null : current };
  });
  const changes = entries.filter((e) => e.current !== e.enabled);
  const skips = entries.filter((e) => e.current === e.enabled);
  return [changes, skips];
}

function negativesErrors(negatives: Array<Record<string, unknown>>): string[] {
  const one = (ng: Record<string, unknown>): string[] => {
    const cid = ng.campaignId;
    const items = Array.isArray(ng.add) ? ng.add : [];
    return [
      ...(cid === undefined || cid === null ? ["negatives: entry missing campaignId"] : []),
      ...(cid !== undefined && cid !== null && !isDigitString(cid)
        ? [`negatives campaign ${pyRepr(cid)}: campaignId must be numeric`]
        : []),
      ...(items.length === 0 ? [`negatives campaign ${strId(ng.campaignId)}: empty add list`] : []),
      ...items.flatMap((item) => {
        const err = coerceKeyword(item)[1];
        return err ? [`negatives campaign ${strId(ng.campaignId)}: ${pyRepr(item)}: ${err}`] : [];
      }),
    ];
  };
  return negatives.flatMap(one);
}

/**
 * Validate each `languages` block: a `campaignId` that is present and digits-only. The
 * lever is "make this campaign English-only", so there is nothing else to parse — a bad
 * campaign id fails at dry-run rather than mid-apply. Mirrors {@link negativesErrors}.
 */
function languagesErrors(languageBlocks: Array<Record<string, unknown>>): string[] {
  const one = (lg: Record<string, unknown>): string[] => {
    const cid = lg.campaignId;
    return [
      ...(cid === undefined || cid === null ? ["languages: entry missing campaignId"] : []),
      ...(cid !== undefined && cid !== null && !isDigitString(cid)
        ? [`languages campaign ${pyRepr(cid)}: campaignId must be numeric`]
        : []),
    ];
  };
  return languageBlocks.flatMap(one);
}

/** Render an id for the `{x}` (str, not repr) slots — Python's f-string `{cid}`. */
function strId(value: unknown): string {
  if (value === undefined || value === null) {
    return "None";
  }
  return String(value);
}

function rewritesErrors(rewrites: Array<Record<string, unknown>>): string[] {
  const one = (rw: Record<string, unknown>): string[] => {
    const hs = Array.isArray(rw.headlines) ? (rw.headlines as string[]) : [];
    const ds = Array.isArray(rw.descriptions) ? (rw.descriptions as string[]) : [];
    const adId = strId(rw.adId);
    return [
      ...(hs.length !== H_TARGET ? [`ad ${adId}: ${hs.length} headlines (need ${H_TARGET})`] : []),
      ...(ds.length !== D_TARGET ? [`ad ${adId}: ${ds.length} descriptions (need ${D_TARGET})`] : []),
      ...(new Set(hs).size !== hs.length ? [`ad ${adId}: duplicate headline`] : []),
      ...(new Set(ds).size !== ds.length ? [`ad ${adId}: duplicate description`] : []),
      ...hs.filter((h) => h.length > H_MAX).map((h) => `ad ${adId}: headline >${H_MAX} (${h.length}) ${pyRepr(h)}`),
      ...ds.filter((d) => d.length > D_MAX).map((d) => `ad ${adId}: description >${D_MAX} (${d.length}) ${pyRepr(d)}`),
    ];
  };
  return rewrites.flatMap(one);
}

function appendHeadlinesErrors(
  appends: Array<Record<string, unknown>>,
  liveHeadlines: Map<unknown, string[]> | Record<string, string[]>,
): string[] {
  const getLive = (adId: unknown): string[] => {
    if (liveHeadlines instanceof Map) {
      return liveHeadlines.get(adId) ?? [];
    }
    const v = (liveHeadlines as Record<string, string[]>)[adId as string];
    return v ?? [];
  };
  const one = (ap: Record<string, unknown>): string[] => {
    const cur = getLive(ap.adId);
    const add = Array.isArray(ap.add) ? (ap.add as string[]) : [];
    const full = [...cur, ...add.filter((h) => !cur.includes(h))];
    const adId = strId(ap.adId);
    return [
      ...(full.length !== H_TARGET
        ? [`ad ${adId}: append -> ${full.length}H (need ${H_TARGET}; have ${cur.length})`]
        : []),
      ...(new Set(full).size !== full.length ? [`ad ${adId}: duplicate headline after append`] : []),
      ...add.filter((h) => h.length > H_MAX).map((h) => `ad ${adId}: headline >${H_MAX} (${h.length}) ${pyRepr(h)}`),
    ];
  };
  return appends.flatMap(one);
}

function sitelinksErrors(sitelinkBlocks: Array<Record<string, unknown>>): string[] {
  const one = (s: Record<string, unknown>): string[] => {
    const text = s.text as string;
    const d1 = s.description1;
    const d2 = s.description2;
    return [
      ...(text.length > SITELINK_TEXT_MAX ? [`sitelink text >${SITELINK_TEXT_MAX}: ${pyRepr(text)}`] : []),
      ...(Boolean(d1) !== Boolean(d2) ? [`sitelink ${pyRepr(text)}: descriptions must be both-or-neither`] : []),
      ...[d1, d2]
        .filter((d): d is string => Boolean(d) && (d as string).length > SITELINK_DESC_MAX)
        .map((d) => `sitelink desc >${SITELINK_DESC_MAX}: ${pyRepr(d)}`),
    ];
  };
  return sitelinkBlocks.flatMap((sl) => {
    const add = Array.isArray(sl.add) ? (sl.add as Array<Record<string, unknown>>) : [];
    return add.flatMap(one);
  });
}

function calloutsErrors(calloutBlocks: Array<Record<string, unknown>>): string[] {
  return calloutBlocks.flatMap((co) => {
    const add = Array.isArray(co.add) ? (co.add as string[]) : [];
    return add.filter((c) => c.length > CALLOUT_MAX).map((c) => `callout >${CALLOUT_MAX} (${c.length}): ${pyRepr(c)}`);
  });
}

function budgetsErrors(
  budgetBlocks: Array<Record<string, unknown>>,
  budgets: Map<unknown, { amountMicros?: number }> | Record<string, { amountMicros?: number }>,
): string[] {
  const getBudget = (cid: unknown): { amountMicros?: number } | undefined => {
    if (budgets instanceof Map) {
      return budgets.get(cid);
    }
    return (budgets as Record<string, { amountMicros?: number }>)[cid as string];
  };
  const one = (b: Record<string, unknown>): string[] => {
    const cid = b.campaignId;
    const target = b.dailyMicros;
    if (typeof target !== "number" || !Number.isInteger(target) || target <= 0) {
      return [`budget campaign ${strId(cid)}: dailyMicros must be a positive int`];
    }
    const cur = getBudget(cid)?.amountMicros;
    if (cur === undefined || cur === null) {
      return [`budget campaign ${strId(cid)}: no current budget found`];
    }
    const rawPct = typeof b.maxRaisePct === "number" ? b.maxRaisePct : MAX_RAISE_PCT_CAP;
    const pct = Math.min(rawPct, MAX_RAISE_PCT_CAP); // cap can only be lowered
    const cap = cur * (1 + pct / 100);
    return target > cap
      ? [
          `budget campaign ${strId(cid)}: $${(target / 1e6).toFixed(2)} exceeds guardrail ` +
            `($${(cur / 1e6).toFixed(2)} +${pct}% = $${(cap / 1e6).toFixed(2)})`,
        ]
      : [];
  };
  return budgetBlocks.flatMap(one);
}

function keywordsErrors(
  keywordBlocks: Array<Record<string, unknown>>,
  livePositive: LiveKeywordMap | null | undefined,
): string[] {
  const one = (kb: Record<string, unknown>): string[] => {
    const agid = kb.adGroupId;
    const add = Array.isArray(kb.add) ? kb.add : [];
    const remove = Array.isArray(kb.remove) ? kb.remove : [];
    const pause = Array.isArray(kb.pause) ? kb.pause : [];
    const liveKeys = liveKeysFor(livePositive, asInt(agid));

    const rpErrors = (label: string, items: unknown[]): string[] =>
      items.flatMap((item) => {
        const [kw, err] = coerceKeyword(item);
        if (err) {
          return [`keywords adGroup ${strId(agid)}: ${label} ${pyRepr(item)}: ${err}`];
        }
        if (kw !== null && !liveKeys.has(keyStr(posKey(kw.text, kw.matchType)))) {
          return [
            `keywords adGroup ${strId(agid)}: cannot ${label} ` +
              `${kw.text}[${kw.matchType}] — not present on the ad group`,
          ];
        }
        return [];
      });

    return [
      ...(agid === undefined || agid === null ? ["keywords: entry missing adGroupId"] : []),
      ...(agid !== undefined && agid !== null && !isDigitString(agid)
        ? [`keywords adGroup ${pyRepr(agid)}: adGroupId must be numeric`]
        : []),
      ...(add.length === 0 && remove.length === 0 && pause.length === 0
        ? [`keywords adGroup ${strId(agid)}: empty operation lists (add/remove/pause)`]
        : []),
      ...add.flatMap((item) => {
        const err = coerceKeyword(item)[1];
        return err ? [`keywords adGroup ${strId(agid)}: add ${pyRepr(item)}: ${err}`] : [];
      }),
      ...rpErrors("remove", remove),
      ...rpErrors("pause", pause),
    ];
  };
  return keywordBlocks.flatMap(one);
}

type StatusSchema = typeof CampaignStatusChangeSchema | typeof AdGroupStatusChangeSchema;

/**
 * Shared shape for campaignStatus/adGroupStatus: each block must parse against the
 * schema; every issue surfaces prefixed with `label`/`noun` and the block's id.
 */
function statusChangeErrors(
  blocks: unknown[],
  schema: StatusSchema,
  label: string,
  noun: string,
  idField: string,
): string[] {
  const one = (item: unknown): string[] => {
    if (!isObject(item)) {
      return [`${label}: entry must be an object, got ${pyTypeName(item)}`];
    }
    const parsed = schema.safeParse(item);
    if (parsed.success) {
      return [];
    }
    return parsed.error.issues.map((issue: ZodIssue) => {
      const loc = issue.path.map((p) => String(p)).join(".") || "?";
      return `${label} ${noun} ${pyRepr(item[idField])}: ${loc}: ${issue.message}`;
    });
  };
  return blocks.flatMap(one);
}

/**
 * Validate each searchPartners block against {@link SearchPartnersChangeSchema}; every
 * issue surfaces prefixed with the campaign id. Mirrors statusChangeErrors, but
 * standalone since there is only one status schema to check here.
 */
function searchPartnersErrors(blocks: unknown[]): string[] {
  const one = (item: unknown): string[] => {
    if (!isObject(item)) {
      return [`searchPartners: entry must be an object, got ${pyTypeName(item)}`];
    }
    const parsed = SearchPartnersChangeSchema.safeParse(item);
    if (parsed.success) {
      return [];
    }
    return parsed.error.issues.map((issue: ZodIssue) => {
      const loc = issue.path.map((p) => String(p)).join(".") || "?";
      return `searchPartners campaign ${pyRepr(item.campaignId)}: ${loc}: ${issue.message}`;
    });
  };
  return blocks.flatMap(one);
}

/**
 * Reject enabling search partners (`enabled: true`) on a campaign whose live
 * `target_google_search` is `false` — Google Ads rejects that combination
 * server-side (CampaignError.CANNOT_TARGET_SEARCH_NETWORK_WITHOUT_GOOGLE_SEARCH),
 * so catching it here means a bad ENABLE fails at validate (dry-run-safe), not
 * mid-apply against the live API. Turning search partners OFF has no such
 * precondition, so only `enabled: true` blocks are checked. A campaign with no
 * live data (unknown target_google_search) is not blocked — only a *known* false
 * rejects.
 */
function searchPartnersPreconditionErrors(
  blocks: Array<Record<string, unknown>>,
  liveGoogleSearch: LiveBoolMap,
): string[] {
  const one = (b: Record<string, unknown>): string[] => {
    if (b.enabled !== true) {
      return [];
    }
    const googleSearch = liveBoolFor(liveGoogleSearch, asInt(b.campaignId));
    return googleSearch === false
      ? [
          `searchPartners campaign ${strId(b.campaignId)}: cannot enable search partners while ` +
            "Google Search targeting is off for this campaign",
        ]
      : [];
  };
  return blocks.flatMap(one);
}

/** A bare string becomes `{text}`; anything else passes through for the schema to judge. */
function asTextObject(item: unknown): unknown {
  return typeof item === "string" ? { text: item } : item;
}

/**
 * A plan keyword item as a schema-shaped object: a bare string becomes `{text}` (the
 * schema defaults matchType to PHRASE), and an object's matchType is upper-cased so
 * the `adGroups` block accepts the same case-insensitive `matchType` the rest of the
 * update plan does (via coerceKeyword). Anything else passes through unchanged.
 */
function asKeywordObject(item: unknown): unknown {
  if (typeof item === "string") {
    return { text: item };
  }
  if (isObject(item) && typeof item.matchType === "string") {
    return { ...item, matchType: item.matchType.toUpperCase() };
  }
  return item;
}

/**
 * Normalize a raw `adGroup` plan value into the object shape {@link AdGroupSchema}
 * parses — so an `adGroups` block can author headlines/descriptions/keywords as the
 * bare strings the rest of the update plan uses, not `{text}`/`{text,matchType}`
 * objects. Purely structural (bare string -> `{text}`, upper-case a keyword's
 * matchType); the schema remains the single authority on lengths, counts, and
 * uniqueness. A non-object passes straight through for the schema to reject.
 */
function normalizeAdGroup(raw: unknown): unknown {
  if (!isObject(raw)) {
    return raw;
  }
  const rsa = raw.responsiveSearchAd;
  return {
    ...raw,
    ...(isObject(rsa)
      ? {
          responsiveSearchAd: {
            ...rsa,
            ...(Array.isArray(rsa.headlines) ? { headlines: rsa.headlines.map(asTextObject) } : {}),
            ...(Array.isArray(rsa.descriptions) ? { descriptions: rsa.descriptions.map(asTextObject) } : {}),
          },
        }
      : {}),
    ...(Array.isArray(raw.keywords) ? { keywords: raw.keywords.map(asKeywordObject) } : {}),
  };
}

/**
 * Validate each `adGroups` (add-ad-group) block: a numeric `campaignId` plus an
 * `adGroup` that must parse against the same {@link AdGroupSchema} /adkit create
 * enforces (full 15/4 RSA, 1–30 keywords, ≤$15 CPC) after boundary normalization
 * (bare-string headlines/keywords accepted). Every schema issue surfaces prefixed
 * with the campaign id and the offending field path, so a bad ad group fails at
 * validate (dry-run-safe), not mid-apply against the live API.
 */
function adGroupsErrors(blocks: Array<Record<string, unknown>>): string[] {
  const one = (b: Record<string, unknown>): string[] => {
    const cid = b.campaignId;
    const idErrors = [
      ...(cid === undefined || cid === null ? ["adGroups: entry missing campaignId"] : []),
      ...(cid !== undefined && cid !== null && !isDigitString(cid)
        ? [`adGroups campaign ${pyRepr(cid)}: campaignId must be numeric`]
        : []),
    ];
    if (b.adGroup === undefined || b.adGroup === null) {
      return [...idErrors, `adGroups campaign ${strId(cid)}: entry missing adGroup`];
    }
    const parsed = AdGroupSchema.safeParse(normalizeAdGroup(b.adGroup));
    if (parsed.success) {
      return idErrors;
    }
    return [
      ...idErrors,
      ...parsed.error.issues.map((issue: ZodIssue) => {
        const loc = issue.path.map((p) => String(p)).join(".") || "?";
        return `adGroups campaign ${strId(cid)}: adGroup.${loc}: ${issue.message}`;
      }),
    ];
  };
  return blocks.flatMap(one);
}

/** A new-ad-group plan entry: the target campaign, the parsed ad group, and its name. */
export interface AdGroupCreatePlanEntry {
  campaignId: unknown;
  name: string;
  adGroup: AdGroup;
}

/** Live ad-group names per campaign: {campaignId -> Set of lowercased names}. */
type LiveNamesMap = Map<number, ReadonlySet<string>> | Record<number, ReadonlySet<string>>;

function liveNamesFor(map: LiveNamesMap | null | undefined, id: number | null): ReadonlySet<string> {
  if (map === null || map === undefined || id === null) {
    return new Set<string>();
  }
  const raw = map instanceof Map ? map.get(id) : (map as Record<number, ReadonlySet<string>>)[id];
  return raw ?? new Set<string>();
}

/**
 * Split `adGroups` blocks into [creates, skips] against the live ad-group names in
 * each target campaign. A block whose ad-group name already exists (case-insensitive)
 * in its campaign is a skip — the add is idempotent, so re-running a plan never
 * creates a duplicate group; everything else is a create. Blocks are assumed already
 * validated (adGroup parses), so a parse failure here drops the block defensively.
 */
export function addAdGroupsPlan(
  blocks: Array<Record<string, unknown>>,
  liveNames: LiveNamesMap | null | undefined,
): [AdGroupCreatePlanEntry[], AdGroupCreatePlanEntry[]] {
  const creates: AdGroupCreatePlanEntry[] = [];
  const skips: AdGroupCreatePlanEntry[] = [];
  for (const b of blocks) {
    const parsed = AdGroupSchema.safeParse(normalizeAdGroup(b.adGroup));
    if (!parsed.success) {
      continue;
    }
    const adGroup = parsed.data;
    const entry: AdGroupCreatePlanEntry = { campaignId: b.campaignId, name: adGroup.name, adGroup };
    const names = liveNamesFor(liveNames, asInt(b.campaignId));
    (names.has(adGroup.name.toLowerCase()) ? skips : creates).push(entry);
  }
  return [creates, skips];
}

/** Live-state input maps for validate (kept permissive to mirror the Python shell). */
export interface ValidateLiveState {
  liveHeadlines: Map<unknown, string[]> | Record<string, string[]>;
  budgets: Map<unknown, { amountMicros?: number }> | Record<string, { amountMicros?: number }>;
  livePositive?: LiveKeywordMap | null;
}

/**
 * Run every per-block validation and concatenate the resulting error lists. An
 * empty array means the plan is safe to apply.
 */
export function validate(
  plan: Record<string, unknown>,
  liveHeadlines: ValidateLiveState["liveHeadlines"],
  budgets: ValidateLiveState["budgets"],
  livePositive: LiveKeywordMap | null | undefined = undefined,
  liveSearchPartnersGoogleSearch: LiveBoolMap | null | undefined = undefined,
): string[] {
  const arr = (key: string): Array<Record<string, unknown>> =>
    Array.isArray(plan[key]) ? (plan[key] as Array<Record<string, unknown>>) : [];
  return [
    ...negativesErrors(arr("negatives")),
    ...rewritesErrors(arr("rewrites")),
    ...appendHeadlinesErrors(arr("appendHeadlines"), liveHeadlines),
    ...sitelinksErrors(arr("sitelinks")),
    ...calloutsErrors(arr("callouts")),
    ...budgetsErrors(arr("budgets"), budgets),
    ...keywordsErrors(arr("keywords"), livePositive),
    ...statusChangeErrors(arr("campaignStatus"), CampaignStatusChangeSchema, "campaignStatus", "campaign", "campaignId"),
    ...statusChangeErrors(arr("adGroupStatus"), AdGroupStatusChangeSchema, "adGroupStatus", "adGroup", "adGroupId"),
    ...searchPartnersErrors(arr("searchPartners")),
    ...searchPartnersPreconditionErrors(arr("searchPartners"), liveSearchPartnersGoogleSearch ?? new Map()),
    ...adGroupsErrors(arr("adGroups")),
    ...languagesErrors(arr("languages")),
  ];
}
