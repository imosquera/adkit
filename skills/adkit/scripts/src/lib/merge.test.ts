import { describe, expect, it } from "vitest";
import { type ApiIdea, MIN_VOLUME, comparisonKey, unionCandidates } from "./merge.js";

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

  it("drops api below min volume", () => {
    const result = unionCandidates([], [idea("low vol", MIN_VOLUME - 1)]);
    expect(result).toEqual([]);
  });

  it("keeps api at min volume", () => {
    const result = unionCandidates([], [idea("ok vol", MIN_VOLUME)]);
    expect(result).toHaveLength(1);
    expect(result[0].volume).toBe(MIN_VOLUME);
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
