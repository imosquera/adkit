import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse as yamlParse } from "yaml";
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
  const rsaVariant = (variant: number) => ({
    headlines: Array.from({ length: 15 }, (_, i) => ({ text: `Headline ${variant}-${i + 1}` })),
    descriptions: Array.from({ length: 4 }, (_, i) => ({ text: `Description ${variant}-${i + 1} ok` })),
    finalUrl: "https://example.com/a",
  });
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
      {
        name: "widgets",
        defaultBidMicros: 1_500_000,
        responsiveSearchAds: [rsaVariant(0), rsaVariant(1)],
        keywords: [{ text: "widget", matchType: "PHRASE" }],
      },
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
    adGroups: [{ name: "widgets", adGroupId: "333", responsiveSearchAdIds: ["444", "445"], keywordResourceNames: [] }],
    ...over,
  };
}

describe("buildState", () => {
  it("maps ExecResults ids into the state payload (adIds from responsiveSearchAdIds)", () => {
    const state = buildState(brief({ customerId: "1234567890" }), execResults());
    expect(state).toEqual({
      customerId: "1234567890",
      campaign: { name: "Widget Launch Search", campaignId: "222", budgetId: "111" },
      adGroups: [{ name: "widgets", adGroupId: "333", adIds: ["444", "445"] }],
    });
  });

  it("carries an empty adIds array for a reused ad group with no fresh RSA", () => {
    const state = buildState(
      brief(),
      execResults({ adGroups: [{ name: "widgets", adGroupId: "333", responsiveSearchAdIds: [], keywordResourceNames: [] }] }),
    );
    expect(state.adGroups[0]!.adIds).toEqual([]);
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

describe("legacy id formats (real historical state files predate bare-numeric ids)", () => {
  it("parseState accepts full Ads resource names and normalizes to bare numeric ids", () => {
    // Mirrors the exact shape of the live `simple-invoice-search.state.yaml`
    // fixture written before /adkit create switched to bare numeric ids.
    const data = yamlParse(`
customerId: "8911925499"
campaign:
  campaignId: "customers/8911925499/campaigns/24057685583"
  budgetId: "customers/8911925499/campaignBudgets/15731813177"
  name: "Simple Invoice Search"
adGroups:
  - name: "invoice generator"
    adGroupId: "customers/8911925499/adGroups/201075600400"
    adId: "customers/8911925499/adGroupAds/201075600400~817868708871"
`);
    const state = parseState(data);
    expect(state.campaign.campaignId).toBe("24057685583");
    expect(state.campaign.budgetId).toBe("15731813177");
    expect(state.adGroups[0]!.adGroupId).toBe("201075600400");
    // The ad id is the segment AFTER "~" (the ad's own id), not the ad-group
    // prefix repeated before it.
    expect(state.adGroups[0]!.adIds).toEqual(["817868708871"]);
  });

  it("still accepts bare numeric ids unchanged", () => {
    const state = parseState({
      campaign: { campaignId: "24057685583", budgetId: "15731813177", name: "X" },
      adGroups: [{ name: "ag", adGroupId: "201075600400", adIds: ["817868708871"] }],
    });
    expect(state.campaign.campaignId).toBe("24057685583");
    expect(state.adGroups[0]!.adIds).toEqual(["817868708871"]);
  });

  it("rejects an id with no trailing numeric segment", () => {
    expect(() =>
      parseState({
        campaign: { campaignId: "customers/123/campaigns/", budgetId: null, name: "X" },
        adGroups: [],
      }),
    ).toThrow();
  });

  it("normalizes a null budgetId through unchanged", () => {
    const state = parseState({
      campaign: { campaignId: "1", budgetId: null, name: "X" },
      adGroups: [],
    });
    expect(state.campaign.budgetId).toBeNull();
  });

  it("accepts the pre-2-RSA singular `adId` key and normalizes it to a 0/1-element `adIds` array", () => {
    const state = parseState({
      campaign: { campaignId: "1", budgetId: null, name: "X" },
      adGroups: [
        { name: "with-ad", adGroupId: "20", adId: "30" },
        { name: "reused", adGroupId: "21", adId: null },
      ],
    });
    expect(state.adGroups[0]).toEqual({ name: "with-ad", adGroupId: "20", adIds: ["30"] });
    expect(state.adGroups[1]).toEqual({ name: "reused", adGroupId: "21", adIds: [] });
  });

  it("accepts a legacy singular adId that is also a full resource name", () => {
    const state = parseState({
      campaign: { campaignId: "1", budgetId: null, name: "X" },
      adGroups: [
        {
          name: "with-ad",
          adGroupId: "customers/8911925499/adGroups/201075600400",
          adId: "customers/8911925499/adGroupAds/201075600400~817868708871",
        },
      ],
    });
    expect(state.adGroups[0]).toEqual({
      name: "with-ad",
      adGroupId: "201075600400",
      adIds: ["817868708871"],
    });
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
          { name: "closers", adGroupId: "20", adIds: ["30"] },
          { name: "reused", adGroupId: "21", adIds: [] },
        ],
      }),
    );
    // A second campaign — the index must span every state file.
    writeFileSync(
      join(root, "adbriefs", "beta.state.yaml"),
      serializeState({
        campaign: { name: "Beta", campaignId: "40", budgetId: null },
        adGroups: [{ name: "leads", adGroupId: "50", adIds: ["60", "61"] }],
      }),
    );
    // An intent brief (non-state) in the same dir must be ignored.
    writeFileSync(join(root, "adbriefs", "acme.yaml"), "name: acme\n");
    return root;
  }

  it("indexes campaignId / adGroupId / both adIds across every state file to its slug + name", () => {
    const idx = loadStateIndex(seed());
    expect(idx.byCampaignId.get("10")).toEqual({ slug: "acme", campaignName: "Acme" });
    expect(idx.byCampaignId.get("40")).toEqual({ slug: "beta", campaignName: "Beta" });
    expect(idx.byAdGroupId.get("20")).toEqual({ slug: "acme", campaignName: "Acme", adGroupName: "closers" });
    expect(idx.byAdId.get("30")).toEqual({ slug: "acme", campaignName: "Acme", adGroupName: "closers", rsaIndex: 0 });
    expect(idx.byAdId.get("60")).toEqual({ slug: "beta", campaignName: "Beta", adGroupName: "leads", rsaIndex: 0 });
    // rsaIndex is positional within THIS ad group's adIds, not a global counter.
    expect(idx.byAdId.get("61")).toEqual({ slug: "beta", campaignName: "Beta", adGroupName: "leads", rsaIndex: 1 });
  });

  it("omits an empty adIds ad group from the byAdId index (a reused group has no ad to resolve)", () => {
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

  it("loads a real legacy-format state file (full resource names) into the index", () => {
    const root = mkdtempSync(join(tmpdir(), "state-legacy-"));
    mkdirSync(join(root, "adbriefs"), { recursive: true });
    writeFileSync(
      join(root, "adbriefs", "simple-invoice-search.state.yaml"),
      [
        'customerId: "8911925499"',
        "campaign:",
        '  campaignId: "customers/8911925499/campaigns/24057685583"',
        '  budgetId: "customers/8911925499/campaignBudgets/15731813177"',
        '  name: "Simple Invoice Search"',
        "adGroups:",
        '  - name: "invoice generator"',
        '    adGroupId: "customers/8911925499/adGroups/201075600400"',
        '    adId: "customers/8911925499/adGroupAds/201075600400~817868708871"',
        "",
      ].join("\n"),
    );
    const idx = loadStateIndex(root);
    expect(idx.byCampaignId.get("24057685583")).toEqual({
      slug: "simple-invoice-search",
      campaignName: "Simple Invoice Search",
    });
    expect(idx.byAdGroupId.get("201075600400")).toEqual({
      slug: "simple-invoice-search",
      campaignName: "Simple Invoice Search",
      adGroupName: "invoice generator",
    });
    expect(idx.byAdId.get("817868708871")).toEqual({
      slug: "simple-invoice-search",
      campaignName: "Simple Invoice Search",
      adGroupName: "invoice generator",
      rsaIndex: 0,
    });
  });
});
