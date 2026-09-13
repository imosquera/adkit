/** Tests for the Meta report bin: arg splitting/parsing, the window, and `main` end to end over a fake client. */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

import type { Params } from "../client.js";
import type { MetaContext } from "../config.js";
import { MetaConfigError } from "../errors.js";
import { fakeMetaClient, metaApiError, type FakeMetaClient, type FakeMetaClientOptions } from "../fake-client.js";
import { MetaAccessTokenSchema, MetaAdAccountIdSchema } from "../ids.js";
import { main, parseMetaReportArgs, reportWindow, splitReportArgs, type ReportDeps } from "./report.js";

const CTX: MetaContext = {
  token: MetaAccessTokenSchema.parse("EAAtoken"),
  adAccountId: MetaAdAccountIdSchema.parse("act_1234567890"),
  pageId: null,
  pixelId: null,
  appSecret: null,
  psiApiKey: null,
};

const TODAY = new Date("2026-09-13T15:00:00Z");
const ACCOUNT = { id: "act_1234567890", name: "Acme", account_status: 1, currency: "EUR" };

const row = (extra: Record<string, unknown>) => ({
  date_start: "2026-08-30",
  date_stop: "2026-09-12",
  ...extra,
});

/** Multi-row responses per read, routed by path + level/breakdowns/time_increment. */
const happyGet = (path: string, params: Params): unknown => {
  if (path === "act_1234567890") return ACCOUNT;
  if (path.endsWith("/campaigns")) {
    return [
      { id: "1", name: "Leads A", effective_status: "ACTIVE", objective: "OUTCOME_LEADS" },
      { id: "2", name: "Leads B", effective_status: "ACTIVE", objective: "OUTCOME_LEADS" },
    ];
  }
  const leads = (n: number) => [
    { action_type: "lead", value: String(n) },
    { action_type: "link_click", value: "99" },
  ];
  const key = `${String(params.level)}|${String(params.breakdowns ?? "")}|${String(params.time_increment ?? "")}`;
  switch (key) {
    case "campaign||":
      return [
        row({ campaign_id: "1", campaign_name: "Leads A", spend: "100.50", impressions: "10000", clicks: "200", actions: leads(10) }),
        row({ campaign_id: "2", campaign_name: "Leads B", spend: "40", impressions: "4000", clicks: "50", actions: leads(2) }),
      ];
    case "campaign||1":
      return [
        row({ campaign_id: "1", date_start: "2026-09-11", spend: "7", impressions: "700" }),
        row({ campaign_id: "1", date_start: "2026-09-12", spend: "8", impressions: "800" }),
      ];
    case "adset||":
      return [
        row({ campaign_id: "1", adset_id: "11", adset_name: "AS1", spend: "60", impressions: "6000" }),
        row({ campaign_id: "1", adset_id: "12", adset_name: "AS2", spend: "40.50", impressions: "4000" }),
      ];
    case "ad||":
      return [row({ campaign_id: "1", adset_id: "11", ad_id: "111", ad_name: "Ad 1", spend: "60", impressions: "6000" })];
    case "account|publisher_platform,platform_position|":
      return [
        row({ publisher_platform: "facebook", platform_position: "feed", spend: "90", impressions: "9000" }),
        row({ publisher_platform: "instagram", platform_position: "reels", spend: "50.50", impressions: "5000" }),
      ];
    case "account|age,gender|":
      return [row({ age: "25-34", gender: "female", spend: "80", impressions: "8000" })];
    case "account|country|":
      return [row({ country: "DE", spend: "140.50", impressions: "14000" })];
    case "account|region|":
      return [row({ region: "Berlin", spend: "140.50", impressions: "14000" })];
    default:
      return [];
  }
};

describe("splitReportArgs", () => {
  it("pulls Meta flags in space and = form, leaving the rest", () => {
    expect(
      splitReportArgs(["--days", "7", "--result-action", "complete_registration", "--attribution=1d_click", "--ad-account", "act_9", "--all-time"]),
    ).toEqual({
      kind: "ok",
      value: {
        rest: ["--days", "7", "--all-time"],
        values: { "--result-action": "complete_registration", "--attribution": "1d_click", "--ad-account": "act_9" },
      },
    });
  });

  it("refuses a valueless flag", () => {
    expect(splitReportArgs(["--attribution", "--days", "7"])).toMatchObject({ kind: "err", message: "--attribution requires a value" });
    expect(splitReportArgs(["--ad-account"])).toMatchObject({ kind: "err" });
  });
});

describe("parseMetaReportArgs", () => {
  it("defaults to 14 days, lead, 7d_click,1d_view", () => {
    expect(parseMetaReportArgs([])).toEqual({
      kind: "ok",
      value: {
        window: { days: 14, allTime: false, includePaused: false },
        adAccount: null,
        resultAction: "lead",
        attribution: ["7d_click", "1d_view"],
      },
    });
  });

  it("refuses 7d_view, a bad --days and Google account flags", () => {
    expect(parseMetaReportArgs(["--attribution", "7d_view"])).toMatchObject({ kind: "err", message: expect.stringMatching(/2026-01-12/) });
    expect(parseMetaReportArgs(["--days", "zero"])).toMatchObject({ kind: "err", message: expect.stringMatching(/--days/) });
    expect(parseMetaReportArgs(["--customer", "123"])).toMatchObject({ kind: "err", message: expect.stringMatching(/--ad-account/) });
  });
});

