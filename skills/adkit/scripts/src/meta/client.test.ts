import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  GRAPH_API_VERSION,
  MAX_ATTEMPTS,
  MAX_DELAY_MS,
  VIDEO_POLL_ATTEMPTS,
  appsecretProof,
  classifyGraphError,
  createMetaClient,
  encodeParams,
  retryDelayMs,
} from "./client.js";
import { MetaApiError, MetaConfigError, formatMetaError } from "./errors.js";
import { CampaignSchema, CreatedIdSchema, MeSchema } from "./graph.js";
import { MetaAdAccountIdSchema } from "./ids.js";

const TOKEN = "EAABsecretTOKEN123";
const ACCOUNT = MetaAdAccountIdSchema.parse("act_42");

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const graphError = (code: number, extra: Record<string, unknown> = {}) => ({
  error: { message: `boom ${code}`, type: "OAuthException", code, fbtrace_id: "TRACE1", ...extra },
});

/** fetch stub answering from a queue of responses, recording each (url, init). */
const queueFetch = (responses: readonly Response[]) => {
  const fn = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
  responses.forEach((r) => fn.mockResolvedValueOnce(r));
  return fn;
};

const noSleep = () => vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

const headers = (h: Record<string, string>) => new Headers(h);

const campaign = (id: string) => ({ id, name: `C${id}`, objective: "OUTCOME_SALES", effective_status: "ACTIVE" });

describe("encodeParams", () => {
  it("stringifies scalars, JSON-encodes objects/arrays, joins fields, drops undefined", () => {
    expect(
      encodeParams({
        fields: ["id", "name"],
        limit: 50,
        is_dynamic: false,
        name: "x",
        targeting: { geo_locations: { countries: ["US"] } },
        special_ad_categories: [],
        skip: undefined,
      }),
    ).toEqual([
      ["fields", "id,name"],
      ["limit", "50"],
      ["is_dynamic", "false"],
      ["name", "x"],
      ["targeting", '{"geo_locations":{"countries":["US"]}}'],
      ["special_ad_categories", "[]"],
    ]);
  });

  it("keeps a string fields value as-is", () => {
    expect(encodeParams({ fields: "id,name" })).toEqual([["fields", "id,name"]]);
  });
});

