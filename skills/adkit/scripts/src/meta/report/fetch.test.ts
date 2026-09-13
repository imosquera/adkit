/** Unit tests for the Meta report reads: attribution parsing, all-time clamp, request params. */
import { describe, expect, it } from "vitest";

import type { Params } from "../client.js";
import { fakeMetaClient, metaApiError } from "../fake-client.js";
import { MetaAdAccountIdSchema } from "../ids.js";
import { clampAllTime, fetchMetaReportRows, INSIGHTS_FIELDS, parseAttribution } from "./fetch.js";

const ctx = { adAccountId: MetaAdAccountIdSchema.parse("act_42") };
const window = { start: "2026-09-01", end: "2026-09-12" };
const opts = { includePaused: false, attribution: ["7d_click", "1d_view"] as const, resultAction: "lead" };

const insight = (extra: Record<string, unknown>) => ({
  date_start: "2026-09-01",
  date_stop: "2026-09-12",
  spend: "10",
  impressions: "100",
  ...extra,
});

/** Answers each read with one row tagged by its level/breakdown so routing is checkable. */
const responder = (path: string, params: Params): unknown =>
  path.endsWith("/campaigns")
    ? [{ id: "1", name: "C1", effective_status: "ACTIVE", objective: "OUTCOME_LEADS" }]
    : [
        insight({
          campaign_id: "1",
          campaign_name: `${String(params.level)}|${String(params.breakdowns ?? "")}|${String(params.time_increment ?? "")}`,
        }),
      ];

describe("parseAttribution", () => {
  it("defaults to 7d_click,1d_view", () => {
    expect(parseAttribution()).toEqual({ kind: "ok", value: ["7d_click", "1d_view"] });
  });

  it("accepts allowed windows, trimming and de-duplicating", () => {
    expect(parseAttribution(" 1d_click, 28d_click ,1d_ev,1d_click")).toEqual({
      kind: "ok",
      value: ["1d_click", "28d_click", "1d_ev"],
    });
  });

  it.each(["7d_view", "28d_view", "1d_click,7d_view"])("rejects removed view window %s with the 2026-01-12 explanation", (raw) => {
    const result = parseAttribution(raw);
    expect(result.kind).toBe("err");
    expect(result.kind === "err" && result.message).toMatch(/2026-01-12/);
  });

  it("rejects unknown and empty values", () => {
    expect(parseAttribution("3d_click")).toMatchObject({ kind: "err", message: expect.stringMatching(/unknown window 3d_click/) });
    expect(parseAttribution(" , ")).toMatchObject({ kind: "err" });
  });
});

describe("clampAllTime", () => {
  const today = new Date("2026-09-13T15:00:00Z");

  it("clamps an earlier start to 37 months before today", () => {
    expect(clampAllTime("2000-01-01", today)).toBe("2023-08-13");
  });

  it("keeps a start already inside the limit", () => {
    expect(clampAllTime("2024-01-01", today)).toBe("2024-01-01");
    expect(clampAllTime("2023-08-13", today)).toBe("2023-08-13");
  });

  it("caps the day at the target month's end", () => {
    // 37 months before 2026-03-31 is February 2023 (28 days).
    expect(clampAllTime("2000-01-01", new Date("2026-03-31T00:00:00Z"))).toBe("2023-02-28");
  });
});

describe("fetchMetaReportRows", () => {
  it("issues the campaigns read and eight insights reads with their params and steps", async () => {
    const client = fakeMetaClient({ get: responder, readOnly: true });
    await fetchMetaReportRows(client, ctx, window, opts);

    expect(client.calls).toHaveLength(9);
    expect(client.calls.every((c) => c.method === "getAll")).toBe(true);

    const campaigns = client.calls.find((c) => c.path === "act_42/campaigns");
    expect(campaigns).toMatchObject({
      step: "report-campaigns",
      params: {
        fields: "id,name,effective_status,objective",
        filtering: [{ field: "effective_status", operator: "IN", value: ["ACTIVE"] }],
      },
    });

    const insights = client.calls.filter((c) => c.path === "act_42/insights");
    expect(insights.map((c) => [c.step, c.method === "getAll" ? c.params.level : null])).toEqual([
      ["report-insights-campaign", "campaign"],
      ["report-insights-campaign-daily", "campaign"],
      ["report-insights-adset", "adset"],
      ["report-insights-ad", "ad"],
      ["report-insights-placements", "account"],
      ["report-insights-demographics", "account"],
      ["report-insights-country", "account"],
      ["report-insights-region", "account"],
    ]);
    const params = insights.map((c) => (c.method === "getAll" ? c.params : {}));
    expect(params.map((p) => p.breakdowns)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      "publisher_platform,platform_position",
      "age,gender",
      "country",
      "region",
    ]);
    expect(params.map((p) => p.time_increment)).toEqual([undefined, 1, undefined, undefined, undefined, undefined, undefined, undefined]);
    params.forEach((p) =>
      expect(p).toMatchObject({
        fields: INSIGHTS_FIELDS,
        time_range: { since: "2026-09-01", until: "2026-09-12" },
        action_attribution_windows: ["7d_click", "1d_view"],
        use_account_attribution_setting: false,
        filtering: [{ field: "campaign.effective_status", operator: "IN", value: ["ACTIVE"] }],
      }),
    );
  });

  it("drops every effective_status filter with --include-paused", async () => {
    const client = fakeMetaClient({ get: responder });
    await fetchMetaReportRows(client, ctx, window, { ...opts, includePaused: true });
    expect(client.calls.map((c) => (c.method === "getAll" ? c.params.filtering : "x"))).toEqual(Array(9).fill(undefined));
  });

  it("routes each read's parsed rows to its MetaReportRows key", async () => {
    const rows = await fetchMetaReportRows(fakeMetaClient({ get: responder }), ctx, window, opts);
    expect(rows.campaigns).toEqual([{ id: "1", name: "C1", effective_status: "ACTIVE", objective: "OUTCOME_LEADS" }]);
    expect(rows.campaignTotals[0]).toMatchObject({ campaign_id: "1", campaign_name: "campaign||", spend: 10, impressions: 100 });
    expect(rows.campaignDaily[0]?.campaign_name).toBe("campaign||1");
    expect(rows.adSets[0]?.campaign_name).toBe("adset||");
    expect(rows.ads[0]?.campaign_name).toBe("ad||");
    expect(rows.placements[0]?.campaign_name).toBe("account|publisher_platform,platform_position|");
    expect(rows.demographics[0]?.campaign_name).toBe("account|age,gender|");
    expect(rows.countries[0]?.campaign_name).toBe("account|country|");
    expect(rows.regions[0]?.campaign_name).toBe("account|region|");
  });

  it("rejects with the failing read's step", async () => {
    const client = fakeMetaClient({
      get: responder,
      failOn: (c) => (c.step === "report-insights-region" ? metaApiError(100, "bad breakdown") : null),
    });
    await expect(fetchMetaReportRows(client, ctx, window, opts)).rejects.toMatchObject({ step: "report-insights-region", code: 100 });
  });
});
