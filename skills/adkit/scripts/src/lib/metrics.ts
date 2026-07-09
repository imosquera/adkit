/**
 * Pure helpers: volume short-form, CPC range, competition label.
 *
 * No SDK imports. All functions are referentially transparent.
 */

const EN_DASH = "–";

/**
 * Format a search-volume integer into its short form: `1000 -> "1k"`,
 * `3650 -> "3.7k"`, `1_500_000 -> "1.5M"`. Values under 1000 are returned as-is.
 *
 * Rounds to one decimal place using round-half-up (so `3.65 -> 3.7`, not the
 * float-naive `3.6`), then drops a trailing `.0`.
 */
export function formatVolume(n: number): string {
  if (n < 1_000) {
    return String(n);
  }
  const [unit, div] = n >= 1_000_000 ? (["M", 1_000_000] as const) : (["k", 1_000] as const);
  // Round n/div to one decimal, half-up, via integer math to avoid float error
  // (Python used Decimal(ROUND_HALF_UP) for exactly this reason).
  const numer = n * 10;
  const tenths = Math.floor((2 * numer + div) / (2 * div));
  const whole = Math.floor(tenths / 10);
  const frac = tenths % 10;
  const rounded = frac === 0 ? `${whole}` : `${whole}.${frac}`;
  return `${rounded}${unit}`;
}

function formatMicros(micros: number | null | undefined): string {
  return micros ? `$${(micros / 1_000_000).toFixed(2)}` : "$" + EN_DASH;
}

/**
 * Format a low/high CPC micros pair into a display range. A missing (null/0) bound
 * renders as `$–`; both missing collapses to a single `$–`. A missing low keeps the
 * range separator (`$–$14.00`) while both-present renders `$8.20–$14.00`.
 */
export function formatCpcRange(
  lowMicros: number | null | undefined,
  highMicros: number | null | undefined,
): string {
  const lowMissing = !lowMicros;
  const highMissing = !highMicros;
  if (lowMissing && highMissing) {
    return "$" + EN_DASH;
  }
  if (lowMissing) {
    // asymmetric per spec — low-missing drops the range separator
    return `$${EN_DASH}${formatMicros(highMicros)}`;
  }
  return `${formatMicros(lowMicros)}${EN_DASH}${formatMicros(highMicros)}`;
}

/**
 * Normalize a competition value to one of `LOW`/`MEDIUM`/`HIGH`, collapsing
 * anything else (including `UNKNOWN`/`UNSPECIFIED` and stray strings) to
 * `UNSPECIFIED`. Accepts either an enum-like object with a `name` field or a
 * bare string.
 */
export function competitionLabel(value: unknown): string {
  const raw =
    typeof value === "object" && value !== null && typeof (value as { name?: unknown }).name === "string"
      ? (value as { name: string }).name
      : String(value);
  const name = raw.toUpperCase();
  return name === "LOW" || name === "MEDIUM" || name === "HIGH" ? name : "UNSPECIFIED";
}
