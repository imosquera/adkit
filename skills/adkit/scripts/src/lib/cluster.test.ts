/**
 * Tests for the data-driven cluster analysis shared by report and audit.
 *
 * Pure-function tests — feed performance rows, assert the proposals. No IO.
 */

import { describe, expect, it } from "vitest";
import {
  clusterSplitRecommendation,
  keywordsByClicksAndCtr,
  keywordsToPromote,
  negativesToAdd,
  type Row,
} from "./cluster.js";

interface StOptions {
  clicks?: number;
  conversions?: number;
  cost?: number;
  impressions?: number;
  adGroupId?: string;
}

function st(term: string, options: StOptions = {}): Row {
  const { clicks = 0, conversions = 0, cost = 0, impressions = 0, adGroupId = "1" } = options;
  return {
    search_term: term,
    ad_group_id: adGroupId,
    clicks,
    conversions,
    cost,
    impressions,
  };
}

describe("keywordsToPromote", () => {
  it("promotes converting and clicked terms", () => {
    const rows = [
      st("online reputation software", { clicks: 5, conversions: 2, cost: 40 }),
      st("reputation monitoring", { clicks: 4, conversions: 0, cost: 12 }),
      st("free review widget", { clicks: 1, conversions: 0, cost: 1 }), // below bar
    ];
    const out = keywordsToPromote(rows);
    const texts = out.map((p) => p.text);
    expect(texts).toEqual(["online reputation software", "reputation monitoring"]);
    expect(out.every((p) => p.matchType === "PHRASE")).toBe(true);
  });

  it("excludes existing keywords case-insensitively", () => {
    const rows = [st("Online Reputation Software", { clicks: 9, conversions: 3, cost: 50 })];
    const out = keywordsToPromote(rows, [{ text: "online reputation software" }]);
    expect(out).toEqual([]);
  });

  it("aggregates same term across ad groups", () => {
    const rows = [
      st("review software", { clicks: 2, conversions: 0, cost: 6, adGroupId: "1" }),
      st("review software", { clicks: 2, conversions: 1, cost: 8, adGroupId: "2" }),
    ];
    const out = keywordsToPromote(rows);
    expect(out.length).toBe(1);
    expect(out[0].clicks).toBe(4);
    expect(out[0].conversions).toBe(1.0);
    expect(out[0].cost).toBe(14.0);
  });

  it("sorted strongest first and capped by limit", () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      st(`kw ${i}`, { clicks: 10, conversions: i }),
    );
    const out = keywordsToPromote(rows, [], { limit: 2 });
    expect(out.map((p) => p.text)).toEqual(["kw 4", "kw 3"]);
  });
});

describe("negativesToAdd", () => {
  it("flags zero-conversion spend", () => {
    const rows = [
      st("cheap reviews free", { clicks: 6, conversions: 0, cost: 9 }),
      st("reputation software pricing", { clicks: 3, conversions: 2, cost: 20 }), // converted -> keep
    ];
    const out = negativesToAdd(rows);
    expect(out.map((n) => n.text)).toEqual(["cheap reviews free"]);
    expect(out[0].cost).toBe(9.0);
  });

  it("ignores terms under min cost", () => {
    const rows = [st("barely spent", { clicks: 1, conversions: 0, cost: 0.4 })];
    expect(negativesToAdd(rows, { minCost: 1.0 })).toEqual([]);
  });

  it("sorted by wasted cost desc", () => {
    const rows = [
      st("waste a", { clicks: 2, conversions: 0, cost: 5 }),
      st("waste b", { clicks: 9, conversions: 0, cost: 30 }),
    ];
    const out = negativesToAdd(rows);
    expect(out.map((n) => n.text)).toEqual(["waste b", "waste a"]);
  });
});

describe("keywordsByClicksAndCtr", () => {
  it("ranks by clicks/CTR, ignoring conversions, and flags cheap CPC as strong", () => {
    const rows = [
      // high clicks, high CTR, cheap CPC -> strong + cheapToScale
      st("best running shoes", { clicks: 10, impressions: 100, cost: 5, conversions: 0 }),
      // high clicks, CTR far below the campaign average -> weak-relevance
      st("running shoes", { clicks: 5, impressions: 1000, cost: 5, conversions: 9 }),
      // high clicks, above-average CTR, but CPC is not cheap -> watch
      st("premium running shoes", { clicks: 8, impressions: 20, cost: 20 }),
    ];
    const out = keywordsByClicksAndCtr(rows, [], 1.0);
    const byText = Object.fromEntries(out.map((c) => [c.text, c]));
    expect(byText["best running shoes"].verdict).toBe("strong");
    expect(byText["best running shoes"].cheapToScale).toBe(true);
    expect(byText["running shoes"].verdict).toBe("weak-relevance");
    expect(byText["premium running shoes"].verdict).toBe("watch");
    expect(byText["premium running shoes"].cheapToScale).toBe(false);
    // sorted by clicks desc
    expect(out.map((c) => c.text)).toEqual([
      "best running shoes",
      "premium running shoes",
      "running shoes",
    ]);
  });

  it("treats campaignAvgCpc=0 as unknown and skips the CPC check", () => {
    const rows = [st("wide shoe fit", { clicks: 10, impressions: 20, cost: 500 })];
    const out = keywordsByClicksAndCtr(rows, [], 0);
    expect(out[0].verdict).toBe("strong");
    expect(out[0].cheapToScale).toBe(false);
  });

  it("keeps the same term separate per ad group instead of merging", () => {
    const rows = [
      st("shoe repair", { clicks: 4, impressions: 40, adGroupId: "111" }),
      st("shoe repair", { clicks: 6, impressions: 60, adGroupId: "222" }),
    ];
    const out = keywordsByClicksAndCtr(rows, []);
    expect(out.length).toBe(2);
    expect(out.map((c) => c.adGroupId).sort()).toEqual([111, 222]);
  });

  it("excludes existing keywords and terms under minClicks", () => {
    const rows = [
      st("already a keyword", { clicks: 20, impressions: 40 }),
      st("too few clicks", { clicks: 1, impressions: 2 }),
    ];
    const out = keywordsByClicksAndCtr(rows, [{ text: "Already A Keyword" }], 0, {
      minClicks: 3,
    });
    expect(out).toEqual([]);
  });
});

describe("clusterSplitRecommendation", () => {
  function kw(text: string, cpc: number): Row {
    return { text, avg_cpc: cpc };
  }

  it("recommends split on wide cpc spread", () => {
    const kws = [
      kw("client engagement software", 0.99),
      kw("engagement tool", 1.1),
      kw("online reputation software", 12.0),
      kw("reputation management software", 18.0),
    ];
    const rec = clusterSplitRecommendation(kws);
    expect(rec).not.toBeNull();
    expect(rec!.ratio).toBeGreaterThanOrEqual(3.0);
    expect(rec!.expensive).toContain("online reputation software");
    expect(rec!.cheap).toContain("client engagement software");
  });

  it("none when spread is tight", () => {
    const kws = Array.from({ length: 5 }, (_, i) => kw(`kw ${i}`, 2.0 + i * 0.1));
    expect(clusterSplitRecommendation(kws)).toBeNull();
  });

  it("none when too few priced keywords", () => {
    const kws = [kw("a", 1.0), kw("b", 10.0), { text: "c", avg_cpc: 0 }];
    expect(clusterSplitRecommendation(kws, { minKeywords: 4 })).toBeNull();
  });
});
