import { describe, expect, it } from "vitest";

import { parseMetaBrief, type MetaBrief } from "./brief.js";
import type { Params } from "./client.js";
import { fakeMetaClient, metaApiError, type FakeCall } from "./fake-client.js";
import { ImageHashSchema, MetaAdAccountIdSchema, MetaAdSetIdSchema, MetaCampaignIdSchema, MetaCreativeIdSchema, MetaPageIdSchema, MetaVideoIdSchema } from "./ids.js";
import {
  adParams,
  adSetParams,
  campaignParams,
  creativeParams,
  planPublish,
  publishMeta,
  type LocalMedia,
  type PublishContext,
} from "./publish.js";
import { emptyMetaState, type MetaState } from "./state.js";

const account = MetaAdAccountIdSchema.parse("act_111");
const ctx: PublishContext = { adAccountId: account, pageId: MetaPageIdSchema.parse("999"), currency: "USD" };

const ad = (name: string, image = "./hero.png") => ({
  name,
  link: "https://example.com/lp",
  callToAction: "LEARN_MORE",
  primaryTexts: ["Body one", "Body two"],
  headlines: ["Headline"],
  media: { image },
  enhancements: { enhance_cta: "OPT_OUT", text_optimizations: "OPT_IN" },
});

const rawBrief = (budget: Record<string, unknown>, adSetBudget: Record<string, unknown> = {}) => ({
  type: "meta",
  name: "widget-launch",
  campaign: { name: "Widget Launch", objective: "OUTCOME_LEADS", budget, startTime: "2026-10-01T00:00:00Z" },
  adSets: [
    {
      name: "Set A",
      ...adSetBudget,
      optimizationGoal: "OFFSITE_CONVERSIONS",
      conversion: { pixelId: "777", event: "LEAD" },
      audience: { countries: ["US"], ageMin: 25, genders: ["female"], interests: [{ id: "6003", name: "Yoga" }], advantageAudience: true },
      placements: { publisherPlatforms: ["facebook", "instagram"], facebookPositions: ["feed"] },
      ads: [ad("Ad 1"), ad("Ad 2", "./copy-of-hero.png")],
    },
    {
      name: "Set B",
      ...adSetBudget,
      optimizationGoal: "LINK_CLICKS",
      audience: { countries: ["CA"] },
      ads: [ad("Ad 3")],
    },
  ],
});

const parse = (data: unknown): MetaBrief => {
  const r = parseMetaBrief(data, { fileExists: () => true });
  if (r.kind === "err") throw new Error(r.message);
  return r.value;
};

const cboBrief = parse(rawBrief({ mode: "campaign", dailyBudget: 100, bidStrategy: "LOWEST_COST_WITHOUT_CAP" }));
const aboBrief = parse(rawBrief({ mode: "adset", bidStrategy: "COST_CAP" }, { dailyBudget: 50, bidAmount: 12.5 }));

/** Both hero files share bytes, so they share a sha256 and upload once. */
const readMedia = (path: string): LocalMedia => ({ name: path.replace("./", ""), bytes: new Uint8Array([1]), sha256: "same-sha" });

const recorder = () => {
  const saved: MetaState[] = [];
  return { saved, deps: { readMedia, saveState: (s: MetaState) => void saved.push(s) } };
};

const posts = (calls: readonly FakeCall[]) =>
  calls.flatMap((c) => (c.method === "post" ? [{ path: c.path, step: c.step, body: c.body }] : []));

