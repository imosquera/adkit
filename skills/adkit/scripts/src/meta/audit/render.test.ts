import { describe, expect, it } from "vitest";
import { findingLines, renderMetaAudit, severityCounts } from "./render.js";
import type { MetaFinding } from "./scoring.js";

const finding = (over: Partial<MetaFinding>): MetaFinding => ({
  level: "adset",
  entityId: "as1",
  entityName: "Set 1",
  issue: "learning_limited",
  severity: "high",
  detail: "learning limited",
  evidence: {},
  fix: "consolidate",
  playbook: "reference/meta/1-fundamentals.md#the-learning-phase",
  ...over,
});

const campaigns = [
  { id: "c1", name: "Prospecting", status: "ACTIVE" },
  { id: "c2", name: "Retargeting", status: "PAUSED" },
];

describe("severityCounts", () => {
  it("counts every severity, zero included", () => {
    expect(severityCounts([finding({ severity: "low" }), finding({ severity: "high" }), finding({ severity: "low" })])).toBe(
      "high= 1 medium= 0 low= 2",
    );
  });
});

describe("findingLines", () => {
  it("renders the issue line, entity, fix and playbook", () => {
    expect(findingLines(finding({}))).toEqual([
      "  ! learning_limited: learning limited",
      "      [high]   adset Set 1 (as1)",
      "      fix: consolidate",
      "      see: reference/meta/1-fundamentals.md#the-learning-phase",
    ]);
  });
});

describe("renderMetaAudit", () => {
  it("renders the account section first, then campaigns in input order, findings by severity", () => {
    const low = finding({ issue: "advantage_creative_enhancements_on", severity: "low", level: "ad", entityId: "a1", entityName: "Ad 1", detail: "1 on" });
    const high = finding({});
    const account = finding({ level: "account", entityId: "account", entityName: "Ad account", issue: "weak_conversion_signal", detail: "10 events/week" });
    const lines = renderMetaAudit({
      campaigns,
      score: { campaigns: { c1: [low, high], c2: [] }, account: [account] },
      windowDays: 14,
    });
    expect(lines).toEqual([
      "META AUDIT — last 14 days",
      "\nACCOUNT — 1 finding: high= 1 medium= 0 low= 0",
      "  ! weak_conversion_signal: 10 events/week",
      "      [high]   account Ad account (account)",
      "      fix: consolidate",
      "      see: reference/meta/1-fundamentals.md#the-learning-phase",
      "\nProspecting (c1) [ACTIVE] — 2 findings: high= 1 medium= 0 low= 1",
      "  ! learning_limited: learning limited",
      "      [high]   adset Set 1 (as1)",
      "      fix: consolidate",
      "      see: reference/meta/1-fundamentals.md#the-learning-phase",
      "  ! advantage_creative_enhancements_on: 1 on",
      "      [low]    ad Ad 1 (a1)",
      "      fix: consolidate",
      "      see: reference/meta/1-fundamentals.md#the-learning-phase",
      "\nRetargeting (c2) [PAUSED] — no issues",
      "\n3 findings (1 account-wide) · 1/2 campaigns flagged",
    ]);
  });

  it("omits the account section when there are no account findings and treats a missing key as clean", () => {
    const lines = renderMetaAudit({ campaigns, score: { campaigns: { c1: [] }, account: [] }, windowDays: 1 });
    expect(lines).toEqual([
      "META AUDIT — last 1 day",
      "\nProspecting (c1) [ACTIVE] — no issues",
      "\nRetargeting (c2) [PAUSED] — no issues",
      "\n0 findings (0 account-wide) · 0/2 campaigns flagged",
    ]);
  });

  it("does not mutate the score", () => {
    const fs = [finding({ severity: "low" }), finding({ severity: "high" })];
    const score = { campaigns: { c1: fs }, account: [] };
    renderMetaAudit({ campaigns, score, windowDays: 7 });
    expect(fs.map((f) => f.severity)).toEqual(["low", "high"]);
  });
});
