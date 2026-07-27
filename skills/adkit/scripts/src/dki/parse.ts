/**
 * Dynamic Keyword Insertion (DKI) parsing — `{keyword:default text}` inline within
 * RSA headline / description / Display-path string fields (issue #19).
 *
 * This is the single parse boundary for DKI (FR-001, FR-014): it recognizes the
 * five capitalization modes, requires a non-empty default, rejects malformed braces,
 * and computes the worst-case length (every code replaced by its verbatim default)
 * that callers enforce against a field's character limit. Nothing downstream
 * re-validates — `lib/schema.ts` is the only caller, at Brief-parse time.
 *
 * Rendering (casing playback) and lint warnings are separate, non-blocking
 * concerns — see `render.ts` and `lint.ts`.
 */

export const CASING_MODES = ["keyword", "Keyword", "KeyWord", "KEYWord", "KeyWORD"] as const;
export type CasingMode = (typeof CASING_MODES)[number];

const CASING_MODE_SET: ReadonlySet<string> = new Set(CASING_MODES);

/** One parsed `{casing:default}` code, plus its verbatim source for round-trip emission. */
export interface DkiCode {
  readonly casing: CasingMode;
  /** Verbatim, untrimmed default text as authored. */
  readonly default: string;
  /** The exact `{...}` substring this code was parsed from. */
  readonly source: string;
}

/** A headline/description/Display-path field, parsed for DKI codes. */
export interface DkiField {
  /** The verbatim original field text (unchanged — this IS the round-trip value). */
  readonly source: string;
  readonly codes: readonly DkiCode[];
  /** Length after replacing every code with its default text; the field-limit input. */
  readonly worstCaseLength: number;
}

/** A malformed or invalid DKI code, naming the field it was found in. */
export class DkiFieldError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(`${field}: ${message}`);
    this.name = "DkiFieldError";
  }
}

/**
 * Parse every `{...}` code out of `text`. A brace pair that isn't a valid DKI code
 * (missing colon, empty default, unrecognized casing token) is rejected rather than
 * passed through as literal text, as are unclosed braces, nested braces, and stray
 * unmatched `}`. Fields with no braces at all parse as zero codes, worst-case length
 * equal to their own length.
 */
export function parseDkiField(fieldName: string, text: string): DkiField {
  const codes: DkiCode[] = [];
  const worstCaseParts: string[] = [];
  let i = 0;

  while (i < text.length) {
    const openIdx = text.indexOf("{", i);
    if (openIdx === -1) {
      const rest = text.slice(i);
      if (rest.includes("}")) {
        throw new DkiFieldError(fieldName, `unmatched '}' (no opening '{')`);
      }
      worstCaseParts.push(rest);
      break;
    }

    const strayCloseIdx = text.indexOf("}", i);
    if (strayCloseIdx !== -1 && strayCloseIdx < openIdx) {
      throw new DkiFieldError(fieldName, `unmatched '}' (no opening '{')`);
    }
    worstCaseParts.push(text.slice(i, openIdx));

    const nextOpenIdx = text.indexOf("{", openIdx + 1);
    const closeIdx = text.indexOf("}", openIdx + 1);
    if (closeIdx === -1) {
      throw new DkiFieldError(fieldName, `unclosed '{' — missing '}' (in ${JSON.stringify(text.slice(openIdx))})`);
    }
    if (nextOpenIdx !== -1 && nextOpenIdx < closeIdx) {
      throw new DkiFieldError(fieldName, `nested '{' is not allowed inside a DKI code`);
    }

    const source = text.slice(openIdx, closeIdx + 1);
    const inner = text.slice(openIdx + 1, closeIdx);
    const colonIdx = inner.indexOf(":");
    if (colonIdx === -1) {
      throw new DkiFieldError(fieldName, `DKI code ${JSON.stringify(source)} requires a default text, e.g. {keyword:default}`);
    }

    const token = inner.slice(0, colonIdx);
    const defaultText = inner.slice(colonIdx + 1);
    if (defaultText === "") {
      throw new DkiFieldError(fieldName, `DKI code ${JSON.stringify(source)} must not have an empty default text`);
    }
    if (!CASING_MODE_SET.has(token)) {
      throw new DkiFieldError(
        fieldName,
        `DKI code ${JSON.stringify(source)} uses unrecognized casing ${JSON.stringify(token)} — must be one of ${CASING_MODES.join(", ")}`,
      );
    }

    codes.push({ casing: token as CasingMode, default: defaultText, source });
    worstCaseParts.push(defaultText);
    i = closeIdx + 1;
  }

  return { source: text, codes, worstCaseLength: worstCaseParts.join("").length };
}

/** True when `text` contains a DKI code opener/closer at all (used to gate the Final URL rule). */
export function containsDkiSyntax(text: string): boolean {
  return text.includes("{") || text.includes("}");
}