describe("appsecretProof", () => {
  it("is the hex HMAC-SHA256 of the token keyed by the secret", () => {
    expect(appsecretProof(TOKEN, "shh")).toBe(createHmac("sha256", "shh").update(TOKEN).digest("hex"));
    expect(appsecretProof(TOKEN, "shh")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("classifyGraphError", () => {
  it.each([1, 2, 4, 17, 32, 613, 80000, 80004, 80014])("retries code %i", (code) => {
    expect(classifyGraphError(graphError(code), 400)).toBe("retry");
  });

  it("retries is_transient and HTTP 5xx", () => {
    expect(classifyGraphError(graphError(100, { is_transient: true }), 400)).toBe("retry");
    expect(classifyGraphError(graphError(100), 503)).toBe("retry");
    expect(classifyGraphError("not json", 502)).toBe("retry");
  });

  it("does not retry budget-change quota subcode 1487632 even under 613", () => {
    expect(classifyGraphError(graphError(613, { error_subcode: 1487632 }), 400)).toBe("fatal");
  });

  it("treats other 4xx as fatal", () => {
    expect(classifyGraphError(graphError(100), 400)).toBe("fatal");
    expect(classifyGraphError(graphError(190), 401)).toBe("fatal");
    expect(classifyGraphError(graphError(80015), 400)).toBe("fatal");
    expect(classifyGraphError(undefined, 404)).toBe("fatal");
  });
});

describe("retryDelayMs", () => {
  it("backs off exponentially from 1s", () => {
    const none = headers({});
    expect([1, 2, 3].map((a) => retryDelayMs(a, none))).toEqual([1000, 2000, 4000]);
  });

  it("adds up to 25% jitter", () => {
    expect(retryDelayMs(2, headers({}), 0.5)).toBe(2250);
  });

  it("honours X-Business-Use-Case-Usage estimated_time_to_regain_access (minutes)", () => {
    const h = headers({
      "X-Business-Use-Case-Usage": JSON.stringify({
        "123": [{ type: "ads_management", call_count: 100, estimated_time_to_regain_access: 2 }],
      }),
    });
    expect(retryDelayMs(1, h)).toBe(120_000);
  });

  it("honours X-Ad-Account-Usage reset_time_duration (seconds)", () => {
    const h = headers({ "X-Ad-Account-Usage": JSON.stringify({ acc_id_util_pct: 99, reset_time_duration: 30 }) });
    expect(retryDelayMs(1, h)).toBe(30_000);
  });

  it("ignores malformed headers and caps long waits", () => {
    expect(retryDelayMs(1, headers({ "X-Ad-Account-Usage": "{nope" }))).toBe(1000);
    const h = headers({ "X-Ad-Account-Usage": JSON.stringify({ reset_time_duration: 3600 }) });
    expect(retryDelayMs(1, h)).toBe(MAX_DELAY_MS);
  });
});

describe("createMetaClient.get", () => {
  it("builds a versioned URL with encoded params and access_token, and parses the body", async () => {
    const fetch = queueFetch([json({ id: "1", name: "Me" })]);
    const client = createMetaClient({ token: TOKEN, fetch, sleep: noSleep() });
    await expect(client.get("me", { fields: ["id", "name"] }, MeSchema)).resolves.toEqual({ id: "1", name: "Me" });
    const url = new URL(fetch.mock.calls[0]![0]);
    expect(url.origin + url.pathname).toBe(`https://graph.facebook.com/${GRAPH_API_VERSION}/me`);
    expect(url.searchParams.get("fields")).toBe("id,name");
    expect(url.searchParams.get("access_token")).toBe(TOKEN);
    expect(url.searchParams.has("appsecret_proof")).toBe(false);
  });

  it("adds appsecret_proof when an app secret is configured", async () => {
    const fetch = queueFetch([json({ id: "1" })]);
    const client = createMetaClient({ token: TOKEN, appSecret: "shh", fetch, sleep: noSleep() });
    await client.get("/me", {}, MeSchema);
    const url = new URL(fetch.mock.calls[0]![0]);
    expect(url.pathname).toBe(`/${GRAPH_API_VERSION}/me`);
    expect(url.searchParams.get("appsecret_proof")).toBe(appsecretProof(TOKEN, "shh"));
  });

  it("retries a throttled call then succeeds, sleeping per retryDelayMs", async () => {
    const fetch = queueFetch([json(graphError(17), 400), json(graphError(2), 500), json({ id: "1" })]);
    const sleep = noSleep();
    const client = createMetaClient({ token: TOKEN, fetch, sleep, random: () => 0 });
    await expect(client.get("me", {}, MeSchema)).resolves.toEqual({ id: "1" });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 2000]);
  });

  it("gives up after MAX_ATTEMPTS with a MetaApiError", async () => {
    const fetch = queueFetch(Array.from({ length: MAX_ATTEMPTS + 1 }, () => json(graphError(4), 400)));
    const sleep = noSleep();
    const client = createMetaClient({ token: TOKEN, fetch, sleep, random: () => 0 });
    await expect(client.get("me", {}, MeSchema)).rejects.toMatchObject({ name: "MetaApiError", code: 4 });
    expect(fetch).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(sleep).toHaveBeenCalledTimes(MAX_ATTEMPTS - 1);
  });

  it("fails immediately on budget quota subcode 1487632", async () => {
    const fetch = queueFetch([json(graphError(613, { error_subcode: 1487632 }), 400)]);
    const sleep = noSleep();
    const client = createMetaClient({ token: TOKEN, fetch, sleep });
    const error = await client.post("123", { daily_budget: 5000 }, CreatedIdSchema, { step: "budget" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MetaApiError);
    expect(error).toMatchObject({ step: "budget", code: 613, subcode: 1487632 });
    expect((error as MetaApiError).message).toContain("4 budget changes");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("maps a Graph error body onto MetaApiError fields with the default step", async () => {
    const body = graphError(100, { error_subcode: 33, error_user_title: "Bad", error_user_msg: "Nope" });
    const client = createMetaClient({ token: TOKEN, fetch: queueFetch([json(body, 400)]), sleep: noSleep() });
    await expect(client.get("act_42", {}, MeSchema)).rejects.toMatchObject({
      step: "graph-get",
      code: 100,
      subcode: 33,
      message: "boom 100",
      userTitle: "Bad",
      userMessage: "Nope",
      fbtraceId: "TRACE1",
    });
  });

  it("maps a non-Graph error body to the HTTP status", async () => {
    const fetch = queueFetch([new Response("gateway nope", { status: 404 })]);
    const client = createMetaClient({ token: TOKEN, fetch, sleep: noSleep() });
    await expect(client.get("x", {}, MeSchema)).rejects.toMatchObject({ code: 404, message: "HTTP 404: gateway nope" });
  });

  it("throws code schema with zod issues when a 2xx body fails its schema", async () => {
    const client = createMetaClient({ token: TOKEN, fetch: queueFetch([json({ name: "no id" })]), sleep: noSleep() });
    const error = (await client.get("me", {}, MeSchema, { step: "auth" }).catch((e: unknown) => e)) as MetaApiError;
    expect(error).toBeInstanceOf(MetaApiError);
    expect(error.code).toBe("schema");
    expect(error.step).toBe("auth");
    expect(error.issues?.[0]?.path).toEqual(["id"]);
    expect(error.message).not.toContain(TOKEN);
  });

  it("never leaks the token or appsecret_proof in error text", async () => {
    const echoed = graphError(190, { message: `Invalid token access_token=${TOKEN}&appsecret_proof=abc123` });
    const client = createMetaClient({ token: TOKEN, appSecret: "shh", fetch: queueFetch([json(echoed, 400)]), sleep: noSleep() });
    const error = await client.get("me", {}, MeSchema).catch((e: unknown) => e);
    expect((error as Error).message).not.toContain(TOKEN);
    expect(formatMetaError(error)).not.toContain(TOKEN);
    expect(formatMetaError(error)).toContain("access_token=[REDACTED]");
  });

  it("redacts the token from network failures", async () => {
    const fetch = vi.fn<(url: string) => Promise<Response>>().mockRejectedValue(new TypeError(`fetch failed for ?access_token=${TOKEN}`));
    const client = createMetaClient({ token: TOKEN, fetch, sleep: noSleep() });
    const error = await client.get("me", {}, MeSchema).catch((e: unknown) => e);
    expect((error as Error).message).not.toContain(TOKEN);
  });
});

describe("createMetaClient.getAll", () => {
  it("follows paging.next through an empty middle page until absent", async () => {
    const next1 = `https://graph.facebook.com/${GRAPH_API_VERSION}/act_42/campaigns?access_token=${TOKEN}&after=c1`;
    const next2 = `https://graph.facebook.com/${GRAPH_API_VERSION}/act_42/campaigns?access_token=${TOKEN}&after=c2`;
    const fetch = queueFetch([
      json({ data: [campaign("1"), campaign("2")], paging: { next: next1 } }),
      json({ data: [], paging: { next: next2 } }),
      json({ data: [campaign("3")], paging: { cursors: { before: "a", after: "b" } } }),
    ]);
    const client = createMetaClient({ token: TOKEN, fetch, sleep: noSleep() });
    const rows = await client.getAll("act_42/campaigns", { fields: ["id", "name"], limit: 100 }, CampaignSchema);
    expect(rows.map((r) => r.id)).toEqual(["1", "2", "3"]);
    expect(fetch.mock.calls.map(([u]) => u).slice(1)).toEqual([next1, next2]);
  });

  it("adds missing auth params to a next URL", async () => {
    const next = `https://graph.facebook.com/${GRAPH_API_VERSION}/act_42/campaigns?after=c1`;
    const fetch = queueFetch([json({ data: [], paging: { next } }), json({ data: [] })]);
    const client = createMetaClient({ token: TOKEN, appSecret: "shh", fetch, sleep: noSleep() });
    await client.getAll("act_42/campaigns", {}, CampaignSchema);
    const url = new URL(fetch.mock.calls[1]![0]);
    expect(url.searchParams.get("after")).toBe("c1");
    expect(url.searchParams.get("access_token")).toBe(TOKEN);
    expect(url.searchParams.get("appsecret_proof")).toBe(appsecretProof(TOKEN, "shh"));
  });

  it("fails with code schema when an item does not parse", async () => {
    const client = createMetaClient({ token: TOKEN, fetch: queueFetch([json({ data: [{ id: "x" }] })]), sleep: noSleep() });
    await expect(client.getAll("act_42/campaigns", {}, CampaignSchema)).rejects.toMatchObject({ code: "schema" });
  });
});

describe("createMetaClient.post", () => {
  it("sends a form-encoded body with JSON-encoded objects and the token", async () => {
    const fetch = queueFetch([json({ id: "777" })]);
    const client = createMetaClient({ token: TOKEN, fetch, sleep: noSleep() });
    await expect(
      client.post("act_42/adsets", { name: "A", status: "PAUSED", targeting: { age_min: 18 } }, CreatedIdSchema),
    ).resolves.toEqual({ id: "777" });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`https://graph.facebook.com/${GRAPH_API_VERSION}/act_42/adsets`);
    expect(init?.method).toBe("POST");
    const body = new URLSearchParams(String(init?.body));
    expect(body.get("targeting")).toBe('{"age_min":18}');
    expect(body.get("status")).toBe("PAUSED");
    expect(body.get("access_token")).toBe(TOKEN);
  });

  it("defaults the step to graph-post", async () => {
    const client = createMetaClient({ token: TOKEN, fetch: queueFetch([json(graphError(100), 400)]), sleep: noSleep() });
    await expect(client.post("act_42/ads", {}, CreatedIdSchema)).rejects.toMatchObject({ step: "graph-post" });
  });
});

describe("createMetaClient.uploadImage", () => {
  it("posts multipart to act_<id>/adimages and returns the hash", async () => {
    const fetch = queueFetch([json({ images: { "hero.png": { hash: "abc123hash", url: "https://x" } } })]);
    const client = createMetaClient({ token: TOKEN, fetch, sleep: noSleep() });
    const hash = await client.uploadImage(ACCOUNT, { name: "hero.png", bytes: new Uint8Array([1, 2, 3]) });
    expect(hash).toBe("abc123hash");
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`https://graph.facebook.com/${GRAPH_API_VERSION}/act_42/adimages`);
    const form = init?.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("access_token")).toBe(TOKEN);
    const file = form.get("filename") as File;
    expect(file.name).toBe("hero.png");
    expect(file.size).toBe(3);
  });

  it("fails with code schema when the response has no usable hash", async () => {
    const fetch = queueFetch([json({ images: {} })]);
    const client = createMetaClient({ token: TOKEN, fetch, sleep: noSleep() });
    await expect(client.uploadImage(ACCOUNT, { name: "a.png", bytes: new Uint8Array([1]) })).rejects.toMatchObject({
      code: "schema",
      step: "upload-image",
    });
  });
});

describe("createMetaClient.uploadVideo", () => {
  const status = (video_status: string, extra: Record<string, unknown> = {}) => json({ id: "555", status: { video_status, ...extra } });

  it("uploads source then polls status until ready", async () => {
    const fetch = queueFetch([json({ id: "555" }), status("processing"), status("processing"), status("ready")]);
    const sleep = noSleep();
    const client = createMetaClient({ token: TOKEN, fetch, sleep });
    await expect(client.uploadVideo(ACCOUNT, { name: "v.mp4", bytes: new Uint8Array([9, 9]) })).resolves.toBe("555");
    const [uploadUrl, init] = fetch.mock.calls[0]!;
    expect(uploadUrl).toBe(`https://graph.facebook.com/${GRAPH_API_VERSION}/act_42/advideos`);
    expect(((init?.body as FormData).get("source") as File).size).toBe(2);
    const pollUrl = new URL(fetch.mock.calls[1]![0]);
    expect(pollUrl.pathname).toBe(`/${GRAPH_API_VERSION}/555`);
    expect(pollUrl.searchParams.get("fields")).toBe("status");
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("rejects files over 1 GB before any call", async () => {
    const fetch = queueFetch([]);
    const client = createMetaClient({ token: TOKEN, fetch, sleep: noSleep() });
    const big = { byteLength: 1024 * 1024 * 1024 + 1 } as Uint8Array;
    await expect(client.uploadVideo(ACCOUNT, { name: "big.mp4", bytes: big })).rejects.toBeInstanceOf(MetaConfigError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails when processing reports an error", async () => {
    const fetch = queueFetch([
      json({ id: "555" }),
      status("error", { processing_phase: { status: "error", errors: [{ code: 1363, message: "bad codec" }] } }),
    ]);
    const client = createMetaClient({ token: TOKEN, fetch, sleep: noSleep() });
    await expect(client.uploadVideo(ACCOUNT, { name: "v.mp4", bytes: new Uint8Array([1]) })).rejects.toMatchObject({
      step: "upload-video",
      code: 1363,
    });
  });

  it("stops polling after VIDEO_POLL_ATTEMPTS", async () => {
    const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
    fetch.mockResolvedValueOnce(json({ id: "555" }));
    fetch.mockImplementation(async () => status("processing"));
    const client = createMetaClient({ token: TOKEN, fetch, sleep: noSleep() });
    await expect(client.uploadVideo(ACCOUNT, { name: "v.mp4", bytes: new Uint8Array([1]) })).rejects.toThrow(/status checks/);
    expect(fetch).toHaveBeenCalledTimes(1 + VIDEO_POLL_ATTEMPTS);
  });
});

describe("schema typing", () => {
  it("accepts transforming schemas", async () => {
    const client = createMetaClient({ token: TOKEN, fetch: queueFetch([json({ n: "3" })]), sleep: noSleep() });
    const schema = z.object({ n: z.string().transform(Number) });
    await expect(client.get("x", {}, schema)).resolves.toEqual({ n: 3 });
  });
});
