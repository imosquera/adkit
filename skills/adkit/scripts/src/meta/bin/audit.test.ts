import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Params } from "../client.js";
import type { MetaContext, MetaContextFlags } from "../config.js";
import { fakeMetaClient, metaApiError, type FakeMetaClient, type FakeMetaClientOptions } from "../fake-client.js";
import { MetaAccessTokenSchema, MetaAdAccountIdSchema, MetaCampaignIdSchema } from "../ids.js";
import {
  PSI_NO_KEY_REASON,
  auditWindows,
  main,
  parseMetaAuditArgs,
  renderMetaLandingPageHealth,
  runMetaPsi,
} from "./audit.js";

const CTX: MetaContext = {
  token: MetaAccessTokenSchema.parse("EAAtoken"),
  adAccountId: MetaAdAccountIdSchema.parse("act_1234567890"),
  pageId: null,
  pixelId: null,
  appSecret: null,
  psiApiKey: "PSIKEY",
};

const NOW = new Date("2026-09-15T12:00:00Z");
const CURRENT = { since: "2026-09-01", until: "2026-09-14" };
const PREVIOUS = { since: "2026-08-18", until: "2026-08-31" };
const DATES = { date_start: CURRENT.since, date_stop: CURRENT.until };

const CAMPAIGN_ID = "120200000000000001";

// One of each issue type (see scoring.ts):
// - adset 201: learning FAIL (learning_limited) and prospecting with no exclusion (missing_customer_exclusion)
// - adset 202: LEARNING on low volume (still_learning_low_volume)
// - adset 203: OFFSITE_CONVERSIONS without a pixel (weak_conversion_signal, plus the account-wide low-volume one)
// - three active ad sets at < 50 events/week (fragmented_budget)
// - ad 301: frequency 4 and link CTR 2% → 0.8% (creative_fatigue), enhance_cta OPT_IN (advantage_creative_enhancements_on)
// - placement audience_network / classic: 50% of spend with 0 results (wasted_breakdown_spend)
const CAMPAIGNS = [
  {
    id: CAMPAIGN_ID,
    name: "Prospecting",
    objective: "OUTCOME_LEADS",
    effective_status: "ACTIVE",
    advantage_state_info: { advantage_state: "DISABLED" },
  },
];

const AUDIENCE = [{ id: "555" }];
const ADSETS = [
  {
    id: "201",
    name: "Broad",
    campaign_id: CAMPAIGN_ID,
    effective_status: "ACTIVE",
    optimization_goal: "LEAD_GENERATION",
    targeting: {},
    learning_stage_info: { status: "FAIL" },
  },
  {
    id: "202",
    name: "Retargeting",
    campaign_id: CAMPAIGN_ID,
    effective_status: "ACTIVE",
    optimization_goal: "LEAD_GENERATION",
    targeting: { custom_audiences: AUDIENCE },
    learning_stage_info: { status: "LEARNING" },
  },
  {
    id: "203",
    name: "Conversions",
    campaign_id: CAMPAIGN_ID,
    effective_status: "ACTIVE",
    optimization_goal: "OFFSITE_CONVERSIONS",
    targeting: { excluded_custom_audiences: AUDIENCE },
    learning_stage_info: { status: "SUCCESS" },
    campaign: { id: CAMPAIGN_ID, advantage_state_info: { advantage_state: "DISABLED" } },
  },
];

const ADS = [
  {
    id: "301",
    name: "Hook A",
    adset_id: "201",
    effective_status: "ACTIVE",
    creative: {
      id: "401",
      asset_feed_spec: { link_urls: [{ website_url: "https://example.com/a" }] },
      degrees_of_freedom_spec: { creative_features_spec: { enhance_cta: { enroll_status: "OPT_IN" } } },
    },
  },
  {
    id: "302",
    name: "Hook B",
    adset_id: "202",
    effective_status: "ACTIVE",
    creative: {
      id: "402",
      object_story_spec: { page_id: "999", link_data: { link: "https://example.com/b" } },
    },
  },
];

