import { describe, expect, it } from "vitest";
import { AD_GROUP_MAX_KEYWORDS, MAX_AD_GROUPS, parseBrief } from "./schema.js";

const adGroup = (name = "Waitlist Core", root = "vontevo") => ({
  name,
  defaultBidMicros: 1_500_000,
  responsiveSearchAd: {
    headlines: Array.from({ length: 15 }, (_, i) => ({ text: `Vontevo headline ${i}` })),
    descriptions: Array.from({ length: 4 }, (_, i) => ({ text: `Vontevo description ${i}` })),
    finalUrl: "https://www.example.com/waitlist",
  },
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
    raw.adGroups[0].responsiveSearchAd.finalUrl = "http://www.example.com/waitlist";
    expect(() => parseBrief(raw)).toThrow();
  });

  it("rejects version < 1", () => {
    expect(() => parseBrief({ ...validBrief(), version: 0 })).toThrow();
  });
});

describe("display paths", () => {
  it("omits paths by default", () => {
    const brief = parseBrief(validBrief());
    const rsa = brief.adGroups[0].responsiveSearchAd;
    expect(rsa.path1).toBeUndefined();
    expect(rsa.path2).toBeUndefined();
  });

  it("parses and lowercases", () => {
    const raw = validBrief();
    Object.assign(raw.adGroups[0].responsiveSearchAd, { path1: "Review-Replies", path2: "Free-Trial" });
    const brief = parseBrief(raw);
    const rsa = brief.adGroups[0].responsiveSearchAd;
    expect(rsa.path1).toBe("review-replies");
    expect(rsa.path2).toBe("free-trial");
  });

  it("rejects a path over 15 chars", () => {
    const raw = validBrief();
    Object.assign(raw.adGroups[0].responsiveSearchAd, { path1: "WayTooLongPathSegment" });
    expect(() => parseBrief(raw)).toThrow();
  });

  it("rejects a path with a slash", () => {
    const raw = validBrief();
    Object.assign(raw.adGroups[0].responsiveSearchAd, { path1: "a/b" });
    expect(() => parseBrief(raw)).toThrow();
  });

  it("rejects a path with a space", () => {
    const raw = validBrief();
    Object.assign(raw.adGroups[0].responsiveSearchAd, { path1: "free trial" });
    expect(() => parseBrief(raw)).toThrow();
  });

  it("rejects path2 without path1", () => {
    const raw = validBrief();
    Object.assign(raw.adGroups[0].responsiveSearchAd, { path2: "Free-Trial" });
    expect(() => parseBrief(raw)).toThrow();
  });

  it("rejects a TODO placeholder path", () => {
    const raw = validBrief();
    Object.assign(raw.adGroups[0].responsiveSearchAd, { path1: "TODO-keyword" });
    expect(() => parseBrief(raw)).toThrow();
  });
});

describe("RSA assets", () => {
  it("rejects too few headlines", () => {
    const raw = validBrief();
    raw.adGroups[0].responsiveSearchAd.headlines = raw.adGroups[0].responsiveSearchAd.headlines.slice(0, 14);
    expect(() => parseBrief(raw)).toThrow();
  });

  it("rejects duplicate headlines", () => {
    const raw = validBrief();
    raw.adGroups[0].responsiveSearchAd.headlines[1] = { text: "Vontevo headline 0" };
    expect(() => parseBrief(raw)).toThrow(/headlines must be unique/);
  });

  it("rejects a pinned headline", () => {
    const raw = validBrief();
    raw.adGroups[0].responsiveSearchAd.headlines[0] = { text: "Vontevo headline 0", pin: "HEADLINE_1" } as never;
    expect(() => parseBrief(raw)).toThrow();
  });

  it("rejects a pinned description", () => {
    const raw = validBrief();
    raw.adGroups[0].responsiveSearchAd.descriptions[0] = { text: "A description ending in act now.", pin: "DESCRIPTION_1" } as never;
    expect(() => parseBrief(raw)).toThrow();
  });

  it("rejects too many descriptions", () => {
    const raw = validBrief();
    raw.adGroups[0].responsiveSearchAd.descriptions = Array.from({ length: 5 }, (_, i) => ({ text: `D${i}` }));
    expect(() => parseBrief(raw)).toThrow();
  });
});

