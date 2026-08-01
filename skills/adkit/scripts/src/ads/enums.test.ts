import { describe, expect, it } from "vitest";
import { adStrengthName } from "./enums.js";

describe("adStrengthName", () => {
  it("decodes a raw numeric ordinal to its string name", () => {
    expect(adStrengthName(7)).toBe("EXCELLENT");
    expect(adStrengthName(6)).toBe("GOOD");
  });

  it("passes an already-decoded string name through unchanged", () => {
    expect(adStrengthName("EXCELLENT")).toBe("EXCELLENT");
  });

  it("throws on an out-of-range ordinal instead of returning an unproven value", () => {
    expect(() => adStrengthName(99)).toThrow(/Unknown AdStrength/);
  });

  it("throws on an unrecognized string instead of casting it through", () => {
    expect(() => adStrengthName("NOT_A_REAL_STRENGTH")).toThrow(/Unknown AdStrength/);
  });
});
