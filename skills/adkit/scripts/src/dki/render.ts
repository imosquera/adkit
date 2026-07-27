/**
 * Pure display-render helper for DKI casing modes (FR-004) — human preview only.
 * Never persisted or emitted: emission stays the verbatim `{casing:default}`
 * source (see `parse.ts`), and field-limit enforcement is casing-independent
 * (worst-case length is measured on the raw default text, not a rendered form).
 */

import type { CasingMode, DkiField } from "./parse.js";

/**
 * Small maintained list of tokens that stay fully uppercase under the mixed casing
 * modes (`KEYWord`, `KeyWORD`) instead of being title-cased. Lookup is
 * case-insensitive; extend as new acronyms come up.
 */
export const ALL_CAPS_TOKENS = ["USA", "UK", "US", "TV", "AI", "SUV", "DIY", "USB"] as const;

const ALL_CAPS_TOKEN_SET = new Set(ALL_CAPS_TOKENS.map((t) => t.toUpperCase()));

function capitalizeFirst(text: string): string {
  if (text.length === 0) {
    return text;
  }
  return text[0]!.toUpperCase() + text.slice(1).toLowerCase();
}

function titleCase(text: string, preserveAllCapsTokens: boolean): string {
  return text
    .split(" ")
    .map((word) => {
      if (preserveAllCapsTokens && word.length > 0 && ALL_CAPS_TOKEN_SET.has(word.toUpperCase())) {
        return word.toUpperCase();
      }
      return capitalizeFirst(word);
    })
    .join(" ");
}

/**
 * Render `text` (the searcher's triggering keyword, or a default) under one of the
 * five casing modes. `KEYWord` and `KeyWORD` — the mixed modes — preserve
 * {@link ALL_CAPS_TOKENS} in place of title-casing them; `KeyWord` title-cases
 * every word uniformly, with no token awareness.
 */
export function renderCasing(casing: CasingMode, text: string): string {
  switch (casing) {
    case "keyword":
      return text.toLowerCase();
    case "Keyword":
      return capitalizeFirst(text.toLowerCase());
    case "KeyWord":
      return titleCase(text, false);
    case "KEYWord":
    case "KeyWORD":
      return titleCase(text, true);
  }
}

/**
 * Render a full preview of `field` with every DKI code replaced by `keyword`
 * (rendered under that code's casing mode) — for optional human preview only.
 * Literal text around the codes is left untouched.
 */
export function renderDkiPreview(field: DkiField, keyword: string): string {
  let rendered = field.source;
  for (const code of field.codes) {
    rendered = rendered.replace(code.source, renderCasing(code.casing, keyword));
  }
  return rendered;
}
