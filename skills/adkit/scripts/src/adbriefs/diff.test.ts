import { describe, expect, it } from "vitest";

import { parseBrief, type Brief } from "../lib/schema.js";
import { diffBriefs } from "./diff.js";

const adGroup = (name = "Waitlist Core", root = "vontevo") => ({
  name,
  defaultBidMicros: 1_500_000,
  responsiveSearchAd: {
    headlines: Array.from({ length: 15 }, (_, i) => ({ text: `Vontevo headline ${i}` })),
    descriptions: Array.from({ length: 4 }, (_, i) => ({ text: `Vontevo description ${i}` })),
    finalUrl: "https://www.example.com/waitlist",
  },
  keywords: [{ text: root, matchType: "PHRASE" }],
});

const brief = (budgetMicros = 10_000_000): Brief =>
  parseBrief({
    name: "vontevo-waitlist-q3",
    version: 1,
    campaign: { name: "Vontevo Waitlist Q3", budgetMicros, networkSettings: "search-only" },
    adGroups: [adGroup()],
  });

describe("diffBriefs", () => {
  it("reports no change for two identical briefs (FR-007)", () => {
    const d = diffBriefs(brief(), brief());
    expect(d.changed).toBe(false);
    expect(d.added).toBe(0);
    expect(d.removed).toBe(0);
    expect(d.render).toBe("");
  });

  it("renders a scoped diff for a budget change", () => {
    const d = diffBriefs(brief(10_000_000), brief(25_000_000));
    expect(d.changed).toBe(true);
    expect(d.added).toBeGreaterThan(0);
    expect(d.removed).toBeGreaterThan(0);
    expect(d.render).toContain("+");
    expect(d.render).toContain("25000000");
    // Scoped: the huge unchanged headline block is elided, not printed in full.
    expect(d.render).toContain("…");
  });

  it("treats a null current brief as an all-added diff", () => {
    const d = diffBriefs(null, brief());
    expect(d.changed).toBe(true);
    expect(d.removed).toBe(0);
    expect(d.added).toBeGreaterThan(0);
    expect(d.render.split("\n").every((l) => l.startsWith("+") || l.trim() === "…")).toBe(true);
  });

  it("shows an added ad-group keyword", () => {
    const withExtra = parseBrief({
      ...brief(),
      adGroups: [{ ...adGroup(), keywords: [{ text: "vontevo", matchType: "PHRASE" }, { text: "new kw", matchType: "PHRASE" }] }],
    });
    const d = diffBriefs(brief(), withExtra);
    expect(d.changed).toBe(true);
    expect(d.render).toContain("new kw");
  });
});
