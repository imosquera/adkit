/** Unit tests for applying a Meta update plan: live reads, appliers, the apply fold and brief staging. */
import { describe, expect, it } from "vitest";

import {
  AD_FIELDS,
  AD_SET_FIELDS,
  applyMetaPlanToBrief,
  buildSwapCreativeParams,
  mergeExclusions,
  planMetaApplySteps,
  readLiveState,
  resolveMetaPlanGroups,
  runMetaApply,
  swapCreativeName,
  type MetaApplyContext,
} from "./apply.js";
import { parseMetaBrief, type MetaBrief } from "./brief.js";
import { fakeMetaClient, metaApiError, type FakeCall } from "./fake-client.js";
import { AdSchema, AdSetSchema, CampaignSchema, type AdSet, type Campaign } from "./graph.js";
import { MetaAdAccountIdSchema } from "./ids.js";
import { parseMetaPlan, type MetaLiveAd, type MetaLiveState, type MetaPlan } from "./plan.js";
import type { MetaStateIndex, MetaStateLocator } from "./state.js";

// ---------- Fixtures ----------

const account = MetaAdAccountIdSchema.parse("act_111");
const now = new Date("2026-09-13T10:00:00Z");

const rawCampaign = { id: "100", name: "C", objective: "OUTCOME_SALES", effective_status: "ACTIVE", status: "ACTIVE" };
const rawAdSet = {
  id: "200",
  name: "S",
  campaign_id: "100",
  effective_status: "ACTIVE",
  status: "ACTIVE",
  optimization_goal: "OFFSITE_CONVERSIONS",
  daily_budget: "5000",
  targeting: { geo_locations: { countries: ["US"] }, age_min: 25, excluded_custom_audiences: [{ id: "900", name: "Buyers" }] },
};
const rawAd = {
  id: "300",
  name: "A",
  adset_id: "200",
  effective_status: "PAUSED",
  status: "PAUSED",
  creative: {
    id: "400",
    name: "Creative A",
    object_story_spec: { page_id: "55" },
    asset_feed_spec: {
      bodies: [{ text: "b1" }],
      titles: [{ text: "t1" }],
      descriptions: [{ text: "d1" }],
      images: [{ hash: "abc" }],
      optimization_type: "DEGREES_OF_FREEDOM",
    },
    degrees_of_freedom_spec: {
      creative_features_spec: { enhance_cta: { enroll_status: "OPT_OUT" }, image_touchups: { enroll_status: "OPT_IN" } },
    },
  },
};

const campaign: Campaign = CampaignSchema.parse(rawCampaign);
const adSet: AdSet = AdSetSchema.parse(rawAdSet);
const ad: MetaLiveAd = AdSchema.parse(rawAd);

const live: MetaLiveState = {
  campaigns: new Map([[campaign.id, campaign]]),
  adSets: new Map([[adSet.id, adSet]]),
  ads: new Map([[ad.id, ad]]),
  currency: "USD",
};

const ctx: MetaApplyContext = { adAccountId: account, live, now };

const plan = (raw: Record<string, unknown>): MetaPlan => {
  const r = parseMetaPlan({ platform: "meta", ...raw });
  if (r.kind !== "ok") throw new Error(r.message);
  return r.value;
};

const posts = (calls: readonly FakeCall[]) =>
  calls.flatMap((c) => (c.method === "post" ? [{ path: c.path, body: c.body, step: c.step }] : []));

const writer = () => fakeMetaClient({ post: (path) => (path.endsWith("/adcreatives") ? { id: "777" } : { success: true }) });

// ---------- readLiveState ----------

