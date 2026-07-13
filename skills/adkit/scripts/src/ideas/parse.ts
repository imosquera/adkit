/**
 * Pure markdown-extraction helpers for the /adkit create scaffold: read the
 * theme-grouped keywords and negative keywords that /adkit gtm authored under
 * "## Go To Market". Ad groups come from the "### Keyword Themes" subsection (one
 * ad group per non-spend-trap theme); negatives come from "### Keywords > ####
 * Negative Keywords". No SDK, no urllib, no stdout, no sys.exit — every function
 * is referentially transparent and covered by parse.test.ts.
 *
 * The IO shell (bin/create) reads the markdown off disk and feeds the text into
 * these functions; nothing here touches the filesystem or the network.
 */

import type { Keyword } from "../lib/schema.js";

// STAG = Single Theme Ad Group. The scaffold makes one ad group per Keyword Theme
// authored by /adkit gtm (step 15c) and packs up to this many keywords into each.
// With 3-6 themes this lands a fresh campaign near the ~100-keyword launch target
// (the gtm generation target, well above the audit's 25-keyword floor); with AI Max
// + Smart Bidding on, more keywords per theme means more data to consolidate, not
// the micro-SKAG anti-pattern. `--top-n` overrides (up to MAX_KEYWORDS_PER_THEME,
// leaving headroom above the default).
export const DEFAULT_TOP_N = 25;
export const MAX_KEYWORDS_PER_THEME = 30;

// A theme flagged by gtm as the generic "keep-but-don't-lead" spend trap. The
// marker may sit anywhere in the `####` heading (before OR after any ` — role
// note`) and is case-insensitive. Such themes are EXCLUDED from ad-group creation
// (they feed the negative-keyword list instead — see reference/gtm.md step 15c).
const SPEND_TRAP_MARKER = /\[\s*spend-?trap\s*\]/i;

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
 * The text under a `### <heading>` subsection within the `## Go To Market` block
 * (sliced until the next `###` sibling), or null when either heading is absent.
 * Shared by {@link readThemeGroups} and {@link extractNegatives}.
 */
function gtmSubsection(md: string, heading: string): string | null {
  const gtm = /^##\s+Go\s+To\s+Market\b.*$/im.exec(md);
  if (!gtm) {
    return null;
  }
  const block = sliceUntilNext(md.slice(gtm.index + gtm[0].length), "^##\\s+");
  const re = new RegExp(`^###\\s+${escapeRegExp(heading)}\\b.*$`, "im");
  const m = re.exec(block);
  if (!m) {
    return null;
  }
  return sliceUntilNext(block.slice(m.index + m[0].length), "^###\\s+");
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
 * The display name of a `#### ` Keyword Theme heading: the `[spend-trap]` marker
 * and any ` — role note` are removed, leaving the theme's name.
 */
function themeName(heading: string): string {
  return heading
    .replace(SPEND_TRAP_MARKER, "")
    .split(/\s+[—–-]{1,2}\s+/)[0]!
    .replace(/[*_`]/g, "")
    .trim();
}

/**
 * Read the Single Theme Ad Groups authored by ads:gtm under
 * "## Go To Market > ### Keyword Themes" — one `[name, keywords]` pair per
 * `#### ` theme, in file order, `[spend-trap]`-marked themes EXCLUDED (they feed
 * negatives, not ad groups). Keywords are cleaned (decoration/offer suffix
 * stripped, lowercased), deduped ACROSS themes (first-seen wins, so no keyword
 * can land in two ad groups — the no-cannibalization contract), and each theme is
 * truncated to `maxPerTheme` (Google's per-ad-group ceiling). Empty when the
 * `### Keyword Themes` subsection is absent → bin/create dies asking for a gtm
 * re-run (there is deliberately NO fallback to the old intent tiers).
 */
export function readThemeGroups(md: string, maxPerTheme: number): Array<[string, string[]]> {
  const section = gtmSubsection(md, "Keyword Themes");
  if (section === null) {
    return [];
  }
  const headings = [...section.matchAll(/^####\s+(.+?)\s*$/gm)];
  const seen = new Set<string>();
  return headings.flatMap((m, i): Array<[string, string[]]> => {
    const heading = m[1]!;
    if (SPEND_TRAP_MARKER.test(heading)) {
      return []; // spend-trap theme → excluded from ad groups
    }
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < headings.length ? (headings[i + 1]!.index ?? section.length) : section.length;
    const kws = bulletBodies(section.slice(start, end))
      .map(cleanKeyword)
      .filter((c) => c !== "" && !seen.has(c));
    kws.forEach((k) => seen.add(k));
    const capped = kws.slice(0, maxPerTheme);
    return capped.length > 0 ? [[themeName(heading), capped]] : [];
  });
}

/**
 * Pull bullets under '#### Negative Keywords' (within ### Keywords) into
 * campaign negative-keyword objects. Phrase only (reason suffix stripped); PHRASE
 * match by default. Empty when the section is absent.
 */
export function extractNegatives(md: string): Keyword[] {
  const section = gtmSubsection(md, "Keywords");
  if (section === null) {
    return [];
  }
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