describe("reportWindow", () => {
  it("is the trailing complete days with today as the partial day", () => {
    expect(reportWindow({ days: 7, allTime: false }, TODAY)).toEqual({
      start: "2026-09-06",
      end: "2026-09-12",
      days: 7,
      partial_day: "2026-09-13",
    });
  });

  it("clamps all-time to 37 months and reports the clamped span", () => {
    const w = reportWindow({ days: 14, allTime: true }, TODAY);
    expect(w.start).toBe("2023-08-13");
    expect(w.end).toBe("2026-09-12");
    expect(w.days).toBe(1127);
  });
});

describe("main", () => {
  let cwd: string;
  let stdout: string[];

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "meta-report-"));
    stdout = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(cwd, { recursive: true, force: true });
  });

  const run = async (
    argv: readonly string[],
    fake: FakeMetaClientOptions = { get: happyGet, readOnly: true },
    overrides: Partial<ReportDeps> = {},
  ): Promise<{ code: number; client: FakeMetaClient; out: string }> => {
    const client = fakeMetaClient(fake);
    const code = await main(argv, {}, {
      clientFactory: () => client,
      resolveContext: async () => CTX,
      now: () => TODAY,
      cwd: () => cwd,
      reportsDir: () => "ads/output/reports",
      ...overrides,
    });
    return { code, client, out: stdout.join("") };
  };

  it("writes the Meta YAML and prints only its path", async () => {
    const { code, client, out } = await run(["--days", "14", "--attribution", "1d_click,1d_view"]);
    expect(code).toBe(0);
    const expected = join(cwd, "ads/output/reports", "2026-09-13-act_1234567890-raw.yaml");
    expect(out).toBe(`${expected}\n`);
    expect(readdirSync(join(cwd, "ads/output/reports"))).toEqual(["2026-09-13-act_1234567890-raw.yaml"]);

    const report = parseYaml(readFileSync(expected, "utf8"));
    expect(report).toMatchObject({
      platform: "meta",
      customer_id: "act_1234567890",
      manager_id: null,
      currency: "EUR",
      attribution: ["1d_click", "1d_view"],
      result_action: "lead",
      window: { start: "2026-08-30", end: "2026-09-12", days: 14, partial_day: "2026-09-13" },
      generated_at: "2026-09-13",
      keywords: [],
      search_terms: [],
      recommendations: [],
    });
    expect(report.campaigns).toHaveLength(2);
    expect(report.campaigns[0]).toMatchObject({ id: "1", name: "Leads A", status: "ACTIVE", cost: 100.5, conversions: 10 });
    const totalCost = report.campaigns.reduce((s: number, c: { cost: number }) => s + c.cost, 0);
    const totalConv = report.campaigns.reduce((s: number, c: { conversions: number }) => s + c.conversions, 0);
    expect(totalCost).toBeCloseTo(140.5);
    expect(totalConv).toBe(12);
    expect(report.campaign_daily).toHaveLength(2);
    expect(report.ad_groups).toHaveLength(2);
    expect(report.placements.map((p: { publisher_platform: string }) => p.publisher_platform)).toEqual(["facebook", "instagram"]);
    expect(report.demographics[0]).toMatchObject({ age: "25-34", gender: "female" });

    const insights = client.calls.filter((c) => c.path === "act_1234567890/insights");
    expect(insights).toHaveLength(8);
    expect(insights[0]).toMatchObject({
      params: {
        time_range: { since: "2026-08-30", until: "2026-09-12" },
        action_attribution_windows: ["1d_click", "1d_view"],
      },
    });
  });

  it("refuses 7d_view with ok:false before any call", async () => {
    const { code, client, out } = await run(["--attribution", "7d_view"]);
    expect(code).toBe(1);
    expect(JSON.parse(out)).toEqual({ ok: false, message: expect.stringMatching(/2026-01-12/), step: "args" });
    expect(client.calls).toEqual([]);
  });

  it("exits 1 with nothing written when there are no campaigns", async () => {
    const empty = (path: string): unknown => (path === "act_1234567890" ? ACCOUNT : []);
    const { code, out } = await run([], { get: empty });
    expect(code).toBe(1);
    expect(JSON.parse(out)).toMatchObject({ ok: false, step: "report", message: expect.stringMatching(/nothing written/) });
    expect(() => readdirSync(join(cwd, "ads"))).toThrow();
  });

  it("names the failing read's step", async () => {
    const { code, out } = await run([], {
      get: happyGet,
      failOn: (call) => (call.step === "report-insights-adset" ? metaApiError(17, "User request limit reached") : null),
    });
    expect(code).toBe(1);
    expect(JSON.parse(out)).toMatchObject({ ok: false, step: "report-insights-adset" });
  });

  it("passes --ad-account to context resolution and keeps its config error step", async () => {
    const resolveContext = vi.fn(async () => {
      throw new MetaConfigError("ad-account", "no meta_ad_account_id");
    });
    const { code, out } = await run(["--ad-account", "act_77"], undefined, { resolveContext });
    expect(resolveContext).toHaveBeenCalledWith({ adAccount: "act_77" });
    expect(code).toBe(1);
    expect(JSON.parse(out)).toMatchObject({ ok: false, step: "ad-account" });
  });

  it("drops the ACTIVE filter under --include-paused", async () => {
    const { code, client } = await run(["--include-paused"]);
    expect(code).toBe(0);
    expect(client.calls.every((c) => c.method !== "getAll" || c.params.filtering === undefined)).toBe(true);
  });
});
