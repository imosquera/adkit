import { mkdtempSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadStateIndex } from "../adbriefs/state.js";
import { AdbriefsError } from "../adbriefs/store.js";
import { MetaAdAccountIdSchema, MetaAdIdSchema, MetaCreativeIdSchema } from "./ids.js";
import {
  emptyMetaState,
  loadMetaStateIndex,
  META_STATE_SUFFIX,
  metaStatePath,
  parseMetaState,
  readMetaState,
  serializeMetaState,
  slugFromMetaStateFile,
  withSwappedCreatives,
  writeMetaState,
  type MetaState,
} from "./state.js";

const account = MetaAdAccountIdSchema.parse("act_111");

const brief = {
  name: "widget-launch",
  campaign: { name: "Widget Launch Meta" },
  adSets: [
    { name: "US broad", ads: [{ name: "Ad A" }, { name: "Ad B" }] },
    { name: "Retargeting", ads: [{ name: "Ad C" }] },
  ],
};

const tempRoot = (): string => mkdtempSync(join(tmpdir(), "adkit-meta-state-"));

/** A partially published state: campaign + first ad set + ad A exist; the rest is pending. */
const partialState = (): MetaState => {
  const parsed = parseMetaState({
    platform: "meta",
    adAccountId: "act_111",
    campaign: { name: "Widget Launch Meta", campaignId: "100" },
    media: { "./hero.png": { sha256: "abc", imageHash: "hash1" } },
    adSets: [
      {
        name: "US broad",
        adSetId: "200",
        ads: [
          { name: "Ad A", creativeId: "300", adId: "400" },
          { name: "Ad B", creativeId: "301", adId: null },
        ],
      },
      { name: "Retargeting", adSetId: null, ads: [{ name: "Ad C", creativeId: null, adId: null }] },
    ],
  });
  if (parsed.kind === "err") throw new Error(parsed.message);
  return parsed.value;
};

describe("emptyMetaState", () => {
  it("pre-populates every name with null ids", () => {
    expect(emptyMetaState(brief, account)).toEqual({
      platform: "meta",
      adAccountId: "act_111",
      campaign: { name: "Widget Launch Meta", campaignId: null },
      media: {},
      adSets: [
        {
          name: "US broad",
          adSetId: null,
          ads: [
            { name: "Ad A", creativeId: null, adId: null },
            { name: "Ad B", creativeId: null, adId: null },
          ],
        },
        { name: "Retargeting", adSetId: null, ads: [{ name: "Ad C", creativeId: null, adId: null }] },
      ],
    });
  });

  it("round-trips through parseMetaState", () => {
    const state = emptyMetaState(brief, account);
    expect(parseMetaState(state)).toEqual({ kind: "ok", value: state });
  });
});

describe("parseMetaState", () => {
  it("normalizes numeric ids to strings and bare account ids to act_", () => {
    const parsed = parseMetaState({
      platform: "meta",
      adAccountId: "111",
      campaign: { name: "C", campaignId: 100 },
      media: {},
      adSets: [],
    });
    expect(parsed).toEqual({
      kind: "ok",
      value: { platform: "meta", adAccountId: "act_111", campaign: { name: "C", campaignId: "100" }, media: {}, adSets: [] },
    });
  });

  it("rejects unknown keys, wrong platform, and non-numeric ids with every issue listed", () => {
    const parsed = parseMetaState({
      platform: "google",
      adAccountId: "act_111",
      campaign: { name: "C", campaignId: "abc", extra: 1 },
      media: {},
      adSets: [],
    });
    expect(parsed.kind).toBe("err");
    if (parsed.kind === "err") {
      expect(parsed.message).toContain("platform");
      expect(parsed.message).toContain("campaign.campaignId");
      expect(parsed.message).toContain("extra");
    }
  });
});

describe("paths", () => {
  it("builds <root>/<dir>/<slug>.meta-state.yaml", () => {
    expect(metaStatePath("/r", brief)).toBe(join("/r", "adbriefs", `widget-launch-meta${META_STATE_SUFFIX}`));
    expect(metaStatePath("/r", brief, "briefs")).toBe(join("/r", "briefs", "widget-launch-meta.meta-state.yaml"));
  });

  it("extracts the slug only from Meta state filenames", () => {
    expect(slugFromMetaStateFile("x.meta-state.yaml")).toBe("x");
    expect(slugFromMetaStateFile("x.state.yaml")).toBeNull();
    expect(slugFromMetaStateFile("x.yaml")).toBeNull();
  });
});

