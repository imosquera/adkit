import { describe, expect, it } from "vitest";
import { normalizeKeywordMetricsRow, type RawKeywordMetricsRow } from "./rows.js";

describe("normalizeKeywordMetricsRow", () => {
  it("carries ad_group.id and keyword match_type so keyword rows are pause-plan-ready (#22)", () => {
    const raw: RawKeywordMetricsRow = {
      campaign: { id: 111 },
      ad_group: { id: 222 },
      ad_group_criterion: { keyword: { text: "blue widgets", match_type: "EXACT" } },
      metrics: { average_cpc: 1_500_000 },
    };
    const row = normalizeKeywordMetricsRow(raw);
    expect(row.ad_group?.id).toBe(222);
    expect(row.ad_group_criterion.keyword.match_type).toBe("EXACT");
    expect(row.metrics.average_cpc).toBe(1_500_000);
  });

  it("zero-fills missing average_cpc and tolerates an absent match_type", () => {
    const raw: RawKeywordMetricsRow = {
      campaign: { id: 111 },
      ad_group: { id: 333 },
      ad_group_criterion: { keyword: { text: "no cpc yet" } },
    };
    const row = normalizeKeywordMetricsRow(raw);
    expect(row.metrics.average_cpc).toBe(0);
    expect(row.ad_group_criterion.keyword.match_type).toBeUndefined();
  });
});
