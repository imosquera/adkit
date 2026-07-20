import { afterEach, describe, expect, it, vi } from "vitest";
import { runPsi } from "./audit.js";
import { renderPsi } from "../audit/render.js";
import type { CampaignReport, QualityScoreEntry } from "../audit/types.js";

const belowAvg: QualityScoreEntry = {
  keyword: "k",
  qualityScore: 3,
  landingPageExp: "BELOW_AVERAGE",
  adRelevance: "AVERAGE",
  expectedCtr: "AVERAGE",
};
const avg: QualityScoreEntry = { ...belowAvg, landingPageExp: "AVERAGE" };

function report(url: string | null): CampaignReport[] {
  return [
    {
      campaignId: 1,
      campaignName: "c",
      status: "ENABLED",
      keywords: 0,
      sitelinks: 0,
      callouts: 0,
      campaignFindings: [],
      ads: [
        {
          adId: 1,
          adGroup: "ag",
          strength: "GOOD",
          status: "ENABLED",
          headlines: [],
          descriptions: [],
          finalUrl: url,
          actionItems: [],
          issues: [],
          keywords: [],
          pathToExcellent: [],
        },
      ],
    },
  ];
}

afterEach(() => vi.unstubAllGlobals());

describe("runPsi", () => {
  it("is a no-op (no note, no fetch) when nothing is below-average", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const psi = await runPsi({ 1: [avg] }, report("https://x.com"), "KEY");
    expect(psi).toEqual({ skipped: null, results: [] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("skips gracefully with a reason (no fetch) when below-average but no key", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const psi = await runPsi({ 1: [belowAvg] }, report("https://x.com"), null);
    expect(psi.results).toEqual([]);
    expect(psi.skipped).toMatch(/no credential/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("isolates a per-URL HTTP failure — the audit is not aborted", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 429 }) as Response));
    const psi = await runPsi({ 1: [belowAvg] }, report("https://x.com"), "KEY");
    expect(psi.skipped).toBeNull();
    expect(psi.results).toHaveLength(1);
    expect(psi.results[0]).toMatchObject({ ok: false, url: "https://x.com", error: "PSI HTTP 429" });
  });

  it("isolates a thrown fetch error into a PsiFailure rather than rejecting", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network down");
    }));
    const psi = await runPsi({ 1: [belowAvg] }, report("https://x.com"), "KEY");
    expect(psi.results[0]).toMatchObject({ ok: false, error: "network down" });
  });

  it("returns a parsed diagnosis on a successful call", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        lighthouseResult: { audits: { "largest-contentful-paint": { numericValue: 3100 } } },
      }),
    }) as unknown as Response));
    const psi = await runPsi({ 1: [belowAvg] }, report("https://x.com"), "KEY");
    expect(psi.results[0]).toMatchObject({ ok: true, url: "https://x.com", lcpMs: 3100 });
  });
});

describe("renderPsi", () => {
  it("renders the skip reason", () => {
    expect(renderPsi({ skipped: "no credential", results: [] }).join("\n")).toContain("skipped: no credential");
  });

  it("renders nothing when there is nothing to report", () => {
    expect(renderPsi({ skipped: null, results: [] })).toEqual([]);
  });

  it("formats a success line (n/a LCP) and a failure line", () => {
    const lines = renderPsi({
      skipped: null,
      results: [
        { ok: true, url: "https://a.com", lcpMs: null, renderBlocking: [], unusedJs: [] },
        { ok: false, url: "https://b.com", error: "PSI HTTP 500" },
      ],
    });
    expect(lines.join("\n")).toContain("https://a.com: LCP n/a");
    expect(lines.join("\n")).toContain("https://b.com: unavailable — PSI HTTP 500");
  });
});
