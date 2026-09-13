import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";

import type { MetaContext } from "../config.js";
import { fakeMetaClient, metaApiError, type FakeMetaClient, type FakeMetaClientOptions } from "../fake-client.js";
import { MetaAccessTokenSchema, MetaAdAccountIdSchema, MetaPageIdSchema } from "../ids.js";
import { readMetaState } from "../state.js";
import { main, parseCreateArgs } from "./create.js";

const CTX: MetaContext = {
  token: MetaAccessTokenSchema.parse("EAAtoken"),
  adAccountId: MetaAdAccountIdSchema.parse("act_111"),
  pageId: MetaPageIdSchema.parse("999"),
  pixelId: null,
  appSecret: null,
  psiApiKey: null,
};

const ad = (name: string) => ({
  name,
  link: "https://example.com/lp",
  callToAction: "LEARN_MORE",
  primaryTexts: ["Body one"],
  headlines: ["Headline"],
  media: { image: "./media/hero.png" },
  enhancements: { enhance_cta: "OPT_OUT" },
});

const rawBrief = (overrides: Record<string, unknown> = {}) => ({
  type: "meta",
  name: "widget-launch",
  campaign: {
    name: "Widget Launch",
    objective: "OUTCOME_TRAFFIC",
    budget: { mode: "campaign", dailyBudget: 50, bidStrategy: "LOWEST_COST_WITHOUT_CAP" },
  },
  adSets: [{ name: "Set A", optimizationGoal: "LINK_CLICKS", audience: { countries: ["US"] }, ads: [ad("Ad 1"), ad("Ad 2")] }],
  ...overrides,
});

/** Answers the currency read and every find-by-name lookup (none live). */
const liveGet = (path: string): unknown => (path === "act_111" ? { currency: "USD" } : []);

describe("parseCreateArgs", () => {
  it("takes one brief path and the two flags", () => {
    expect(parseCreateArgs(["b.yaml", "--dry-run", "--skip-url-check"])).toEqual({
      kind: "ok",
      value: { briefPath: "b.yaml", dryRun: true, skipUrlCheck: true },
    });
    expect(parseCreateArgs([]).kind).toBe("err");
    expect(parseCreateArgs(["b.yaml", "--apply"]).kind).toBe("err");
  });
});

