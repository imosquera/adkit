import { describe, expect, it } from "vitest";

import {
  ENHANCEMENT_FEATURE_KEYS,
  OBJECTIVE_OPTIMIZATION_GOALS,
  parseMetaBrief,
  softWarnings,
  type MetaBrief,
} from "./brief.js";

const allFiles = { fileExists: () => true };

const ad = (over: Record<string, unknown> = {}) => ({
  name: "ad-1",
  link: "https://example.com/landing",
  callToAction: "LEARN_MORE",
  primaryTexts: ["Get a quote in minutes."],
  headlines: ["Fast quotes"],
  descriptions: ["No obligation"],
  media: { image: "./img/hero.png" },
  enhancements: { enhance_cta: "OPT_OUT", text_optimizations: "OPT_OUT" },
  ...over,
});

const adSet = (over: Record<string, unknown> = {}) => ({
  name: "set-1",
  optimizationGoal: "OFFSITE_CONVERSIONS",
  conversion: { pixelId: "123456", event: "LEAD" },
  audience: { countries: ["US"], ageMin: 25, ageMax: 60, genders: ["female"] },
  placements: "advantage",
  ads: [ad()],
  ...over,
});

const brief = (over: Record<string, unknown> = {}, campaign: Record<string, unknown> = {}) => ({
  type: "meta",
  name: "close-assistant",
  adAccountId: "1234567890",
  pageId: "987654321",
  campaign: {
    name: "Close Assistant",
    objective: "OUTCOME_LEADS",
    specialAdCategories: [],
    budget: { mode: "campaign", dailyBudget: 100, bidStrategy: "LOWEST_COST_WITHOUT_CAP" },
    startTime: "2026-10-01T00:00:00Z",
    ...campaign,
  },
  adSets: [adSet()],
  ...over,
});

const errorOf = (data: unknown, deps = allFiles): string => {
  const r = parseMetaBrief(data, deps);
  if (r.kind !== "err") throw new Error("expected err");
  return r.message;
};

const valueOf = (data: unknown): MetaBrief => {
  const r = parseMetaBrief(data, allFiles);
  if (r.kind !== "ok") throw new Error(r.message);
  return r.value;
};