describe("builders", () => {
  it("puts the budget on the campaign under CBO and on ad sets under ABO", () => {
    const campaignId = MetaCampaignIdSchema.parse("1");
    expect(campaignParams(cboBrief, "USD")).toEqual({
      name: "Widget Launch",
      objective: "OUTCOME_LEADS",
      status: "PAUSED",
      special_ad_categories: [],
      buying_type: "AUCTION",
      daily_budget: 10000,
      bid_strategy: "LOWEST_COST_WITHOUT_CAP",
    });
    expect(adSetParams(cboBrief, cboBrief.adSets[0]!, campaignId, "USD")).not.toHaveProperty("daily_budget");

    const abo = campaignParams(aboBrief, "USD");
    expect(abo).not.toHaveProperty("daily_budget");
    expect(abo).toMatchObject({ is_adset_budget_sharing_enabled: false });
    expect(adSetParams(aboBrief, aboBrief.adSets[0]!, campaignId, "USD")).toMatchObject({
      daily_budget: 5000,
      bid_amount: 1250,
      bid_strategy: "COST_CAP",
    });
  });

  it("applies the currency offset (zero-decimal JPY)", () => {
    const campaignId = MetaCampaignIdSchema.parse("1");
    expect(campaignParams(cboBrief, "JPY")).toMatchObject({ daily_budget: 100 });
    expect(adSetParams(aboBrief, aboBrief.adSets[0]!, campaignId, "JPY")).toMatchObject({ daily_budget: 50, bid_amount: 13 });
  });

  it("builds a JSON-ready ad set with targeting, automation and promoted object", () => {
    expect(adSetParams(cboBrief, cboBrief.adSets[0]!, MetaCampaignIdSchema.parse("1"), "USD")).toEqual({
      campaign_id: "1",
      name: "Set A",
      status: "PAUSED",
      optimization_goal: "OFFSITE_CONVERSIONS",
      billing_event: "IMPRESSIONS",
      destination_type: "WEBSITE",
      promoted_object: { pixel_id: "777", custom_event_type: "LEAD" },
      start_time: "2026-10-01T00:00:00Z",
      targeting: {
        geo_locations: { countries: ["US"] },
        age_min: 25,
        age_max: 65,
        genders: [2],
        flexible_spec: [{ interests: [{ id: "6003", name: "Yoga" }] }],
        publisher_platforms: ["facebook", "instagram"],
        facebook_positions: ["feed"],
        targeting_automation: { advantage_audience: 1 },
      },
    });
  });

  it("builds a flexible creative with enhancements, and a paused ad", () => {
    const a = cboBrief.adSets[0]!.ads[0]!;
    const image = creativeParams(cboBrief, a, ctx.pageId, { kind: "image", hash: ImageHashSchema.parse("h1") });
    expect(image).toEqual({
      name: "Widget Launch / Ad 1",
      object_story_spec: { page_id: "999" },
      asset_feed_spec: {
        bodies: [{ text: "Body one" }, { text: "Body two" }],
        titles: [{ text: "Headline" }],
        link_urls: [{ website_url: "https://example.com/lp" }],
        call_to_action_types: ["LEARN_MORE"],
        images: [{ hash: "h1" }],
        ad_formats: ["SINGLE_IMAGE"],
        optimization_type: "DEGREES_OF_FREEDOM",
      },
      degrees_of_freedom_spec: {
        creative_features_spec: { enhance_cta: { enroll_status: "OPT_OUT" }, text_optimizations: { enroll_status: "OPT_IN" } },
      },
    });
    const video = creativeParams(cboBrief, { ...a, enhancements: {} }, ctx.pageId, {
      kind: "video",
      videoId: MetaVideoIdSchema.parse("55"),
      thumbnailHash: ImageHashSchema.parse("t1"),
    });
    expect(video).not.toHaveProperty("degrees_of_freedom_spec");
    expect(video.asset_feed_spec).toMatchObject({ videos: [{ video_id: "55", thumbnail_hash: "t1" }], ad_formats: ["SINGLE_VIDEO"] });
    expect(adParams(a, MetaAdSetIdSchema.parse("2"), MetaCreativeIdSchema.parse("3"))).toEqual({
      name: "Ad 1",
      adset_id: "2",
      creative: { creative_id: "3" },
      status: "PAUSED",
    });
  });
});

