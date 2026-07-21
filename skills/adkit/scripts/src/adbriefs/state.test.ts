import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AdbriefsError } from "./store.js";
import {
  buildState,
  loadStateIndex,
  parseState,
  serializeState,
  slugFromStateFile,
  statePathForCampaign,
} from "./state.js";
import { parseBrief, type Brief } from "../lib/schema.js";
import type { ExecResults } from "../ads/publish.js";

/** A minimal valid brief for path/slug derivation. */
function brief(overrides: Partial<{ name: string; campaignName: string; customerId: string }> = {}): Brief {
  const headlines = Array.from({ length: 15 }, (_, i) => ({ text: `Headline number ${i + 1}` }));
  const descriptions = Array.from({ length: 4 }, (_, i) => ({ text: `Description number ${i + 1} ok` }));
  return parseBrief({
    name: overrides.name ?? "widget-launch",
    version: 1,
    ...(overrides.customerId ? { customerId: overrides.customerId } : {}),
    campaign: {
      name: overrides.campaignName ?? "Widget Launch Search",
      budgetMicros: 25_000_000,
      sitelinks: Array.from({ length: 6 }, (_, i) => ({ text: `Site ${i + 1}`, finalUrl: "https://example.com/a" })),
      callouts: ["One two", "Three four", "Five six", "Seven eight"],
    },
    adGroups: [
      { name: "widgets", defaultBidMicros: 1_500_000, responsiveSearchAd: { headlines, descriptions, finalUrl: "https://example.com/a" }, keywords: [{ text: "widget", matchType: "PHRASE" }] },
    ],
  });
}

function execResults(over: Partial<ExecResults> = {}): ExecResults {
  return {
    budgetId: "111",
    campaignId: "222",
    sitelinkResourceNames: [],
    calloutResourceNames: [],
    priceAssetResourceNames: [],
    structuredSnippetResourceNames: [],
    adGroups: [{ name: "widgets", adGroupId: "333", responsiveSearchAdId: "444", keywordResourceNames: [] }],
    ...over,
  };
}

describe("buildState", () => {
  it("maps ExecResults ids into the state payload (adId from responsiveSearchAdId)", () => {
    const state = buildState(brief({ customerId: "1234567890" }), execResults());
    expect(state).toEqual({
      customerId: "1234567890",
      campaign: { name: "Widget Launch Search", campaignId: "222", budgetId: "111" },
      adGroups: [{ name: "widgets", adGroupId: "333", adId: "444" }],
    });
  });

  it("carries a null adId for a reused ad group with no fresh RSA", () => {
    const state = buildState(
      brief(),
      execResults({ adGroups: [{ name: "widgets", adGroupId: "333", responsiveSearchAdId: null, keywordResourceNames: [] }] }),
    );
    expect(state.adGroups[0]!.adId).toBeNull();
  });

  it("omits customerId when the brief has none, and round-trips through parseState", () => {
    const state = buildState(brief(), execResults());
    expect("customerId" in state).toBe(false);
    expect(parseState(state)).toEqual(state); // serialize target is schema-valid
  });
});

describe("statePathForCampaign / slugFromStateFile", () => {
  it("derives the sibling .state.yaml path from the campaign slug", () => {
    const p = statePathForCampaign("/root", brief({ campaignName: "Widget Launch Search" }));
    expect(p).toBe(join("/root", "adbriefs", "widget-launch-search.state.yaml"));
  });

  it("recovers the slug from a state filename (and rejects a non-state file)", () => {
    expect(slugFromStateFile("widget-launch-search.state.yaml")).toBe("widget-launch-search");
    expect(slugFromStateFile("widget-launch-search.yaml")).toBeNull();
  });
});

describe("loadStateIndex", () => {
  function seed(): string {
    const root = mkdtempSync(join(tmpdir(), "state-idx-"));
    mkdirSync(join(root, "adbriefs"), { recursive: true });
    writeFileSync(
      join(root, "adbriefs", "acme.state.yaml"),
      serializeState({
        customerId: "1234567890",
        campaign: { name: "Acme", campaignId: "10", budgetId: "11" },
        adGroups: [
          { name: "closers", adGroupId: "20", adId: "30" },
          { name: "reused", adGroupId: "21", adId: null },
        ],
      }),
    );
    // A second campaign — the index must span every state file.
    writeFileSync(
      join(root, "adbriefs", "beta.state.yaml"),
      serializeState({
        campaign: { name: "Beta", campaignId: "40", budgetId: null },
        adGroups: [{ name: "leads", adGroupId: "50", adId: "60" }],
      }),
    );
    // An intent brief (non-state) in the same dir must be ignored.
    writeFileSync(join(root, "adbriefs", "acme.yaml"), "name: acme\n");
    return root;
  }

  it("indexes campaignId / adGroupId / adId across every state file to its slug + name", () => {
    const idx = loadStateIndex(seed());
    expect(idx.byCampaignId.get("10")).toEqual({ slug: "acme", campaignName: "Acme" });
    expect(idx.byCampaignId.get("40")).toEqual({ slug: "beta", campaignName: "Beta" });
    expect(idx.byAdGroupId.get("20")).toEqual({ slug: "acme", campaignName: "Acme", adGroupName: "closers" });
    expect(idx.byAdId.get("30")).toEqual({ slug: "acme", campaignName: "Acme", adGroupName: "closers" });
    expect(idx.byAdId.get("60")).toEqual({ slug: "beta", campaignName: "Beta", adGroupName: "leads" });
  });

  it("omits a null adId from the byAdId index (a reused group has no ad to resolve)", () => {
    const idx = loadStateIndex(seed());
    expect(idx.byAdGroupId.has("21")).toBe(true);
    expect([...idx.byAdId.values()].some((v) => v.adGroupName === "reused")).toBe(false);
  });

  it("returns empty maps when adbriefs/ does not exist", () => {
    const root = mkdtempSync(join(tmpdir(), "state-empty-"));
    const idx = loadStateIndex(root);
    expect(idx.byCampaignId.size).toBe(0);
  });

  it("raises AdbriefsError naming a corrupt state file rather than silently skipping it", () => {
    const root = mkdtempSync(join(tmpdir(), "state-bad-"));
    mkdirSync(join(root, "adbriefs"), { recursive: true });
    writeFileSync(join(root, "adbriefs", "broken.state.yaml"), "campaign:\n  name: X\n  campaignId: not-a-number\n");
    expect(() => loadStateIndex(root)).toThrow(AdbriefsError);
  });
});