describe("readLiveState", () => {
  it("multi-gets referenced ads, their ad sets, campaigns, CBO child ad sets and the currency", async () => {
    const client = fakeMetaClient({
      get: (path, params) => {
        if (path === "act_111") return { currency: "JPY" };
        if (path === "100/adsets") return [{ ...rawAdSet, id: "201" }];
        const ids = String(params.ids).split(",");
        const pool: Record<string, unknown> = { "100": rawCampaign, "200": rawAdSet, "300": rawAd };
        return Object.fromEntries(ids.map((id) => [id, pool[id]]));
      },
    });
    const state = await readLiveState(
      client,
      plan({ budgets: [{ level: "campaign", id: "100", dailyBudget: 80 }], textPools: [{ adId: "300", headlines: ["h"] }] }),
      account,
    );
    expect(state.currency).toBe("JPY");
    expect([...state.campaigns.keys()]).toEqual(["100"]);
    expect([...state.adSets.keys()].sort()).toEqual(["200", "201"]);
    expect(state.ads.get("300")?.creative?.asset_feed_spec?.titles).toEqual([{ text: "t1" }]);
    const gets = client.calls.filter((c) => c.method === "get" && c.path === "");
    expect(gets.map((c) => c.method === "get" && c.params.fields)).toEqual(
      expect.arrayContaining([AD_FIELDS, AD_SET_FIELDS]),
    );
    expect(AD_SET_FIELDS).toContain("campaign{id,advantage_state_info}");
    expect(AD_SET_FIELDS).toContain("learning_stage_info");
    expect(client.calls.every((c) => c.method !== "post")).toBe(true);
  });

  it("leaves unknown ids out by retrying a failed multi-get one id at a time", async () => {
    const client = fakeMetaClient({
      get: (path, params) =>
        path === "act_111"
          ? { currency: "USD" }
          : Object.fromEntries(String(params.ids).split(",").map((id) => [id, id === "200" ? rawAdSet : rawAd])),
      failOn: (c) =>
        c.method === "get" && c.path === "" && String(c.params.ids).includes("999") ? metaApiError(100, "does not exist") : null,
    });
    const state = await readLiveState(
      client,
      plan({ status: [{ level: "ad", id: "300", status: "ACTIVE" }, { level: "ad", id: "999", status: "ACTIVE" }] }),
      account,
    );
    expect([...state.ads.keys()]).toEqual(["300"]);
  });

  it("rethrows other read failures", async () => {
    const client = fakeMetaClient({ get: () => ({ currency: "USD" }), failOn: (c) => (c.path === "" ? metaApiError(190, "bad token") : null) });
    await expect(readLiveState(client, plan({ status: [{ level: "ad", id: "300", status: "ACTIVE" }] }), account)).rejects.toThrow(
      "bad token",
    );
  });

  it("makes only the currency read for an empty plan", async () => {
    const client = fakeMetaClient({ get: () => ({ currency: "USD" }) });
    await readLiveState(client, plan({}), account);
    expect(client.calls.map((c) => c.path)).toEqual(["act_111"]);
  });
});

// ---------- Pure helpers ----------

describe("buildSwapCreativeParams", () => {
  it("replaces given text pools, keeps the rest and merges enroll statuses", () => {
    const r = buildSwapCreativeParams(
      ad,
      { features: { enhance_cta: "OPT_IN" }, textPools: { primaryTexts: ["n1", "n2"] } },
      now,
    );
    if (r.kind !== "ok") throw new Error(r.message);
    expect(r.value.name).toBe("Creative A (adkit 2026-09-13)");
    expect(r.value.object_story_spec).toEqual({ page_id: "55" });
    expect(r.value.asset_feed_spec).toEqual({ ...rawAd.creative.asset_feed_spec, bodies: [{ text: "n1" }, { text: "n2" }] });
    expect(r.value.degrees_of_freedom_spec?.creative_features_spec).toEqual({
      enhance_cta: { enroll_status: "OPT_IN" },
      image_touchups: { enroll_status: "OPT_IN" },
    });
  });

  it("rejects text pools on a creative without asset_feed_spec", () => {
    const plain = { ...ad, creative: { id: ad.creative!.id, object_story_spec: ad.creative!.object_story_spec } };
    expect(buildSwapCreativeParams(plain, { textPools: { headlines: ["h"] } }, now).kind).toBe("err");
    expect(buildSwapCreativeParams(plain, { features: { enhance_cta: "OPT_IN" } }, now).kind).toBe("ok");
  });

  it("does not stack adkit name suffixes", () => {
    expect(swapCreativeName("X (adkit 2026-01-01)", now)).toBe("X (adkit 2026-09-13)");
  });
});

describe("mergeExclusions", () => {
  it("removes, then appends new ids without duplicates", () => {
    const p = plan({ exclusions: [{ adSetId: "200", add: ["901", "900"], remove: ["902"] }] });
    expect(mergeExclusions([{ id: "902" }, { id: "900" }], p.exclusions[0]!)).toEqual(["900", "901"]);
  });
});

