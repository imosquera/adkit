import { describe, expect, it } from "vitest";
import { formatBulletText } from "./markdown.js";
import type { Candidate } from "./merge.js";

describe("formatBulletText", () => {
  it("renders the full decorated form", () => {
    const c: Candidate = {
      phrase: "single keyword ad group",
      source: "both",
      volume: 3600,
      competition: "HIGH",
      lowMicros: 8_200_000,
      highMicros: 14_000_000,
    };
    expect(formatBulletText(c)).toBe("single keyword ad group (3.6k, HIGH, $8.20–$14.00)");
  });

  it("renders an undecorated bullet as the bare phrase", () => {
    const c: Candidate = { phrase: "long tail variant", source: "llm" };
    expect(formatBulletText(c)).toBe("long tail variant");
  });

  it("renders a decorated bullet with missing cpc high", () => {
    const c: Candidate = {
      phrase: "info query",
      source: "api",
      volume: 150,
      competition: "LOW",
      lowMicros: 500_000,
      highMicros: null,
    };
    expect(formatBulletText(c)).toBe("info query (150, LOW, $0.50–$–)");
  });

  it("drops the cost segment when CPC is entirely absent (bug 6)", () => {
    // Keyword Planner returns null low_micros + high_micros for some keywords;
    // the bullet should read "(6.6k, LOW)" not "(6.6k, LOW, $–)".
    const c: Candidate = {
      phrase: "online reputation",
      source: "api",
      volume: 6600,
      competition: "LOW",
      lowMicros: null,
      highMicros: null,
    };
    expect(formatBulletText(c)).toBe("online reputation (6.6k, LOW)");
  });

  it("is deterministic", () => {
    const c: Candidate = {
      phrase: "x",
      source: "both",
      volume: 1_500_000,
      competition: "MEDIUM",
      lowMicros: 1_000_000,
      highMicros: 2_000_000,
    };
    expect(formatBulletText(c)).toBe(formatBulletText(c));
  });
});
