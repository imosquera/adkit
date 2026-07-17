/**
 * Tests for the /adkit report entrypoint.
 *
 * The pure shaping/aggregation helpers (shapeRows, recommendations, buildReport,
 * parseArgs) are exercised with canned rows — no network. `main` is driven with a
 * fake AdsClient into a temp cwd to assert the file it writes and its exit codes,
 * mirroring report.py's side effects.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import type { AdsClient } from "../lib/auth.js";
import { toGaql, type SearchArgs } from "../gaql/search-args.js";
import {
  DEFAULT_CUSTOMER,
  DEFAULT_DAYS,
  DEFAULT_MANAGER,
  buildReport,
  main,
  parseArgs,
  recommendations,
  reportPath,
  shapeRows,
} from "./report.js";

/** A raw metrics block as the SDK returns it (snake_case, numbers/micros). */
function metrics(over: Record<string, number> = {}) {
  return {
    cost_micros: 0,
    impressions: 0,
    clicks: 0,
    ctr: 0,
    average_cpc: 0,
    conversions: 0,
    cost_per_conversion: 0,
    ...over,
  };
}

describe("parseArgs", () => {
  it("defaults with no args", () => {
    expect(parseArgs([])).toEqual({
      customer: DEFAULT_CUSTOMER,
      manager: DEFAULT_MANAGER,
      days: DEFAULT_DAYS,
    });
  });

  it("positional customer and flags", () => {
    expect(parseArgs(["1234567890", "--manager", "999", "--days", "7"])).toEqual({
      customer: "1234567890",
      manager: "999",
      days: 7,
    });
  });

  it("equals-form flags", () => {
    expect(parseArgs(["--days=30", "--manager=42"])).toEqual({
      customer: DEFAULT_CUSTOMER,
      manager: "42",
      days: 30,
    });
  });
});

describe("shapeRows", () => {
  it("normalises the six collections", () => {
    const data = shapeRows({
      campaigns: [
        {
          campaign: { id: 11, name: "Camp A", status: "ENABLED" },
          metrics: metrics({ cost_micros: 2_000_000, impressions: 100, clicks: 5, conversions: 2 }),
        },
      ],
      campaignDaily: [
        { campaign: { id: 11, name: "Camp A" }, segments: { date: "2026-06-08" }, metrics: metrics() },
      ],
      adGroups: [{ campaign: { id: 11 }, ad_group: { id: 21, name: "AG" }, metrics: metrics() }],
      ads: [
        {
          campaign: { id: 11 },
          ad_group: { id: 21 },
          ad_group_ad: { ad: { id: 31, name: "", type: "RESPONSIVE_SEARCH_AD" }, ad_strength: "GOOD" },
          metrics: metrics(),
        },
      ],
      keywords: [
        {
          campaign: { id: 11 },
          ad_group: { id: 21 },
          // match_type as the SDK actually returns it: raw numeric enum (3 === PHRASE).
          ad_group_criterion: { keyword: { text: "shoes", match_type: 3 } },
          metrics: metrics(),
        },
      ],
      searchTerms: [
        {
          campaign: { id: 11 },
          ad_group: { id: 21 },
          search_term_view: { search_term: "red shoes" },
          metrics: metrics(),
        },
      ],
    });

    expect(data.campaigns[0]).toMatchObject({
      id: "11",
      name: "Camp A",
      status: "ENABLED",
      cost: 2.0,
      impressions: 100,
      clicks: 5,
      conversions: 2,
    });
    expect(data.campaign_daily[0]).toMatchObject({ id: "11", date: "2026-06-08" });
    expect(data.ad_groups[0]).toMatchObject({ campaign_id: "11", id: "21", name: "AG" });
    // blank ad name falls back to `Ad <id>`; enums are strings; ids stringified.
    expect(data.ads[0]).toMatchObject({
      campaign_id: "11",
      ad_group_id: "21",
      id: "31",
      name: "Ad 31",
      type: "RESPONSIVE_SEARCH_AD",
      ad_strength: "GOOD",
    });
    expect(data.keywords[0]).toMatchObject({ text: "shoes", match_type: "PHRASE" });
    expect(data.search_terms[0]).toMatchObject({ search_term: "red shoes" });
  });

  it("keeps a present ad name", () => {
    const data = shapeRows({
      campaigns: [],
      campaignDaily: [],
      adGroups: [],
      ads: [
        {
          campaign: { id: 1 },
          ad_group: { id: 2 },
          ad_group_ad: { ad: { id: 3, name: "Spring Sale", type: "TEXT_AD" }, ad_strength: "EXCELLENT" },
          metrics: metrics(),
        },
      ],
      keywords: [],
      searchTerms: [],
    });
    expect(data.ads[0].name).toBe("Spring Sale");
  });
});

