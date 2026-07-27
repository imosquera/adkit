/**
 * Non-blocking DKI lint warnings (FR-010–FR-013) — a pure function, separate from
 * the blocking parse in `parse.ts` (FR-014). Syntactically valid DKI can still be
 * risky at serve time; this surfaces the documented failure modes as advisory
 * findings without rejecting the field.
 */

import type { DkiField } from "./parse.js";

export const LINT_CATEGORIES = [
  "too-many-characters",
  "dsa-unavailable",
  "restricted-content",
  "trademark",
  "misspelling",
  "grammar",
  "landing-page",
] as const;
export type LintCategory = (typeof LINT_CATEGORIES)[number];

export interface LintWarning {
  readonly category: LintCategory;
  readonly message: string;
}

export interface LintContext {
  /** The field's character limit (30 headline / 90 description / 15 path). */
  readonly fieldLimit: number;
  /** True when this ad runs in a Dynamic Search Ad context (no keyword targeting). */
  readonly isDsa?: boolean;
  /** Content vertical, e.g. "healthcare" / "sexual-content" — case-insensitive. */
  readonly vertical?: string;
  /** False when the landing page is known not to support dynamic text substitution. */
  readonly landingPageSupportsDynamicText?: boolean;
}

/** Verticals Google restricts DKI insertion in (case-insensitive). */
const RESTRICTED_VERTICALS = new Set(["healthcare", "sexual-content"]);

/** Small maintained list of brand-like tokens that may trigger trademark policy review. */
const TRADEMARK_LIKE_TOKENS = new Set([
  "nike",
  "adidas",
  "coca-cola",
  "pepsi",
  "apple",
  "iphone",
  "google",
  "amazon",
  "microsoft",
  "disney",
]);

/** Small maintained list of common misspellings worth a heads-up (best-effort, not a spellchecker). */
const COMMON_MISSPELLINGS: Readonly<Record<string, string>> = {
  recieve: "receive",
  seperate: "separate",
  definately: "definitely",
  occured: "occurred",
  wich: "which",
};

/** Trailing words that make an inserted-keyword sentence likely to read awkwardly. */
const TRAILING_WORD_SMELL = new Set(["a", "an", "the", "for", "to", "of", "in", "on", "with", "and"]);

/** A field is "near its limit" once worst-case usage crosses this fraction. */
const NEAR_LIMIT_RATIO = 0.9;

function wordsOf(text: string): string[] {
  return text.toLowerCase().match(/[a-z']+/g) ?? [];
}

/** Surface every applicable advisory warning for `field`. Never throws; never blocks authoring. */
export function lintDkiField(fieldName: string, field: DkiField, context: LintContext): LintWarning[] {
  const warnings: LintWarning[] = [];
  const hasCodes = field.codes.length > 0;

  if (field.worstCaseLength >= context.fieldLimit * NEAR_LIMIT_RATIO) {
    warnings.push({
      category: "too-many-characters",
      message:
        `${fieldName}: worst-case length ${field.worstCaseLength}/${context.fieldLimit} leaves little headroom — ` +
        "an inserted keyword risks exceeding the limit and falling back to the default",
    });
  }

  if (hasCodes && context.isDsa) {
    warnings.push({
      category: "dsa-unavailable",
      message: `${fieldName}: DKI is unavailable for Dynamic Search Ads (no keyword targeting) — the default text will be used instead`,
    });
  }

  if (hasCodes && context.vertical !== undefined && RESTRICTED_VERTICALS.has(context.vertical.toLowerCase())) {
    warnings.push({
      category: "restricted-content",
      message: `${fieldName}: DKI insertion in a restricted vertical (${context.vertical}) may be blocked by Google policy`,
    });
  }

  if (hasCodes && wordsOf(field.source).some((word) => TRADEMARK_LIKE_TOKENS.has(word))) {
    warnings.push({
      category: "trademark",
      message: `${fieldName}: DKI text contains a trademark-like token — insertion may be blocked by Google policy`,
    });
  }

  for (const code of field.codes) {
    const defaultWords = wordsOf(code.default);
    const misspelled = defaultWords.find((word) => word in COMMON_MISSPELLINGS);
    if (misspelled !== undefined) {
      warnings.push({
        category: "misspelling",
        message:
          `${fieldName}: DKI default ${JSON.stringify(code.default)} appears to misspell "${misspelled}" ` +
          `as "${COMMON_MISSPELLINGS[misspelled]}" — Google may auto-correct it or fall back to the default`,
      });
    }
    const lastWord = defaultWords[defaultWords.length - 1];
    if (lastWord !== undefined && TRAILING_WORD_SMELL.has(lastWord)) {
      warnings.push({
        category: "grammar",
        message: `${fieldName}: DKI default ${JSON.stringify(code.default)} ends on "${lastWord}" — the inserted keyword may read ungrammatically in context`,
      });
    }
  }

  if (hasCodes && context.landingPageSupportsDynamicText === false) {
    warnings.push({
      category: "landing-page",
      message: `${fieldName}: the landing page may not support dynamic text substitution for this field`,
    });
  }

  return warnings;
}