describe("planMetaApplySteps", () => {
  it("orders pause → budget → exclusions → one swap per ad → enable", () => {
    const p = plan({
      status: [{ level: "campaign", id: "100", status: "ACTIVE" }, { level: "ad", id: "300", status: "PAUSED" }],
      budgets: [{ level: "adset", id: "200", dailyBudget: 60 }],
      exclusions: [{ adSetId: "200", add: ["901"] }],
      enhancements: [{ adId: "300", features: { enhance_cta: "OPT_IN" } }],
      textPools: [{ adId: "300", headlines: ["h"] }],
    });
    expect(planMetaApplySteps(p).map((s) => s.kind)).toEqual([
      "pause-status",
      "budget",
      "exclusions",
      "creative-swap",
      "enable-status",
    ]);
  });
});

// ---------- runMetaApply ----------

describe("runMetaApply", () => {
  it("posts every write with the right bodies, in order", async () => {
    const client = writer();
    const p = plan({
      status: [{ level: "campaign", id: "100", status: "ACTIVE" }],
      budgets: [{ level: "adset", id: "200", dailyBudget: 60.5 }],
      exclusions: [{ adSetId: "200", add: ["901"], remove: ["900"] }],
      enhancements: [{ adId: "300", features: { enhance_cta: "OPT_IN" } }],
      textPools: [{ adId: "300", headlines: ["h1", "h2"] }],
    });
    const result = await runMetaApply(client, ctx, p);
    expect(result.errors).toEqual([]);
    expect(result.applied).toEqual([
      { section: "budgets", entityId: "200" },
      { section: "exclusions", entityId: "200" },
      { section: "enhancements", entityId: "300" },
      { section: "textPools", entityId: "300" },
      { section: "status", entityId: "100" },
    ]);
    const writes = posts(client.calls);
    expect(writes.map((w) => w.path)).toEqual(["200", "200", "act_111/adcreatives", "300", "100"]);
    expect(writes[0]?.body).toEqual({ daily_budget: 6050 });
    expect(writes[1]?.body).toEqual({
      targeting: { geo_locations: { countries: ["US"] }, age_min: 25, excluded_custom_audiences: [{ id: "901" }] },
    });
    expect(writes[2]?.body).toMatchObject({
      name: "Creative A (adkit 2026-09-13)",
      asset_feed_spec: { titles: [{ text: "h1" }, { text: "h2" }], bodies: [{ text: "b1" }] },
      degrees_of_freedom_spec: { creative_features_spec: { enhance_cta: { enroll_status: "OPT_IN" } } },
    });
    expect(writes[3]?.body).toEqual({ creative: { creative_id: "777" } });
    expect(writes[4]?.body).toEqual({ status: "ACTIVE" });
  });

  it("drops excluded_custom_audiences when the merged list is empty", async () => {
    const client = writer();
    await runMetaApply(client, ctx, plan({ exclusions: [{ adSetId: "200", remove: ["900"] }] }));
    expect(posts(client.calls)[0]?.body).toEqual({ targeting: { geo_locations: { countries: ["US"] }, age_min: 25 } });
  });

  it("records a failing entry and continues with the rest", async () => {
    const client = fakeMetaClient({
      post: (path) => (path.endsWith("/adcreatives") ? { id: "777" } : { success: true }),
      failOn: (c) => (c.method === "post" && c.path === "200" ? metaApiError(613, "budget changed too often", 1487632) : null),
    });
    const result = await runMetaApply(
      client,
      ctx,
      plan({
        budgets: [{ level: "adset", id: "200", dailyBudget: 60 }],
        status: [{ level: "ad", id: "300", status: "ACTIVE" }],
        enhancements: [{ adId: "404", features: { enhance_cta: "OPT_IN" } }],
      }),
    );
    expect(result.applied).toEqual([{ section: "status", entityId: "300" }]);
    expect(result.errors).toEqual([
      { step: "budget", entityId: "200", message: expect.stringContaining("budget changed too often") },
      { step: "creative-swap", entityId: "404", message: expect.stringContaining("not found in live state") },
    ]);
  });

  it("does not repoint the ad when creating the new creative fails", async () => {
    const client = fakeMetaClient({ failOn: (c) => (c.path.endsWith("/adcreatives") ? metaApiError(100, "invalid spec") : null) });
    const result = await runMetaApply(client, ctx, plan({ textPools: [{ adId: "300", headlines: ["h"] }] }));
    expect(result.errors).toHaveLength(1);
    expect(posts(client.calls).map((w) => w.path)).toEqual(["act_111/adcreatives"]);
  });
});