describe("parseMetaBrief", () => {
  it("accepts a valid brief and applies defaults", () => {
    const b = valueOf(brief());
    expect(b.adAccountId).toBe("act_1234567890");
    expect(b.adSets[0].audience.interests).toEqual([]);
    expect(b.adSets[0].audience.advantageAudience).toBe(false);
    expect(b.adSets[0].ads[0].enhancements).toEqual({ enhance_cta: "OPT_OUT", text_optimizations: "OPT_OUT" });
  });

  it("accepts ad set budgets with a video ad and manual placements", () => {
    const b = valueOf(
      brief(
        {
          adSets: [
            adSet({
              dailyBudget: 50,
              bidAmount: 40,
              placements: { publisherPlatforms: ["facebook"], facebookPositions: ["feed"] },
              ads: [ad({ media: { video: "./v.mp4", thumbnail: "./t.png" } })],
            }),
          ],
        },
        { budget: { mode: "adset", bidStrategy: "COST_CAP" } },
      ),
    );
    expect(b.campaign.budget.mode).toBe("adset");
  });

  it("rejects unknown enhancement keys and non-https links", () => {
    const msg = errorOf(brief({ adSets: [adSet({ ads: [ad({ enhancements: { magic: "OPT_IN" }, link: "http://x.com" })] })] }));
    expect(msg).toMatch(/enhancements.*magic/);
    expect(msg).toMatch(/link must use https/);
  });

  it("enforces hard text limits and pool counts", () => {
    const msg = errorOf(
      brief({
        adSets: [
          adSet({
            ads: [ad({ primaryTexts: ["x".repeat(1025)], headlines: [], descriptions: ["a", "b", "c", "d", "e", "f"] })],
          }),
        ],
      }),
    );
    expect(msg).toMatch(/primaryTexts may be at most 1024/);
    expect(msg).toMatch(/headlines/);
    expect(msg).toMatch(/descriptions/);
  });

  it("caps ad sets at 10 and ads at 6", () => {
    const names = (n: number, f: (i: number) => unknown) => Array.from({ length: n }, (_, i) => f(i));
    expect(errorOf(brief({ adSets: names(11, (i) => adSet({ name: `s${i}` })) }))).toMatch(/adSets/);
    expect(errorOf(brief({ adSets: [adSet({ ads: names(7, (i) => ad({ name: `a${i}` })) })] }))).toMatch(/adSets\.0\.ads/);
  });

  it("budget mode campaign forbids ad set dailyBudget", () => {
    expect(errorOf(brief({ adSets: [adSet({ dailyBudget: 20 })] }))).toMatch(
      /adSets\.0\.dailyBudget: dailyBudget is forbidden/,
    );
  });

  it("budget mode adset requires ad set dailyBudget and forbids campaign dailyBudget", () => {
    expect(errorOf(brief({}, { budget: { mode: "adset", bidStrategy: "LOWEST_COST_WITHOUT_CAP" } }))).toMatch(
      /dailyBudget is required/,
    );
    expect(
      errorOf(brief({}, { budget: { mode: "adset", dailyBudget: 5, bidStrategy: "LOWEST_COST_WITHOUT_CAP" } })),
    ).toMatch(/campaign\.budget/);
  });

  it("requires bidAmount for cap strategies and forbids it otherwise", () => {
    expect(
      errorOf(brief({}, { budget: { mode: "campaign", dailyBudget: 100, bidStrategy: "LOWEST_COST_WITH_BID_CAP" } })),
    ).toMatch(/requires bidAmount/);
    expect(errorOf(brief({ adSets: [adSet({ bidAmount: 10 })] }))).toMatch(/bidAmount is only valid/);
  });

  it("checks objective ↔ optimization goal against the allow-list", () => {
    expect(OBJECTIVE_OPTIMIZATION_GOALS.OUTCOME_TRAFFIC).not.toContain("OFFSITE_CONVERSIONS");
    const msg = errorOf(brief({}, { objective: "OUTCOME_TRAFFIC" }));
    expect(msg).toMatch(/optimizationGoal OFFSITE_CONVERSIONS is not valid for objective OUTCOME_TRAFFIC/);
  });

  it("pairs OFFSITE_CONVERSIONS with conversion both ways", () => {
    expect(errorOf(brief({ adSets: [adSet({ conversion: undefined })] }))).toMatch(/requires conversion/);
    expect(errorOf(brief({ adSets: [adSet({ optimizationGoal: "LINK_CLICKS" })] }))).toMatch(
      /conversion is only valid/,
    );
  });

  it("restricts targeting under special ad categories", () => {
    const msg = errorOf(
      brief(
        { adSets: [adSet({ audience: { countries: ["US"], ageMin: 25, ageMax: 60, genders: ["female"], interests: [{ id: "1", name: "x" }] } })] },
        { specialAdCategories: ["HOUSING"] },
      ),
    );
    expect(msg).toMatch(/require ageMin 18/);
    expect(msg).toMatch(/require ageMax 65/);
    expect(msg).toMatch(/forbid gender targeting/);
    expect(msg).toMatch(/forbid interest targeting/);
    const ok = parseMetaBrief(
      brief(
        { adSets: [adSet({ audience: { countries: ["US"], genders: ["male", "female"] } })] },
        { specialAdCategories: ["HOUSING"] },
      ),
      allFiles,
    );
    expect(ok.kind).toBe("ok");
  });

  it.each(["CREDIT", "EMPLOYMENT"])("applies the same restrictions under %s", (category) => {
    expect(errorOf(brief({}, { specialAdCategories: [category] }))).toMatch(/forbid gender targeting/);
  });

  it("does not apply audience restrictions to ISSUES_ELECTIONS_POLITICS alone", () => {
    expect(parseMetaBrief(brief({}, { specialAdCategories: ["ISSUES_ELECTIONS_POLITICS"] }), allFiles).kind).toBe("ok");
    expect(errorOf(brief({}, { specialAdCategories: ["ISSUES_ELECTIONS_POLITICS", "HOUSING"] }))).toMatch(/forbid gender targeting/);
  });

  it("requires city radius of at least 15 miles / 25 km under restricted categories", () => {
    const withCities = (cities: unknown[]) =>
      brief({ adSets: [adSet({ audience: { cities } })] }, { specialAdCategories: ["EMPLOYMENT"] });
    const msg = errorOf(
      withCities([
        { key: "1", radius: 10, distance_unit: "mile" },
        { key: "2", radius: 20, distance_unit: "kilometer" },
      ]),
    );
    expect(msg).toMatch(/adSets\.0\.audience\.cities\.0\.radius: .*at least 15 miles \/ 25 km \(got 10 mile\)/);
    expect(msg).toMatch(/cities\.1\.radius: .*got 20 kilometer/);
    expect(
      parseMetaBrief(
        withCities([
          { key: "1", radius: 15, distance_unit: "mile" },
          { key: "2", radius: 25, distance_unit: "kilometer" },
        ]),
        allFiles,
      ).kind,
    ).toBe("ok");
    // Without a special ad category a small radius is fine.
    expect(parseMetaBrief(brief({ adSets: [adSet({ audience: { cities: [{ key: "1", radius: 1, distance_unit: "mile" }] } })] }), allFiles).kind).toBe("ok");
  });

  it.each<[string, Record<string, unknown>, Record<string, unknown>, RegExp]>([
    ["unknown objective", {}, { objective: "OUTCOME_APP_PROMOTION" }, /campaign\.objective/],
    ["headline > 255", { adSets: [adSet({ ads: [ad({ headlines: ["h".repeat(256)] })] })] }, {}, /headlines may be at most 255/],
    ["description > 255", { adSets: [adSet({ ads: [ad({ descriptions: ["d".repeat(256)] })] })] }, {}, /descriptions may be at most 255/],
    ["> 5 primaryTexts", { adSets: [adSet({ ads: [ad({ primaryTexts: ["1", "2", "3", "4", "5", "6"] })] })] }, {}, /adSets\.0\.ads\.0\.primaryTexts/],
    ["> 5 headlines", { adSets: [adSet({ ads: [ad({ headlines: ["1", "2", "3", "4", "5", "6"] })] })] }, {}, /adSets\.0\.ads\.0\.headlines/],
  ])("rejects %s", (_label, over, campaign, pattern) => {
    expect(errorOf(brief(over, campaign))).toMatch(pattern);
  });

  it("reports all of those issues at once", () => {
    const msg = errorOf(
      brief(
        {
          adSets: [
            adSet({
              ads: [ad({ headlines: ["h".repeat(256), "2", "3", "4", "5", "6"], descriptions: ["d".repeat(256)], primaryTexts: ["1", "2", "3", "4", "5", "6"] })],
            }),
          ],
        },
        { objective: "OUTCOME_APP_PROMOTION" },
      ),
    );
    [/campaign\.objective/, /headlines may be at most 255/, /descriptions may be at most 255/, /primaryTexts/, /headlines: .*5/].forEach((p) =>
      expect(msg).toMatch(p),
    );
  });

  it("allows omitted enhancement keys (left to Meta's default)", () => {
    expect(valueOf(brief({ adSets: [adSet({ ads: [ad({ enhancements: { image_touchups: "OPT_OUT" } })] })] })).adSets[0].ads[0].enhancements).toEqual({
      image_touchups: "OPT_OUT",
    });
    const { enhancements: _omitted, ...noEnhancements } = ad();
    expect(valueOf(brief({ adSets: [adSet({ ads: [noEnhancements] })] })).adSets[0].ads[0].enhancements).toEqual({});
  });

  it("requires unique ad set and ad names", () => {
    expect(errorOf(brief({ adSets: [adSet(), adSet()] }))).toMatch(/adSets\[\]\.name must be unique/);
    expect(errorOf(brief({ adSets: [adSet({ ads: [ad(), ad()] })] }))).toMatch(/ads\[\]\.name must be unique/);
  });

  it("reports missing media via deps.fileExists with the path as written", () => {
    const seen: string[] = [];
    const msg = errorOf(brief(), {
      fileExists: (p) => {
        seen.push(p);
        return false;
      },
    });
    expect(seen).toEqual(["./img/hero.png"]);
    expect(msg).toBe("adSets.0.ads.0.media.image: media file not found or unreadable: ./img/hero.png");
  });

  it("collects every issue at once, including missing media on a structurally broken brief", () => {
    const msg = errorOf(
      brief(
        {
          name: "Not Kebab",
          adSets: [adSet({ dailyBudget: 20, ads: [ad({ callToAction: "BUY" })] })],
        },
        { objective: "OUTCOME_TRAFFIC" },
      ),
      { fileExists: () => false },
    );
    const lines = msg.split("\n");
    expect(lines.some((l) => l.startsWith("name:"))).toBe(true);
    expect(lines.some((l) => l.includes("callToAction"))).toBe(true);
    expect(lines.some((l) => l.includes("media file not found"))).toBe(true);
  });

  it("collects every cross-field issue at once", () => {
    const msg = errorOf(
      brief(
        { adSets: [adSet({ dailyBudget: 20, conversion: undefined }), adSet({ name: "set-1", bidAmount: 3 })] },
        { objective: "OUTCOME_AWARENESS" },
      ),
    );
    expect(msg.split("\n").length).toBeGreaterThanOrEqual(6);
  });
});

