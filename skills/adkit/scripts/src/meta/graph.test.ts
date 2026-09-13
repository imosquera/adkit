import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  AdAccountSchema,
  AdCreativeSchema,
  AdSchema,
  AdSetSchema,
  CampaignSchema,
  CreatedIdSchema,
  createdIdSchema,
  GraphErrorSchema,
  GraphNumberSchema,
  ImageUploadSchema,
  InsightsRowSchema,
  MeSchema,
  multiGetSchema,
  pageSchema,
  PermissionsSchema,
  SuccessSchema,
  VideoStatusSchema,
} from "./graph.js";
import { MetaCampaignIdSchema, type MetaCampaignId } from "./ids.js";

describe("GraphNumberSchema", () => {
  it.each([
    ["12.34", 12.34],
    ["0", 0],
    [" 7 ", 7],
    [3, 3],
  ])("coerces %j to %d", (raw, expected) => {
    expect(GraphNumberSchema.parse(raw)).toBe(expected);
  });

  it.each([[""], ["abc"], ["NaN"], [null], [undefined], [{}]])("rejects %j", (raw) => {
    expect(GraphNumberSchema.safeParse(raw).success).toBe(false);
  });
});

describe("GraphErrorSchema", () => {
  it("parses a full rate-limit error body", () => {
    const body = {
      error: {
        message: "(#17) User request limit reached",
        type: "OAuthException",
        code: 17,
        error_subcode: 2446079,
        is_transient: true,
        error_user_title: "Ad Account Has Too Many API Calls",
        error_user_msg: "There have been too many calls from this ad account.",
        fbtrace_id: "AbC123xyz",
      },
    };
    expect(GraphErrorSchema.parse(body)).toEqual(body);
  });

  it("accepts a minimal error and rejects a non-error body", () => {
    expect(GraphErrorSchema.parse({ error: { message: "Invalid OAuth access token.", code: 190 } }).error.code).toBe(190);
    expect(GraphErrorSchema.safeParse({ data: [] }).success).toBe(false);
  });
});

describe("pageSchema", () => {
  const Item = z.object({ id: z.string() });

  it("parses data with paging.next and without paging", () => {
    const withNext = {
      data: [{ id: "1" }],
      paging: { cursors: { before: "b", after: "a" }, next: "https://graph.facebook.com/v26.0/act_1/campaigns?after=a" },
    };
    expect(pageSchema(Item).parse(withNext).paging?.next).toContain("after=a");
    expect(pageSchema(Item).parse({ data: [] })).toEqual({ data: [] });
  });

  it("requires data and validates items", () => {
    expect(pageSchema(Item).safeParse({ paging: {} }).success).toBe(false);
    expect(pageSchema(Item).safeParse({ data: [{ nope: 1 }] }).success).toBe(false);
  });
});

describe("multiGetSchema", () => {
  it("parses an ids= response keyed by id", () => {
    const parsed = multiGetSchema(z.object({ id: MetaCampaignIdSchema })).parse({ "111": { id: "111" }, "222": { id: "222" } });
    expect(Object.keys(parsed)).toEqual(["111", "222"]);
  });
});

describe("write acknowledgements", () => {
  it("CreatedIdSchema parses { id } and strips extras", () => {
    expect(CreatedIdSchema.parse({ id: "120210000000001", success: true })).toEqual({ id: "120210000000001" });
    expect(CreatedIdSchema.safeParse({}).success).toBe(false);
    expect(CreatedIdSchema.safeParse({ id: "abc" }).success).toBe(false);
  });

  it("createdIdSchema brands the id", () => {
    const parsed = createdIdSchema(MetaCampaignIdSchema).parse({ id: 120210000000001 });
    const id: MetaCampaignId = parsed.id;
    expect(id).toBe("120210000000001");
  });

  it("SuccessSchema", () => {
    expect(SuccessSchema.parse({ success: true })).toEqual({ success: true });
  });
});

