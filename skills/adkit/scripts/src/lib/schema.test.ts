import { describe, expect, it } from "vitest";
import {
  AD_GROUP_MAX_KEYWORDS,
  MAX_AD_GROUPS,
  RSAS_PER_AD_GROUP,
  displayPathPairErrors,
  parseBrief,
} from "./schema.js";

/** One RSA fixture; `variant` offsets the placeholder text so two RSAs in the same ad group don't collide. */
const rsa = (variant = 0) => ({
  headlines: Array.from({ length: 15 }, (_, i) => ({ text: `Vontevo headline ${variant}-${i}` })),
  descriptions: Array.from({ length: 4 }, (_, i) => ({ text: `Vontevo description ${variant}-${i}` })),
  finalUrl: "https://www.example.com/waitlist",
});

const adGroup = (name = "Waitlist Core", root = "vontevo") => ({
  name,
  defaultBidMicros: 1_500_000,
  responsiveSearchAds: [rsa(0), rsa(1)],
  keywords: [
    { text: root, matchType: "PHRASE" },
    { text: root, matchType: "EXACT" },
  ],
});

const validBrief = () => ({
  name: "vontevo-waitlist-q3",
  version: 1,
  campaign: {
    name: "Vontevo Waitlist Q3",
    budgetMicros: 10_000_000,
    networkSettings: "search-only",
  },
  adGroups: [adGroup()],
});

const sitelink = (text = "How It Works") => ({ text, finalUrl: "https://www.example.com/page.html" });

describe("Brief validation", () => {
  it("parses a valid brief", () => {
    expect(() => parseBrief(validBrief())).not.toThrow();
  });

  it("parses at the max ad group count", () => {
    const raw = { ...validBrief(), adGroups: Array.from({ length: MAX_AD_GROUPS }, (_, i) => adGroup(`Ag-${i}`, `root-${i}`)) };
    expect(() => parseBrief(raw)).not.toThrow();
  });

  it("rejects over the max ad group count", () => {
    const raw = { ...validBrief(), adGroups: Array.from({ length: MAX_AD_GROUPS + 1 }, (_, i) => adGroup(`Ag-${i}`, `root-${i}`)) };
    expect(() => parseBrief(raw)).toThrow();
  });

  it("rejects zero ad groups", () => {
    expect(() => parseBrief({ ...validBrief(), adGroups: [] })).toThrow();
  });

  it("parses at the per-ad-group keyword cap and rejects one over", () => {
    const kw = (n: number) => Array.from({ length: n }, (_, i) => ({ text: `kw-${i}`, matchType: "PHRASE" }));
    const withKw = (n: number) => ({ ...validBrief(), adGroups: [{ ...adGroup(), keywords: kw(n) }] });
    expect(() => parseBrief(withKw(AD_GROUP_MAX_KEYWORDS))).not.toThrow();
    expect(() => parseBrief(withKw(AD_GROUP_MAX_KEYWORDS + 1))).toThrow();
  });

  it("rejects duplicate ad group names", () => {
    const raw = { ...validBrief(), adGroups: [adGroup("Same"), adGroup("Same", "x")] };
    expect(() => parseBrief(raw)).toThrow();
  });

  it("rejects an unknown top-level key", () => {
    expect(() => parseBrief({ ...validBrief(), extraField: "nope" })).toThrow();
  });

  it("rejects an invalid name pattern", () => {
    expect(() => parseBrief({ ...validBrief(), name: "Has_Underscores_Caps" })).toThrow();
  });

  it("rejects a non-https final URL", () => {
    const raw = validBrief();
    raw.adGroups[0].responsiveSearchAds[0].finalUrl = "http://www.example.com/waitlist";
    expect(() => parseBrief(raw)).toThrow();
  });

  it("rejects version < 1", () => {
    expect(() => parseBrief({ ...validBrief(), version: 0 })).toThrow();
  });
});

describe("RSA cardinality (exactly RSAS_PER_AD_GROUP per ad group)", () => {
  it("rejects a single RSA (the pre-change shape)", () => {
    const raw = validBrief();
    raw.adGroups[0].responsiveSearchAds = [rsa(0)];
    expect(() => parseBrief(raw)).toThrow();
  });

  it("rejects three RSAs", () => {
    const raw = validBrief();
    raw.adGroups[0].responsiveSearchAds = [rsa(0), rsa(1), rsa(2)];
    expect(() => parseBrief(raw)).toThrow();
  });

  it("rejects the legacy singular `responsiveSearchAd` key (no silent migration)", () => {
    const raw = validBrief() as Record<string, unknown>;
    const adGroups = raw["adGroups"] as Array<Record<string, unknown>>;
    const { responsiveSearchAds, ...rest } = adGroups[0]!;
    adGroups[0] = { ...rest, responsiveSearchAd: (responsiveSearchAds as unknown[])[0] };
    expect(() => parseBrief(raw)).toThrow();
  });

  it("accepts exactly RSAS_PER_AD_GROUP RSAs", () => {
    const raw = validBrief();
    expect(raw.adGroups[0].responsiveSearchAds).toHaveLength(RSAS_PER_AD_GROUP);
    expect(() => parseBrief(raw)).not.toThrow();
  });
});

