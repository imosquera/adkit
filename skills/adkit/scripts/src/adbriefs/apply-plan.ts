/**
 * Pure staging logic for `ads.sh update` (`bin/apply-fixes.ts`): resolve a fixes
 * plan's live ids (`adId`/`adGroupId`/`campaignId`) back to the `adbriefs/` brief(s)
 * they belong to (via the reverse {@link StateIndex}), group the plan's sections per
 * resolved brief slug, and apply the already-computed changes onto a proposed copy of
 * that brief. No fs/network access here — `bin/apply-fixes.ts` is the only I/O edge
 * that reads/writes `adbriefs/*.yaml` and calls the Ads API; this module only builds
 * new in-memory values from ones it is handed.
 *
 * Design note: a plan block is keyed by exactly one id (`adId`, `adGroupId`, or
 * `campaignId`) and carries no sibling id to fall back on, so an id with no match in
 * the {@link StateIndex} cannot be attributed to a particular brief slug — it is
 * collected as a *standalone* unresolved id (not attached to any {@link ResolvedPlanGroup}).
 * `bin/apply-fixes.ts` surfaces these as an explicit warning (FR-001) and, when the
 * index is entirely empty (no `adbriefs/*.state.yaml` at all), as the FR-008
 * "no-state-file" degrade case.
 */

import type { AdGroup, Brief, Keyword } from "../lib/schema.js";
import { coerceKeyword, keyStr, negKey, posKey, type AdGroupCreatePlanEntry } from "../fixes/plan.js";
import type { AdGroupLocator, StateIndex } from "./state.js";

/** A plan id with no record in any loaded state file — reported, never silently dropped. */
export interface UnresolvedId {
  kind: "campaignId" | "adGroupId" | "adId";
  id: string;
}

/**
 * A `rewrites` or `appendHeadlines` block, resolved to the ad group it targets.
 * `rsaIndex` is which of the ad group's RSAS_PER_AD_GROUP `responsiveSearchAds`
 * entries the block's live `adId` names (from the state index's positional
 * adIds<->responsiveSearchAds correspondence — see state.ts's `AdGroupLocator`
 * doc); defaults to 0 when the locator carries none (a `byAdId` match always
 * sets one, so this only guards a hypothetically absent index).
 */
interface ResolvedAdBlock {
  adGroupName: string;
  rsaIndex: number;
  block: Record<string, unknown>;
}

/** A `keywords` block, resolved to the ad group it targets. */
interface ResolvedKeywordsBlock {
  adGroupName: string;
  block: Record<string, unknown>;
}

/** An `adGroups` (add-ad-group) block, resolved to this slug's owning campaign. */
interface ResolvedAdGroupCreateBlock {
  block: Record<string, unknown>;
}

/**
 * Every plan section touching one resolved brief slug — a proof that every id inside
 * `sections` resolved to `slug`, plus a per-slug `unresolvedIds` list for a sibling id
 * within an otherwise-resolved campaign that didn't resolve (kept for completeness;
 * this plan shape rarely produces one, since each block carries a single id — see the
 * module doc). `campaignStatus`/`adGroupStatus`/`adStatus`/`searchPartners`/`languages`
 * are walked for resolution (so an unresolvable id in those sections still warns) but
 * are not carried into `sections`: the {@link Brief} schema has no live-status,
 * search-partners, or language field to stage them into.
 */
export interface ResolvedPlanGroup {
  slug: string;
  campaignName: string;
  sections: {
    rewrites: ResolvedAdBlock[];
    appendHeadlines: ResolvedAdBlock[];
    sitelinks: Array<Record<string, unknown>>;
    callouts: Array<Record<string, unknown>>;
    negatives: Array<Record<string, unknown>>;
    keywords: ResolvedKeywordsBlock[];
    budgets: Array<Record<string, unknown>>;
    adGroups: ResolvedAdGroupCreateBlock[];
  };
  unresolvedIds: UnresolvedId[];
}

/** Sentinel slug for the synthetic group holding ids that resolved to no brief at all. */
const UNRESOLVED_SLUG = "";

function emptySections(): ResolvedPlanGroup["sections"] {
  return {
    rewrites: [],
    appendHeadlines: [],
    sitelinks: [],
    callouts: [],
    negatives: [],
    keywords: [],
    budgets: [],
    adGroups: [],
  };
}

/** The plan-section shape `resolvePlanGroups` needs — a structural subset of `FixesPlan`. */
export interface PlanSections {
  rewrites?: Array<Record<string, unknown>>;
  appendHeadlines?: Array<Record<string, unknown>>;
  sitelinks?: Array<Record<string, unknown>>;
  callouts?: Array<Record<string, unknown>>;
  negatives?: Array<Record<string, unknown>>;
  keywords?: Array<Record<string, unknown>>;
  budgets?: Array<Record<string, unknown>>;
  campaignStatus?: Array<Record<string, unknown>>;
  adGroupStatus?: Array<Record<string, unknown>>;
  adStatus?: Array<Record<string, unknown>>;
  searchPartners?: Array<Record<string, unknown>>;
  adGroups?: Array<Record<string, unknown>>;
  languages?: Array<Record<string, unknown>>;
}