describe("softWarnings", () => {
  it("warns beyond recommended lengths and is silent otherwise", () => {
    expect(softWarnings(valueOf(brief()))).toEqual([]);
    const long = valueOf(
      brief({
        adSets: [adSet({ ads: [ad({ primaryTexts: ["p".repeat(126)], headlines: ["h".repeat(41)], descriptions: ["d".repeat(31)] })] })],
      }),
    );
    const w = softWarnings(long);
    expect(w).toHaveLength(3);
    expect(w[0]).toMatch(/primaryTexts\[0\] is 126 chars \(recommended ≤ 125/);
  });

  it("warns when exclusions are combined with Advantage+ audience", () => {
    const audience = { countries: ["US"], excludedCustomAudienceIds: ["23850000000000001"] };
    expect(softWarnings(valueOf(brief({ adSets: [adSet({ audience })] })))).toEqual([]);
    const w = softWarnings(valueOf(brief({ adSets: [adSet({ audience: { ...audience, advantageAudience: true } })] })));
    expect(w).toEqual([expect.stringMatching(/ad set "set-1": .*exclusions may not apply under Advantage\+ audience/)]);
  });
});

describe("constants", () => {
  it("exports the ten enhancement feature keys", () => {
    expect(ENHANCEMENT_FEATURE_KEYS).toHaveLength(10);
  });
});
