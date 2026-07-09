/**
 * GAQL literal escaping + id validation — the single home for the two ways an
 * untrusted value can reach a Google Ads Query string.
 *
 * {@link gaqlString} escapes a value destined for a single-quoted string literal
 * (campaign/ad-group names, geo names). {@link gaqlId} guards a value interpolated
 * raw (unquoted) into a query — campaign/customer ids — by requiring bare digits,
 * so nothing can break out of the numeric context. Callers that interpolate ids
 * directly MUST route them through {@link gaqlId} (or the audit-facing
 * `requireDigits`, which delegates here).
 */

/**
 * Escape a value for a single-quoted GAQL string literal: backslash first (so the
 * quote-escape's backslash isn't doubled), then the single quote.
 */
export function gaqlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/**
 * Validate that an id interpolated raw (unquoted) into GAQL is digits-only,
 * returning it unchanged. Throws otherwise — the numeric-context analogue of
 * {@link gaqlString}, consolidating the scattered isdigit() guards.
 */
export function gaqlId(value: string | number): string {
  const str = String(value);
  if (!/^[0-9]+$/.test(str)) {
    throw new Error(`GAQL id must be digits only, got ${JSON.stringify(str)}`);
  }
  return str;
}