const lead = (value: number) => [{ action_type: "lead", value: String(value) }];

const ADSET_INSIGHTS = [
  { ...DATES, adset_id: "201", spend: "100", impressions: "10000", actions: lead(5) },
  { ...DATES, adset_id: "202", spend: "50", impressions: "5000", actions: lead(2) },
  { ...DATES, adset_id: "203", spend: "50", impressions: "5000", actions: lead(1) },
];

const AD_CURRENT = [
  { ...DATES, ad_id: "301", adset_id: "201", spend: "100", impressions: "10000", frequency: "4", inline_link_clicks: "80" },
  { ...DATES, ad_id: "302", adset_id: "202", spend: "50", impressions: "5000", frequency: "1.2", inline_link_clicks: "100" },
];
const AD_PREVIOUS = [
  { date_start: PREVIOUS.since, date_stop: PREVIOUS.until, ad_id: "301", spend: "90", impressions: "10000", frequency: "2.5", inline_link_clicks: "200" },
];

const PLACEMENTS = [
  { ...DATES, publisher_platform: "facebook", platform_position: "feed", spend: "100", impressions: "10000", actions: lead(8) },
  { ...DATES, publisher_platform: "audience_network", platform_position: "classic", spend: "100", impressions: "10000" },
];
const DEMOGRAPHICS = [{ ...DATES, age: "25-34", gender: "female", spend: "200", impressions: "20000", actions: lead(8) }];

const timeRange = (params: Params): unknown => params["time_range"];

const graph = (path: string, params: Params): unknown => {
  if (path === "act_1234567890/campaigns") return CAMPAIGNS;
  if (path === "act_1234567890/adsets") return ADSETS;
  if (path === "act_1234567890/ads") return ADS;
  if (path !== "act_1234567890/insights") return undefined;
  if (params["breakdowns"] === "publisher_platform,platform_position") return PLACEMENTS;
  if (params["breakdowns"] === "age,gender") return DEMOGRAPHICS;
  if (params["level"] === "adset") return ADSET_INSIGHTS;
  return JSON.stringify(timeRange(params)) === JSON.stringify(PREVIOUS) ? AD_PREVIOUS : AD_CURRENT;
};

const psiBody = (lcpMs: number) => ({ lighthouseResult: { audits: { "largest-contentful-paint": { numericValue: lcpMs } } } });

/** PSI stub: /a is slow, /b answers HTTP 500. */
const psiFetch = () =>
  vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input)).searchParams.get("url");
    return url === "https://example.com/a"
      ? new Response(JSON.stringify(psiBody(5200)), { status: 200 })
      : new Response("boom", { status: 500 });
  });

describe("parseMetaAuditArgs", () => {
  it("defaults --days to 14 and --result-action to lead", () => {
    expect(parseMetaAuditArgs([])).toEqual({
      kind: "ok",
      value: { flags: { adAccount: null, psiKey: null }, days: 14, resultAction: "lead" },
    });
  });

  it("reads every flag", () => {
    const parsed = parseMetaAuditArgs(["--days", "30", "--result-action=purchase", "--ad-account", "act_9", "--psi-key", "K"]);
    expect(parsed).toEqual({
      kind: "ok",
      value: { flags: { adAccount: "act_9", psiKey: "K" }, days: 30, resultAction: "purchase" },
    });
  });

  it("rejects --days outside 7/14/30", () => {
    const parsed = parseMetaAuditArgs(["--days", "28"]);
    expect(parsed.kind).toBe("err");
    expect(parsed.kind === "err" && parsed.message).toContain("7, 14, 30");
  });
});