describe("recommendations", () => {
  const empty = {
    campaigns: [],
    campaign_daily: [],
    ad_groups: [],
    ads: [],
    keywords: [],
    search_terms: [],
  };

  it("promotes a converting search term not already a keyword", () => {
    const recs = recommendations({
      ...empty,
      campaigns: [
        { id: "11", name: "Camp A", status: "ENABLED", ...metrics() } as never,
      ],
      search_terms: [
        {
          campaign_id: "11",
          ad_group_id: "21",
          search_term: "blue widget",
          cost: 5,
          impressions: 50,
          clicks: 10,
          ctr: 0.2,
          avg_cpc: 0.5,
          conversions: 3,
          cost_per_conversion: 1.67,
        } as never,
      ],
    });
    expect(recs).toHaveLength(1);
    expect(recs[0].campaign_id).toBe("11");
    expect(recs[0].promote_keywords.map((p) => p.text)).toContain("blue widget");
    expect(recs[0].split).toBeNull();
  });

  it("adds a spending non-converting term as negative", () => {
    const recs = recommendations({
      ...empty,
      campaigns: [{ id: "11", name: "Camp A", status: "ENABLED", ...metrics() } as never],
      search_terms: [
        {
          campaign_id: "11",
          ad_group_id: "21",
          search_term: "free stuff",
          cost: 8,
          impressions: 200,
          clicks: 4,
          conversions: 0,
        } as never,
      ],
    });
    expect(recs[0].add_negatives.map((n) => n.text)).toContain("free stuff");
  });
});

describe("buildReport", () => {
  const data = {
    campaigns: [{ id: "11", name: "Camp A", status: "ENABLED", ...metrics() } as never],
    campaign_daily: [],
    ad_groups: [],
    ads: [],
    keywords: [],
    search_terms: [],
  };

  it("carries identifiers, window, and recommendations in order", () => {
    const report = buildReport({
      customer: "8911925499",
      manager: "4193158021",
      data,
      start: "2026-06-08",
      end: "2026-06-21",
      days: 14,
      dailyEnd: "2026-06-22",
      generatedAt: "2026-06-22",
    });
    expect(report.customer_id).toBe("8911925499");
    expect(report.manager_id).toBe("4193158021");
    expect(report.window).toEqual({
      start: "2026-06-08",
      end: "2026-06-21",
      days: 14,
      partial_day: "2026-06-22",
    });
    expect(report.generated_at).toBe("2026-06-22");
    expect(report.recommendations).toHaveLength(1);
    // key order matches report.py's dict (sort_keys=False -> preserved in YAML).
    expect(Object.keys(report).slice(0, 4)).toEqual([
      "customer_id",
      "manager_id",
      "window",
      "generated_at",
    ]);
  });
});

describe("reportPath", () => {
  it("builds the dated raw yaml path", () => {
    expect(reportPath("/work", "2026-06-22", "8911925499")).toBe(
      "/work/ads/output/reports/2026-06-22-8911925499-raw.yaml",
    );
  });
});