// ---------- Staging onto briefs ----------

const loc = (over: Partial<MetaStateLocator> = {}): MetaStateLocator => ({ slug: "shop", campaignName: "Shop", ...over });

const index: MetaStateIndex = {
  byCampaignId: new Map([["100", loc()]]),
  byAdSetId: new Map([["200", loc({ adSetName: "set-1" })]]),
  byAdId: new Map([["300", loc({ adSetName: "set-1", adName: "ad-1" })]]),
};

const briefOf = (budget: Record<string, unknown>, adSetBudget?: number): MetaBrief => {
  const r = parseMetaBrief(
    {
      type: "meta",
      name: "shop",
      campaign: { name: "Shop", objective: "OUTCOME_TRAFFIC", budget },
      adSets: [
        {
          name: "set-1",
          ...(adSetBudget === undefined ? {} : { dailyBudget: adSetBudget }),
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
              media: { image: "a.png" },
              enhancements: { image_touchups: "OPT_OUT" },
            },
          ],
        },
      ],
    },
    { fileExists: () => true },
  );
  if (r.kind !== "ok") throw new Error(r.message);
  return r.value;
};

describe("resolveMetaPlanGroups", () => {
  it("groups brief-relevant entries by slug and reports unresolved ids, ignoring status", () => {
    const p = plan({
      budgets: [{ level: "adset", id: "200", dailyBudget: 60 }, { level: "campaign", id: "555", dailyBudget: 10 }],
      status: [{ level: "ad", id: "888", status: "PAUSED" }],
      textPools: [{ adId: "300", headlines: ["x"] }],
    });
    const { groups, unresolvedPlanIds } = resolveMetaPlanGroups(p, index);
    expect(unresolvedPlanIds).toEqual(["555"]);
    expect(groups.map((g) => [g.slug, g.budgets.length, g.textPools.length, g.exclusions.length])).toEqual([["shop", 1, 1, 0]]);
  });
});

describe("applyMetaPlanToBrief", () => {
  it("writes ad set budget, exclusions, enhancements and text pools back by name", () => {
    const brief = briefOf({ mode: "adset", bidStrategy: "LOWEST_COST_WITHOUT_CAP" }, 50);
    const p = plan({
      budgets: [{ level: "adset", id: "200", dailyBudget: 60 }],
      status: [{ level: "campaign", id: "100", status: "ACTIVE" }],
      exclusions: [{ adSetId: "200", add: ["901"], remove: ["900"] }],
      enhancements: [{ adId: "300", features: { enhance_cta: "OPT_IN" } }],
      textPools: [{ adId: "300", headlines: ["h1", "h2"] }],
    });
    const [group] = resolveMetaPlanGroups(p, index).groups;
    const next = applyMetaPlanToBrief(brief, group!);
    const set = next.adSets[0]!;
    expect(set.dailyBudget).toBe(60);
    expect(set.audience.excludedCustomAudienceIds).toEqual(["901"]);
    expect(set.ads[0]?.enhancements).toEqual({ image_touchups: "OPT_OUT", enhance_cta: "OPT_IN" });
    expect(set.ads[0]?.headlines).toEqual(["h1", "h2"]);
    expect(set.ads[0]?.primaryTexts).toEqual(["p"]);
    expect(brief.adSets[0]?.dailyBudget).toBe(50); // input untouched
    expect(next.campaign).toEqual(brief.campaign); // status is not stored in briefs
  });

  it("writes a campaign (CBO) budget and ignores a budget level that contradicts the mode", () => {
    const brief = briefOf({ mode: "campaign", dailyBudget: 100, bidStrategy: "LOWEST_COST_WITHOUT_CAP" });
    const p = plan({ budgets: [{ level: "campaign", id: "100", dailyBudget: 120 }, { level: "adset", id: "200", dailyBudget: 5 }] });
    const next = applyMetaPlanToBrief(brief, resolveMetaPlanGroups(p, index).groups[0]!);
    expect(next.campaign.budget).toEqual({ mode: "campaign", dailyBudget: 120, bidStrategy: "LOWEST_COST_WITHOUT_CAP" });
    expect(next.adSets[0]?.dailyBudget).toBeUndefined();
  });
});
