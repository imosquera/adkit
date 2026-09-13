/** Tests for the Meta update bin: `main` end to end over a temp cwd (briefs + state) and a stateful fake client. */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import type { MetaContext } from "../config.js";
import { fakeMetaClient, metaApiError, type FakeCall, type FakeMetaClient } from "../fake-client.js";
import { MetaAccessTokenSchema, MetaAdAccountIdSchema } from "../ids.js";
import { main, parseUpdateArgs, type UpdateDeps } from "./update.js";

const CTX: MetaContext = {
  token: MetaAccessTokenSchema.parse("EAAtoken"),
  adAccountId: MetaAdAccountIdSchema.parse("act_111"),
  pageId: null,
  pixelId: null,
  appSecret: null,
  psiApiKey: null,
};

const NOW = new Date("2026-09-13T10:00:00Z");

// ---------- Live world (a stateful fake Graph) ----------

type Obj = Record<string, unknown>;

const campaignObj = (id: string, name: string): Obj => ({
  id,
  name,
  objective: "OUTCOME_TRAFFIC",
  effective_status: "ACTIVE",
  status: "ACTIVE",
});

const adSetObj = (id: string, campaignId: string, extra: Obj = {}): Obj => ({
  id,
  name: `set-${id}`,
  campaign_id: campaignId,
  effective_status: "ACTIVE",
  status: "ACTIVE",
  optimization_goal: "LINK_CLICKS",
  daily_budget: "5000",
  targeting: { geo_locations: { countries: ["US"] }, excluded_custom_audiences: [{ id: "900" }] },
  ...extra,
});

const adObj = (id: string, adSetId: string): Obj => ({
  id,
  name: `ad-${id}`,
  adset_id: adSetId,
  effective_status: "PAUSED",
  status: "PAUSED",
  creative: {
    id: `4${id}`,
    name: "Creative",
    object_story_spec: { page_id: "55" },
    asset_feed_spec: { bodies: [{ text: "p" }], titles: [{ text: "h" }], descriptions: [{ text: "d" }] },
  },
});

/**
 * A fake Graph whose objects change as posts land, so a re-run reads what the
 * previous `--apply` wrote. Test double: the closure-owned pool is replaced per post.
 */
const makeWorld = (initial: Record<string, Obj>) => {
  let pool: Record<string, Obj> = { ...initial };
  let pendingCreative: Obj = {};
  const get = (path: string, params: Obj): unknown => {
    if (path === "act_111") return { currency: "USD" };
    if (path.endsWith("/adsets")) {
      const campaignId = path.split("/")[0];
      return Object.values(pool).filter((o) => o["campaign_id"] === campaignId && "optimization_goal" in o);
    }
    return Object.fromEntries(
      String(params["ids"])
        .split(",")
        .flatMap((id) => (pool[id] === undefined ? [] : [[id, pool[id]]])),
    );
  };
  const post = (path: string, body: Obj): unknown => {
    if (path.endsWith("/adcreatives")) {
      pendingCreative = body;
      return { id: "777" };
    }
    const cur = pool[path] ?? {};
    const creative = body["creative"] as { creative_id: string } | undefined;
    const next: Obj = {
      ...cur,
      ...("status" in body ? { status: body["status"], effective_status: body["status"] } : {}),
      ...("daily_budget" in body ? { daily_budget: String(body["daily_budget"]) } : {}),
      ...("targeting" in body ? { targeting: body["targeting"] } : {}),
      ...(creative === undefined ? {} : { creative: { ...pendingCreative, id: creative.creative_id } }),
    };
    pool = { ...pool, [path]: next };
    return { success: true };
  };
  return {
    client: (failOn?: (call: FakeCall) => ReturnType<typeof metaApiError> | null): FakeMetaClient =>
      fakeMetaClient({ get, post, ...(failOn === undefined ? {} : { failOn }) }),
    obj: (id: string): Obj | undefined => pool[id],
  };
};

