import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { parseBrief, type Brief } from "../lib/schema.js";
import {
  AdbriefsError,
  assertNoForeignBrief,
  briefPathForCampaign,
  loadBriefIfExists,
  serializeBrief,
  slugForCampaign,
  writeBrief,
} from "./store.js";

const rsa = (variant = 0) => ({
  headlines: Array.from({ length: 15 }, (_, i) => ({ text: `Vontevo headline ${variant}-${i}` })),
  descriptions: Array.from({ length: 4 }, (_, i) => ({ text: `Vontevo description ${variant}-${i}` })),
  finalUrl: "https://www.example.com/waitlist",
});

const adGroup = (name = "Waitlist Core", root = "vontevo") => ({
  name,
  defaultBidMicros: 1_500_000,
  responsiveSearchAds: [rsa(0), rsa(1)],
  keywords: [{ text: root, matchType: "PHRASE" }],
});

const brief = (campaignName = "Vontevo Waitlist Q3", name = "vontevo-waitlist-q3"): Brief =>
  parseBrief({
    name,
    version: 1,
    campaign: { name: campaignName, budgetMicros: 10_000_000, networkSettings: "search-only" },
    adGroups: [adGroup()],
  });

describe("slugForCampaign", () => {
  it("is deterministic and kebab-cases the campaign name", () => {
    const b = brief("Vontevo Waitlist Q3");
    expect(slugForCampaign(b)).toBe("vontevo-waitlist-q3");
    expect(slugForCampaign(b)).toBe(slugForCampaign(b));
  });

  it("collapses runs of punctuation/whitespace and trims edges", () => {
    expect(slugForCampaign(brief("  Barber / Stylist -- search  "))).toBe("barber-stylist-search");
  });

  it("falls back to the brief name when the campaign name is all punctuation", () => {
    expect(slugForCampaign(brief("!!!", "fallback-name"))).toBe("fallback-name");
  });
});

describe("serializeBrief", () => {
  it("round-trips through parseBrief and is byte-stable for equal briefs", () => {
    const b = brief();
    const yaml = serializeBrief(b);
    expect(serializeBrief(b)).toBe(yaml);
    expect(parseBrief(parseYaml(yaml))).toEqual(b);
  });
});

describe("loadBriefIfExists / writeBrief", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "adbriefs-test-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns null when no brief exists, then loads what was written", () => {
    const b = brief();
    expect(loadBriefIfExists(root, b)).toBeNull();
    const path = writeBrief(root, b);
    expect(path).toBe(briefPathForCampaign(root, b));
    expect(loadBriefIfExists(root, b)).toEqual(b);
  });

  it("overwrites the same campaign's brief without complaint", () => {
    const b = brief();
    writeBrief(root, b);
    const raised = { ...b, campaign: { ...b.campaign, budgetMicros: 20_000_000 } };
    writeBrief(root, raised);
    expect(loadBriefIfExists(root, b)?.campaign.budgetMicros).toBe(20_000_000);
  });

  it("refuses to overwrite a different campaign that slugifies to the same file", () => {
    const first = brief("Same Slug");
    writeBrief(root, first);
    // Different campaign name that collapses to the identical slug "same-slug".
    const collider = brief("same  slug", "other-brief");
    expect(() => writeBrief(root, collider)).toThrow(AdbriefsError);
  });

  // issue #69: briefs_dir used to be collected and ignored, so the store was pinned to
  // adbriefs/ no matter what .adkit.yaml said. The write and the read must relocate
  // together — a brief written to a configured dir is invisible at the default one.
  describe("with a configured briefs directory", () => {
    it("writes, reads back, and reports the path under that directory", () => {
      const b = brief();
      const path = writeBrief(root, b, "ads/briefs");
      expect(path).toBe(join(root, "ads", "briefs", `${slugForCampaign(b)}.yaml`));
      expect(path).toBe(briefPathForCampaign(root, b, "ads/briefs"));
      expect(loadBriefIfExists(root, b, "ads/briefs")).toEqual(b);
    });

    it("does not find a relocated brief at the default directory", () => {
      const b = brief();
      writeBrief(root, b, "ads/briefs");
      expect(loadBriefIfExists(root, b)).toBeNull();
    });

    // The collision guard protects the configured path, not just the default one.
    it("still refuses a foreign-campaign collision there", () => {
      writeBrief(root, brief("Same Slug"), "ads/briefs");
      expect(() => writeBrief(root, brief("same  slug", "other-brief"), "ads/briefs")).toThrow(AdbriefsError);
    });
  });
});

// Plan D7: the store is generic over StorableBrief so a non-Google brief (e.g. Meta)
// round-trips through its own parse boundary instead of parseAnyBrief.
describe("with a custom brief parser", () => {
  const OtherBriefSchema = z
    .object({ type: z.literal("other"), name: z.string(), campaign: z.object({ name: z.string(), objective: z.string() }).strict() })
    .strict();
  type OtherBrief = z.infer<typeof OtherBriefSchema>;
  const parseOther = (data: unknown): OtherBrief => OtherBriefSchema.parse(data);
  const other = (campaignName: string): OtherBrief => ({
    type: "other",
    name: "other-brief",
    campaign: { name: campaignName, objective: "OUTCOME_LEADS" },
  });

  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "adbriefs-test-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("writes, reloads through the parser, and guards collisions with it", () => {
    const b = other("Meta Leads Q4");
    expect(loadBriefIfExists(root, b, undefined, parseOther)).toBeNull();
    const path = writeBrief(root, b, undefined, parseOther);
    expect(path).toBe(join(root, "adbriefs", "meta-leads-q4.yaml"));
    const loaded: OtherBrief | null = loadBriefIfExists(root, b, undefined, parseOther);
    expect(loaded).toEqual(b);
    // Same campaign overwrites cleanly; the occupant is read with the custom parser.
    expect(() => writeBrief(root, { ...b, campaign: { ...b.campaign, objective: "OUTCOME_SALES" } }, undefined, parseOther)).not.toThrow();
    expect(() => assertNoForeignBrief(root, other("meta  leads q4"), undefined, parseOther)).toThrow(AdbriefsError);
    // The default (Google) parser rejects the same file as a schema violation.
    expect(() => loadBriefIfExists(root, brief("Meta Leads Q4"))).toThrow(AdbriefsError);
  });
});
