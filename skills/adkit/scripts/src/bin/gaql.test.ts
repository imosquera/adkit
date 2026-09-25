import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdsClient, GaqlRow } from "../lib/auth.js";
import { main as gaql } from "./gaql.js";
import { KEYWORDS_QUERY, main as keywords } from "./keywords.js";

function fakeClient(rows: GaqlRow[], seen: string[] = []): () => AdsClient {
  return () => ({
    search: async <Row>(_cid: string, q: string) => {
      seen.push(q);
      return rows as Row[];
    },
    searchStructured: async () => [],
    mutate: async () => ({ results: [] }),
  });
}

function captureStdout(): () => string {
  let buf = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    buf += String(chunk);
    return true;
  });
  return () => buf;
}

afterEach(() => vi.restoreAllMocks());

const ROW = {
  campaign: { name: "Winter", status: 2 },
  ad_group: { name: "Skates", status: 2 },
  ad_group_criterion: { status: 2, keyword: { text: "ice skates", match_type: 4 } },
};

describe("gaql", () => {
  it("prints the rows as pure JSON on stdout", async () => {
    const out = captureStdout();
    const seen: string[] = [];
    const code = await gaql(["SELECT campaign.name FROM campaign", "--customer", "1234567890"], fakeClient([ROW], seen));
    expect(code).toBe(0);
    expect(seen).toEqual(["SELECT campaign.name FROM campaign"]);
    expect(JSON.parse(out())).toEqual([ROW]);
  });

  it("rejects a missing query with an ok:false envelope", async () => {
    const out = captureStdout();
    expect(await gaql([], fakeClient([]))).toBe(1);
    expect(JSON.parse(out()).ok).toBe(false);
  });

  it("reports a failed query as an ok:false envelope", async () => {
    const out = captureStdout();
    const failing = () => ({ ...fakeClient([])(), search: async () => Promise.reject(new Error("bad field")) });
    expect(await gaql(["SELECT x FROM y", "--customer", "1234567890"], failing)).toBe(1);
    expect(JSON.parse(out())).toMatchObject({ ok: false, message: expect.stringContaining("bad field") });
  });
});

describe("keywords", () => {
  it("--json decodes the numeric enums", async () => {
    const out = captureStdout();
    const seen: string[] = [];
    expect(await keywords(["--json", "--customer", "1234567890"], fakeClient([ROW], seen))).toBe(0);
    expect(seen).toEqual([KEYWORDS_QUERY]);
    expect(JSON.parse(out())).toEqual([
      {
        campaign: "Winter",
        adGroup: "Skates",
        keyword: "ice skates",
        matchType: "BROAD",
        status: "ENABLED",
        adGroupStatus: "ENABLED",
        campaignStatus: "ENABLED",
      },
    ]);
  });

  it("prints a tab-separated table by default", async () => {
    const out = captureStdout();
    expect(await keywords(["--customer", "1234567890"], fakeClient([ROW]))).toBe(0);
    expect(out()).toBe("campaign\tad_group\tkeyword\tmatch_type\tstatus\nWinter\tSkates\tice skates\tBROAD\tENABLED\n");
  });
});
