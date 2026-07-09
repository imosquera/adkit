/**
 * Pure markdown-extraction helpers for the /adkit create scaffold: read the
 * tier-grouped keywords and negative keywords that /adkit gtm authored under
 * "## Go To Market > ### Keywords". No SDK, no urllib, no stdout, no sys.exit —
 * every function is referentially transparent and covered by parse.test.ts.
 *
 * The IO shell (bin/create) reads the markdown off disk and feeds the text into
 * these functions; nothing here touches the filesystem or the network.
 */

import type { Keyword } from "../lib/schema.js";

// STAG = Single Theme Ad Group. The scaffold makes one ad group per intent tier
// (Informational/Navigational/Commercial/Transactional) and packs up to this many
// keywords into each. 25/tier across the 4 tiers lands a fresh campaign near the
// ~100-keyword launch target (the gtm generation target, well above the audit's
// 25-keyword floor); with AI Max + Smart Bidding on, more keywords per theme means
// more data to consolidate, not the micro-SKAG anti-pattern. `--top-n` overrides
// (up to MAX_KEYWORDS_PER_THEME, leaving headroom above the default).
export const DEFAULT_TOP_N = 25;
export const MAX_KEYWORDS_PER_THEME = 30;

// STAG themes ARE the intent tiers. The model does the grouping in ads:gtm
// (each keyword is classified into exactly one tier — that classification IS the
// theme assignment). This skill only READS those pre-grouped themes; it makes no
// grouping decision of its own.
const TIER_THEMES = ["Informational", "Navigational", "Commercial", "Transactional"] as const;

/** Escape a string for literal use inside a RegExp (mirrors Python's `re.escape`). */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function slugFromProcessedPath(mdPath: string): string {
  const leaf = mdPath.split("/").pop() ?? mdPath;
  return leaf.replace(/\.(md|markdown)$/i, "");
}

function sliceUntilNext(text: string, pattern: string): string {
  const re = new RegExp(pattern, "m");
  const m = re.exec(text);
  return m ? text.slice(0, m.index) : text;
}

/**
 * Drop the ' — offer: ...' / ' -- offer: ...' annotation appended by /adkit gtm
 * to multi-intent bullets, leaving just the keyword phrase.
 */
function stripOfferSuffix(bullet: string): string {
  return bullet.replace(/\s+[—–-]{1,2}\s*offer:.*$/i, "").trim();
}

function cleanKeyword(raw: string): string {
  // Strip /adkit gtm decoration `(volume, competition, $L–$H)` at end.
  const stripped = stripOfferSuffix(raw).replace(/\s*\([^)]*\)\s*$/, "");
  return stripped.replace(/[*_`]/g, "").toLowerCase().trim();
}

/**
 * Pull the group captures of `^\s*[-*]\s+(.+?)\s*$` (MULTILINE) — the bullet
 * bodies — matching Python's `re.findall` with a single capture group.
 */
function bulletBodies(text: string): string[] {
  return [...text.matchAll(/^[ \t]*[-*][ \t]+(.+?)[ \t]*$/gm)].map((m) => m[1]);
}

/**
 * Pull bullets under the given tier headings (in order), deduped, lowercased,
 * offer-suffix stripped. Order: tier order, then bullet order within each tier.
 */
function extractKeywords(md: string, tiers: readonly string[]): string[] {
  const gtm = /^##\s+Go\s+To\s+Market\b.*$/im.exec(md);
  if (!gtm) {
    return [];
  }
  const block = sliceUntilNext(md.slice(gtm.index + gtm[0].length), "^##\\s+");
  const kw = /^###\s+Keywords\b.*$/im.exec(block);
  if (!kw) {
    return [];
  }
  const section = block.slice(kw.index + kw[0].length);

  const tierKeywords = (heading: string): string[] => {
    const re = new RegExp(`^####\\s+${escapeRegExp(heading)}\\b.*$`, "im");
    const m = re.exec(section);
    if (!m) {
      return [];
    }
    const sub = sliceUntilNext(section.slice(m.index + m[0].length), "^####\\s+");
    return bulletBodies(sub)
      .map((bullet) => cleanKeyword(bullet))
      .filter((c) => c !== "");
  };

  // Map-by-key dedup keeps first-seen order — across all tiers, matching the
  // original sequential seen-set threaded tier to tier.
  const all = tiers.flatMap((tier) => tierKeywords(tier));
  return [...new Set(all)];
}

/**
 * Read the Single Theme Ad Groups defined upstream by ads:gtm — one per
 * non-empty intent tier, in tier order, keywords in authored order. Truncates a
 * theme to `maxPerTheme` (Google's per-ad-group ceiling). No grouping logic:
 * ads:gtm guarantees each keyword lives in exactly one tier.
 */
export function readThemeGroups(md: string, maxPerTheme: number): Array<[string, string[]]> {
  return TIER_THEMES.map((tier): [string, string[]] => [tier, extractKeywords(md, [tier]).slice(0, maxPerTheme)]).filter(
    ([, kws]) => kws.length > 0,
  );
}

/**
 * Pull bullets under '#### Negative Keywords' (within ### Keywords) into
 * campaign negative-keyword objects. Phrase only (reason suffix stripped); PHRASE
 * match by default. Empty when the section is absent.
 */
export function extractNegatives(md: string): Keyword[] {
  const gtm = /^##\s+Go\s+To\s+Market\b.*$/im.exec(md);
  if (!gtm) {
    return [];
  }
  const block = sliceUntilNext(md.slice(gtm.index + gtm[0].length), "^##\\s+");
  const kw = /^###\s+Keywords\b.*$/im.exec(block);
  if (!kw) {
    return [];
  }
  const section = block.slice(kw.index + kw[0].length);
  const m = /^####\s+Negative\s+Keywords\b.*$/im.exec(section);
  if (!m) {
    return [];
  }
  const sub = sliceUntilNext(section.slice(m.index + m[0].length), "^####\\s+");
  const phrases = bulletBodies(sub)
    .map((bullet) => cleanKeyword(bullet.split(/\s+—\s+/)[0]))
    .filter((p) => p !== "");
  return [...new Set(phrases)].map((text): Keyword => ({ text, matchType: "PHRASE" }));
}