describe("identity & account", () => {
  it("MeSchema with and without name", () => {
    expect(MeSchema.parse({ id: "10160000000000001", name: "Ada Admin" })).toEqual({ id: "10160000000000001", name: "Ada Admin" });
    expect(MeSchema.parse({ id: "10160000000000001" }).name).toBeUndefined();
  });

  it("PermissionsSchema", () => {
    const body = {
      data: [
        { permission: "ads_read", status: "granted" },
        { permission: "ads_management", status: "declined" },
        { permission: "public_profile", status: "granted" },
      ],
    };
    expect(PermissionsSchema.parse(body).data.map((p) => p.permission)).toEqual(["ads_read", "ads_management", "public_profile"]);
    expect(PermissionsSchema.safeParse({ data: [{ permission: "ads_read", status: "maybe" }] }).success).toBe(false);
  });

  it("AdAccountSchema canonicalises the act_ id", () => {
    const parsed = AdAccountSchema.parse({
      id: "act_1234567890",
      account_id: "1234567890",
      name: "Acme Leads",
      account_status: 1,
      currency: "USD",
      timezone_name: "America/Los_Angeles",
      disable_reason: 0,
    });
    expect(parsed.id).toBe("act_1234567890");
    expect(AdAccountSchema.safeParse({ id: "act_1", name: "x", account_status: 1 }).success).toBe(false);
  });
});

describe("CampaignSchema", () => {
  it("parses a CBO campaign with budgets coerced from strings", () => {
    const parsed = CampaignSchema.parse({
      id: "120210000000001",
      name: "Leads — US",
      objective: "OUTCOME_LEADS",
      effective_status: "ACTIVE",
      daily_budget: "10000",
      bid_strategy: "LOWEST_COST_WITHOUT_CAP",
      special_ad_categories: [],
      advantage_state_info: {
        advantage_state: "DISABLED",
        advantage_budget_state: "ENABLED",
        advantage_audience_state: "DISABLED",
        advantage_placement_state: "ENABLED",
      },
    });
    expect(parsed.daily_budget).toBe(10000);
    expect(parsed.lifetime_budget).toBeUndefined();
    expect(parsed.advantage_state_info?.advantage_state).toBe("DISABLED");
  });

  it("rejects a campaign missing a required key", () => {
    expect(CampaignSchema.safeParse({ id: "1", name: "x", effective_status: "ACTIVE" }).success).toBe(false);
  });
});

const sampleAdSet = {
  id: "120210000000010",
  name: "Prospecting — 25-65",
  campaign_id: "120210000000001",
  effective_status: "ACTIVE",
  optimization_goal: "OFFSITE_CONVERSIONS",
  billing_event: "IMPRESSIONS",
  daily_budget: "5000",
  promoted_object: { pixel_id: "987654321012345", custom_event_type: "LEAD" },
  targeting: {
    geo_locations: {
      countries: ["US"],
      cities: [{ key: "2420379", name: "Austin", radius: 25, distance_unit: "mile" }],
      location_types: ["home", "recent"],
    },
    age_min: 25,
    age_max: 65,
    genders: [1, 2],
    custom_audiences: [{ id: "23850000000000001", name: "Lookalike 1%" }],
    excluded_custom_audiences: [{ id: "23850000000000002", name: "Customers" }],
    flexible_spec: [{ interests: [{ id: "6003139266461", name: "Fitness" }] }],
    publisher_platforms: ["facebook", "instagram"],
    targeting_automation: { advantage_audience: 0 },
    brand_safety_content_filter_levels: ["FACEBOOK_STANDARD"],
  },
  learning_stage_info: { status: "LEARNING", conversions: 12, last_sig_edit_ts: 1757000000, attribution_windows: ["7d_click", "1d_view"] },
  is_dynamic_creative: false,
  campaign: { id: "120210000000001", advantage_state_info: { advantage_state: "DISABLED" } },
};

