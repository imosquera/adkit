/**
 * Pure scoring/detection logic for the audit skill — no google-ads client, no stdout.
 *
 * These functions take already-fetched data (objects/arrays/strings) and compute
 * findings. The IO shell (bin/audit.ts) runs the GAQL queries, builds the rows, calls
 * these, and prints. Keeping them SDK-free makes them unit-testable without a live
 * account.
 *
 * Naming note: Python public names are camelCased here. Python `_private` helpers that
 * are imported by other modules (bin/audit) are treated as package-internal API and
 * exported as camelCase (`_path_to_excellent` -> `pathToExcellent`,
 * `_differentiation_gaps` -> `differentiationGaps`, `_cannibalization` ->
 * `cannibalization`, `_require_digits` -> `requireDigits`, `_concept_words` ->
 * `conceptWords`).
 */

import { gaqlId } from "../gaql/escape.js";
import type { DifferentiationProfile } from "../lib/brand.js";

export const MIN_HEADLINES = 15;
export const MIN_DESCRIPTIONS = 4;
export const MIN_SITELINKS = 6;
export const MIN_CALLOUTS = 4;
/**
 * Keywords match ads to the searches people make on Google. Google's own guidance:
 * successful campaigns have at least this many keywords — add more to reach people
 * actively searching for the product/service. Below this, flag the campaign.
 */
export const MIN_KEYWORDS = 25;
/** headline shared across >= this many ad groups in one campaign = keyword-agnostic boilerplate */
export const SHARED_HEADLINE_GROUPS = 3;

export const TIER_NAMES: ReadonlySet<string> = new Set([
  "informational",
  "navigational",
  "commercial",
  "transactional",
]);

// Impression-share thresholds — WHY a campaign isn't winning more impressions (a
// separate axis from ad strength: an EXCELLENT ad can still hold tiny IS).
/** below this, there is meaningful impression share to win back */
export const IS_OPPORTUNITY = 0.65;
/** losing >10% IS to a cause => flag that cause */
export const LOST_HI = 0.1;

/**
 * Words a winning headline should contain. Prefer the ad group's actual keywords;
 * fall back to the name only when it isn't a generic intent-tier label.
 */