describe("pure helpers", () => {
  it("builds consecutive windows of equal length ending yesterday", () => {
    expect(auditWindows(NOW, 14)).toEqual({
      days: 14,
      current: { start: CURRENT.since, end: CURRENT.until },
      previous: { start: PREVIOUS.since, end: PREVIOUS.until },
    });
  });

  it("renders landing page health with full Meta ids (beyond safe integers)", () => {
    const lines = renderMetaLandingPageHealth([{ id: MetaCampaignIdSchema.parse(CAMPAIGN_ID), name: "Prospecting" }], {
      [CAMPAIGN_ID]: [{ url: "https://x", issue: "slow_mobile_lcp", detail: "slow" }],
    });
    expect(lines.join("\n")).toContain(`Prospecting (${CAMPAIGN_ID})`);
  });

  it("runs PSI only with URLs and a key", async () => {
    const f = psiFetch();
    expect(await runMetaPsi([], "K", f)).toEqual({ skipped: null, results: [] });
    expect(await runMetaPsi(["https://example.com/a"], null, f)).toEqual({ skipped: PSI_NO_KEY_REASON, results: [] });
    expect(f).not.toHaveBeenCalled();
  });
});

describe("main", () => {
  let stdout: ReturnType<typeof vi.spyOn>;
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const emitted = (): Record<string, unknown> =>
    JSON.parse(stdout.mock.calls.map((c) => String(c[0])).join("")) as Record<string, unknown>;
  const human = (): string => stderr.mock.calls.map((c) => String(c[0])).join("");

  const run = async (
    fake: FakeMetaClientOptions = { get: graph },
    argv: string[] = [],
    ctx: MetaContext = CTX,
  ): Promise<{ code: number; client: FakeMetaClient; fetch: ReturnType<typeof psiFetch>; flags: MetaContextFlags[] }> => {
    const client = fakeMetaClient({ readOnly: true, ...fake });
    const fetchStub = psiFetch();
    const flags: MetaContextFlags[] = [];
    const code = await main(argv, {}, {
      resolveContext: async (f) => {
        flags.push(f);
        return ctx;
      },
      clientFactory: () => client,
      fetch: fetchStub as unknown as typeof fetch,
      now: () => NOW,
    });
    return { code, client, fetch: fetchStub, flags };
  };

  type Finding = { issue: string; entityId: string; severity: string; fix: string; playbook: string };

  it("emits every issue type once, read-only, with the envelope shape", async () => {
    const { code, client } = await run();
    expect(code).toBe(0);
    const env = emitted();
    expect(env).toMatchObject({
      ok: true,
      platform: "meta",
      adAccountId: "act_1234567890",
      window: { start: CURRENT.since, end: CURRENT.until, days: 14 },
    });
    const campaigns = env["campaigns"] as { id: string; name: string; status: string; findings: Finding[] }[];
    expect(campaigns.map((c) => [c.id, c.name, c.status])).toEqual([[CAMPAIGN_ID, "Prospecting", "ACTIVE"]]);
    const all = [...(campaigns[0]?.findings ?? []), ...(env["account"] as Finding[])];
    const byIssue = (issue: string) => all.filter((f) => f.issue === issue).map((f) => f.entityId);
    expect(byIssue("learning_limited")).toEqual(["201"]);
    expect(byIssue("still_learning_low_volume")).toEqual(["202"]);
    expect(byIssue("fragmented_budget")).toEqual([CAMPAIGN_ID]);
    expect(byIssue("creative_fatigue")).toEqual(["301"]);
    expect(byIssue("wasted_breakdown_spend")).toEqual(["placement:audience_network / classic"]);
    expect(byIssue("missing_customer_exclusion")).toEqual(["201"]);
    expect(byIssue("weak_conversion_signal")).toEqual(["203", "account"]);
    expect(byIssue("advantage_creative_enhancements_on")).toEqual(["301"]);
    expect(all.every((f) => f.severity !== "" && f.fix !== "" && f.playbook.startsWith("reference/meta/"))).toBe(true);

    expect(client.calls.every((c) => c.method === "getAll")).toBe(true);
    expect(client.calls).toHaveLength(8);
  });

  it("requests the entity fields and both insights windows", async () => {
    const { client } = await run();
    const call = (step: string) => client.calls.find((c) => c.step === step);
    expect(call("audit-adsets")?.method === "getAll" && call("audit-adsets")?.params["fields"]).toContain(
      "campaign{id,advantage_state_info}",
    );
    const insight = (step: string) => {
      const c = call(step);
      return c?.method === "getAll" ? c.params : {};
    };
    expect(insight("audit-insights-ad")).toMatchObject({ level: "ad", time_range: CURRENT });
    expect(insight("audit-insights-ad-previous")).toMatchObject({ level: "ad", time_range: PREVIOUS });
    expect(insight("audit-insights-adset")).toMatchObject({ level: "adset", time_range: CURRENT });
    expect(insight("audit-insights-adset")["fields"]).toContain("actions");
    expect(insight("audit-insights-placements")).toMatchObject({ breakdowns: "publisher_platform,platform_position" });
    expect(insight("audit-insights-demographics")).toMatchObject({ breakdowns: "age,gender" });
  });

  it("diagnoses each landing page once and flags slow ones per campaign", async () => {
    const { fetch } = await run();
    expect(fetch).toHaveBeenCalledTimes(2);
    const env = emitted();
    const psi = env["psi"] as { skipped: string | null; results: { ok: boolean; url: string }[] };
    expect(psi.skipped).toBeNull();
    expect(psi.results.map((r) => [r.url, r.ok])).toEqual([
      ["https://example.com/a", true],
      ["https://example.com/b", false],
    ]);
    expect(env["landingPageHealth"]).toEqual({
      [CAMPAIGN_ID]: [expect.objectContaining({ url: "https://example.com/a", issue: "slow_mobile_lcp" })],
    });
    const text = human();
    expect(text).toContain("META AUDIT — last 14 days");
    expect(text).toContain("! learning_limited:");
    expect(text).toContain("=== LANDING PAGE HEALTH ===");
    expect(text).toContain("=== PAGESPEED INSIGHTS (mobile) ===");
  });

  it("skips PSI with a reason when there is no key", async () => {
    const { fetch } = await run(undefined, [], { ...CTX, psiApiKey: null });
    expect(fetch).not.toHaveBeenCalled();
    expect(emitted()["psi"]).toEqual({ skipped: PSI_NO_KEY_REASON, results: [] });
    expect(emitted()["landingPageHealth"]).toEqual({});
  });

  it("passes --ad-account and --psi-key to the resolver and honours --days", async () => {
    const { flags, client } = await run(undefined, ["--ad-account", "act_5", "--psi-key", "K", "--days", "7"]);
    expect(flags).toEqual([{ adAccount: "act_5", psiKey: "K" }]);
    expect(emitted()["window"]).toMatchObject({ days: 7, start: "2026-09-08", end: "2026-09-14" });
    const prev = client.calls.find((c) => c.step === "audit-insights-ad-previous");
    expect(prev?.method === "getAll" && prev.params["time_range"]).toEqual({ since: "2026-09-01", until: "2026-09-07" });
  });

  it("fails at args on a bad --days without resolving context", async () => {
    const { code, flags, client } = await run(undefined, ["--days", "10"]);
    expect(code).toBe(1);
    expect(emitted()).toMatchObject({ ok: false, step: "args" });
    expect(flags).toEqual([]);
    expect(client.calls).toEqual([]);
  });

  it("reports the failing read's step", async () => {
    const { code } = await run({
      get: graph,
      failOn: (call) => (call.step === "audit-insights-placements" ? metaApiError(100, "Invalid breakdown") : null),
    });
    expect(code).toBe(1);
    expect(emitted()).toMatchObject({ ok: false, step: "audit-insights-placements" });
    expect(String(emitted()["message"])).toContain("Invalid breakdown");
  });
});
