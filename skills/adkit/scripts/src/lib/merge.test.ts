import { describe, expect, it } from "vitest";
import { type ApiIdea, comparisonKey, unionCandidates } from "./merge.js";

function idea(
  phrase: string,
  volume = 20_000,
  comp = "LOW",
  low: number | null = 1_000_000,
  high: number | null = 2_000_000,
  conceptGroup: string | null = null,
): ApiIdea {
  return { phrase, volume, competition: comp, lowMicros: low, highMicros: high, conceptGroup };
}

describe("comparisonKey", () => {
  it("collapses case and whitespace", () => {
    expect(comparisonKey("Buy Now")).toBe(comparisonKey("buy  now"));
    expect(comparisonKey("  Sell My CAR  ")).toBe("sell my car");
  });
});

describe("unionCandidates", () => {
  it("drops zero-volume api phrases", () => {
    const result = unionCandidates([], [idea("dead phrase", 0)]);
    expect(result).toEqual([]);
  });

  // A local geo's keywords live in the tens, not the thousands: a 25-mile radius
  // whose whole keyword set totals 470/mo used to come back empty under a 1000/mo
  // floor, which read as "no demand here" rather than "small market".
  it("keeps low-volume api phrases (no floor beyond zero)", () => {
    const result = unionCandidates([], [idea("soccer clinics near me", 10)]);
    expect(result).toHaveLength(1);
    expect(result[0].volume).toBe(10);
  });

  it("drops api phrases over 80 chars", () => {
    const long = "a".repeat(81);
    const result = unionCandidates([], [idea(long, 50_000)]);
    expect(result).toEqual([]);
  });

  it("attributes api metrics to matching llm phrase", () => {
    const result = unionCandidates(
      ["Buy Now"],
      [idea("buy  now", 36_000, "HIGH", 8_000_000, 14_000_000)],
    );
    expect(result).toHaveLength(1);
    const c = result[0];
    expect(c.phrase).toBe("Buy Now"); // LLM casing preserved
    expect(c.source).toBe("both");
    expect(c.volume).toBe(36_000);
    expect(c.competition).toBe("HIGH");
  });

  it("carries the api concept group through to matched and api-only candidates", () => {
    const both = unionCandidates(
      ["buy now"],
      [idea("buy now", 20_000, "LOW", 1_000_000, 2_000_000, "Purchase Intent")],
    );
    expect(both[0].conceptGroup).toBe("Purchase Intent");
    const apiOnly = unionCandidates(
      [],
      [idea("espresso machine", 20_000, "LOW", 1_000_000, 2_000_000, "Coffee Makers")],
    );
    expect(apiOnly[0].conceptGroup).toBe("Coffee Makers");
  });

  it("keeps api-only phrases and drops bare llm", () => {
    const result = unionCandidates(
      ["coffee maker"], // no API backing -> dropped, not kept bare
      [idea("espresso machine", 20_000)],
    );
    const phrases = new Set(result.map((c) => c.phrase));
    expect(phrases).toEqual(new Set(["espresso machine"]));
  });

  it("drops bare llm with no api match", () => {
    const result = unionCandidates(["niche phrase"], []);
    expect(result).toEqual([]);
  });
});
