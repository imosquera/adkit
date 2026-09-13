import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { MetaClient } from "./client.js";
import { MetaApiError } from "./errors.js";
import { fakeMetaClient, metaApiError } from "./fake-client.js";
import { MetaAdAccountIdSchema, MetaCampaignIdSchema } from "./ids.js";

const account = MetaAdAccountIdSchema.parse("act_123");
const Named = z.object({ id: z.string(), name: z.string() });
const Created = z.object({ id: MetaCampaignIdSchema });
const media = { name: "hero shot.png", bytes: new Uint8Array([1, 2, 3]) };

describe("fakeMetaClient", () => {
  it("is assignable to MetaClient", () => {
    const client: MetaClient = fakeMetaClient();
    expect(typeof client.get).toBe("function");
  });

  it("serves get and getAll through the caller's schema and records calls", async () => {
    const client = fakeMetaClient({
      get: (path) => (path === "me" ? { id: "1", name: "Me", extra: true } : [{ id: "2", name: "A" }, { id: "3", name: "B" }]),
    });
    await expect(client.get("me", { fields: "id,name" }, Named, { step: "auth" })).resolves.toEqual({ id: "1", name: "Me" });
    await expect(client.getAll("act_123/campaigns", { limit: 50 }, Named)).resolves.toEqual([
      { id: "2", name: "A" },
      { id: "3", name: "B" },
    ]);
    expect(client.calls).toEqual([
      { method: "get", path: "me", params: { fields: "id,name" }, step: "auth" },
      { method: "getAll", path: "act_123/campaigns", params: { limit: 50 }, step: "graph-get" },
    ]);
  });

  it("throws a schema MetaApiError on a shape mismatch", async () => {
    const client = fakeMetaClient({ get: () => ({ id: 1 }) });
    const error = await client.get("me", {}, Named, { step: "auth" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MetaApiError);
    expect(error).toMatchObject({ code: "schema", step: "auth" });
    await expect(fakeMetaClient({ get: () => ({}) }).getAll("x", {}, Named)).rejects.toMatchObject({ code: "schema" });
  });

  it("auto-assigns incrementing ids to post responses without one", async () => {
    const client = fakeMetaClient({ post: (path) => (path === "act_123/ads" ? { success: true } : undefined) });
    await expect(client.post("act_123/campaigns", { status: "PAUSED" }, Created)).resolves.toEqual({ id: "10001" });
    await expect(client.post("act_123/ads", {}, z.object({ id: z.string(), success: z.boolean() }))).resolves.toEqual({
      id: "10002",
      success: true,
    });
    await expect(fakeMetaClient({ post: () => ({ id: "77" }) }).post("x", {}, Created)).resolves.toEqual({ id: "77" });
    expect(client.calls[0]).toEqual({ method: "post", path: "act_123/campaigns", body: { status: "PAUSED" }, step: "graph-post" });
  });

  it("returns deterministic upload results", async () => {
    const client = fakeMetaClient();
    await expect(client.uploadImage(account, media)).resolves.toBe("hash_hero_shot.png");
    await expect(client.uploadVideo(account, { ...media, name: "v.mp4" }, { step: "upload-media" })).resolves.toBe("10001");
    expect(client.calls.map((c) => [c.method, c.path, c.step])).toEqual([
      ["uploadImage", "act_123/adimages", "upload-image"],
      ["uploadVideo", "act_123/advideos", "upload-media"],
    ]);
  });

  it("throws on every write when readOnly, but still records the attempt", async () => {
    const client = fakeMetaClient({ readOnly: true, get: () => ({ id: "1", name: "x" }) });
    await expect(client.get("me", {}, Named)).resolves.toEqual({ id: "1", name: "x" });
    await expect(client.post("act_123/campaigns", {}, Created)).rejects.toThrow(/read-only/);
    await expect(client.uploadImage(account, media)).rejects.toThrow(/read-only/);
    await expect(client.uploadVideo(account, media)).rejects.toThrow(/read-only/);
    expect(client.calls.map((c) => c.method)).toEqual(["get", "post", "uploadImage", "uploadVideo"]);
  });

  it("throws failOn errors stamped with the call's step", async () => {
    const client = fakeMetaClient({
      failOn: (call) => (call.method === "post" && call.path.endsWith("/adsets") ? metaApiError(100, "Invalid parameter", 1487) : null),
    });
    await expect(client.post("act_123/campaigns", {}, Created)).resolves.toEqual({ id: "10001" });
    const error = await client.post("act_123/adsets", {}, Created, { step: "create-ad-set" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MetaApiError);
    expect(error).toMatchObject({ step: "create-ad-set", code: 100, subcode: 1487, message: "Invalid parameter" });
    expect(client.calls).toHaveLength(2);
  });
});