const standardWorld = (adSetExtra: Obj = {}) =>
  makeWorld({
    "100": campaignObj("100", "Shop"),
    "200": adSetObj("200", "100", adSetExtra),
    "300": adObj("300", "200"),
    "110": campaignObj("110", "Other"),
    "210": adSetObj("210", "110"),
    "310": adObj("310", "210"),
  });

// ---------- Disk fixtures ----------

const briefData = (campaignName: string, name: string): Obj => ({
  type: "meta",
  name,
  campaign: { name: campaignName, objective: "OUTCOME_TRAFFIC", budget: { mode: "adset", bidStrategy: "LOWEST_COST_WITHOUT_CAP" } },
  adSets: [
    {
      name: "set-1",
      dailyBudget: 50,
      optimizationGoal: "LINK_CLICKS",
      audience: { countries: ["US"], excludedCustomAudienceIds: ["900"] },
      ads: [
        {
          name: "ad-1",
          link: "https://example.com",
          callToAction: "LEARN_MORE",
          primaryTexts: ["p"],
          headlines: ["h"],
          descriptions: ["d"],
          media: { image: "./a.png" },
        },
      ],
    },
  ],
});

const stateData = (campaignName: string, campaignId: string, adSetId: string, adId: string): Obj => ({
  platform: "meta",
  adAccountId: "act_111",
  campaign: { name: campaignName, campaignId },
  media: {},
  adSets: [{ name: "set-1", adSetId, ads: [{ name: "ad-1", creativeId: `4${adId}`, adId }] }],
});

describe("parseUpdateArgs", () => {
  it("reads the plan path, --apply and --ad-account", () => {
    expect(parseUpdateArgs(["plan.yaml", "--apply", "--ad-account", "act_9"])).toEqual({
      kind: "ok",
      value: { planPath: "plan.yaml", apply: true, adAccount: "act_9" },
    });
    expect(parseUpdateArgs(["--apply"])).toMatchObject({ kind: "err" });
    expect(parseUpdateArgs(["p.yaml", "--ad-account"])).toMatchObject({ kind: "err" });
    expect(parseUpdateArgs(["p.yaml", "--ad-account="])).toMatchObject({ kind: "err" });
    expect(parseUpdateArgs(["p.yaml", "--ad-account=act_7"])).toMatchObject({ kind: "ok", value: { adAccount: "act_7" } });
  });
});