describe("display paths", () => {
  it("omits paths by default", () => {
    const brief = parseBrief(validBrief());
    const r = brief.adGroups[0].responsiveSearchAds[0];
    expect(r.path1).toBeUndefined();
    expect(r.path2).toBeUndefined();
  });

  it("parses and lowercases", () => {
    const raw = validBrief();
    Object.assign(raw.adGroups[0].responsiveSearchAds[0], { path1: "Review-Replies", path2: "Free-Trial" });
    const brief = parseBrief(raw);
    const r = brief.adGroups[0].responsiveSearchAds[0];
    expect(r.path1).toBe("review-replies");
    expect(r.path2).toBe("free-trial");
  });

  it("rejects a path over 15 chars", () => {
    const raw = validBrief();
    Object.assign(raw.adGroups[0].responsiveSearchAds[0], { path1: "WayTooLongPathSegment" });
    expect(() => parseBrief(raw)).toThrow();
  });

  it("rejects a path with a slash", () => {
    const raw = validBrief();
    Object.assign(raw.adGroups[0].responsiveSearchAds[0], { path1: "a/b" });
    expect(() => parseBrief(raw)).toThrow();
  });

  it("rejects a path with a space", () => {
    const raw = validBrief();
    Object.assign(raw.adGroups[0].responsiveSearchAds[0], { path1: "free trial" });
    expect(() => parseBrief(raw)).toThrow();
  });

  it("rejects path2 without path1", () => {
    const raw = validBrief();
    Object.assign(raw.adGroups[0].responsiveSearchAds[0], { path2: "Free-Trial" });
    expect(() => parseBrief(raw)).toThrow();
  });

  it("rejects a TODO placeholder path", () => {
    const raw = validBrief();
    Object.assign(raw.adGroups[0].responsiveSearchAds[0], { path1: "TODO-keyword" });
    expect(() => parseBrief(raw)).toThrow();
  });
});

describe("displayPathPairErrors (shared create/update rules)", () => {
  it("accepts an absent pair", () => {
    expect(displayPathPairErrors(undefined, undefined)).toEqual([]);
  });

  it("accepts a valid pair", () => {
    expect(displayPathPairErrors("demo", "trial")).toEqual([]);
  });

  it("rejects a non-string segment", () => {
    expect(displayPathPairErrors(42, undefined).some((m) => m.includes("path1 must be a string"))).toBe(true);
  });

  it("prefixes each message", () => {
    const errs = displayPathPairErrors("free trial", undefined, "ad 9: ");
    expect(errs.every((m) => m.startsWith("ad 9: "))).toBe(true);
  });

  it("rejects path2 without path1", () => {
    expect(displayPathPairErrors(undefined, "trial").some((m) => m.includes("path2 requires path1"))).toBe(true);
  });
});

describe("RSA assets", () => {
  it("rejects too few headlines", () => {
    const raw = validBrief();
    raw.adGroups[0].responsiveSearchAds[0].headlines = raw.adGroups[0].responsiveSearchAds[0].headlines.slice(0, 14);
    expect(() => parseBrief(raw)).toThrow();
  });

  it("rejects duplicate headlines", () => {
    const raw = validBrief();
    raw.adGroups[0].responsiveSearchAds[0].headlines[1] = { text: raw.adGroups[0].responsiveSearchAds[0].headlines[0]!.text };
    expect(() => parseBrief(raw)).toThrow(/headlines must be unique/);
  });

  it("rejects a pinned headline", () => {
    const raw = validBrief();
    raw.adGroups[0].responsiveSearchAds[0].headlines[0] = { text: "Vontevo headline 0", pin: "HEADLINE_1" } as never;
    expect(() => parseBrief(raw)).toThrow();
  });

  it("rejects a pinned description", () => {
    const raw = validBrief();
    raw.adGroups[0].responsiveSearchAds[0].descriptions[0] = { text: "A description ending in act now.", pin: "DESCRIPTION_1" } as never;
    expect(() => parseBrief(raw)).toThrow();
  });

  it("rejects too many descriptions", () => {
    const raw = validBrief();
    raw.adGroups[0].responsiveSearchAds[0].descriptions = Array.from({ length: 5 }, (_, i) => ({ text: `D${i}` }));
    expect(() => parseBrief(raw)).toThrow();
  });

  it("validates each RSA in the pair independently (second RSA's rule violation still rejects)", () => {
    const raw = validBrief();
    raw.adGroups[0].responsiveSearchAds[1].headlines = raw.adGroups[0].responsiveSearchAds[1].headlines.slice(0, 14);
    expect(() => parseBrief(raw)).toThrow();
  });
});