describe("withSwappedCreatives", () => {
  it("replaces the creativeId of matching ads only, without mutating the input", () => {
    const state = partialState();
    const before = structuredClone(state);
    const next = withSwappedCreatives(state, [
      { adId: MetaAdIdSchema.parse("400"), creativeId: MetaCreativeIdSchema.parse("777") },
      { adId: MetaAdIdSchema.parse("999"), creativeId: MetaCreativeIdSchema.parse("888") },
    ]);
    expect(next.adSets[0]?.ads).toEqual([
      { name: "Ad A", creativeId: "777", adId: "400" },
      { name: "Ad B", creativeId: "301", adId: null },
    ]);
    expect(next.adSets[1]).toEqual(state.adSets[1]);
    expect({ ...next, adSets: state.adSets }).toEqual(state);
    expect(state).toEqual(before);
  });

  it("returns an equal state for no swaps", () => {
    expect(withSwappedCreatives(partialState(), [])).toEqual(partialState());
  });
});

describe("readMetaState / writeMetaState", () => {
  it("returns null for a missing file", () => {
    expect(readMetaState(join(tempRoot(), "nope.meta-state.yaml"))).toBeNull();
  });

  it("writes atomically and reads back an equal state", () => {
    const root = tempRoot();
    const path = metaStatePath(root, brief);
    const state = partialState();
    writeMetaState(path, state);
    expect(readMetaState(path)).toEqual(state);
    expect(readdirSync(join(root, "adbriefs"))).toEqual(["widget-launch-meta.meta-state.yaml"]);
    // Overwrite with further progress.
    const next: MetaState = { ...state, campaign: { ...state.campaign, name: "Renamed" } };
    writeMetaState(path, next);
    expect(readMetaState(path)?.campaign.name).toBe("Renamed");
  });

  it("serializes deterministically", () => {
    expect(serializeMetaState(partialState())).toBe(serializeMetaState(partialState()));
  });

  it("throws AdbriefsError on invalid YAML or schema failure", () => {
    const root = tempRoot();
    const bad = join(root, "bad.meta-state.yaml");
    writeFileSync(bad, "platform: [unterminated\n");
    expect(() => readMetaState(bad)).toThrow(AdbriefsError);
    const wrong = join(root, "wrong.meta-state.yaml");
    writeFileSync(wrong, "platform: meta\n");
    expect(() => readMetaState(wrong)).toThrow(/failed validation/);
  });
});

describe("loadMetaStateIndex", () => {
  it("returns empty maps when the directory is missing", () => {
    const index = loadMetaStateIndex(tempRoot());
    expect([index.byCampaignId.size, index.byAdSetId.size, index.byAdId.size]).toEqual([0, 0, 0]);
  });

  it("indexes published ids to slug + names and skips null ids", () => {
    const root = tempRoot();
    writeMetaState(metaStatePath(root, brief), partialState());
    const index = loadMetaStateIndex(root);
    expect([...index.byCampaignId]).toEqual([["100", { slug: "widget-launch-meta", campaignName: "Widget Launch Meta" }]]);
    expect([...index.byAdSetId]).toEqual([
      ["200", { slug: "widget-launch-meta", campaignName: "Widget Launch Meta", adSetName: "US broad" }],
    ]);
    expect([...index.byAdId]).toEqual([
      ["400", { slug: "widget-launch-meta", campaignName: "Widget Launch Meta", adSetName: "US broad", adName: "Ad A" }],
    ]);
  });

  it("ignores Google state files and briefs in the same directory", () => {
    const root = tempRoot();
    mkdirSync(join(root, "adbriefs"), { recursive: true });
    writeFileSync(join(root, "adbriefs", "other.yaml"), "name: other\n");
    writeFileSync(
      join(root, "adbriefs", "g.state.yaml"),
      'campaign:\n  name: "G"\n  campaignId: "9"\n  budgetId: null\nadGroups: []\n',
    );
    const index = loadMetaStateIndex(root);
    expect(index.byCampaignId.size).toBe(0);
  });
});

describe("Google loadStateIndex", () => {
  it("ignores .meta-state.yaml files", () => {
    const root = tempRoot();
    writeMetaState(metaStatePath(root, brief), partialState());
    const index = loadStateIndex(root);
    expect([index.byCampaignId.size, index.byAdGroupId.size, index.byAdId.size]).toEqual([0, 0, 0]);
  });
});
