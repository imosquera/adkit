/**
 * Flag parsers shared by the Meta bins (`preflight.ts`, `audit.ts`, `report.ts`).
 *
 * - {@link parseAdAccountFlag} — `--ad-account`, space or `=` form. A flag given
 *   without a value (end of argv, another `--flag` next, or blank) is an error, never
 *   a silent fall-back to the configured account: `node:util` `parseArgs` with
 *   `strict: false` turns a bare `--ad-account` into `true`, which a `typeof raw ===
 *   "string"` check would quietly read as "not given".
 * - {@link parseResultAction} — `--result-action`, defaulting to
 *   {@link DEFAULT_RESULT_ACTION}; a blank or valueless flag is an error.
 *
 * Pure: every parser reads only its argument and returns a {@link Result}.
 */

import { err, ok, type Result } from "../ids.js";

export const AD_ACCOUNT_FLAG = "--ad-account";

/** Default `--result-action`: the insights `action_type` counted as a result. */
export const DEFAULT_RESULT_ACTION = "lead";

/** The raw values of every `--ad-account` occurrence; `null` when one has no value. */
const adAccountOccurrences = (argv: readonly string[]): readonly (string | null)[] =>
  argv.flatMap((arg, i) => {
    if (arg === AD_ACCOUNT_FLAG) {
      const next = argv[i + 1];
      return [next === undefined || next.startsWith("--") ? null : next];
    }
    return arg.startsWith(`${AD_ACCOUNT_FLAG}=`) ? [arg.slice(AD_ACCOUNT_FLAG.length + 1)] : [];
  });

/**
 * Parse `--ad-account` out of argv: the trimmed value (last occurrence wins, like
 * `parseArgs`), `null` when the flag is absent, or an error when any occurrence has a
 * missing or blank value. Pure.
 */
export const parseAdAccountFlag = (argv: readonly string[]): Result<string | null> => {
  const values = adAccountOccurrences(argv).map((raw) => (raw === null ? "" : raw.trim()));
  if (values.some((v) => v === "")) return err(`${AD_ACCOUNT_FLAG} requires a value`);
  return ok(values.at(-1) ?? null);
};

/**
 * Parse a raw `--result-action` value (as `parseArgs` or an argv split hands it over):
 * absent → {@link DEFAULT_RESULT_ACTION}; a non-blank string → trimmed; anything else
 * (blank, or `true` from a bare flag) → error. Pure.
 */
export const parseResultAction = (raw: unknown): Result<string> => {
  if (raw === undefined) return ok(DEFAULT_RESULT_ACTION);
  const value = typeof raw === "string" ? raw.trim() : "";
  return value === ""
    ? err("--result-action needs a non-blank action_type (e.g. lead, offsite_conversion.fb_pixel_purchase)")
    : ok(value);
};