describe("AdSetSchema", () => {
  it("parses a realistic ad set, keeping unknown targeting keys for round-trips", () => {
    const parsed = AdSetSchema.parse(sampleAdSet);
    expect(parsed.daily_budget).toBe(5000);
    expect(parsed.promoted_object?.pixel_id).toBe("987654321012345");
    expect(parsed.learning_stage_info?.status).toBe("LEARNING");
    expect(parsed.targeting.excluded_custom_audiences?.[0]?.id).toBe("23850000000000002");
    expect(parsed.targeting["brand_safety_content_filter_levels"]).toEqual(["FACEBOOK_STANDARD"]);
    expect(parsed.campaign?.advantage_state_info?.advantage_state).toBe("DISABLED");
  });

  it("accepts an ad set without optional keys (ABO-less, not learning, no promoted object)", () => {
    const { daily_budget, promoted_object, learning_stage_info, is_dynamic_creative, campaign, ...rest } = sampleAdSet;
    void [daily_budget, promoted_object, learning_stage_info, is_dynamic_creative, campaign];
    expect(AdSetSchema.safeParse({ ...rest, targeting: {} }).success).toBe(true);
  });

  it("rejects an unknown learning status and a missing targeting", () => {
    expect(AdSetSchema.safeParse({ ...sampleAdSet, learning_stage_info: { status: "MAYBE" } }).success).toBe(false);
    const { targeting, ...noTargeting } = sampleAdSet;
    void targeting;
    expect(AdSetSchema.safeParse(noTargeting).success).toBe(false);
  });
});

const sampleCreative = {
  id: "120210000000100",
  name: "Creative A",
  object_story_spec: { page_id: "1122334455", instagram_user_id: "17841400000000000" },
  asset_feed_spec: {
    bodies: [{ text: "Get a free quote today." }],
    titles: [{ text: "Save 20%" }],
    descriptions: [{ text: "No obligation" }],
    link_urls: [{ website_url: "https://example.com/quote" }],
    call_to_action_types: ["GET_QUOTE"],
    images: [{ hash: "a1b2c3d4e5f6", url: "https://scontent.example/img.png" }],
    ad_formats: ["AUTOMATIC_FORMAT"],
    optimization_type: "DEGREES_OF_FREEDOM",
  },
  degrees_of_freedom_spec: {
    creative_features_spec: {
      enhance_cta: { enroll_status: "OPT_IN" },
      text_optimizations: { enroll_status: "OPT_OUT" },
    },
  },
};

describe("AdCreativeSchema", () => {
  it("parses asset_feed_spec + degrees_of_freedom_spec", () => {
    const parsed = AdCreativeSchema.parse(sampleCreative);
    expect(parsed.asset_feed_spec?.images?.[0]?.hash).toBe("a1b2c3d4e5f6");
    expect(parsed.asset_feed_spec?.["ad_formats"]).toEqual(["AUTOMATIC_FORMAT"]);
    expect(parsed.degrees_of_freedom_spec?.creative_features_spec?.["enhance_cta"]?.enroll_status).toBe("OPT_IN");
  });

  it("parses a link_data creative and an id-only expansion", () => {
    const linkCreative = AdCreativeSchema.parse({
      id: "120210000000101",
      object_story_spec: {
        page_id: "1122334455",
        link_data: {
          link: "https://example.com/lp",
          message: "Primary text",
          image_hash: "ffee",
          call_to_action: { type: "LEARN_MORE", value: { link: "https://example.com/lp" } },
        },
      },
    });
    expect(linkCreative.object_story_spec?.link_data?.link).toBe("https://example.com/lp");
    expect(AdCreativeSchema.parse({ id: "120210000000102" })).toEqual({ id: "120210000000102" });
  });

  it("requires page_id inside object_story_spec", () => {
    expect(AdCreativeSchema.safeParse({ id: "1", object_story_spec: { link_data: {} } }).success).toBe(false);
  });
});

