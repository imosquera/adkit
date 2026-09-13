/**
 * Money conversion between brief/plan decimal amounts (`dailyBudget: 50`) and the
 * Graph API's minor units (cents for USD, whole yen for JPY).
 */

// ponytail: static offset table; switch to Meta's currency list if a new zero-decimal currency appears.
export const ZERO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  "CLP",
  "COP",
  "CRC",
  "HUF",
  "ISK",
  "IDR",
  "JPY",
  "KRW",
  "PYG",
  "TWD",
  "VND",
]);

/** Minor units per major unit for `currency` (case-insensitive ISO code). */
const offsetFor = (currency: string): number =>
  ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase()) ? 1 : 100;

/** Decimal amount → integer minor units, rounded to the nearest unit. */
export const toMinorUnits = (amount: number, currency: string): number =>
  Math.round(amount * offsetFor(currency));

/**
 * Minor units → decimal amount. Accepts Graph's decimal strings (`"5000"`);
 * throws a RangeError on a non-numeric value rather than returning NaN.
 */
export const fromMinorUnits = (value: number | string, currency: string): number => {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw new RangeError(`fromMinorUnits: not a numeric amount: ${JSON.stringify(value)}`);
  }
  return n / offsetFor(currency);
};