function arr(plan: PlanSections, key: keyof PlanSections): Array<Record<string, unknown>> {
  const v = plan[key];
  return Array.isArray(v) ? v : [];
}

/**
 * Resolve every id-bearing plan section against the {@link StateIndex} and group the
 * plan's already-typed sections by the brief slug each id belongs to (FR-001, FR-010).
 * An id with no match is collected into a standalone `unresolvedIds`-only group keyed
 * by {@link UNRESOLVED_SLUG} (present in the returned array only when at least one id
 * failed to resolve) — see the module doc for why it cannot be attributed to a slug.
 * Pure — no fs/network, single input -> single output.
 */
export function resolvePlanGroups(plan: PlanSections, index: StateIndex): ResolvedPlanGroup[] {
  const groups = new Map<string, ResolvedPlanGroup>();
  const standalone: UnresolvedId[] = [];

  const groupFor = (slug: string, campaignName: string): ResolvedPlanGroup => {
    const existing = groups.get(slug);
    if (existing) {
      return existing;
    }
    const fresh: ResolvedPlanGroup = { slug, campaignName, sections: emptySections(), unresolvedIds: [] };
    groups.set(slug, fresh);
    return fresh;
  };

  const byAdId = (block: Record<string, unknown>, idField: string): AdGroupLocator | null => {
    const id = String(block[idField]);
    const loc = index.byAdId.get(id);
    if (!loc) {
      standalone.push({ kind: "adId", id });
    }
    return loc ?? null;
  };
  const byAdGroupId = (block: Record<string, unknown>, idField: string): AdGroupLocator | null => {
    const id = String(block[idField]);
    const loc = index.byAdGroupId.get(id);
    if (!loc) {
      standalone.push({ kind: "adGroupId", id });
    }
    return loc ?? null;
  };
  const byCampaignId = (block: Record<string, unknown>): { slug: string; campaignName: string } | null => {
    const id = String(block["campaignId"]);
    const loc = index.byCampaignId.get(id);
    if (!loc) {
      standalone.push({ kind: "campaignId", id });
    }
    return loc ?? null;
  };

  for (const b of arr(plan, "rewrites")) {
    const loc = byAdId(b, "adId");
    if (loc)
      groupFor(loc.slug, loc.campaignName).sections.rewrites.push({
        adGroupName: loc.adGroupName,
        rsaIndex: loc.rsaIndex ?? 0,
        block: b,
      });
  }
  for (const b of arr(plan, "appendHeadlines")) {
    const loc = byAdId(b, "adId");
    if (loc)
      groupFor(loc.slug, loc.campaignName).sections.appendHeadlines.push({
        adGroupName: loc.adGroupName,
        rsaIndex: loc.rsaIndex ?? 0,
        block: b,
      });
  }
  // adStatus resolves (for the unresolved-id warning) but has no Brief field to stage into.
  for (const b of arr(plan, "adStatus")) {
    byAdId(b, "adId");
  }
  for (const b of arr(plan, "keywords")) {
    const loc = byAdGroupId(b, "adGroupId");
    if (loc) groupFor(loc.slug, loc.campaignName).sections.keywords.push({ adGroupName: loc.adGroupName, block: b });
  }
  // adGroupStatus: same as adStatus above — resolved for the warning, no Brief field.
  for (const b of arr(plan, "adGroupStatus")) {
    byAdGroupId(b, "adGroupId");
  }

  const campaignSection = (key: keyof PlanSections, push: ((g: ResolvedPlanGroup, b: Record<string, unknown>) => void) | null) => {
    for (const b of arr(plan, key)) {
      const loc = byCampaignId(b);
      if (loc) push?.(groupFor(loc.slug, loc.campaignName), b);
    }
  };
  campaignSection("sitelinks", (g, b) => g.sections.sitelinks.push(b));
  campaignSection("callouts", (g, b) => g.sections.callouts.push(b));
  campaignSection("negatives", (g, b) => g.sections.negatives.push(b));
  campaignSection("budgets", (g, b) => g.sections.budgets.push(b));
  campaignSection("adGroups", (g, b) => g.sections.adGroups.push({ block: b }));
  // campaignStatus/searchPartners/languages: resolved for the warning only (no Brief field).
  campaignSection("campaignStatus", null);
  campaignSection("searchPartners", null);
  campaignSection("languages", null);

  const result = [...groups.values()];
  if (standalone.length > 0) {
    result.push({ slug: UNRESOLVED_SLUG, campaignName: "", sections: emptySections(), unresolvedIds: standalone });
  }
  return result;
}

