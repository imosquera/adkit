import { describe, expect, it } from "vitest";
import { belowAverageFinalUrls, buildPsiRequestUrl, parsePsiResponse } from "./psi.js";
import type { CampaignReport, QualityScoreEntry, ScoredAd } from "../audit/types.js";

function ad(finalUrl: string | null): ScoredAd {
  return {
    adId: 1,
    adGroup: "ag",
    strength: "GOOD",
    status: "ENABLED",
    headlines: [],
    descriptions: [],
    finalUrl,
    actionItems: [],
    issues: [],
    keywords: [],
    pathToExcellent: [],
  };
}

function campaign(ads: ScoredAd[], campaignId = 1): CampaignReport {
  return {
    campaignId,
    campaignName: `c${campaignId}`,
    status: "ENABLED",
    keywords: 0,
    sitelinks: 0,
    callouts: 0,
    campaignFindings: [],
    ads,
  };
}

const belowAvg: QualityScoreEntry = {
  keyword: "k",
  qualityScore: 3,
  landingPageExp: "BELOW_AVERAGE",
  adRelevance: "AVERAGE",
  expectedCtr: "AVERAGE",
};
const avg: QualityScoreEntry = { ...belowAvg, landingPageExp: "AVERAGE" };

describe("buildPsiRequestUrl", () => {
  it("targets the runPagespeed endpoint with mobile strategy and the key", () => {
    const url = buildPsiRequestUrl("https://example.com/lp", "SECRET");
    expect(url).toContain("pagespeedonline/v5/runPagespeed");
    expect(url).toContain("strategy=mobile");
    expect(url).toContain("key=SECRET");
    expect(url).toContain("url=https%3A%2F%2Fexample.com%2Flp");
  });
});

describe("belowAverageFinalUrls", () => {
  it("returns nothing when no keyword has a below-average landing-page score", () => {
    expect(belowAverageFinalUrls({ 1: [avg] }, [campaign([ad("https://a.com")])])).toEqual([]);
  });

  it("returns nothing when there are no final URLs even if a score is below-average", () => {
    expect(belowAverageFinalUrls({ 1: [belowAvg] }, [campaign([ad(null)])])).toEqual([]);
  });

  it("dedupes distinct final URLs when a below-average score is present", () => {
    const urls = belowAverageFinalUrls({ 1: [belowAvg] }, [
      campaign([ad("https://a.com"), ad("https://a.com"), ad("https://b.com")]),
    ]);
    expect(urls.sort()).toEqual(["https://a.com", "https://b.com"]);
  });

  it("scopes to the affected campaign — a healthy campaign's URLs are not dragged in", () => {
    const urls = belowAverageFinalUrls({ 1: [belowAvg], 2: [avg] }, [
      campaign([ad("https://flagged.com")], 1),
      campaign([ad("https://healthy.com")], 2),
    ]);
    expect(urls).toEqual(["https://flagged.com"]);
  });
});

describe("parsePsiResponse", () => {
  it("extracts LCP and opportunity counts from a valid response", () => {
    const raw = {
      lighthouseResult: {
        audits: {
          "largest-contentful-paint": { numericValue: 4200.5, title: "LCP" },
          "render-blocking-resources": {
            title: "Eliminate render-blocking resources",
            details: { items: [{ wastedMs: 300 }, { wastedMs: 120 }] },
          },
          "unused-javascript": {
            title: "Reduce unused JavaScript",
            details: { items: [{ wastedMs: 90 }] },
          },
        },
      },
    };
    const r = parsePsiResponse("https://a.com", raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.lcpMs).toBe(4200.5);
      expect(r.renderBlocking).toHaveLength(2);
      expect(r.renderBlocking[0]?.savingsMs).toBe(300);
      expect(r.unusedJs).toHaveLength(1);
    }
  });

  it("tolerates a partial response (missing audits) without throwing", () => {
    const r = parsePsiResponse("https://a.com", { lighthouseResult: {} });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.lcpMs).toBeNull();
      expect(r.renderBlocking).toEqual([]);
      expect(r.unusedJs).toEqual([]);
    }
  });

  it("returns a tagged failure (not a throw) for a structurally invalid blob", () => {
    const r = parsePsiResponse("https://a.com", "not an object");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.url).toBe("https://a.com");
      expect(r.error).toContain("PSI");
    }
  });
});