describe("main (fake client, temp cwd)", () => {
  let dir: string;
  let cwd: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "report-"));
    cwd = process.cwd();
    process.chdir(dir);
  });

  afterEach(() => {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Fake client: dispatch on the FROM clause so each query returns its rows.
   * Both `FROM campaign` queries carry `segments.date` in their WHERE clause, so
   * the daily one is told apart by its unique `ORDER BY segments.date`; its key
   * is `campaign_daily`.
   */
  function fakeClient(rowsByResource: Record<string, unknown[]>): AdsClient {
    return {
      async search<Row>(_customerId: string, query: string): Promise<Row[]> {
        const match = /FROM (\w+)/.exec(query);
        let resource = match ? match[1] : "";
        if (resource === "campaign" && query.includes("ORDER BY segments.date")) {
          resource = "campaign_daily";
        }
        return (rowsByResource[resource] ?? []) as Row[];
      },
      // report's reads now flow through searchStructured; delegate through toGaql so
      // the FROM/ORDER BY matching keeps working (toGaql reproduces the GAQL string).
      async searchStructured<Row>(customerId: string, args: SearchArgs): Promise<Row[]> {
        return this.search<Row>(customerId, toGaql(args));
      },
      async mutate() {
        throw new Error("not used");
      },
    };
  }

  it("writes the raw yaml and prints its path (exit 0)", async () => {
    const client = fakeClient({
      campaign: [
        {
          campaign: { id: 11, name: "Camp A", status: "ENABLED" },
          metrics: metrics({ cost_micros: 3_000_000, impressions: 300, clicks: 12, conversions: 4 }),
        },
      ],
      campaign_daily: [],
      ad_group: [],
      ad_group_ad: [],
      keyword_view: [],
      search_term_view: [],
    });

    const out: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string) => {
      out.push(String(s));
      return true;
    }) as typeof process.stdout.write;
    let code: number;
    try {
      code = await main(["8911925499", "--manager", "4193158021", "--days", "14"], () => client);
    } finally {
      process.stdout.write = orig;
    }

    expect(code).toBe(0);
    const printed = out.join("").trim();
    expect(printed).toMatch(/ads\/output\/reports\/\d{4}-\d{2}-\d{2}-8911925499-raw\.yaml$/);

    const parsed = parseYaml(readFileSync(printed, "utf8")) as Record<string, unknown>;
    expect(parsed.customer_id).toBe("8911925499");
    expect(parsed.manager_id).toBe("4193158021");
    expect((parsed.campaigns as unknown[])).toHaveLength(1);
    expect(parsed.recommendations).toBeDefined();
    expect((parsed.window as { days: number }).days).toBe(14);
  });

  it("exit 1 and writes nothing when no campaigns", async () => {
    const client = fakeClient({});
    const err: string[] = [];
    const origErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string) => {
      err.push(String(s));
      return true;
    }) as typeof process.stderr.write;
    let code: number;
    try {
      code = await main([], () => client);
    } finally {
      process.stderr.write = origErr;
    }
    expect(code).toBe(1);
    expect(err.join("")).toContain("no ENABLED campaigns");
  });

  it("exit 1 when the query fails, with a remediation hint", async () => {
    const client: AdsClient = {
      async search() {
        throw { failure: { errors: [{ message: "User doesn't have permission" }] } };
      },
      async searchStructured() {
        throw { failure: { errors: [{ message: "User doesn't have permission" }] } };
      },
      async mutate() {
        throw new Error("not used");
      },
    };
    const err: string[] = [];
    const origErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string) => {
      err.push(String(s));
      return true;
    }) as typeof process.stderr.write;
    let code: number;
    try {
      code = await main([], () => client);
    } finally {
      process.stderr.write = origErr;
    }
    expect(code).toBe(1);
    const text = err.join("");
    expect(text).toContain("Google Ads query failed");
    expect(text).toContain("permission");
  });

  it("exit 1 when credentials fail to load", async () => {
    const err: string[] = [];
    const origErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string) => {
      err.push(String(s));
      return true;
    }) as typeof process.stderr.write;
    let code: number;
    try {
      code = await main([], () => {
        throw new Error("missing google-ads.yaml");
      });
    } finally {
      process.stderr.write = origErr;
    }
    expect(code).toBe(1);
    expect(err.join("")).toContain("could not load Google Ads credentials");
  });
});