describe("planPublish", () => {
  it("lists every object in publish order, skipping ids already in state", () => {
    const empty = emptyMetaState(cboBrief, account);
    const plan = planPublish(cboBrief, empty);
    expect(plan.map((p) => `${p.step}:${p.name}:${p.action}`)).toEqual([
      "upload-media:./hero.png:create",
      "upload-media:./copy-of-hero.png:create",
      "create-campaign:Widget Launch:create",
      "create-ad-set:Set A:create",
      "create-creative:Ad 1:create",
      "create-ad:Ad 1:create",
      "create-creative:Ad 2:create",
      "create-ad:Ad 2:create",
      "create-ad-set:Set B:create",
      "create-creative:Ad 3:create",
      "create-ad:Ad 3:create",
    ]);
    const partial: MetaState = { ...empty, campaign: { ...empty.campaign, campaignId: MetaCampaignIdSchema.parse("10") } };
    expect(planPublish(cboBrief, partial).find((p) => p.step === "create-campaign")).toMatchObject({ action: "skip", existingId: "10" });
  });
});

describe("publishMeta", () => {
  it("creates everything PAUSED in order, saving state after each step and reusing media by sha256", async () => {
    const client = fakeMetaClient({ get: () => [] });
    const { saved, deps } = recorder();
    const result = await publishMeta(client, ctx, cboBrief, emptyMetaState(cboBrief, account), deps);

    expect(result.failure).toBeNull();
    expect(client.calls.filter((c) => c.method === "uploadImage")).toHaveLength(1);
    const ps = posts(client.calls);
    expect(ps.map((p) => `${p.step} ${p.path}`)).toEqual([
      "create-campaign act_111/campaigns",
      "create-ad-set act_111/adsets",
      "create-creative act_111/adcreatives",
      "create-ad act_111/ads",
      "create-creative act_111/adcreatives",
      "create-ad act_111/ads",
      "create-ad-set act_111/adsets",
      "create-creative act_111/adcreatives",
      "create-ad act_111/ads",
    ]);
    ps.filter((p) => p.step !== "create-creative").forEach((p) => expect(p.body.status).toBe("PAUSED"));
    // 2 media + campaign + 2 ad sets + 3 creatives + 3 ads
    expect(saved).toHaveLength(11);
    expect(result.state).toEqual(saved.at(-1));
    expect(result.state.media).toEqual({
      "./hero.png": { sha256: "same-sha", imageHash: "hash_hero.png" },
      "./copy-of-hero.png": { sha256: "same-sha", imageHash: "hash_hero.png" },
    });
    expect(result.state.adSets.flatMap((s) => s.ads).every((a) => a.adId !== null && a.creativeId !== null)).toBe(true);
    const lookup = client.calls.find((c) => c.method === "getAll" && c.path === "act_111/campaigns");
    expect(lookup).toMatchObject({ step: "find-existing" });
    expect((lookup as { params: Params }).params.filtering).toEqual([
      { field: "name", operator: "EQUAL", value: "Widget Launch" },
    ]);
  });

  it("stops at a failing ad set, returns the last saved state, and a re-run creates only the missing objects", async () => {
    const failing = fakeMetaClient({
      get: () => [],
      failOn: (c) => (c.method === "post" && c.step === "create-ad-set" && c.body.name === "Set B" ? metaApiError(100, "Invalid parameter") : null),
    });
    const first = recorder();
    const r1 = await publishMeta(failing, ctx, cboBrief, emptyMetaState(cboBrief, account), first.deps);

    expect(r1.failure).toEqual({ step: "create-ad-set", message: "Invalid parameter", code: 100 });
    expect(r1.state).toEqual(first.saved.at(-1));
    expect(r1.state.adSets[0]!.adSetId).not.toBeNull();
    expect(r1.state.adSets[1]).toEqual({ name: "Set B", adSetId: null, ads: [{ name: "Ad 3", creativeId: null, adId: null }] });

    const retry = fakeMetaClient({ get: () => [], firstId: 50001 });
    const second = recorder();
    const r2 = await publishMeta(retry, ctx, cboBrief, r1.state, second.deps);

    expect(r2.failure).toBeNull();
    expect(retry.calls.some((c) => c.method === "uploadImage")).toBe(false);
    expect(posts(retry.calls).map((p) => `${p.step}:${String(p.body.name)}`)).toEqual([
      "create-ad-set:Set B",
      "create-creative:Widget Launch / Ad 3",
      "create-ad:Ad 3",
    ]);
    expect(r2.state.adSets[0]).toEqual(r1.state.adSets[0]);
    expect(second.saved).toHaveLength(3);
  });

  it("adopts objects created by a run whose state write failed, by exact name under the parent", async () => {
    const base = emptyMetaState(cboBrief, account);
    const state: MetaState = {
      ...base,
      media: { "./hero.png": { sha256: "same-sha", imageHash: ImageHashSchema.parse("h") }, "./copy-of-hero.png": { sha256: "same-sha", imageHash: ImageHashSchema.parse("h") } },
      campaign: { ...base.campaign, campaignId: MetaCampaignIdSchema.parse("10") },
    };
    const client = fakeMetaClient({
      get: (path) =>
        path === "10/adsets"
          ? [
              { id: "20", name: "Set A", effective_status: "PAUSED" },
              { id: "21", name: "Set A", effective_status: "DELETED" },
              { id: "22", name: "Set A copy", effective_status: "PAUSED" },
            ]
          : path === "20/ads"
            ? [{ id: "40", name: "Ad 1", effective_status: "PAUSED", creative: { id: "30" } }]
            : [],
    });
    const { deps } = recorder();
    const result = await publishMeta(client, ctx, cboBrief, state, deps);

    expect(result.failure).toBeNull();
    expect(result.state.adSets[0]!.adSetId).toBe("20");
    expect(result.state.adSets[0]!.ads[0]).toEqual({ name: "Ad 1", creativeId: "30", adId: "40" });
    const ps = posts(client.calls).map((p) => `${p.step}:${String(p.body.name)}`);
    expect(ps).not.toContain("create-ad-set:Set A");
    expect(ps).not.toContain("create-ad:Ad 1");
    expect(ps).toContain("create-ad:Ad 2");
  });

  it("fails at find-existing when more than one live object has the name", async () => {
    const client = fakeMetaClient({
      get: (path) =>
        path === "act_111/campaigns"
          ? [
              { id: "1", name: "Widget Launch", effective_status: "ACTIVE" },
              { id: "2", name: "Widget Launch", effective_status: "PAUSED" },
            ]
          : [],
    });
    const { saved, deps } = recorder();
    const result = await publishMeta(client, ctx, cboBrief, emptyMetaState(cboBrief, account), deps);

    expect(result.failure?.step).toBe("find-existing");
    expect(result.failure?.message).toContain("ids 1, 2");
    expect(posts(client.calls)).toEqual([]);
    expect(result.state).toEqual(saved.at(-1));
    expect(result.state.campaign.campaignId).toBeNull();
  });

  it("reports a state save failure and returns the previously saved state", async () => {
    const client = fakeMetaClient({ get: () => [] });
    const result = await publishMeta(client, ctx, cboBrief, emptyMetaState(cboBrief, account), {
      readMedia,
      saveState: () => {
        throw new Error("disk full");
      },
    });
    expect(result.failure).toEqual({ step: "save-state", message: "disk full" });
    expect(result.state.media).toEqual({});
  });

  it("refuses a state recorded for another ad account", async () => {
    const client = fakeMetaClient();
    const other = emptyMetaState(cboBrief, MetaAdAccountIdSchema.parse("act_222"));
    const result = await publishMeta(client, ctx, cboBrief, other, recorder().deps);
    expect(result.failure?.step).toBe("state");
    expect(client.calls).toEqual([]);
  });
});
