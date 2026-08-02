import { describe, expect, it } from "vitest";
import {
  normalizeAuctionInsightRow,
  normalizeKeywordMetricsRow,
  type RawAuctionInsightRow,
  type RawKeywordMetricsRow,
} from "./rows.js";

describe("normalizeAuctionInsightRow", () => {
  it("maps every metric field to its AuctionInsightRow name", () => {
    const raw: RawAuctionInsightRow = {
      campaign: { id: 111 },
      auction_insight_domain: { domain: "competitor.com" },
      metrics: {
        auction_insight_search_impression_share: 0.42,
        auction_insight_search_overlap_rate: 0.3,
        auction_insight_search_position_above_rate: 0.2,
        auction_insight_search_top_impression_percentage: 0.65,
        auction_insight_search_outranking_share: 0.71,
      },
    };
    const row = normalizeAuctionInsightRow(raw);
    expect(row).toEqual({
      campaignId: 111,
      domain: "competitor.com",
      impressionShare: 0.42,
      overlapRate: 0.3,
      positionAboveRate: 0.2,
      topOfPageRate: 0.65,
      outrankingShare: 0.71,
    });
  });

  it("zero-fills an absent metrics object", () => {
    const raw: RawAuctionInsightRow = {
      campaign: { id: 222 },
      auction_insight_domain: { domain: "no-metrics-yet.com" },
    };
    const row = normalizeAuctionInsightRow(raw);
    expect(row.impressionShare).toBe(0);
    expect(row.overlapRate).toBe(0);
    expect(row.positionAboveRate).toBe(0);
    expect(row.topOfPageRate).toBe(0);
    expect(row.outrankingShare).toBe(0);
  });
});

describe("normalizeKeywordMetricsRow", () => {
  it("carries ad_group.id and keyword match_type so keyword rows are pause-plan-ready (#22)", () => {
    const raw: RawKeywordMetricsRow = {
      campaign: { id: 111 },
      ad_group: { id: 222 },
      ad_group_criterion: { keyword: { text: "blue widgets", match_type: "EXACT" } },
      metrics: { average_cpc: 1_500_000, impressions: 4200, ctr: 0.055 },
    };
    const row = normalizeKeywordMetricsRow(raw);
    expect(row.ad_group?.id).toBe(222);
    expect(row.ad_group_criterion.keyword.match_type).toBe("EXACT");
    expect(row.metrics.average_cpc).toBe(1_500_000);
    expect(row.metrics.impressions).toBe(4200);
    expect(row.metrics.ctr).toBe(0.055);
  });

  it("zero-fills missing average_cpc/impressions/ctr and tolerates an absent match_type", () => {
    const raw: RawKeywordMetricsRow = {
      campaign: { id: 111 },
      ad_group: { id: 333 },
      ad_group_criterion: { keyword: { text: "no cpc yet" } },
    };
    const row = normalizeKeywordMetricsRow(raw);
    expect(row.metrics.average_cpc).toBe(0);
    expect(row.metrics.impressions).toBe(0);
    expect(row.metrics.ctr).toBe(0);
    expect(row.ad_group_criterion.keyword.match_type).toBeUndefined();
  });
});