describe("bid strategy", () => {
  it("defaults to maximize-clicks", () => {
    expect(parseBrief(validBrief()).campaign.bidStrategy).toBe("maximize-clicks");
  });

  it("rejects a cpc ceiling without maximize-clicks", () => {
    const raw = validBrief();
    Object.assign(raw.campaign, { bidStrategy: "maximize-conversions", cpcBidCeilingMicros: 2_000_000 });
    expect(() => parseBrief(raw)).toThrow(/cpcBidCeilingMicros only valid/);
  });

  it("accepts a cpc ceiling with maximize-clicks", () => {
    const raw = validBrief();
    Object.assign(raw.campaign, { bidStrategy: "maximize-clicks", cpcBidCeilingMicros: 2_000_000 });
    expect(() => parseBrief(raw)).not.toThrow();
  });

  it("parses manual-cpc", () => {
    const raw = validBrief();
    Object.assign(raw.campaign, { bidStrategy: "manual-cpc" });
    expect(parseBrief(raw).campaign.bidStrategy).toBe("manual-cpc");
  });

  it("requires targetCpaMicros for target-cpa", () => {
    const raw = validBrief();
    Object.assign(raw.campaign, { bidStrategy: "target-cpa" });
    expect(() => parseBrief(raw)).toThrow(/targetCpaMicros/);
  });

  it("accepts target-cpa with targetCpaMicros", () => {
    const raw = validBrief();
    Object.assign(raw.campaign, { bidStrategy: "target-cpa", targetCpaMicros: 5_000_000 });
    expect(() => parseBrief(raw)).not.toThrow();
  });

  it("requires targetRoas for target-roas", () => {
    const raw = validBrief();
    Object.assign(raw.campaign, { bidStrategy: "target-roas" });
    expect(() => parseBrief(raw)).toThrow(/targetRoas/);
  });

  it("accepts target-roas with targetRoas", () => {
    const raw = validBrief();
    Object.assign(raw.campaign, { bidStrategy: "target-roas", targetRoas: 4.0 });
    expect(() => parseBrief(raw)).not.toThrow();
  });

  it("rejects targetCpaMicros when the strategy does not need it", () => {
    const raw = validBrief();
    Object.assign(raw.campaign, { bidStrategy: "maximize-conversions", targetCpaMicros: 5_000_000 });
    expect(() => parseBrief(raw)).toThrow(/targetCpaMicros only valid/);
  });

  it("rejects an unknown bid strategy", () => {
    const raw = validBrief();
    Object.assign(raw.campaign, { bidStrategy: "secret-sauce" });
    expect(() => parseBrief(raw)).toThrow();
  });
});

describe("sitelinks & callouts", () => {
  it("accepts six sitelinks", () => {
    const raw = validBrief();
    Object.assign(raw.campaign, { sitelinks: Array.from({ length: 6 }, (_, i) => sitelink(`Link ${i}`)) });
    expect(() => parseBrief(raw)).not.toThrow();
  });

  it("accepts zero sitelinks (legacy)", () => {
    expect(() => parseBrief(validBrief())).not.toThrow();
  });

  it("rejects five sitelinks", () => {
    const raw = validBrief();
    Object.assign(raw.campaign, { sitelinks: Array.from({ length: 5 }, (_, i) => sitelink(`Link ${i}`)) });
    expect(() => parseBrief(raw)).toThrow(/exactly 6/);
  });

  it("rejects seven sitelinks", () => {
    const raw = validBrief();
    Object.assign(raw.campaign, { sitelinks: Array.from({ length: 7 }, (_, i) => sitelink(`Link ${i}`)) });
    expect(() => parseBrief(raw)).toThrow();
  });

  it("rejects sitelink text over 25 chars", () => {
    const raw = validBrief();
    const sl = Array.from({ length: 6 }, (_, i) => sitelink(`Link ${i}`));
    sl[0].text = "x".repeat(26);
    Object.assign(raw.campaign, { sitelinks: sl });
    expect(() => parseBrief(raw)).toThrow();
  });

  it("rejects a sitelink with one description", () => {
    const raw = validBrief();
    const sl = Array.from({ length: 6 }, (_, i) => sitelink(`Link ${i}`));
    Object.assign(sl[0], { description1: "only one line" });
    Object.assign(raw.campaign, { sitelinks: sl });
    expect(() => parseBrief(raw)).toThrow(/both description1 and description2/);
  });
});

describe("default bid ceiling", () => {
  it("rejects a default bid over $15", () => {
    const raw = validBrief();
    raw.adGroups[0].defaultBidMicros = 15_000_001;
    expect(() => parseBrief(raw)).toThrow();
  });

  it("accepts a default bid at $15", () => {
    const raw = validBrief();
    raw.adGroups[0].defaultBidMicros = 15_000_000;
    expect(() => parseBrief(raw)).not.toThrow();
  });
});