describe("main", () => {
  let cwd: string;
  let stdout: ReturnType<typeof vi.spyOn>;
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "meta-create-"));
    mkdirSync(join(cwd, "drafts", "media"), { recursive: true });
    writeFileSync(join(cwd, "drafts", "media", "hero.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(cwd, { recursive: true, force: true });
  });

  const writeBriefFile = (data: unknown): string => {
    writeFileSync(join(cwd, "drafts", "brief.yaml"), yamlStringify(data));
    return "drafts/brief.yaml";
  };

  /** The last JSON envelope written to stdout. */
  const emitted = (): Record<string, unknown> => {
    const text = stdout.mock.calls.map((c) => String(c[0])).join("");
    const lastStart = text.lastIndexOf("\n{\n") >= 0 ? text.lastIndexOf("\n{\n") + 1 : 0;
    return JSON.parse(text.slice(lastStart)) as Record<string, unknown>;
  };
  const stderrText = (): string => stderr.mock.calls.map((c) => String(c[0])).join("");

  const run = async (
    argv: string[],
    fake: FakeMetaClientOptions = { get: liveGet },
    ctx: MetaContext = CTX,
  ): Promise<{ code: number; client: FakeMetaClient; urls: string[] }> => {
    const client = fakeMetaClient(fake);
    const urls: string[] = [];
    const code = await main(argv, {}, {
      resolveContext: async () => ctx,
      clientFactory: () => client,
      checkUrl: async (url) => {
        urls.push(url);
        return null;
      },
      cwd: () => cwd,
      briefsDir: () => "adbriefs",
    });
    return { code, client, urls };
  };

  const statePath = () => join(cwd, "adbriefs", "widget-launch.meta-state.yaml");
  const stagedPath = () => join(cwd, "adbriefs", "widget-launch.yaml");

  it("reports every brief issue at once and makes zero client calls", async () => {
    const path = writeBriefFile(
      rawBrief({
        adSets: [
          {
            name: "Set A",
            dailyBudget: 10,
            optimizationGoal: "POST_ENGAGEMENT",
            audience: { countries: ["US"] },
            ads: [{ ...ad("Ad 1"), media: { image: "./media/missing.png" } }],
          },
        ],
      }),
    );
    const { code, client, urls } = await run([path]);
    expect(code).toBe(1);
    const env = emitted();
    expect(env).toMatchObject({ ok: false, step: "brief" });
    expect(env["message"]).toContain("dailyBudget is forbidden");
    expect(env["message"]).toContain("POST_ENGAGEMENT is not valid for objective OUTCOME_TRAFFIC");
    expect(env["message"]).toContain("media file not found or unreadable: ./media/missing.png");
    expect(client.calls).toEqual([]);
    expect(urls).toEqual([]);
    expect(existsSync(stagedPath())).toBe(false);
  });

  it("dry run: no client calls, diff on stderr, planned objects, nothing written", async () => {
    const path = writeBriefFile(rawBrief());
    const { code, client, urls } = await run([path, "--dry-run"]);
    expect(code).toBe(0);
    expect(client.calls).toEqual([]);
    expect(urls).toEqual(["https://example.com/lp"]);
    const env = emitted();
    expect(env).toMatchObject({
      ok: true,
      platform: "meta",
      dryRun: true,
      briefDiff: { changed: true, removed: 0 },
      willWriteBrief: stagedPath(),
      willWriteState: statePath(),
    });
    expect((env["planned"] as { step: string; action: string }[]).map((p) => [p.step, p.action])).toEqual([
      ["upload-media", "create"],
      ["create-campaign", "create"],
      ["create-ad-set", "create"],
      ["create-creative", "create"],
      ["create-ad", "create"],
      ["create-creative", "create"],
      ["create-ad", "create"],
    ]);
    expect(stderrText()).toContain("new adbriefs brief");
    expect(existsSync(stagedPath())).toBe(false);
    expect(existsSync(statePath())).toBe(false);
  });

  it("publishes: writes brief + state and reports created ids", async () => {
    const path = writeBriefFile(rawBrief());
    const { code, client } = await run([path]);
    expect(code).toBe(0);
    const env = emitted();
    expect(env).toMatchObject({ ok: true, platform: "meta", failure: null, briefSynced: true, stateSynced: true, warnings: [], orphaned: [] });
    const created = env["created"] as { campaignId: string; adSets: { adSetId: string; ads: { adId: string }[] }[] };
    expect(created.campaignId).toMatch(/^\d+$/);
    expect(created.adSets[0]?.adSetId).toMatch(/^\d+$/);
    expect(created.adSets[0]?.ads.map((a) => a.adId)).toHaveLength(2);
    expect(client.calls[0]).toMatchObject({ method: "get", path: "act_111", params: { fields: ["currency"] } });
    expect(client.calls.filter((c) => c.method === "uploadImage")).toHaveLength(1);
    expect((yamlParse(readFileSync(stagedPath(), "utf8")) as { campaign: { name: string } }).campaign.name).toBe("Widget Launch");
    const state = readMetaState(statePath());
    expect(state?.campaign.campaignId).toBe(created.campaignId);
    expect(state?.adSets[0]?.ads.every((a) => a.adId !== null)).toBe(true);
  });

  it("stages media paths relative to adbriefs/ so the staged copy is re-runnable", async () => {
    const path = writeBriefFile(rawBrief());
    expect((await run([path])).code).toBe(0);
    const staged = yamlParse(readFileSync(stagedPath(), "utf8")) as { adSets: { ads: { media: { image: string } }[] }[] };
    const image = staged.adSets[0]!.ads[0]!.media.image;
    expect(image).toBe("../drafts/media/hero.png");
    expect(existsSync(join(cwd, "adbriefs", image))).toBe(true);

    // Re-running from the staged copy keeps the same media key: no re-upload, no new objects.
    const rerun = await run(["adbriefs/widget-launch.yaml"]);
    expect(rerun.code).toBe(0);
    expect(rerun.client.calls.filter((c) => c.method !== "get")).toEqual([]);
    expect(Object.keys(readMetaState(statePath())!.media)).toEqual(["../drafts/media/hero.png"]);
  });

  it("a failed publish exits 1 with saved progress; the rerun creates only what is missing", async () => {
    const path = writeBriefFile(rawBrief());
    const first = await run([path], {
      get: liveGet,
      failOn: (call) => (call.method === "post" && call.path === "act_111/ads" ? metaApiError(100, "Invalid parameter") : null),
    });
    expect(first.code).toBe(1);
    expect(emitted()).toMatchObject({ ok: false, failure: { step: "create-ad", code: 100 }, briefSynced: false, stateSynced: true });
    const saved = readMetaState(statePath());
    expect(saved?.campaign.campaignId).not.toBeNull();
    expect(saved?.adSets[0]?.ads[0]).toMatchObject({ adId: null });
    expect(saved?.adSets[0]?.ads[0]?.creativeId).not.toBeNull();

    const second = await run([path], { get: liveGet, firstId: 50001 });
    expect(second.code).toBe(0);
    const posts = second.client.calls.filter((c) => c.method !== "get" && c.method !== "getAll");
    // Campaign, ad set, first creative and media were reused: only Ad 1's ad and Ad 2's creative + ad are new.
    expect(posts.map((c) => c.path)).toEqual(["act_111/ads", "act_111/adcreatives", "act_111/ads"]);
    expect(stderrText()).toContain("unchanged");
    const final = readMetaState(statePath());
    expect(final?.campaign.campaignId).toBe(saved?.campaign.campaignId);
    expect(final?.adSets[0]?.ads.every((a) => a.adId !== null)).toBe(true);
  });

  it("an account read failure exits 1 before the brief is written", async () => {
    const path = writeBriefFile(rawBrief());
    const { code, client } = await run([path], {
      get: liveGet,
      failOn: (call) => (call.method === "get" && call.path === "act_111" ? metaApiError(190, "Session has expired") : null),
    });
    expect(code).toBe(1);
    expect(emitted()).toMatchObject({ ok: false, step: "account" });
    expect(client.calls.filter((c) => c.method !== "get")).toEqual([]);
    expect(existsSync(stagedPath())).toBe(false);
    expect(existsSync(statePath())).toBe(false);
  });

  it("warns about exclusions under Advantage+ audience in stderr and both envelopes", async () => {
    const path = writeBriefFile(
      rawBrief({
        adSets: [
          {
            name: "Set A",
            optimizationGoal: "LINK_CLICKS",
            audience: { countries: ["US"], advantageAudience: true, excludedCustomAudienceIds: ["2385"] },
            ads: [ad("Ad 1")],
          },
        ],
      }),
    );
    expect((await run([path, "--dry-run"])).code).toBe(0);
    expect(emitted()["warnings"]).toEqual([expect.stringContaining("exclusions may not apply under Advantage+ audience")]);
    expect(stderrText()).toContain("warning: ad set \"Set A\": ");
    expect((await run([path])).code).toBe(0);
    expect(emitted()["warnings"]).toEqual([expect.stringContaining("exclusions may not apply under Advantage+ audience")]);
  });

  it("warns about ad sets renamed out of the brief and lists them as orphaned, deleting nothing", async () => {
    const path = writeBriefFile(rawBrief());
    expect((await run([path])).code).toBe(0);
    const before = readMetaState(statePath())!;
    const renamed = rawBrief({
      adSets: [{ name: "Set Renamed", optimizationGoal: "LINK_CLICKS", audience: { countries: ["US"] }, ads: [ad("Ad 1"), ad("Ad 2")] }],
    });
    writeBriefFile(renamed);

    expect((await run([path, "--dry-run"])).code).toBe(0);
    expect(emitted()["orphaned"]).toEqual([expect.objectContaining({ kind: "ad-set", name: "Set A", adSetId: before.adSets[0]!.adSetId })]);

    const { code, client } = await run([path]);
    expect(code).toBe(0);
    expect(stderrText()).toMatch(/WARNING: ad set "Set A" is no longer in the brief but state holds adSetId \d+/);
    expect(emitted()["orphaned"]).toEqual([expect.objectContaining({ kind: "ad-set", name: "Set A", adSetId: before.adSets[0]!.adSetId })]);
    expect(client.calls.filter((c) => c.method === "post").every((c) => !String(c.path).startsWith(before.adSets[0]!.adSetId!))).toBe(true);
  });

  it("fails at step page when neither the brief nor the config names a page", async () => {
    const path = writeBriefFile(rawBrief());
    const { code, client } = await run([path], { get: liveGet }, { ...CTX, pageId: null });
    expect(code).toBe(1);
    const env = emitted();
    expect(env).toMatchObject({ ok: false, step: "page" });
    expect(env["message"]).toContain("meta_page_id");
    expect(env["message"]).toContain("pageId");
    expect(client.calls).toEqual([]);
  });

  it("uses the brief's adAccountId and pageId over the context", async () => {
    const path = writeBriefFile(rawBrief({ adAccountId: "act_222", pageId: "333" }));
    const { code } = await run([path, "--dry-run"], { get: liveGet }, { ...CTX, pageId: null });
    expect(code).toBe(0);
    expect(emitted()).toMatchObject({ adAccountId: "act_222", pageId: "333" });
  });

  it("fails at url-check listing unreachable links, before any client call", async () => {
    const path = writeBriefFile(rawBrief());
    const client = fakeMetaClient({ get: liveGet });
    const code = await main([path], {}, {
      resolveContext: async () => CTX,
      clientFactory: () => client,
      checkUrl: async () => "HTTP 404",
      cwd: () => cwd,
      briefsDir: () => "adbriefs",
    });
    expect(code).toBe(1);
    expect(emitted()).toMatchObject({ ok: false, step: "url-check" });
    expect(client.calls).toEqual([]);
  });
});
