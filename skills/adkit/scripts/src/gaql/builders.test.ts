import { describe, expect, it } from "vitest";
import { applyPositiveKeywordsQuery, auditSearchTermsQuery } from "./builders.js";

describe("auditSearchTermsQuery", () => {
  it("guards ids digits-only", () => {
    expect(() => auditSearchTermsQuery(7, ["123", "4x"])).toThrow();
  });

  it("selects terms over the window", () => {
    const q = auditSearchTermsQuery(14, ["12345", "67890"]);
    expect(q).toContain("FROM search_term_view");
    expect(q).toContain("campaign.id IN (12345,67890)");
    expect(q).toContain("search_term_view.search_term");
    expect(q).toContain("metrics.cost_micros");
    expect(q).toContain("segments.date DURING LAST_14_DAYS");
  });
});

describe("applyPositiveKeywordsQuery", () => {
  it("guards ids digits-only", () => {
    expect(() => applyPositiveKeywordsQuery(["123", "4x"])).toThrow();
  });

  it("selects non-negative keyword criteria", () => {
    const q = applyPositiveKeywordsQuery(["12345", "67890"]);
    expect(q).toContain("ad_group.id IN (12345,67890)");
    expect(q).toContain("ad_group_criterion.negative = FALSE");
    expect(q).toContain("ad_group_criterion.type = KEYWORD");
    expect(q).toContain("ad_group_criterion.status != 'REMOVED'");
  });
});
