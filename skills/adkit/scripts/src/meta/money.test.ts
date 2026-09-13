/** Unit tests for Meta minor-unit money conversion. */
import { describe, expect, it } from "vitest";

import { fromMinorUnits, toMinorUnits, ZERO_DECIMAL_CURRENCIES } from "./money.js";

describe("toMinorUnits", () => {
  it("multiplies USD and EUR by 100", () => {
    expect(toMinorUnits(50, "USD")).toBe(5000);
    expect(toMinorUnits(12.34, "EUR")).toBe(1234);
  });

  it("rounds to an integer", () => {
    expect(toMinorUnits(19.999, "USD")).toBe(2000);
    expect(toMinorUnits(0.29, "USD")).toBe(29);
  });

  it("leaves zero-decimal currencies unscaled", () => {
    expect(toMinorUnits(5000, "JPY")).toBe(5000);
    expect(toMinorUnits(1234.6, "KRW")).toBe(1235);
  });

  it("compares currency codes case-insensitively", () => {
    expect(toMinorUnits(5000, "jpy")).toBe(5000);
    expect(toMinorUnits(50, "usd")).toBe(5000);
  });
});

describe("fromMinorUnits", () => {
  it("divides USD and EUR by 100", () => {
    expect(fromMinorUnits(5000, "USD")).toBe(50);
    expect(fromMinorUnits(1234, "EUR")).toBe(12.34);
  });

  it("leaves JPY unscaled", () => {
    expect(fromMinorUnits(5000, "JPY")).toBe(5000);
    expect(fromMinorUnits("5000", "Jpy")).toBe(5000);
  });

  it("accepts Graph decimal strings", () => {
    expect(fromMinorUnits("5000", "USD")).toBe(50);
    expect(fromMinorUnits("1234", "EUR")).toBe(12.34);
  });

  it("round-trips with toMinorUnits", () => {
    expect(fromMinorUnits(toMinorUnits(42.5, "USD"), "USD")).toBe(42.5);
  });

  it("rejects non-numeric input", () => {
    expect(() => fromMinorUnits("abc", "USD")).toThrow(RangeError);
    expect(() => fromMinorUnits("", "USD")).toThrow(RangeError);
  });
});

describe("ZERO_DECIMAL_CURRENCIES", () => {
  it("contains exactly the plan D4 set", () => {
    expect([...ZERO_DECIMAL_CURRENCIES].sort()).toEqual(
      ["CLP", "COP", "CRC", "HUF", "IDR", "ISK", "JPY", "KRW", "PYG", "TWD", "VND"],
    );
  });
});
