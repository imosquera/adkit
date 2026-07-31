import { describe, expect, it } from "vitest";
import { renderQualityScoreSection } from "./render.js";
import type { QualityScoreEntry } from "./types.js";

const belowAvg: QualityScoreEntry = {
  keyword: "widget",
  qualityScore: 2,
  landingPageExp: "BELOW_AVERAGE",
  adRelevance: "BELOW_AVERAGE",
  expectedCtr: "BELOW_AVERAGE",
};
const avg: QualityScoreEntry = { ...belowAvg, adRelevance: "AVERAGE" };

describe("renderQualityScoreSection", () => {
  it("returns nothing when no entry is below average for the given component", () => {
    const lines = renderQualityScoreSection(
      "QUALITY SCORE — AD RELEVANCE BELOW AVERAGE",
      "adRelevance",
      { 1: [avg] },
      { 1: "Campaign A" },
    );
    expect(lines).toEqual([]);
  });

  it("includes a campaign whose entry is BELOW_AVERAGE for the given component (issue #40: the value must already be a normalized string, not a raw enum integer)", () => {
    const lines = renderQualityScoreSection(
      "QUALITY SCORE — AD RELEVANCE BELOW AVERAGE",
      "adRelevance",
      { 1: [belowAvg] },
      { 1: "Campaign A" },
    );
    expect(lines.join("\n")).toContain("Campaign A");
    expect(lines.join("\n")).toContain("widget");
  });

  it("covers all three components (landingPageExp, adRelevance, expectedCtr) independently", () => {
    for (const component of ["landingPageExp", "adRelevance", "expectedCtr"] as const) {
      const lines = renderQualityScoreSection("TITLE", component, { 1: [belowAvg] }, { 1: "C" });
      expect(lines.length).toBeGreaterThan(0);
    }
  });
});