/** Already-computed values `applyPlanToBrief` needs but cannot derive from `group` alone. */
export interface ApplyPlanComputed {
  /** The plan's top-level `landingUrl`, used as a sitelink's `finalUrl` fallback (mirrors the live mutation). */
  defaultLandingUrl?: string;
  /** Every ad-group create the plan's `adGroups` section produced (already parsed + skip-filtered by `addAdGroupsPlan`). */
  adGroupCreates?: AdGroupCreatePlanEntry[];
}

/** True when `a`/`b` are exact-match case-sensitive duplicates (the appendHeadlines dedup rule). */
function isSameHeadline(a: string, b: string): boolean {
  return a === b;
}

/** Coerce a raw plan keyword item to a `Keyword`, dropping anything invalid (already gated by `validate`). */
function coerceKeywords(items: unknown[]): Keyword[] {
  return items.map((item) => coerceKeyword(item)[0]).filter((k): k is Keyword => k !== null);
}

/** `values` with within-batch duplicates removed, keyed by `key` (first occurrence wins). */
function dedupeBy<T>(values: T[], key: (v: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((v) => {
    const k = key(v);
    if (seen.has(k)) {
      return false;
    }
    seen.add(k);
    return true;
  });
}

/**
 * Apply a resolved plan group's already-computed changes onto `base`, returning a new
 * {@link Brief} (pure — never mutates `base`). Rewrites replace the targeted ad
 * group's RSA assets; `appendHeadlines` merges into the existing headline set with a
 * case-sensitive exact-match dedup (mirrors the live-mutation rule in
 * `apply-fixes.ts`); negatives/keywords/sitelinks/callouts/budgets are appended/set
 * from the corresponding section, each deduped against `base`'s existing content so a
 * plan that is already fully reflected in the brief produces a serialization-identical
 * result (FR-011). Sections with no Brief field (status/searchPartners/languages) are
 * not represented in `group.sections` and so never touch the result.
 */
export function applyPlanToBrief(base: Brief, group: ResolvedPlanGroup, computed: ApplyPlanComputed = {}): Brief {
  const adGroups = base.adGroups.map((ag) => {
    // Each rewrite/appendHeadlines block targets exactly one live ad (one RSA),
    // resolved to a specific responsiveSearchAds[rsaIndex] slot via the state
    // index's positional adIds<->responsiveSearchAds correspondence (see
    // state.ts's AdGroupLocator doc) — a whole-ad-group findLast would silently
    // overwrite the WRONG RSA now that an ad group carries RSAS_PER_AD_GROUP of
    // them. findLast is still per-index (not per-ad-group): when two blocks
    // target the SAME rsaIndex, the live imperative mutation loop in
    // apply-fixes.ts applies both in order and "last one wins" — staging must
    // reflect the SAME last block, not the first, or live and staged diverge.
    const responsiveSearchAds = ag.responsiveSearchAds.map((rsa, rsaIndex) => {
      const rewrite = group.sections.rewrites.findLast(
        (r) => r.adGroupName === ag.name && r.rsaIndex === rsaIndex,
      );
      const append = group.sections.appendHeadlines.findLast(
        (a) => a.adGroupName === ag.name && a.rsaIndex === rsaIndex,
      );

      let next = rsa;
      if (rewrite) {
        const b = rewrite.block;
        const headlines = Array.isArray(b["headlines"])
          ? (b["headlines"] as string[]).map((text) => ({ text }))
          : next.headlines;
        const descriptions = Array.isArray(b["descriptions"])
          ? (b["descriptions"] as string[]).map((text) => ({ text }))
          : next.descriptions;
        const path1 = typeof b["path1"] === "string" ? (b["path1"] as string).toLowerCase() : next.path1;
        const path2 = typeof b["path2"] === "string" ? (b["path2"] as string).toLowerCase() : next.path2;
        const finalUrl = typeof b["finalUrl"] === "string" ? (b["finalUrl"] as string) : next.finalUrl;
        next = { ...next, headlines, descriptions, finalUrl, path1, path2 };
      }
      if (append) {
        const add = Array.isArray(append.block["add"]) ? (append.block["add"] as string[]) : [];
        const existing = next.headlines.map((h) => h.text);
        const fresh = dedupeBy(
          add.filter((h) => !existing.some((e) => isSameHeadline(e, h))),
          (h) => h,
        );
        if (fresh.length > 0) {
          next = { ...next, headlines: [...next.headlines, ...fresh.map((text) => ({ text }))] };
        }
      }
      return next;
    });
    // Every slot's identity is preserved when nothing targeted it (`next = rsa`
    // when no rewrite/append matched), so this stays reference-equal to
    // `ag.responsiveSearchAds` unless a slot actually changed — same "no-op
    // touch" shortcut the pre-array code used for `ag.responsiveSearchAd`.
    const rsaChanged = responsiveSearchAds.some((rsa, i) => rsa !== ag.responsiveSearchAds[i]);

    let keywords = ag.keywords;
    const kwBlock = group.sections.keywords.findLast((k) => k.adGroupName === ag.name);
    if (kwBlock) {
      const b = kwBlock.block;
      const addItems = Array.isArray(b["add"]) ? (b["add"] as unknown[]) : [];
      const removeItems = Array.isArray(b["remove"]) ? (b["remove"] as unknown[]) : [];
      const existingKeys = new Set(keywords.map((k) => keyStr(posKey(k.text, k.matchType))));
      const fresh = dedupeBy(
        coerceKeywords(addItems).filter((k) => !existingKeys.has(keyStr(posKey(k.text, k.matchType)))),
        (k) => keyStr(posKey(k.text, k.matchType)),
      );
      const removeKeys = new Set(coerceKeywords(removeItems).map((k) => keyStr(posKey(k.text, k.matchType))));
      keywords = [...keywords.filter((k) => !removeKeys.has(keyStr(posKey(k.text, k.matchType)))), ...fresh];
    }

    return !rsaChanged && keywords === ag.keywords ? ag : { ...ag, responsiveSearchAds, keywords };
  });

  // `computed.adGroupCreates` is already filtered against LIVE ad-group names by
  // `addAdGroupsPlan` (fixes/plan.ts) — the only source of truth for "does this ad
  // group already exist". Re-filtering against the ON-DISK BRIEF's existing names
  // here would silently drop a genuinely-new ad group whenever the brief has a
  // stale/hand-edited name absent from live: the live mutation still creates it
  // (agCreates says it's new), but the brief would never gain a record of it.
  const groupCampaignIds = new Set(group.sections.adGroups.map((e) => String(e.block["campaignId"])));
  const newAdGroups: AdGroup[] = (computed.adGroupCreates ?? [])
    .filter((c) => groupCampaignIds.has(String(c.campaignId)))
    .map((c) => c.adGroup);

  const campaign = base.campaign;
  const existingSitelinkTexts = new Set(campaign.sitelinks.map((s) => s.text.toLowerCase()));
  const newSitelinks = dedupeBy(
    group.sections.sitelinks
      .flatMap((b) => (Array.isArray(b["add"]) ? (b["add"] as Array<Record<string, unknown>>) : []))
      .filter((s) => typeof s["text"] === "string" && !existingSitelinkTexts.has((s["text"] as string).toLowerCase())),
    (s) => (s["text"] as string).toLowerCase(),
  )
    .map((s) => ({
      text: s["text"] as string,
      finalUrl: (s["finalUrl"] as string | undefined) ?? computed.defaultLandingUrl ?? "",
      ...(typeof s["description1"] === "string" ? { description1: s["description1"] as string } : {}),
      ...(typeof s["description2"] === "string" ? { description2: s["description2"] as string } : {}),
    }));

  const existingCallouts = new Set(campaign.callouts.map((c) => c.toLowerCase()));
  const newCallouts = group.sections.callouts
    .flatMap((b) => (Array.isArray(b["add"]) ? (b["add"] as string[]) : []))
    .filter((c, idx, all) => {
      const key = c.toLowerCase();
      return !existingCallouts.has(key) && all.findIndex((o) => o.toLowerCase() === key) === idx;
    });

  const existingNegKeys = new Set(campaign.negativeKeywords.map((k) => keyStr(negKey(k.text, k.matchType))));
  const newNegatives = dedupeBy(
    coerceKeywords(
      group.sections.negatives.flatMap((b) => (Array.isArray(b["add"]) ? (b["add"] as unknown[]) : [])),
    ).filter((k) => !existingNegKeys.has(keyStr(negKey(k.text, k.matchType)))),
    (k) => keyStr(negKey(k.text, k.matchType)),
  );

  const lastBudget = group.sections.budgets[group.sections.budgets.length - 1];
  const budgetMicros =
    lastBudget && typeof lastBudget["dailyMicros"] === "number"
      ? (lastBudget["dailyMicros"] as number)
      : campaign.budgetMicros;

  const campaignChanged =
    newSitelinks.length > 0 || newCallouts.length > 0 || newNegatives.length > 0 || budgetMicros !== campaign.budgetMicros;

  return {
    ...base,
    adGroups: [...adGroups, ...newAdGroups],
    campaign: campaignChanged
      ? {
          ...campaign,
          sitelinks: [...campaign.sitelinks, ...newSitelinks],
          callouts: [...campaign.callouts, ...newCallouts],
          negativeKeywords: [...campaign.negativeKeywords, ...newNegatives],
          budgetMicros,
        }
      : campaign,
  };
}
