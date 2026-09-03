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

  // A legacy expanded text ad carries no ad_strength at all. `ads.sh report` does
  // not filter ad type, so one 2013-era ETA used to throw here and kill the whole
  // report — a missing creative grade is ordinary data, not a parse failure.
  it.each([undefined, null, ""])("decodes an absent ad_strength (%p) to UNSPECIFIED instead of throwing", (absent) => {
    expect(adStrengthName(absent as string | undefined)).toBe("UNSPECIFIED");
  });

  it("still fails an EXCELLENT check for an absent value (UNSPECIFIED misleads nothing downstream)", () => {
    expect(adStrengthName(undefined)).not.toBe("EXCELLENT");
  });

  it("keeps throwing for garbage — absent is not a licence to accept unproven values", () => {
    // The graceful-degrade path is only for a genuinely missing field; an
    // out-of-range ordinal still means the decode assumption broke (issue #51).
    expect(() => adStrengthName(99)).toThrow(/Unknown AdStrength/);
    expect(() => adStrengthName("MEDIOCRE")).toThrow(/Unknown AdStrength/);
  });

  it("decodes the UNSPECIFIED/UNKNOWN ordinals themselves", () => {
    expect(adStrengthName(0)).toBe("UNSPECIFIED");
    expect(adStrengthName(1)).toBe("UNKNOWN");
  });
});