describe("main", () => {
  let cwd: string;
  let stdout: string[];
  let logs: string[];

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "meta-update-"));
    stdout = [];
    logs = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
      logs.push(parts.map(String).join(" "));
    });
    const briefs = join(cwd, "adbriefs");
    mkdirSync(briefs, { recursive: true });
    writeFileSync(join(briefs, "a.png"), "png");
    writeFileSync(join(briefs, "shop.yaml"), stringifyYaml(briefData("Shop", "shop")));
    writeFileSync(join(briefs, "shop.meta-state.yaml"), stringifyYaml(stateData("Shop", "100", "200", "300")));
    writeFileSync(join(briefs, "other.yaml"), stringifyYaml(briefData("Other", "other")));
    writeFileSync(join(briefs, "other.meta-state.yaml"), stringifyYaml(stateData("Other", "110", "210", "310")));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(cwd, { recursive: true, force: true });
  });

  const writePlan = (plan: Obj): string => {
    writeFileSync(join(cwd, "plan.yaml"), stringifyYaml({ platform: "meta", ...plan }));
    return "plan.yaml";
  };

  const run = async (argv: readonly string[], client: FakeMetaClient, overrides: Partial<UpdateDeps> = {}) => {
    stdout.length = 0;
    logs.length = 0;
    const code = await main(argv, {}, {
      clientFactory: () => client,
      resolveContext: async () => CTX,
      now: () => NOW,
      cwd: () => cwd,
      briefsDir: () => "adbriefs",
      ...overrides,
    });
    return { code, envelope: JSON.parse(stdout.join("")) as Obj, logs: [...logs] };
  };

  const posts = (client: FakeMetaClient) => client.calls.filter((c) => c.method === "post");
  const readBrief = (slug: string): Obj => parseYaml(readFileSync(join(cwd, "adbriefs", `${slug}.yaml`), "utf8")) as Obj;
  const readState = (slug: string): Obj =>
    parseYaml(readFileSync(join(cwd, "adbriefs", `${slug}.meta-state.yaml`), "utf8")) as Obj;
  const briefText = (slug: string): string => readFileSync(join(cwd, "adbriefs", `${slug}.yaml`), "utf8");

  const shopPlan = {
    budgets: [{ level: "adset", id: "200", dailyBudget: 60 }],
    status: [{ level: "ad", id: "300", status: "ACTIVE" }],
    exclusions: [{ adSetId: "200", add: ["901"] }],
    textPools: [{ adId: "300", headlines: ["h1", "h2"] }],
  };

  it("dry run: diffs the brief, reports every envelope key, makes zero writes", async () => {
    const world = standardWorld();
    const client = world.client();
    const before = briefText("shop");
    const { code, envelope, logs: out } = await run([writePlan(shopPlan)], client);

    expect(code).toBe(0);
    expect(posts(client)).toEqual([]);
    expect(briefText("shop")).toBe(before);
    expect(envelope).toMatchObject({
      ok: true,
      platform: "meta",
      applied: false,
      budgetChanges: [{ level: "adset", id: "200", dailyBudget: 60 }],
      budgetSkipped: [],
      statusChanges: [{ level: "ad", id: "300", status: "ACTIVE" }],
      statusSkipped: [],
      exclusionChanges: [{ adSetId: "200", add: ["901"], remove: [] }],
      exclusionSkipped: [],
      enhancementChanges: [],
      enhancementSkipped: [],
      textPoolChanges: [{ adId: "300", headlines: ["h1", "h2"] }],
      textPoolSkipped: [],
      enableStartsLiveSpend: ["300"],
      budgetIncreases: ["200"],
      learningResetRisk: [],
      exclusionIgnored: [],
      unresolvedPlanIds: [],
      errors: [],
    });
    expect(envelope["briefs"]).toEqual([
      {
        slug: "shop",
        briefPath: join(cwd, "adbriefs", "shop.yaml"),
        briefSynced: false,
        briefDiff: expect.objectContaining({ changed: true }),
        briefStagingSkipped: false,
        briefStagingSkipReason: null,
      },
    ]);
    expect(out).toContain("validation ok. planned actions:");
    expect(out).toContain("  - budget ad set 200: 50 -> 60 USD/day");
    expect(out.some((l) => l.includes("Dry run. Re-run with --apply."))).toBe(true);
  });

  it("--apply writes live and the brief; a third run skips everything", async () => {
    const world = standardWorld();
    const plan = writePlan(shopPlan);

    const dry = await run([plan], world.client());
    expect(dry.code).toBe(0);

    const client = world.client();
    const applied = await run([plan, "--apply"], client);
    expect(applied.code).toBe(0);
    expect(applied.envelope).toMatchObject({ ok: true, applied: true, errors: [] });
    expect(posts(client).map((c) => c.path)).toEqual(["200", "200", "act_111/adcreatives", "300", "300"]);
    expect(applied.envelope["briefs"]).toEqual([expect.objectContaining({ slug: "shop", briefSynced: true })]);
    const set = (readBrief("shop")["adSets"] as Obj[])[0]!;
    expect(set["dailyBudget"]).toBe(60);
    expect((set["audience"] as Obj)["excludedCustomAudienceIds"]).toEqual(["900", "901"]);
    expect(((set["ads"] as Obj[])[0]!)["headlines"]).toEqual(["h1", "h2"]);
    // The text-pool swap's new creative id is recorded in the state file; other ids are untouched.
    const shopAd = ((readState("shop")["adSets"] as Obj[])[0]!["ads"] as Obj[])[0]!;
    expect(shopAd).toEqual({ name: "ad-1", creativeId: "777", adId: "300" });
    expect(readState("other")).toEqual(stateData("Other", "110", "210", "310"));

    const rerunClient = world.client();
    const briefAfterApply = briefText("shop");
    const third = await run([plan, "--apply"], rerunClient);
    expect(third.code).toBe(0);
    expect(posts(rerunClient)).toEqual([]);
    expect(third.envelope).toMatchObject({
      applied: true,
      budgetChanges: [],
      budgetSkipped: [{ id: "200" }],
      statusChanges: [],
      statusSkipped: [{ id: "300" }],
      exclusionChanges: [],
      exclusionSkipped: [{ adSetId: "200" }],
      textPoolChanges: [],
      textPoolSkipped: [{ adId: "300" }],
      enableStartsLiveSpend: [],
      budgetIncreases: [],
      briefs: [],
    });
    expect(briefText("shop")).toBe(briefAfterApply);
  });

  it("reports enable, raise, learning-reset and ignored-exclusion warnings", async () => {
    const world = standardWorld({
      learning_stage_info: { status: "LEARNING" },
      campaign: { id: "100", advantage_state_info: { advantage_state: "ADVANTAGE_PLUS_AUDIENCE" } },
    });
    const { code, envelope, logs: out } = await run(
      [
        writePlan({
          status: [{ level: "ad", id: "300", status: "ACTIVE" }],
          budgets: [{ level: "adset", id: "200", dailyBudget: 70 }],
          exclusions: [{ adSetId: "200", add: ["901"] }],
        }),
      ],
      world.client(),
    );
    expect(code).toBe(0);
    expect(envelope).toMatchObject({
      enableStartsLiveSpend: ["300"],
      budgetIncreases: ["200"],
      learningResetRisk: ["200"],
      exclusionIgnored: ["200"],
    });
    const warnings = out.filter((l) => l.startsWith("WARNING: "));
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("enabling ad 300 starts live spend"),
        expect.stringContaining("raising daily budget of ad set 200"),
        expect.stringContaining("may reset learning"),
        expect.stringContaining("exclusions may be ignored"),
      ]),
    );
  });

  it("isolates a failed entry: other briefs sync, the failed slug's brief is untouched, exit 1", async () => {
    const world = standardWorld();
    const client = world.client((c) => (c.method === "post" && c.path === "210" ? metaApiError(613, "budget changed too often") : null));
    const otherBefore = briefText("other");
    const { code, envelope, logs: out } = await run(
      [
        writePlan({
          budgets: [
            { level: "adset", id: "210", dailyBudget: 60 },
            { level: "adset", id: "200", dailyBudget: 60 },
          ],
        }),
        "--apply",
      ],
      client,
    );
    expect(code).toBe(1);
    expect(posts(client).map((c) => c.path)).toEqual(["210", "200"]);
    expect(world.obj("200")?.["daily_budget"]).toBe("6000");
    expect(envelope).toMatchObject({
      ok: false,
      applied: true,
      step: "apply",
      errors: [{ step: "budget", entityId: "210", message: expect.stringContaining("budget changed too often"), slugs: ["other"] }],
    });
    expect(envelope["briefs"]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ slug: "shop", briefSynced: true }),
        expect.objectContaining({ slug: "other", briefSynced: false }),
      ]),
    );
    expect(briefText("other")).toBe(otherBefore);
    expect(((readBrief("shop")["adSets"] as Obj[])[0]!)["dailyBudget"]).toBe(60);
    expect(out.some((l) => l.includes("NOT updated"))).toBe(true);
  });

  it("records a successful swap in the state file even when another entry for the same slug fails", async () => {
    const world = standardWorld();
    const client = world.client((c) => (c.method === "post" && c.path === "200" ? metaApiError(613, "budget changed too often") : null));
    const briefBefore = briefText("shop");
    const { code, envelope, logs: out } = await run(
      [
        writePlan({ budgets: [{ level: "adset", id: "200", dailyBudget: 60 }], textPools: [{ adId: "300", headlines: ["h1"] }] }),
        "--apply",
      ],
      client,
    );
    expect(code).toBe(1);
    expect(posts(client).map((c) => c.path)).toContain("act_111/adcreatives");
    // State mirrors what is live: the new creative is recorded ...
    const shopAd = ((readState("shop")["adSets"] as Obj[])[0]!["ads"] as Obj[])[0]!;
    expect(shopAd).toEqual({ name: "ad-1", creativeId: "777", adId: "300" });
    // ... while the brief (intent) stays gated on the failure.
    expect(briefText("shop")).toBe(briefBefore);
    expect(envelope).toMatchObject({ ok: false, errors: [{ step: "budget", entityId: "200", slugs: ["shop"] }] });
    expect(out.some((l) => l.includes("local brief(s) / .meta-state.yaml and the live account have diverged"))).toBe(true);
    expect(out.some((l) => l.includes("shop.yaml NOT updated"))).toBe(true);
  });

  it.skipIf(process.getuid?.() === 0)("reports a failed state write as write-state with a warning, without a NOT updated brief", async () => {
    const world = standardWorld();
    const client = world.client();
    const dir = join(cwd, "adbriefs");
    // A read-only directory blocks the state file's temp-file + rename; the brief is rewritten in place.
    chmodSync(dir, 0o555);
    try {
      const { code, envelope, logs: out } = await run(
        [writePlan({ textPools: [{ adId: "300", headlines: ["h1"] }] }), "--apply"],
        client,
      );
      expect(code).toBe(1);
      expect(envelope).toMatchObject({ ok: false, errors: [{ step: "write-state", entityId: "shop", slugs: ["shop"] }] });
      expect(envelope["briefs"]).toEqual([expect.objectContaining({ slug: "shop", briefSynced: true })]);
      expect(out.some((l) => l.startsWith("WARNING: could not record swapped creative id(s) in adbriefs/shop.meta-state.yaml"))).toBe(
        true,
      );
      expect(out.some((l) => l.includes("NOT updated"))).toBe(false);
    } finally {
      chmodSync(dir, 0o755);
    }
  });

  it("lists enabled paused campaigns and ad sets under enableStartsLiveSpend; pausing does not", async () => {
    const world = makeWorld({
      "100": { ...campaignObj("100", "Shop"), status: "PAUSED", effective_status: "PAUSED" },
      "200": adSetObj("200", "100", { status: "PAUSED", effective_status: "PAUSED" }),
      "110": campaignObj("110", "Other"),
    });
    const { code, envelope, logs: out } = await run(
      [
        writePlan({
          status: [
            { level: "campaign", id: "100", status: "ACTIVE" },
            { level: "adset", id: "200", status: "ACTIVE" },
            { level: "campaign", id: "110", status: "PAUSED" },
          ],
        }),
      ],
      world.client(),
    );
    expect(code).toBe(0);
    expect(envelope).toMatchObject({ enableStartsLiveSpend: ["100", "200"] });
    const warnings = out.filter((l) => l.startsWith("WARNING: "));
    expect(warnings).toEqual(
      expect.arrayContaining(["WARNING: enabling campaign 100 starts live spend", "WARNING: enabling ad set 200 starts live spend"]),
    );
    expect(warnings.some((l) => l.includes("110"))).toBe(false);
  });

  it("posts a campaign-level (CBO) budget change in minor units to the campaign id", async () => {
    const world = makeWorld({
      "100": { ...campaignObj("100", "Shop"), daily_budget: "10000" },
      "200": (({ daily_budget: _d, ...rest }) => rest)(adSetObj("200", "100")),
    });
    const client = world.client();
    const { code } = await run([writePlan({ budgets: [{ level: "campaign", id: "100", dailyBudget: 120.5 }] }), "--apply"], client);
    expect(code).toBe(0);
    expect(posts(client)).toEqual([expect.objectContaining({ path: "100", body: { daily_budget: 12050 } })]);
    expect(world.obj("100")?.["daily_budget"]).toBe("12050");
  });

  it("applies an exclusion removal and an enhancements change through --apply", async () => {
    const world = standardWorld();
    const client = world.client();
    const { code, envelope } = await run(
      [
        writePlan({
          exclusions: [{ adSetId: "200", remove: ["900"] }],
          enhancements: [{ adId: "300", features: { enhance_cta: "OPT_IN" } }],
        }),
        "--apply",
      ],
      client,
    );
    expect(code).toBe(0);
    expect(envelope).toMatchObject({ ok: true, errors: [] });
    const writes = posts(client);
    expect(writes.map((c) => c.path)).toEqual(["200", "act_111/adcreatives", "300"]);
    expect(writes[0]).toMatchObject({ body: { targeting: { geo_locations: { countries: ["US"] } } } });
    expect(writes[0]?.method === "post" && "excluded_custom_audiences" in (writes[0].body["targeting"] as Obj)).toBe(false);
    expect(writes[1]).toMatchObject({
      body: { degrees_of_freedom_spec: { creative_features_spec: { enhance_cta: { enroll_status: "OPT_IN" } } } },
    });
    expect(writes[2]).toMatchObject({ body: { creative: { creative_id: "777" } } });
    const set = (readBrief("shop")["adSets"] as Obj[])[0]!;
    expect((set["audience"] as Obj)["excludedCustomAudienceIds"] ?? []).toEqual([]);
    expect(((set["ads"] as Obj[])[0]!)["enhancements"]).toEqual({ enhance_cta: "OPT_IN" });
    const shopAd = ((readState("shop")["adSets"] as Obj[])[0]!["ads"] as Obj[])[0]!;
    expect(shopAd["creativeId"]).toBe("777");
  });

  it("refuses an --ad-account that conflicts with the plan's adAccountId before any read", async () => {
    const resolveContext = vi.fn(async () => CTX);
    const client = standardWorld().client();
    const conflict = await run([writePlan({ adAccountId: "act_111" }), "--ad-account", "act_222"], client, { resolveContext });
    expect(conflict.code).toBe(2);
    expect(conflict.envelope).toMatchObject({ ok: false, step: "args" });
    expect(resolveContext).not.toHaveBeenCalled();
    expect(client.calls).toEqual([]);

    const same = await run([writePlan({ adAccountId: "act_111" }), "--ad-account", "111"], standardWorld().client(), {
      resolveContext,
    });
    expect(same.code).toBe(0);
  });

  it("VALIDATION FAILED on a budget raise above 50%, with zero writes", async () => {
    const world = standardWorld();
    const client = world.client();
    const { code, envelope, logs: out } = await run(
      [writePlan({ budgets: [{ level: "adset", id: "200", dailyBudget: 80 }] }), "--apply"],
      client,
    );
    expect(code).toBe(1);
    expect(out[0]).toBe("VALIDATION FAILED:");
    expect(out.some((l) => l.includes("exceeds guardrail"))).toBe(true);
    expect(envelope).toMatchObject({ ok: false, step: "validate" });
    expect(posts(client)).toEqual([]);
  });

  it("reports ids with no state record as unresolved, not fatal", async () => {
    const world = makeWorld({ "999": { ...campaignObj("999", "Unmanaged"), daily_budget: "1000" } });
    const { code, envelope, logs: out } = await run(
      [writePlan({ budgets: [{ level: "campaign", id: "999", dailyBudget: 11 }] })],
      world.client(),
    );
    expect(code).toBe(0);
    expect(envelope).toMatchObject({ budgetChanges: [{ id: "999" }], unresolvedPlanIds: ["999"], briefs: [] });
    expect(out.some((l) => l.includes("no record in any adbriefs/*.meta-state.yaml"))).toBe(true);
  });

  it("uses the plan's adAccountId for context resolution and refuses a bad plan with exit 2", async () => {
    const resolveContext = vi.fn(async () => CTX);
    const world = standardWorld();
    const ok = await run([writePlan({ adAccountId: "act_111" })], world.client(), { resolveContext });
    expect(ok.code).toBe(0);
    expect(resolveContext).toHaveBeenCalledWith({ adAccount: "act_111" });

    const bad = await run([writePlan({ bogus: true })], world.client());
    expect(bad.code).toBe(2);
    expect(bad.envelope).toMatchObject({ ok: false, step: "plan" });
    expect(existsSync(join(cwd, "adbriefs", "shop.yaml"))).toBe(true);
  });
});
