import { describe, expect, it } from "vitest";
import { competitionLabel, formatCpcRange, formatVolume } from "./metrics.js";

describe("formatVolume", () => {
  it("returns values under a thousand as-is", () => {
    expect(formatVolume(0)).toBe("0");
    expect(formatVolume(24)).toBe("24");
    expect(formatVolume(999)).toBe("999");
  });

  it("rounds thousands half-up and drops a trailing zero", () => {
    expect(formatVolume(1_000)).toBe("1k");
    expect(formatVolume(1_499)).toBe("1.5k");
    expect(formatVolume(3_000)).toBe("3k");
    expect(formatVolume(3_650)).toBe("3.7k"); // 3.65 -> 3.7 (half up)
  });

  it("formats millions", () => {
    expect(formatVolume(1_000_000)).toBe("1M");
    expect(formatVolume(1_500_000)).toBe("1.5M");
  });
});

describe("formatCpcRange", () => {
  it("formats both bounds present", () => {
    expect(formatCpcRange(8_200_000, 14_000_000)).toBe("$8.20–$14.00");
  });

  it("renders a missing low bound", () => {
    expect(formatCpcRange(null, 14_000_000)).toBe("$–$14.00");
    expect(formatCpcRange(0, 14_000_000)).toBe("$–$14.00");
  });

  it("renders a missing high bound", () => {
    expect(formatCpcRange(8_200_000, null)).toBe("$8.20–$–");
    expect(formatCpcRange(8_200_000, 0)).toBe("$8.20–$–");
  });

  it("collapses both missing to a single dash", () => {
    expect(formatCpcRange(null, null)).toBe("$–");
    expect(formatCpcRange(0, 0)).toBe("$–");
  });
});

describe("competitionLabel", () => {
  it("passes through known labels", () => {
    expect(competitionLabel({ name: "LOW" })).toBe("LOW");
    expect(competitionLabel({ name: "MEDIUM" })).toBe("MEDIUM");
    expect(competitionLabel({ name: "HIGH" })).toBe("HIGH");
  });

  it("collapses unknown values to UNSPECIFIED", () => {
    expect(competitionLabel({ name: "UNKNOWN" })).toBe("UNSPECIFIED");
    expect(competitionLabel({ name: "UNSPECIFIED" })).toBe("UNSPECIFIED");
    expect(competitionLabel("garbage")).toBe("UNSPECIFIED");
  });
});