export function conceptWords(agName: string, keywords: readonly string[]): string[] {
  const src =
    keywords.length > 0 ? keywords.join(" ") : TIER_NAMES.has(agName.toLowerCase()) ? "" : agName;
  return src
    .toLowerCase()
    .replace(/,/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

/**
 * Deterministic, ordered to-do list that closes the gap to EXCELLENT ad strength.
 * Combines the four levers Google scores (quantity, uniqueness, keyword inclusion, no
 * pinning) with Google's own literal actionItems (the asynchronous verdict).
 */
export function pathToExcellent(
  agName: string,
  keywords: readonly string[],
  hs: readonly string[],
  ds: readonly string[],
  dupH: readonly string[],
  echo: readonly string[],
  bannedHit: readonly string[],
  pins: readonly string[],
  actionItems: readonly string[],
  strength: string,
): string[] {
  const headlinesUnder = hs.length < MIN_HEADLINES;
  const descriptionsUnder = ds.length < MIN_DESCRIPTIONS;
  // keyword inclusion: theme words present in >=3 headlines
  const kwWords = conceptWords(agName, keywords);
  const hits =
    kwWords.length > 0
      ? hs.filter((h) => kwWords.some((w) => h.toLowerCase().includes(w))).length
      : 0;
  const keywordGap = kwWords.length > 0 && hits < 3;

  const steps: string[] = [
    ...(headlinesUnder
      ? [
          `Add ${MIN_HEADLINES - hs.length} more headlines (have ${hs.length}, target ${MIN_HEADLINES}) — ` +
            "distinct angles: value, feature, social proof, offer, audience, objection.",
        ]
      : []),
    ...(descriptionsUnder
      ? [
          `Add ${MIN_DESCRIPTIONS - ds.length} more descriptions (have ${ds.length}, target ${MIN_DESCRIPTIONS}), ` +
            "each a different angle ending in a CTA.",
        ]
      : []),
    ...(dupH.length > 0 ? [`Replace duplicate headlines with new angles: ${listRepr(dupH)}.`] : []),
    ...(echo.length > 0 ? [`Rewrite descriptions that just echo a headline: ${listRepr(echo)}.`] : []),
    ...(keywordGap
      ? [
          `Put the ad group's keyword ("${keywords.length > 0 ? keywords[0] : agName}") in >=3 headlines ` +
            `(currently ~${hits}). Google explicitly rewards keyword inclusion.`,
        ]
      : []),
    ...(bannedHit.length > 0
      ? [`Remove off-product / contaminated copy: ${listRepr(bannedHit)}.`]
      : []),
    ...(pins.length > 0 ? [`Unpin all assets (pinning blocks combination testing): ${listRepr(pins)}.`] : []),
  ];

  // what our own steps already cover, to skip echoing a Google hint on the same topic
  const topics = new Set<string>([
    ...(headlinesUnder || dupH.length > 0 ? ["headline"] : []),
    ...(descriptionsUnder || echo.length > 0 ? ["description"] : []),
    ...(keywordGap ? ["keyword", "headline"] : []),
  ]);
  const googleHints = actionItems
    .filter((it) => ![...topics].some((t) => it.toLowerCase().includes(t)))
    .map((it) => `Google says: ${it}`);
  const fallback =
    steps.length === 0 && googleHints.length === 0 && strength !== "EXCELLENT"
      ? [
          "Assets meet the quantitative bar; add more distinct headline angles and " +
            "stronger keyword coverage to push the diversity score to EXCELLENT.",
        ]
      : [];
  return [...steps, ...googleHints, ...fallback];
}

/**
 * Per-ad 'me-too copy' finding. Flags an ad whose message reads as a generic category
 * promise (one of the profile's `genericPhrases`) AND fails to cover every axis in the
 * profile, reporting which axes are absent. An ad that already leads with all axes is
 * NOT flagged even if it uses a generic phrase.
 *
 * Pure: judged against the supplied {@link DifferentiationProfile}, which is derived
 * per run from the campaign, landing page, and idea (not a hardcoded reference). An
 * empty profile never flags anything.
 */
export function differentiationGaps(
  headlines: readonly string[],
  descriptions: readonly string[],
  profile: DifferentiationProfile,
): DifferentiationGap | null {
  const blob = [...headlines, ...descriptions].join(" ").toLowerCase();
  const generic = profile.genericPhrases.some((phrase) => blob.includes(phrase.toLowerCase()));
  const missing = profile.axes
    .filter((axis) => !axis.triggers.some((trigger) => blob.includes(trigger.toLowerCase())))
    .map((axis) => axis.name);
  if (!generic || missing.length === 0) {
    return null;
  }
  return {
    issue: "undifferentiated_copy",
    missingAxes: missing,
    fix: "/adkit update — sharpen copy toward: " + missing.join(", "),
  };
}

export type DifferentiationGap = {
  issue: "undifferentiated_copy";
  missingAxes: string[];
  fix: string;
};

/**
 * Caller-facing CLI guard for GAQL id interpolation: ids must be bare digits, no
 * injection. Absent (null/undefined) is allowed. Delegates the digits check to the
 * central gaqlId validator.
 *
 * Naming note: Python `_require_digits` raised `SystemExit`; here it throws a plain
 * `Error` with the same message text.
 */
export function requireDigits(label: string, value: string | null | undefined): void {
  if (value === null || value === undefined) {
    return;
  }
  try {
    gaqlId(value);
  } catch {
    throw new Error(`error: --${label} must be digits only, got ${pyRepr(value)}`);
  }
}

/**
 * Flag pairs of the account's own ENABLED campaigns that share keywords — Google serves
 * only the higher-Ad-Rank one per auction, starving the other (self-competition). Pure:
 * takes the prefetched keyword map, issues no queries.
 */
export function cannibalization(
  serving: readonly ServingCampaign[],
  kwByCampaign: Readonly<Record<number, Readonly<Record<string, readonly string[]>>>>,
): CannibalizationPair[] {
  const kw = new Map<number, Set<string>>(
    serving.map((c) => [
      c.campaignId,
      new Set(
        Object.values(kwByCampaign[c.campaignId] ?? {}).flatMap((ks) => ks.map((k) => k.toLowerCase())),
      ),
    ]),
  );
  const impr = new Map<number, number>(serving.map((c) => [c.campaignId, c.impressions]));
  const name = new Map<number, string>(serving.map((c) => [c.campaignId, c.campaignName]));
  const ids = [...kw.keys()];
  const candidates = ids.flatMap((a, i) =>
    ids.slice(i + 1).map((b) => ({ a, b, shared: intersect(kw.get(a)!, kw.get(b)!) })),
  );
  return candidates
    .filter(({ shared }) => shared.length > 0)
    .map(({ a, b, shared }) => ({
      a: name.get(a)!,
      b: name.get(b)!,
      shared: [...shared].sort(),
      starvedLikely: impr.get(a)! < impr.get(b)! ? name.get(a)! : name.get(b)!,
    }));
}

export type ServingCampaign = {
  campaignId: number;
  campaignName: string;
  impressions: number;
};

export type CannibalizationPair = {
  a: string;
  b: string;
  shared: string[];
  starvedLikely: string;
};

/** Set intersection preserving no particular order (sorted by callers as needed). */
function intersect(a: ReadonlySet<string>, b: ReadonlySet<string>): string[] {
  return [...a].filter((x) => b.has(x));
}

/** Python-style repr of a list of strings (e.g. `['a', 'b']`), matching f-string output. */
function listRepr(items: readonly string[]): string {
  return `[${items.map(pyRepr).join(", ")}]`;
}

/** Python-style repr of a string: single-quoted, mirroring `{value!r}`. */
function pyRepr(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}