describe("AdSchema", () => {
  it("parses an ad with expanded creative", () => {
    const parsed = AdSchema.parse({
      id: "120210000001000",
      name: "Ad A",
      adset_id: "120210000000010",
      effective_status: "PAUSED",
      creative: sampleCreative,
    });
    expect(parsed.creative.id).toBe("120210000000100");
    expect(AdSchema.safeParse({ id: "1", name: "x", adset_id: "2", effective_status: "ACTIVE" }).success).toBe(false);
  });
});

describe("InsightsRowSchema", () => {
  it("coerces an ad-level row's decimal strings", () => {
    const parsed = InsightsRowSchema.parse({
      date_start: "2026-08-14",
      date_stop: "2026-09-12",
      campaign_id: "120210000000001",
      campaign_name: "Leads — US",
      adset_id: "120210000000010",
      adset_name: "Prospecting",
      ad_id: "120210000001000",
      ad_name: "Ad A",
      spend: "1234.56",
      impressions: "98765",
      reach: "54321",
      frequency: "1.818",
      clicks: "1500",
      inline_link_clicks: "1200",
      ctr: "1.518757",
      inline_link_click_ctr: "1.215",
      cpm: "12.5",
      cpc: "0.823",
      actions: [
        { action_type: "link_click", value: "1200" },
        { action_type: "lead", value: "42", "7d_click": "40", "1d_view": "2" },
      ],
      cost_per_action_type: [{ action_type: "lead", value: "29.394286" }],
    });
    expect(parsed.spend).toBe(1234.56);
    expect(parsed.impressions).toBe(98765);
    expect(parsed.actions?.[1]).toEqual({ action_type: "lead", value: 42, "7d_click": 40, "1d_view": 2 });
    expect(parsed.cost_per_action_type?.[0]?.value).toBeCloseTo(29.394286);
  });

  it("parses an account-level breakdown row without entity ids, ratios or actions", () => {
    const parsed = InsightsRowSchema.parse({
      date_start: "2026-08-14",
      date_stop: "2026-09-12",
      spend: "0",
      impressions: "15",
      publisher_platform: "instagram",
      platform_position: "reels",
    });
    expect(parsed).toMatchObject({ spend: 0, impressions: 15, publisher_platform: "instagram", platform_position: "reels" });
    expect(parsed.actions).toBeUndefined();
    expect(InsightsRowSchema.parse({ date_start: "a", date_stop: "b", spend: "1", impressions: "1", age: "25-34", gender: "female" }).gender).toBe("female");
  });

  it("rejects a non-numeric metric and a missing spend", () => {
    expect(InsightsRowSchema.safeParse({ date_start: "a", date_stop: "b", spend: "n/a", impressions: "1" }).success).toBe(false);
    expect(InsightsRowSchema.safeParse({ date_start: "a", date_stop: "b", impressions: "1" }).success).toBe(false);
  });
});

describe("media uploads", () => {
  it("ImageUploadSchema", () => {
    const parsed = ImageUploadSchema.parse({ images: { "hero.png": { hash: "0a1b2c3d4e5f", url: "https://scontent.example/hero.png" } } });
    expect(parsed.images["hero.png"]?.hash).toBe("0a1b2c3d4e5f");
    expect(ImageUploadSchema.safeParse({ images: { "hero.png": { url: "x" } } }).success).toBe(false);
  });

  it("VideoStatusSchema for processing and ready", () => {
    const processing = VideoStatusSchema.parse({
      id: "1200000000000001",
      status: {
        video_status: "processing",
        uploading_phase: { status: "complete", bytes_transferred: 1000 },
        processing_phase: { status: "in_progress" },
        publishing_phase: { status: "not_started" },
      },
    });
    expect(processing.status.video_status).toBe("processing");
    expect(VideoStatusSchema.parse({ status: { video_status: "ready" } }).status.video_status).toBe("ready");
    expect(VideoStatusSchema.safeParse({ id: "1" }).success).toBe(false);
  });
});