describe("Dynamic Keyword Insertion (DKI)", () => {
  // User Story 1 — parse, round-trip, and worst-case length enforcement.

  it("accepts a DKI headline whose default fits within the 30-char limit", () => {
    const raw = validBrief();
    raw.adGroups[0].responsiveSearchAd.headlines[0] = { text: "{KeyWord:Running Shoes}" };
    const brief = parseBrief(raw);
    expect(brief.adGroups[0].responsiveSearchAd.headlines[0]!.text).toBe("{KeyWord:Running Shoes}");
  });

  it("rejects a DKI headline whose default exceeds the 30-char limit", () => {
    const raw = validBrief();
    raw.adGroups[0].responsiveSearchAd.headlines[0] = {
      text: "{keyword:this default text is far too long to ever fit}",
    };
    expect(() => parseBrief(raw)).toThrow(/exceeds the 30-char limit/);
  });

  it("rejects a DKI code with no default text", () => {
    const raw = validBrief();
    raw.adGroups[0].responsiveSearchAd.headlines[0] = { text: "{KeyWord}" };
    expect(() => parseBrief(raw)).toThrow(/requires a default text/);
  });

  it.each(["keyword", "Keyword", "KeyWord", "KEYWord", "KeyWORD"])(
    "accepts the %s capitalization form",
    (mode) => {
      const raw = validBrief();
      raw.adGroups[0].responsiveSearchAd.headlines[0] = { text: `{${mode}:Running Shoes}` };
      expect(() => parseBrief(raw)).not.toThrow();
    },
  );

  it("rejects an unrecognized casing token", () => {
    const raw = validBrief();
    raw.adGroups[0].responsiveSearchAd.headlines[0] = { text: "{kEyword:Running Shoes}" };
    expect(() => parseBrief(raw)).toThrow(/unrecognized casing/);
  });

  it("computes worst-case length across literal text and multiple codes in a description", () => {
    const raw = validBrief();
    // "Save on " (8) + 82 x's + " today" (6) = 96 > 90
    raw.adGroups[0].responsiveSearchAd.descriptions[0] = { text: `Save on {keyword:${"x".repeat(82)}} today` };
    expect(() => parseBrief(raw)).toThrow(/exceeds the 90-char limit/);
  });

  // User Story 2 — field placement + Display-path character rules.

  it("rejects a DKI code in the Final URL", () => {
    const raw = validBrief();
    raw.adGroups[0].responsiveSearchAd.finalUrl = "https://www.example.com/{keyword:shoes}";
    expect(() => parseBrief(raw)).toThrow(/not allowed in finalUrl/);
  });

  it("rejects a special/non-ASCII character in a Display path", () => {
    const raw = validBrief();
    Object.assign(raw.adGroups[0].responsiveSearchAd, { path1: "café" });
    expect(() => parseBrief(raw)).toThrow(/non-ASCII/);
  });

  it("rejects a non-ASCII character in a Display-path DKI default", () => {
    const raw = validBrief();
    Object.assign(raw.adGroups[0].responsiveSearchAd, { path1: "{keyword:café}" });
    expect(() => parseBrief(raw)).toThrow(/non-ASCII/);
  });

  it("accepts a clean DKI Display path within the 15-char limit", () => {
    const raw = validBrief();
    Object.assign(raw.adGroups[0].responsiveSearchAd, { path1: "{keyword:shoes}" });
    const brief = parseBrief(raw);
    expect(brief.adGroups[0].responsiveSearchAd.path1).toBe("{keyword:shoes}");
  });

  it("preserves a Display path's casing verbatim when it carries a DKI code (no forced lowercase)", () => {
    const raw = validBrief();
    Object.assign(raw.adGroups[0].responsiveSearchAd, { path1: "{KeyWord:Shoes}" });
    const brief = parseBrief(raw);
    expect(brief.adGroups[0].responsiveSearchAd.path1).toBe("{KeyWord:Shoes}");
  });

  // Edge cases.

  it("rejects nested braces", () => {
    const raw = validBrief();
    raw.adGroups[0].responsiveSearchAd.headlines[0] = { text: "{keyword:{x}}" };
    expect(() => parseBrief(raw)).toThrow(/nested/);
  });

  it("rejects an unclosed DKI code", () => {
    const raw = validBrief();
    raw.adGroups[0].responsiveSearchAd.headlines[0] = { text: "{keyword:a" };
    expect(() => parseBrief(raw)).toThrow(/unclosed/);
  });

  it("rejects literal braces that aren't a valid DKI code", () => {
    const raw = validBrief();
    raw.adGroups[0].responsiveSearchAd.headlines[0] = { text: "{call now}" };
    expect(() => parseBrief(raw)).toThrow(/requires a default text/);
  });

  it("rejects an empty DKI default", () => {
    const raw = validBrief();
    raw.adGroups[0].responsiveSearchAd.headlines[0] = { text: "{keyword:}" };
    expect(() => parseBrief(raw)).toThrow(/empty default text/);
  });

  it("continues to parse and round-trip a plain (non-DKI) headline unchanged", () => {
    const raw = validBrief();
    raw.adGroups[0].responsiveSearchAd.headlines[0] = { text: "Plain headline, no DKI here" };
    const brief = parseBrief(raw);
    expect(brief.adGroups[0].responsiveSearchAd.headlines[0]!.text).toBe("Plain headline, no DKI here");
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
