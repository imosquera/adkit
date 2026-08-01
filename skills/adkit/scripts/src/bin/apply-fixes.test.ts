/**
 * Shell-level tests for bin/apply-fixes.ts — arg parsing, pre-mutation guards, and
 * the campaignStatus (campaign on/off) dry-run + apply paths.
 *
 * The pure validation/coercion rules live in fixes/plan.ts and are covered by
 * plan.test.ts. These cover the I/O shell: the early exits (which return before any
 * client work) and the status planning / mutation contract. A FAKE AdsClient returns
 * canned live-state rows and records its mutate ops so an --apply run can be asserted.
 *
 * Ported from ads_skill/bin/apply_fixes_test.py.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parse as yamlParseForTest } from "yaml";
import type { AdsClient, AdsMutateOperation, MutateResult } from "../lib/auth.js";
import type { SearchArgs } from "../gaql/search-args.js";
import { parseBrief } from "../lib/schema.js";

// The shell resolves its client via loadClient; the test swaps in a fake (mirrors the
// Python monkeypatch of `af.load_client`). `currentClient` is what loadClient returns.
let currentClient: AdsClient;
vi.mock("../lib/auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/auth.js")>();
  return { ...actual, loadClient: () => currentClient };
});

// A test can set this to a campaign name to simulate that campaign's writeBrief call
// throwing (foreign-brief race, EACCES/ENOSPC/etc) — every other slug's writeBrief
// call still goes through the real implementation, so the surrounding test asserts
// that one slug's write failure never blocks another's write/report (item 3 fix).
let failWriteForCampaignName: string | null = null;
vi.mock("../adbriefs/store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../adbriefs/store.js")>();
  return {
    ...actual,
    writeBrief: (root: string, brief: Parameters<typeof actual.writeBrief>[1]) => {
      if (failWriteForCampaignName !== null && brief.campaign.name === failWriteForCampaignName) {
        throw new Error("simulated writeBrief failure");
      }
      return actual.writeBrief(root, brief);
    },
  };
});

const { main, loadPlan, livePositiveKeywords, liveNegatives, rsaUpdateOp } = await import("./apply-fixes.js");
const { validate } = await import("../fixes/plan.js");

// ---------------------------------------------------------------------------
// rsaUpdateOp — the field-mask shape depends on which fields are present.
// ---------------------------------------------------------------------------

describe("rsaUpdateOp", () => {
  it("URL-only repoint omits responsive_search_ad (avoids FIELD_HAS_SUBFIELDS)", () => {
    const op = rsaUpdateOp("111", 999, null, null, { finalUrl: "https://x.io/p" });
    const r = op.resource as Record<string, unknown>;
    expect(r.responsive_search_ad).toBeUndefined();
    expect(r.final_urls).toEqual(["https://x.io/p"]);
  });

  it("copy rewrite sets responsive_search_ad and no final_urls when URL absent", () => {
    const op = rsaUpdateOp("111", 999, ["h"], ["d"], null);
    const r = op.resource as Record<string, unknown>;
    expect(r.responsive_search_ad).toEqual({ headlines: [{ text: "h" }], descriptions: [{ text: "d" }] });
    expect(r.final_urls).toBeUndefined();
  });

  it("copy + URL sets both", () => {
    const op = rsaUpdateOp("111", 999, ["h"], ["d"], { finalUrl: "https://x.io/p" });
    const r = op.resource as Record<string, unknown>;
    expect(r.responsive_search_ad).toBeDefined();
    expect(r.final_urls).toEqual(["https://x.io/p"]);
  });
});

// ---------------------------------------------------------------------------
// Fakes + fixtures
// ---------------------------------------------------------------------------

/**
 * Fake client whose search returns the given live campaign statuses (the only read a
 * campaignStatus-only plan triggers). `mutations` records every mutate batch so an
 * --apply run can be asserted; each returns a synthetic resource_name per op.
 */
function statusClient(live: Record<number, string>): {
  client: AdsClient;
  mutations: Array<{ customerId: string; operations: AdsMutateOperation[] }>;
} {
  const rows = Object.entries(live).map(([id, status]) => ({
    campaign: { id: Number(id), status },
  }));
  const mutations: Array<{ customerId: string; operations: AdsMutateOperation[] }> = [];
  const client: AdsClient = {
    async search<Row = unknown>(_customerId: string, _query: string): Promise<Row[]> {
      return rows as Row[];
    },
    async searchStructured<Row = unknown>(_customerId: string, _args: SearchArgs): Promise<Row[]> {
      return rows as Row[];
    },
    async mutate(customerId: string, operations: AdsMutateOperation[]): Promise<MutateResult> {
      mutations.push({ customerId, operations });
      return { results: operations.map(() => ({ resource_name: "customers/1/campaigns/x" })) };
    },
  };
  return { client, mutations };
}

/** Capture everything written to stdout (console.log + emitJson) in order. */
function captureStdout(): { text: () => string } {
  let buf = "";
  const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    buf += args.map((a) => String(a)).join(" ") + "\n";
  });
  const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown): boolean => {
    buf += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  });
  return {
    text: () => {
      log.mockRestore();
      write.mockRestore();
      return buf;
    },
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "apply-fixes-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  failWriteForCampaignName = null;
});

/** Write a campaignStatus-only plan and return its path. */
function writePlan(blocks: Array<Record<string, unknown>>): string {
  const p = join(dir, "plan.json");
  writeFileSync(p, JSON.stringify({ customerId: "1111111111", campaignStatus: blocks }));
  return p;
}

/**
 * Fake client whose search returns the given live campaign network_settings
 * (target_search_network from `live`, target_google_search from `googleSearch` —
 * defaulting to `true` so existing enable/disable tests aren't blocked by the
 * ENABLE precondition unless a test opts in). Pass `omitNetworkSettings` ids to
 * simulate the API returning a row with no network_settings sub-message at all
 * (the "unknown state" case liveSearchPartners must not crash on).
 * `mutations` records every mutate batch.
 */
function searchPartnersClient(
  live: Record<number, boolean>,
  googleSearch: Record<number, boolean> = {},
  omitNetworkSettings: number[] = [],
): {
  client: AdsClient;
  mutations: Array<{ customerId: string; operations: AdsMutateOperation[] }>;
} {
  const rows = Object.entries(live).map(([id, enabled]) => ({
    campaign: {
      id: Number(id),
      network_settings: omitNetworkSettings.includes(Number(id))
        ? undefined
        : { target_search_network: enabled, target_google_search: googleSearch[Number(id)] ?? true },
    },
  }));
  const mutations: Array<{ customerId: string; operations: AdsMutateOperation[] }> = [];
  const client: AdsClient = {
    async search<Row = unknown>(_customerId: string, _query: string): Promise<Row[]> {
      return rows as Row[];
    },
    async searchStructured<Row = unknown>(_customerId: string, _args: SearchArgs): Promise<Row[]> {
      return rows as Row[];
    },
    async mutate(customerId: string, operations: AdsMutateOperation[]): Promise<MutateResult> {
      mutations.push({ customerId, operations });
      return { results: operations.map(() => ({ resource_name: "customers/1/campaigns/x" })) };
    },
  };
  return { client, mutations };
}

/** Write a searchPartners-only plan and return its path. */
function writeSearchPartnersPlan(blocks: Array<Record<string, unknown>>): string {
  const p = join(dir, "plan.json");
  writeFileSync(p, JSON.stringify({ customerId: "1111111111", searchPartners: blocks }));
  return p;
}

// ---------------------------------------------------------------------------
// Early-exit guards (return before any client work)
// ---------------------------------------------------------------------------

describe("early-exit guards", () => {
  it("no path arg returns 2", async () => {
    captureStdout();
    expect(await main([])).toBe(2);
  });

  it("only a flag, no path returns 2", async () => {
    captureStdout();
    expect(await main(["--apply"])).toBe(2);
  });

  it("missing file returns 2", async () => {
    captureStdout();
    expect(await main([join(dir, "nope.json")])).toBe(2);
  });

  it("plan missing customerId returns 2", async () => {
    const p = join(dir, "plan.json");
    writeFileSync(p, JSON.stringify({ rewrites: [] }));
    captureStdout();
    expect(await main([p])).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// campaignStatus (campaign on/off) — dry-run + apply
// ---------------------------------------------------------------------------

describe("campaignStatus path", () => {
  it("dry-run lists changes and warns on enable", async () => {
    const { client, mutations } = statusClient({ 100: "PAUSED" });
    currentClient = client;
    const plan = writePlan([{ campaignId: "100", status: "ENABLED" }]);

    const cap = captureStdout();
    expect(await main([plan])).toBe(0); // dry-run (no --apply)
    const out = cap.text();

    expect(out).toContain("status PAUSED -> ENABLED");
    expect(out).toContain("WARNING: ENABLE starts live spend");
    expect(mutations).toEqual([]); // dry-run never mutates
    // JSON envelope carries the change + the loud live-spend key.
    const payload = JSON.parse(out.slice(out.indexOf("{")));
    expect(payload.applied).toBe(false);
    expect(payload.enableStartsLiveSpend).toEqual(["100"]);
    expect(payload.campaignStatusChanges[0].campaignId).toBe("100");
  });

  it("idempotent skip (no-op flip is never mutated)", async () => {
    const { client, mutations } = statusClient({ 100: "ENABLED" });
    currentClient = client;
    const plan = writePlan([{ campaignId: "100", status: "ENABLED" }]);

    const cap = captureStdout();
    expect(await main([plan, "--apply"])).toBe(0);
    const out = cap.text();

    expect(out).toContain("already ENABLED, skipped");
    expect(mutations).toEqual([]); // no-op flip is never mutated
    const payload = JSON.parse(out.slice(out.indexOf("{")));
    expect(payload.applied).toBe(true);
    expect(payload.campaignStatusChanges).toEqual([]);
    expect(payload.campaignStatusSkipped[0].campaignId).toBe("100");
  });

  it("apply of a PAUSE flip mutates and does not warn about live spend", async () => {
    const { client, mutations } = statusClient({ 100: "ENABLED" });
    currentClient = client;
    const plan = writePlan([{ campaignId: "100", status: "PAUSED" }]);

    const cap = captureStdout();
    expect(await main([plan, "--apply"])).toBe(0);
    const out = cap.text();

    expect(mutations.length).toBe(1); // PAUSE flip executed
    expect(out).not.toContain("WARNING: ENABLE starts live spend"); // PAUSE is not a live-spend warning
    const payload = JSON.parse(out.slice(out.indexOf("{")));
    expect(payload.enableStartsLiveSpend).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// searchPartners (campaign network_settings.target_search_network toggle) — dry-run + apply
// ---------------------------------------------------------------------------

describe("searchPartners path", () => {
  it("dry-run turning OFF lists the change and does not warn", async () => {
    const { client, mutations } = searchPartnersClient({ 100: true });
    currentClient = client;
    const plan = writeSearchPartnersPlan([{ campaignId: "100", enabled: false }]);

    const cap = captureStdout();
    expect(await main([plan])).toBe(0); // dry-run (no --apply)
    const out = cap.text();

    expect(out).toContain("search partners true -> false");
    expect(out).not.toContain("WARNING: search partners ON increases reach");
    expect(mutations).toEqual([]); // dry-run never mutates
    const payload = JSON.parse(out.slice(out.indexOf("{")));
    expect(payload.applied).toBe(false);
    expect(payload.searchPartnersEnableIncreasesReach).toEqual([]);
    expect(payload.searchPartnersChanges[0].campaignId).toBe("100");
  });

  it("dry-run turning ON warns and carries the envelope key", async () => {
    const { client, mutations } = searchPartnersClient({ 100: false });
    currentClient = client;
    const plan = writeSearchPartnersPlan([{ campaignId: "100", enabled: true }]);

    const cap = captureStdout();
    expect(await main([plan])).toBe(0);
    const out = cap.text();

    expect(out).toContain("search partners false -> true");
    expect(out).toContain("WARNING: search partners ON increases reach");
    expect(mutations).toEqual([]);
    const payload = JSON.parse(out.slice(out.indexOf("{")));
    expect(payload.searchPartnersEnableIncreasesReach).toEqual(["100"]);
  });

  it("idempotent skip (no-op flip is never mutated)", async () => {
    const { client, mutations } = searchPartnersClient({ 100: false });
    currentClient = client;
    const plan = writeSearchPartnersPlan([{ campaignId: "100", enabled: false }]);

    const cap = captureStdout();
    expect(await main([plan, "--apply"])).toBe(0);
    const out = cap.text();

    expect(out).toContain("already false, skipped");
    expect(mutations).toEqual([]);
    const payload = JSON.parse(out.slice(out.indexOf("{")));
    expect(payload.applied).toBe(true);
    expect(payload.searchPartnersChanges).toEqual([]);
    expect(payload.searchPartnersSkipped[0].campaignId).toBe("100");
  });

  it("apply mutates only network_settings.target_search_network", async () => {
    const { client, mutations } = searchPartnersClient({ 100: true });
    currentClient = client;
    const plan = writeSearchPartnersPlan([{ campaignId: "100", enabled: false }]);

    const cap = captureStdout();
    expect(await main([plan, "--apply"])).toBe(0);
    cap.text();

    expect(mutations.length).toBe(1);
    expect(mutations[0]!.operations).toEqual([
      {
        entity: "campaign",
        operation: "update",
        resource: {
          resource_name: "customers/1111111111/campaigns/100",
          network_settings: { target_search_network: false },
        },
      },
    ]);
  });

  it("rejects enabling when the campaign's target_google_search is off", async () => {
    const { client, mutations } = searchPartnersClient({ 100: false }, { 100: false });
    currentClient = client;
    const plan = writeSearchPartnersPlan([{ campaignId: "100", enabled: true }]);

    const cap = captureStdout();
    expect(await main([plan])).toBe(1); // validation failure, not a live API error
    const out = cap.text();

    expect(out).toContain("VALIDATION FAILED");
    expect(out).toContain("Google Search targeting is off");
    expect(mutations).toEqual([]); // never reaches the mutate call
  });

  it("does not reject disabling when target_google_search is off", async () => {
    const { client, mutations } = searchPartnersClient({ 100: true }, { 100: false });
    currentClient = client;
    const plan = writeSearchPartnersPlan([{ campaignId: "100", enabled: false }]);

    const cap = captureStdout();
    expect(await main([plan, "--apply"])).toBe(0);
    cap.text();

    expect(mutations.length).toBe(1); // OFF has no target_google_search precondition
  });

  it("a campaign row missing network_settings entirely is treated as unknown, not a crash", async () => {
    const { client, mutations } = searchPartnersClient({ 100: false }, {}, [100]);
    currentClient = client;
    const plan = writeSearchPartnersPlan([{ campaignId: "100", enabled: false }]);

    const cap = captureStdout();
    expect(await main([plan])).toBe(0); // no crash; unknown live state is treated as a change
    const out = cap.text();

    expect(out).toContain("search partners None -> false");
    expect(mutations).toEqual([]); // dry-run
  });
});

// ---------------------------------------------------------------------------
// Live keyword identity keys — GAQL returns match_type as a RAW NUMERIC enum
// (e.g. 3 === PHRASE), and the live map is built here but looked up in plan.ts.
// These guard both halves of a regression that made every remove/pause/dedup
// silently fail: (a) decoding the numeric match_type to its name, and (b) using
// the SAME identity-key serialization (plan.ts's keyStr) on both sides.
// ---------------------------------------------------------------------------

/** Fake client returning fixed rows for any search; records no mutations. */
function rowsClient(rows: unknown[]): AdsClient {
  return {
    async search<Row = unknown>(_customerId: string, _query: string): Promise<Row[]> {
      return rows as Row[];
    },
    async searchStructured<Row = unknown>(_customerId: string, _args: SearchArgs): Promise<Row[]> {
      return rows as Row[];
    },
    async mutate(_customerId: string, _operations: AdsMutateOperation[]): Promise<MutateResult> {
      return { results: [] };
    },
  };
}

describe("live keyword identity keys (numeric match_type)", () => {
  it("livePositiveKeywords: a live PHRASE keyword (match_type 3) is seen as present by validate", async () => {
    const client = rowsClient([
      {
        ad_group: { id: 111 },
        ad_group_criterion: {
          resource_name: "customers/1/adGroupCriteria/111~1",
          keyword: { text: "Running Shoes", match_type: 3 }, // raw numeric enum, as the SDK returns it
        },
      },
    ]);
    const livePos = await livePositiveKeywords(client, "1", [111]);
    // The map key must match what plan.ts builds for the SAME keyword on the plan side.
    const errs = validate(
      { keywords: [{ adGroupId: "111", remove: [{ text: "running shoes", matchType: "PHRASE" }] }] },
      new Map(),
      new Map(),
      livePos,
    );
    expect(errs).toEqual([]); // pre-fix: "cannot remove running shoes[PHRASE] — not present on the ad group"
  });

  it("livePositiveKeywords: a mismatched match type is still correctly rejected", async () => {
    const client = rowsClient([
      {
        ad_group: { id: 111 },
        ad_group_criterion: {
          resource_name: "customers/1/adGroupCriteria/111~1",
          keyword: { text: "running shoes", match_type: 3 }, // live is PHRASE
        },
      },
    ]);
    const livePos = await livePositiveKeywords(client, "1", [111]);
    const errs = validate(
      { keywords: [{ adGroupId: "111", remove: [{ text: "running shoes", matchType: "EXACT" }] }] }, // plan asks EXACT
      new Map(),
      new Map(),
      livePos,
    );
    expect(errs).toEqual([
      "keywords adGroup 111: cannot remove running shoes[EXACT] — not present on the ad group",
    ]);
  });

  it("liveNegatives: numeric match_type dedups against a plan add of the same negative", async () => {
    const client = rowsClient([
      { campaign: { id: 222 }, campaign_criterion: { keyword: { text: "Free", match_type: 2 } } }, // 2 === EXACT
    ]);
    const liveNeg = await liveNegatives(client, "1", [222]);
    const set = liveNeg.get(222)!;
    // Key is byte-identical to plan.ts's keyStr(negKey("free","EXACT")) → text is lowercased, name decoded.
    expect(set.has("free\x1fEXACT")).toBe(true);
    expect(set.has("free\x1f2")).toBe(false); // never the raw numeric form
  });
});

// ---------------------------------------------------------------------------
// adGroups (add a new ad group to an existing campaign) — dry-run + apply
// ---------------------------------------------------------------------------

/**
 * Fake client whose search returns the given live ad-group name rows (the only read
 * an adGroups-only plan triggers), and records every mutate batch. Each mutate
 * returns a synthetic resource_name per op so createAdGroup/RSA/keywords resolve.
 */
function adGroupNamesClient(liveNames: Record<number, string[]>): {
  client: AdsClient;
  mutations: Array<{ customerId: string; operations: AdsMutateOperation[] }>;
} {
  const rows = Object.entries(liveNames).flatMap(([id, names]) =>
    names.map((name) => ({ campaign: { id: Number(id) }, ad_group: { name } })),
  );
  const mutations: Array<{ customerId: string; operations: AdsMutateOperation[] }> = [];
  const client: AdsClient = {
    async search<Row = unknown>(_customerId: string, _query: string): Promise<Row[]> {
      return rows as Row[];
    },
    async searchStructured<Row = unknown>(_customerId: string, _args: SearchArgs): Promise<Row[]> {
      return rows as Row[];
    },
    async mutate(customerId: string, operations: AdsMutateOperation[]): Promise<MutateResult> {
      mutations.push({ customerId, operations });
      return { results: operations.map((_, i) => ({ resource_name: `customers/1/x/${i}` })) };
    },
  };
  return { client, mutations };
}

/** A valid ad-group body authored with bare-string headlines/keywords (normalized at the boundary). */
function adGroupBody(name: string): Record<string, unknown> {
  return {
    name,
    defaultBidMicros: 2_000_000,
    responsiveSearchAd: {
      headlines: Array.from({ length: 15 }, (_, i) => `headline ${i}`),
      descriptions: Array.from({ length: 4 }, (_, i) => `description ${i}`),
      finalUrl: "https://example.com/ideas/x",
    },
    keywords: ["close deals ai"],
  };
}

/** Write an adGroups-only plan and return its path. */
function writeAdGroupsPlan(blocks: Array<Record<string, unknown>>): string {
  const p = join(dir, "plan.json");
  writeFileSync(p, JSON.stringify({ customerId: "1111111111", adGroups: blocks }));
  return p;
}

describe("adGroups (add-ad-group) path", () => {
  it("dry-run lists the create and never mutates", async () => {
    const { client, mutations } = adGroupNamesClient({ 100: [] });
    currentClient = client;
    const plan = writeAdGroupsPlan([{ campaignId: "100", adGroup: adGroupBody("close deals ai") }]);

    const cap = captureStdout();
    expect(await main([plan])).toBe(0); // dry-run (no --apply)
    const out = cap.text();

    expect(out).toContain("+ ad group 'close deals ai' -> campaign 100");
    expect(out).toContain("ad PAUSED");
    expect(mutations).toEqual([]); // dry-run never mutates
  });

  it("apply creates ad group + RSA + keywords (3 mutate batches)", async () => {
    const { client, mutations } = adGroupNamesClient({ 100: [] });
    currentClient = client;
    const plan = writeAdGroupsPlan([{ campaignId: "100", adGroup: adGroupBody("close deals ai") }]);

    const cap = captureStdout();
    expect(await main([plan, "--apply"])).toBe(0);
    cap.text();

    // createAdGroup, createResponsiveSearchAd, createKeywords -> one mutate batch each.
    expect(mutations).toHaveLength(3);
    const [ag, rsa, kw] = mutations;
    expect(ag!.operations[0]!.entity).toBe("ad_group");
    expect(ag!.operations[0]!.resource.campaign).toBe("customers/1111111111/campaigns/100");
    expect(rsa!.operations[0]!.entity).toBe("ad_group_ad");
    expect(kw!.operations[0]!.entity).toBe("ad_group_criterion");
  });

  it("idempotent skip: a name already live in the campaign is not re-created", async () => {
    const { client, mutations } = adGroupNamesClient({ 100: ["Close Deals AI"] }); // case-insensitive collision
    currentClient = client;
    const plan = writeAdGroupsPlan([{ campaignId: "100", adGroup: adGroupBody("close deals ai") }]);

    const cap = captureStdout();
    expect(await main([plan, "--apply"])).toBe(0);
    const out = cap.text();

    expect(out).toContain("already in campaign 100, skipped");
    expect(mutations).toEqual([]); // nothing created
  });

  it("a bad ad group (14 headlines) fails validation and mutates nothing", async () => {
    const { client, mutations } = adGroupNamesClient({ 100: [] });
    currentClient = client;
    const bad = adGroupBody("bad group");
    (bad.responsiveSearchAd as { headlines: unknown[] }).headlines = Array.from({ length: 14 }, (_, i) => ({
      text: `headline ${i}`,
    }));
    const plan = writeAdGroupsPlan([{ campaignId: "100", adGroup: bad }]);

    const cap = captureStdout();
    expect(await main([plan, "--apply"])).toBe(1); // validation failure
    const out = cap.text();

    expect(out).toContain("VALIDATION FAILED");
    expect(out).toContain("adGroup.responsiveSearchAd.headlines");
    expect(mutations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// languages (English-only) — dry-run + apply
// ---------------------------------------------------------------------------

/**
 * Fake client whose search returns the given live language criteria per campaign as
 * {campaignId: [languageConstant, ...]}, each synthesized with a criterion resource
 * name so a remove can be asserted. `mutations` records every mutate batch.
 */
function languagesClient(live: Record<number, string[]>): {
  client: AdsClient;
  mutations: Array<{ customerId: string; operations: AdsMutateOperation[] }>;
} {
  const rows = Object.entries(live).flatMap(([id, langs]) =>
    langs.map((lc) => ({
      campaign: { id: Number(id) },
      campaign_criterion: {
        resource_name: `customers/1111111111/campaignCriteria/${id}~${lc.split("/")[1]}`,
        language: { language_constant: lc },
      },
    })),
  );
  const mutations: Array<{ customerId: string; operations: AdsMutateOperation[] }> = [];
  const client: AdsClient = {
    async search<Row = unknown>(_customerId: string, _query: string): Promise<Row[]> {
      return rows as Row[];
    },
    async searchStructured<Row = unknown>(_customerId: string, _args: SearchArgs): Promise<Row[]> {
      return rows as Row[];
    },
    async mutate(customerId: string, operations: AdsMutateOperation[]): Promise<MutateResult> {
      mutations.push({ customerId, operations });
      return { results: operations.map(() => ({ resource_name: "customers/1/campaigns/x" })) };
    },
  };
  return { client, mutations };
}

function writeLanguagesPlan(blocks: Array<Record<string, unknown>>): string {
  const p = join(dir, "plan.json");
  writeFileSync(p, JSON.stringify({ customerId: "1111111111", languages: blocks }));
  return p;
}

describe("languages path", () => {
  it("dry-run: default all-languages campaign is narrowed to English (add), never mutated", async () => {
    const { client, mutations } = languagesClient({ 100: [] }); // no live language criteria
    currentClient = client;
    const plan = writeLanguagesPlan([{ campaignId: "100" }]);

    const cap = captureStdout();
    expect(await main([plan])).toBe(0); // dry-run
    const out = cap.text();

    expect(out).toContain("languages campaign 100: English only (+1 add, -0 remove)");
    expect(mutations).toEqual([]); // dry-run never mutates
  });

  it("apply: adds English and removes the other live languages (English-exclusive)", async () => {
    // German (1001) + Spanish (1003) live, English absent.
    const { client, mutations } = languagesClient({ 100: ["languageConstants/1001", "languageConstants/1003"] });
    currentClient = client;
    const plan = writeLanguagesPlan([{ campaignId: "100" }]);

    const cap = captureStdout();
    expect(await main([plan, "--apply"])).toBe(0);
    const out = cap.text();

    expect(out).toContain("English only (+1 add, -2 remove)");
    expect(mutations).toHaveLength(1);
    const ops = mutations[0]!.operations;
    expect(ops.map((o) => o.operation)).toEqual(["create", "remove", "remove"]);
    expect((ops[0]!.resource.language as { language_constant: string }).language_constant).toBe(
      "languageConstants/1000",
    );
    expect(ops.slice(1).map((o) => o.resource.resource_name)).toEqual([
      "customers/1111111111/campaignCriteria/100~1001",
      "customers/1111111111/campaignCriteria/100~1003",
    ]);
  });

  it("idempotent skip: a campaign already English-only is not re-mutated", async () => {
    const { client, mutations } = languagesClient({ 100: ["languageConstants/1000"] }); // English is the sole language
    currentClient = client;
    const plan = writeLanguagesPlan([{ campaignId: "100" }]);

    const cap = captureStdout();
    expect(await main([plan, "--apply"])).toBe(0);
    const out = cap.text();

    expect(out).toContain("languages campaign 100: already English only, skipped");
    expect(mutations).toEqual([]); // nothing mutated
  });
});

// ---------------------------------------------------------------------------
// rewrites — display-path (path1/path2) change (issue #14, item 5a)
// ---------------------------------------------------------------------------

/** Recording client for rewrite-only plans: no live-state reads are needed, so
 * search returns []; mutate records each batch so the built RSA op can be asserted. */
function rewritesClient(): {
  client: AdsClient;
  mutations: Array<{ customerId: string; operations: AdsMutateOperation[] }>;
} {
  const mutations: Array<{ customerId: string; operations: AdsMutateOperation[] }> = [];
  const client: AdsClient = {
    async search<Row = unknown>(_customerId: string, _query: string): Promise<Row[]> {
      return [] as Row[];
    },
    async searchStructured<Row = unknown>(_customerId: string, _args: SearchArgs): Promise<Row[]> {
      return [] as Row[];
    },
    async mutate(customerId: string, operations: AdsMutateOperation[]): Promise<MutateResult> {
      mutations.push({ customerId, operations });
      return { results: operations.map(() => ({ resource_name: "customers/1/ads/x" })) };
    },
  };
  return { client, mutations };
}

/** 15 unique headlines / 4 unique descriptions so a rewrite passes validation. */
function rewrite(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    adId: "123",
    headlines: Array.from({ length: 15 }, (_, i) => `headline ${i}`),
    descriptions: Array.from({ length: 4 }, (_, i) => `description ${i}`),
    ...extra,
  };
}

function writeRewritesPlan(blocks: Array<Record<string, unknown>>): string {
  const p = join(dir, "plan.json");
  writeFileSync(p, JSON.stringify({ customerId: "1111111111", rewrites: blocks }));
  return p;
}

/** Pull the responsive_search_ad resource off the (single) recorded ad update op. */
function recordedRsa(mutations: Array<{ operations: AdsMutateOperation[] }>): Record<string, unknown> {
  const op = mutations.flatMap((m) => m.operations).find((o) => o.entity === "ad" && o.operation === "update");
  expect(op).toBeDefined();
  return (op!.resource as Record<string, unknown>).responsive_search_ad as Record<string, unknown>;
}

describe("rewrites display path", () => {
  it("sets path1 (lowercased) on the RSA update op", async () => {
    const { client, mutations } = rewritesClient();
    currentClient = client;
    const plan = writeRewritesPlan([rewrite({ path1: "Demo" })]);

    captureStdout();
    expect(await main([plan, "--apply"])).toBe(0);

    expect(recordedRsa(mutations).path1).toBe("demo");
  });

  it("sets both path1 and path2 when provided (both lowercased)", async () => {
    const { client, mutations } = rewritesClient();
    currentClient = client;
    const plan = writeRewritesPlan([rewrite({ path1: "Demo", path2: "Trial" })]);

    captureStdout();
    expect(await main([plan, "--apply"])).toBe(0);

    const rsa = recordedRsa(mutations);
    expect(rsa.path1).toBe("demo");
    expect(rsa.path2).toBe("trial");
  });

  it("leaves the display path untouched for a copy-only rewrite", async () => {
    const { client, mutations } = rewritesClient();
    currentClient = client;
    const plan = writeRewritesPlan([rewrite({})]);

    captureStdout();
    expect(await main([plan, "--apply"])).toBe(0);

    const rsa = recordedRsa(mutations);
    expect("path1" in rsa).toBe(false);
    expect("path2" in rsa).toBe(false);
  });

  it("dry-run surfaces the display-path change before --apply", async () => {
    const { client, mutations } = rewritesClient();
    currentClient = client;
    const plan = writeRewritesPlan([rewrite({ path1: "demo", path2: "trial" })]);

    const cap = captureStdout();
    expect(await main([plan])).toBe(0); // no --apply
    const out = cap.text();

    expect(out).toContain("display path /demo/trial");
    expect(mutations).toEqual([]); // dry-run mutates nothing
  });

  it("rejects an invalid display path before mutating (path2 without path1)", async () => {
    const { client, mutations } = rewritesClient();
    currentClient = client;
    const plan = writeRewritesPlan([rewrite({ path2: "trial" })]);

    const cap = captureStdout();
    expect(await main([plan, "--apply"])).toBe(1); // validation failure
    const out = cap.text();

    expect(out).toContain("VALIDATION FAILED");
    expect(out).toContain("path2 requires path1");
    expect(mutations).toEqual([]); // never reached the mutate edge
  });
});

// ---------------------------------------------------------------------------
// loadPlan — the single front-door parser. YAML is the authored format; JSON is a
// subset of YAML, so a legacy .json plan must parse to the identical object the
// zod validator then receives. One parser, no schema fork.
// ---------------------------------------------------------------------------
describe("loadPlan (YAML front door)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loadplan-"));
  });

  // A representative plan touching several sections, expressed both ways.
  const yamlPlan = `
customerId: "1111111111"
landingUrl: "https://www.example.com/ideas/close-assistant"
rewrites:
  - adId: 813530865969
    headlines: ["Close Deals Faster", "AI Sales Assistant"]
    descriptions: ["Ship revenue, not busywork."]
    finalUrl: "https://www.example.com/close"
negatives:
  - campaignId: 23955052962
    add:
      - "free"
      - text: "talk to ai"
        matchType: "PHRASE"
budgets:
  - campaignId: 23955052962
    dailyMicros: 50000000
    maxRaisePct: 100
campaignStatus:
  - campaignId: "23955052962"
    status: "ENABLED"
`;

  const jsonPlan = JSON.stringify({
    customerId: "1111111111",
    landingUrl: "https://www.example.com/ideas/close-assistant",
    rewrites: [
      {
        adId: 813530865969,
        headlines: ["Close Deals Faster", "AI Sales Assistant"],
        descriptions: ["Ship revenue, not busywork."],
        finalUrl: "https://www.example.com/close",
      },
    ],
    negatives: [
      { campaignId: 23955052962, add: ["free", { text: "talk to ai", matchType: "PHRASE" }] },
    ],
    budgets: [{ campaignId: 23955052962, dailyMicros: 50000000, maxRaisePct: 100 }],
    campaignStatus: [{ campaignId: "23955052962", status: "ENABLED" }],
  });

  it("parses a YAML plan and the equivalent JSON plan to the identical object", () => {
    const yamlPath = join(dir, "plan.yaml");
    const jsonPath = join(dir, "plan.json");
    writeFileSync(yamlPath, yamlPlan);
    writeFileSync(jsonPath, jsonPlan);

    const fromYaml = loadPlan(yamlPath);
    const fromJson = loadPlan(jsonPath);

    expect(fromYaml).toEqual(fromJson);
    // Spot-check the value the validator downstream depends on survived the parse.
    expect(fromYaml.customerId).toBe("1111111111");
    expect(fromYaml.negatives?.[0]?.add).toEqual(["free", { text: "talk to ai", matchType: "PHRASE" }]);
  });
});

// ---------------------------------------------------------------------------
// adbriefs staging (043-adbrief-stage-update): resolve the plan's ids via the
// campaign's state file, stage into the on-disk brief, diff/write it around the
// (unchanged) live-mutation sequence. These tests chdir into a scratch "repo root"
// containing adbriefs/<slug>.yaml + adbriefs/<slug>.state.yaml, mirroring how
// create.test.ts exercises create's own adbriefs/ persist gate.
// ---------------------------------------------------------------------------

const STAGING_SLUG = "demo-search";

/** A minimal valid brief YAML for the staging campaign (one ad group: "buyers"). */
function stagingBriefYaml(): string {
  const headlines = Array.from({ length: 15 }, (_, i) => `        - text: "Headline number ${i + 1}"`).join("\n");
  const descriptions = Array.from({ length: 4 }, (_, i) => `        - text: "Description number ${i + 1} ok"`).join(
    "\n",
  );
  return [
    'name: "demo-search"',
    "version: 1",
    "campaign:",
    '  name: "Demo Search"',
    "  budgetMicros: 25000000",
    "adGroups:",
    "  - name: buyers",
    "    defaultBidMicros: 1500000",
    "    keywords:",
    '      - text: "buy widgets"',
    "    responsiveSearchAd:",
    '      finalUrl: "https://www.example.com/ideas/widget"',
    "      headlines:",
    headlines,
    "      descriptions:",
    descriptions,
    "",
  ].join("\n");
}

/** The matching `<slug>.state.yaml`: campaign 500, ad group 600, ad 700. */
function stagingStateYaml(): string {
  return [
    "campaign:",
    '  name: "Demo Search"',
    '  campaignId: "500"',
    "  budgetId: null",
    "adGroups:",
    "  - name: buyers",
    '    adGroupId: "600"',
    '    adId: "700"',
    "",
  ].join("\n");
}

/** Fake client: no live-state reads needed for a rewrites/budgets-only plan (both
 * short-circuit to an empty query when their id list would be []; budgets always
 * queries). `failOn` lets a test simulate one mutate batch throwing mid-sequence. */
function stagingClient(
  budgetRows: unknown[] = [],
  failOn?: (op: AdsMutateOperation) => boolean,
): { client: AdsClient; mutations: Array<{ customerId: string; operations: AdsMutateOperation[] }> } {
  const mutations: Array<{ customerId: string; operations: AdsMutateOperation[] }> = [];
  const client: AdsClient = {
    async search<Row = unknown>(): Promise<Row[]> {
      return [] as Row[];
    },
    async searchStructured<Row = unknown>(): Promise<Row[]> {
      return budgetRows as Row[];
    },
    async mutate(customerId: string, operations: AdsMutateOperation[]): Promise<MutateResult> {
      if (failOn && operations.some(failOn)) {
        throw new Error("simulated Google Ads API failure");
      }
      mutations.push({ customerId, operations });
      return { results: operations.map(() => ({ resource_name: "customers/1111111111/x" })) };
    },
  };
  return { client, mutations };
}

describe("adbriefs staging (dry-run diff, apply write, partial-failure safety)", () => {
  let root: string;
  let prevCwd: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "apply-fixes-staging-")));
    prevCwd = process.cwd();
    process.chdir(root);
    mkdirSync(join(root, "adbriefs"), { recursive: true });
    writeFileSync(join(root, "adbriefs", `${STAGING_SLUG}.yaml`), stagingBriefYaml());
    writeFileSync(join(root, "adbriefs", `${STAGING_SLUG}.state.yaml`), stagingStateYaml());
  });

  afterEach(() => {
    process.chdir(prevCwd);
    rmSync(root, { recursive: true, force: true });
  });

  function briefPath(): string {
    return join(root, "adbriefs", `${STAGING_SLUG}.yaml`);
  }

  function onDiskBrief() {
    return parseBrief(yamlParseForTest(readFileSync(briefPath(), "utf8")));
  }

  function rewritePlan(): string {
    const p = join(root, "plan.json");
    writeFileSync(
      p,
      JSON.stringify({
        customerId: "1111111111",
        rewrites: [
          {
            adId: "700",
            headlines: Array.from({ length: 15 }, (_, i) => `staged headline ${i}`),
            descriptions: Array.from({ length: 4 }, (_, i) => `staged description ${i}`),
          },
        ],
      }),
    );
    return p;
  }

  it("dry-run (T009): stages + prints a non-empty brief diff and writes NO file under adbriefs/", async () => {
    const { client } = stagingClient();
    currentClient = client;
    const before = readFileSync(briefPath(), "utf8");

    const cap = captureStdout();
    const code = await main([rewritePlan()]);
    const out = cap.text();

    expect(code).toBe(0);
    expect(out).toContain(`adbriefs brief ${briefPath()}`);
    expect(out).toContain("staged headline 0");
    expect(readFileSync(briefPath(), "utf8")).toBe(before); // untouched (FR-004)
    const payload = JSON.parse(out.slice(out.indexOf("{")));
    expect(payload.briefs[0].briefSynced).toBe(false);
    expect(payload.briefs[0].briefDiff.changed).toBe(true);
  });

  it("apply (T015): writes the staged brief matching the dry-run diff and reports briefSynced true", async () => {
    const { client: dryClient } = stagingClient();
    currentClient = dryClient;
    const dryCap = captureStdout();
    await main([rewritePlan()]);
    const dryPayload = JSON.parse(dryCap.text().slice(dryCap.text().indexOf("{")));

    const { client } = stagingClient();
    currentClient = client;
    const cap = captureStdout();
    const code = await main([rewritePlan(), "--apply"]);
    const out = cap.text();

    expect(code).toBe(0);
    const payload = JSON.parse(out.slice(out.indexOf("{")));
    expect(payload.briefs[0].briefSynced).toBe(true);
    expect(payload.briefs[0].briefPath).toBe(briefPath());
    expect(payload.briefs[0].briefDiff.added).toBe(dryPayload.briefs[0].briefDiff.added);

    const persisted = onDiskBrief();
    expect(persisted.adGroups[0]!.responsiveSearchAd.headlines.map((h: { text: string }) => h.text)).toEqual(
      Array.from({ length: 15 }, (_, i) => `staged headline ${i}`),
    );
  });

  it("partial failure (T016): a mutation failure leaves the brief byte-for-byte unchanged and reports briefSynced false", async () => {
    // Budgets query returns a live budget for campaign 500 so validate's guardrail passes;
    // the budgets mutate step is made to throw, simulating a live API rejection AFTER the
    // rewrite step's mutate has already gone out.
    const budgetRows = [{ campaign: { id: 500 }, campaign_budget: { resource_name: "customers/1/campaignBudgets/9", amount_micros: 25_000_000 } }];
    const { client } = stagingClient(budgetRows, (op) => op.entity === "campaign_budget");
    currentClient = client;

    const p = join(root, "plan.json");
    writeFileSync(
      p,
      JSON.stringify({
        customerId: "1111111111",
        rewrites: [
          {
            adId: "700",
            headlines: Array.from({ length: 15 }, (_, i) => `staged headline ${i}`),
            descriptions: Array.from({ length: 4 }, (_, i) => `staged description ${i}`),
          },
        ],
        budgets: [{ campaignId: 500, dailyMicros: 30_000_000 }],
      }),
    );

    const before = readFileSync(briefPath(), "utf8");
    const cap = captureStdout();
    const code = await main([p, "--apply"]);
    const out = cap.text();

    expect(code).toBe(1);
    expect(out).toContain("diverged");
    expect(readFileSync(briefPath(), "utf8")).toBe(before); // byte-for-byte unchanged
    const payload = JSON.parse(out.slice(out.indexOf("{")));
    expect(payload.ok).toBe(false);
    expect(payload.briefs[0].briefSynced).toBe(false);
  });

  it("no state file (T020): live mutation still applies; no adbriefs/ file is created or modified; envelope reports the skip", async () => {
    rmSync(join(root, "adbriefs", `${STAGING_SLUG}.state.yaml`));
    rmSync(join(root, "adbriefs", `${STAGING_SLUG}.yaml`));
    // No adbriefs/ contents at all for this campaign — the plan's adId cannot resolve.
    const { client, mutations } = stagingClient();
    currentClient = client;

    const cap = captureStdout();
    const code = await main([rewritePlan(), "--apply"]);
    const out = cap.text();

    expect(code).toBe(0);
    expect(mutations.length).toBeGreaterThan(0); // live mutation still ran (unaffected by the skip)
    expect(existsSync(join(root, "adbriefs", `${STAGING_SLUG}.yaml`))).toBe(false);
    expect(existsSync(join(root, "adbriefs", `${STAGING_SLUG}.state.yaml`))).toBe(false);
    const payload = JSON.parse(out.slice(out.indexOf("{")));
    expect(payload.briefStagingSkipped).toBe(true);
    expect(payload.briefStagingSkipReason).toBe("no-state-file");
  });

  it("missing-brief: a state file exists but its adbriefs/<slug>.yaml was deleted; live mutation still proceeds for that entity", async () => {
    rmSync(join(root, "adbriefs", `${STAGING_SLUG}.yaml`)); // state file stays — the id still resolves
    const { client, mutations } = stagingClient();
    currentClient = client;

    const cap = captureStdout();
    const code = await main([rewritePlan(), "--apply"]);
    const out = cap.text();

    expect(code).toBe(0);
    expect(mutations.some((m) => m.operations.some((o) => o.entity === "ad"))).toBe(true); // live mutation still ran
    expect(out).toContain("WARNING");
    expect(out).toContain(`${STAGING_SLUG}.state.yaml exists but`);
    expect(existsSync(join(root, "adbriefs", `${STAGING_SLUG}.yaml`))).toBe(false); // never fabricated

    const payload = JSON.parse(out.slice(out.indexOf("{")));
    const briefEntry = payload.briefs.find((b: { slug: string }) => b.slug === STAGING_SLUG);
    expect(briefEntry.briefStagingSkipReason).toBe("missing-brief");
    expect(briefEntry.briefSynced).toBe(false);
  });

  it("FR-007 collision: an on-disk brief naming a different campaign than the plan resolves is refused in both dry-run and --apply, without blocking an unrelated slug", async () => {
    // Overwrite campaign A's on-disk brief so its campaign.name no longer matches
    // what the state index says this slug's campaignId (500) resolves to ("Demo
    // Search") — simulating a hand-edited/renamed brief.
    const collidingBrief = stagingBriefYaml().replace('name: "Demo Search"', 'name: "Some Other Campaign"');
    writeFileSync(briefPath(), collidingBrief);
    writeFileSync(briefPathB(), stagingBriefYamlB());
    writeFileSync(join(root, "adbriefs", `${STAGING_SLUG_B}.state.yaml`), stagingStateYamlB());

    const budgetRows = [
      { campaign: { id: 501 }, campaign_budget: { resource_name: "customers/1/campaignBudgets/9", amount_micros: 25_000_000 } },
    ];
    const p = join(root, "plan.json");
    writeFileSync(
      p,
      JSON.stringify({
        customerId: "1111111111",
        rewrites: [
          {
            adId: "700",
            headlines: Array.from({ length: 15 }, (_, i) => `staged headline ${i}`),
            descriptions: Array.from({ length: 4 }, (_, i) => `staged description ${i}`),
          },
        ],
        budgets: [{ campaignId: 501, dailyMicros: 30_000_000 }],
      }),
    );
    const beforeA = readFileSync(briefPath(), "utf8");

    // Dry-run refuses to stage the colliding slug ...
    {
      const { client } = stagingClient(budgetRows);
      currentClient = client;
      const cap = captureStdout();
      const code = await main([p]);
      const out = cap.text();
      expect(code).toBe(0);
      expect(out).toContain("adbriefs collision");
      const payload = JSON.parse(out.slice(out.indexOf("{")));
      const briefA = payload.briefs.find((b: { slug: string }) => b.slug === STAGING_SLUG);
      const briefB = payload.briefs.find((b: { slug: string }) => b.slug === STAGING_SLUG_B);
      expect(briefA.briefStagingSkipReason).toBe("collision");
      expect(briefB.briefDiff).not.toBeNull(); // unrelated slug still staged normally
      expect(readFileSync(briefPath(), "utf8")).toBe(beforeA);
    }

    // ... and --apply refuses the same way, still never touching campaign A's brief,
    // while campaign B (unrelated) is staged and written normally.
    {
      const { client, mutations } = stagingClient(budgetRows);
      currentClient = client;
      const beforeB = readFileSync(briefPathB(), "utf8");
      const cap = captureStdout();
      const code = await main([p, "--apply"]);
      const out = cap.text();
      expect(mutations.length).toBeGreaterThan(0); // live mutation proceeds regardless of the collision
      expect(out).toContain("adbriefs collision");
      const payload = JSON.parse(out.slice(out.indexOf("{")));
      const briefA = payload.briefs.find((b: { slug: string }) => b.slug === STAGING_SLUG);
      const briefB = payload.briefs.find((b: { slug: string }) => b.slug === STAGING_SLUG_B);
      expect(briefA.briefStagingSkipReason).toBe("collision");
      expect(briefA.briefSynced).toBe(false);
      expect(readFileSync(briefPath(), "utf8")).toBe(beforeA); // never overwritten
      expect(briefB.briefSynced).toBe(true); // unrelated slug unaffected
      expect(readFileSync(briefPathB(), "utf8")).not.toBe(beforeB);
      void code;
    }
  });

  it("FR-011 no-op at the main() integration level: a plan whose edits already match the on-disk brief leaves briefDiff.changed false, briefPath unwritten, and the file byte-for-byte unchanged", async () => {
    // The staging brief's campaign.budgetMicros is already 25_000_000 (stagingBriefYaml);
    // a budgets block asking for that SAME value is a no-op for staging purposes (the
    // live mutate step still runs, as it always did before this feature).
    const budgetRows = [
      { campaign: { id: 500 }, campaign_budget: { resource_name: "customers/1/campaignBudgets/1", amount_micros: 25_000_000 } },
    ];
    const { client } = stagingClient(budgetRows);
    currentClient = client;

    const p = join(root, "plan.json");
    writeFileSync(p, JSON.stringify({ customerId: "1111111111", budgets: [{ campaignId: 500, dailyMicros: 25_000_000 }] }));

    const before = readFileSync(briefPath(), "utf8");
    const cap = captureStdout();
    const code = await main([p, "--apply"]);
    const out = cap.text();

    expect(code).toBe(0);
    const payload = JSON.parse(out.slice(out.indexOf("{")));
    const briefEntry = payload.briefs.find((b: { slug: string }) => b.slug === STAGING_SLUG);
    expect(briefEntry.briefDiff.changed).toBe(false);
    // briefPath reports the resolved-slug's existing on-disk path (staging was never
    // skipped) — the load-bearing assertion for "no-op, never rewritten" is the
    // byte-for-byte file check below, not this field.
    expect(briefEntry.briefPath).toBe(briefPath());
    expect(briefEntry.briefSynced).toBe(true);
    expect(readFileSync(briefPath(), "utf8")).toBe(before); // byte-for-byte unchanged
  });

  // -------------------------------------------------------------------------
  // Multi-campaign partial failure: a single run touching two independent
  // campaigns/briefs, where one campaign's mutation succeeds and the other's
  // throws, must isolate the failure to the brief it actually touched (FR-006,
  // FR-010 edge case) — NOT mark every staged brief in the run unsynced.
  // -------------------------------------------------------------------------

  const STAGING_SLUG_B = "demo-search-b";

  /** A second campaign's brief, independent of STAGING_SLUG (campaign A). */
  function stagingBriefYamlB(): string {
    const headlines = Array.from({ length: 15 }, (_, i) => `        - text: "B headline number ${i + 1}"`).join(
      "\n",
    );
    const descriptions = Array.from(
      { length: 4 },
      (_, i) => `        - text: "B description number ${i + 1} ok"`,
    ).join("\n");
    return [
      'name: "demo-search-b"',
      "version: 1",
      "campaign:",
      '  name: "Demo Search B"',
      "  budgetMicros: 25000000",
      "adGroups:",
      "  - name: sellers",
      "    defaultBidMicros: 1500000",
      "    keywords:",
      '      - text: "sell gadgets"',
      "    responsiveSearchAd:",
      '      finalUrl: "https://www.example.com/ideas/gadget"',
      "      headlines:",
      headlines,
      "      descriptions:",
      descriptions,
      "",
    ].join("\n");
  }

  /** The matching `<slug>.state.yaml` for campaign B: campaign 501, ad group 601. */
  function stagingStateYamlB(): string {
    return [
      "campaign:",
      '  name: "Demo Search B"',
      '  campaignId: "501"',
      "  budgetId: null",
      "adGroups:",
      "  - name: sellers",
      '    adGroupId: "601"',
      "    adId: null",
      "",
    ].join("\n");
  }

  function briefPathB(): string {
    return join(root, "adbriefs", `${STAGING_SLUG_B}.yaml`);
  }

  it("multi-campaign partial failure: campaign A's mutation succeeds and is synced while campaign B's fails and is left unsynced", async () => {
    writeFileSync(briefPathB(), stagingBriefYamlB());
    writeFileSync(join(root, "adbriefs", `${STAGING_SLUG_B}.state.yaml`), stagingStateYamlB());

    // Campaign A (STAGING_SLUG, campaignId 500) gets a rewrite; campaign B (campaignId
    // 501) gets a budget change whose mutate is made to throw. Both campaigns' budget
    // queries must resolve for `validate`'s guardrail, so the fake client's budgetRows
    // covers both campaignIds.
    const budgetRows = [
      { campaign: { id: 501 }, campaign_budget: { resource_name: "customers/1/campaignBudgets/9", amount_micros: 25_000_000 } },
    ];
    const { client, mutations } = stagingClient(budgetRows, (op) => op.entity === "campaign_budget");
    currentClient = client;

    const p = join(root, "plan.json");
    writeFileSync(
      p,
      JSON.stringify({
        customerId: "1111111111",
        rewrites: [
          {
            adId: "700",
            headlines: Array.from({ length: 15 }, (_, i) => `staged headline ${i}`),
            descriptions: Array.from({ length: 4 }, (_, i) => `staged description ${i}`),
          },
        ],
        budgets: [{ campaignId: 501, dailyMicros: 30_000_000 }],
      }),
    );

    const beforeA = readFileSync(briefPath(), "utf8");
    const beforeB = readFileSync(briefPathB(), "utf8");

    const cap = captureStdout();
    const code = await main([p, "--apply"]);
    const out = cap.text();

    // The run as a whole still reports failure (a step failed) ...
    expect(code).toBe(1);
    expect(out).toContain("diverged");
    // ... the rewrite mutate for campaign A still went out despite campaign B's failure ...
    expect(mutations.some((m) => m.operations.some((o) => o.entity === "ad"))).toBe(true);

    const payload = JSON.parse(out.slice(out.indexOf("{")));
    const briefA = payload.briefs.find((b: { slug: string }) => b.slug === STAGING_SLUG);
    const briefB = payload.briefs.find((b: { slug: string }) => b.slug === STAGING_SLUG_B);
    expect(briefA).toBeDefined();
    expect(briefB).toBeDefined();

    // ... campaign A's brief is written and reported synced ...
    expect(briefA.briefSynced).toBe(true);
    expect(briefA.briefPath).toBe(briefPath());
    expect(readFileSync(briefPath(), "utf8")).not.toBe(beforeA);
    const persistedA = onDiskBrief();
    expect(persistedA.adGroups[0]!.responsiveSearchAd.headlines.map((h: { text: string }) => h.text)).toEqual(
      Array.from({ length: 15 }, (_, i) => `staged headline ${i}`),
    );

    // ... campaign B's brief is left byte-for-byte unchanged and reported unsynced.
    expect(briefB.briefSynced).toBe(false);
    expect(readFileSync(briefPathB(), "utf8")).toBe(beforeB);
  });

  // -------------------------------------------------------------------------
  // invalid-result (fix #1): applyPlanToBrief can propose a Brief that violates
  // BriefSchema (e.g. an appendHeadlines that pushes a 15-headline ad group over
  // 15). store.ts's writeBrief does not re-validate before writing, so the staged
  // result must be re-parsed and, on failure, skipped rather than corrupting the
  // on-disk brief.
  // -------------------------------------------------------------------------

  /** Live headline reader returning 14 headlines distinct from the on-disk brief's
   * 15 — so validate()'s appendHeadlines guardrail (must land on exactly 15 live)
   * passes, while the BRIEF-side dedup (against the brief's own stored headlines,
   * not live) lets the appended headline through, producing 16 in the brief. */
  function invalidResultClient(): {
    client: AdsClient;
    mutations: Array<{ customerId: string; operations: AdsMutateOperation[] }>;
  } {
    const mutations: Array<{ customerId: string; operations: AdsMutateOperation[] }> = [];
    const client: AdsClient = {
      async search<Row = unknown>(): Promise<Row[]> {
        return [] as Row[];
      },
      async searchStructured<Row = unknown>(): Promise<Row[]> {
        return [
          {
            ad_group_ad: {
              ad: {
                id: 700,
                responsive_search_ad: {
                  headlines: Array.from({ length: 14 }, (_, i) => ({ text: `live headline ${i}` })),
                },
              },
            },
          },
        ] as Row[];
      },
      async mutate(customerId: string, operations: AdsMutateOperation[]): Promise<MutateResult> {
        mutations.push({ customerId, operations });
        return { results: operations.map(() => ({ resource_name: "customers/1111111111/x" })) };
      },
    };
    return { client, mutations };
  }

  it("invalid-result: an appendHeadlines plan that would push a 15-headline ad group over 15 is skipped, not written to disk", async () => {
    const { client, mutations } = invalidResultClient();
    currentClient = client;

    const p = join(root, "plan.json");
    writeFileSync(
      p,
      JSON.stringify({
        customerId: "1111111111",
        appendHeadlines: [{ adId: 700, add: ["Brand New Headline"] }],
      }),
    );

    const before = readFileSync(briefPath(), "utf8");
    const cap = captureStdout();
    const code = await main([p, "--apply"]);
    const out = cap.text();

    expect(code).toBe(0); // the live mutation itself succeeds; only brief staging is skipped
    expect(mutations.some((m) => m.operations.some((o) => o.entity === "ad"))).toBe(true);
    expect(out.toLowerCase()).toContain("schema");
    expect(readFileSync(briefPath(), "utf8")).toBe(before); // never written — would have been invalid

    const payload = JSON.parse(out.slice(out.indexOf("{")));
    const briefEntry = payload.briefs.find((b: { slug: string }) => b.slug === STAGING_SLUG);
    expect(briefEntry.briefSynced).toBe(false);
    expect(briefEntry.briefStagingSkipReason).toBe("invalid-result");
  });

  // -------------------------------------------------------------------------
  // invalid-brief (fix #6): a corrupt/invalid adbriefs/<slug>.yaml must not crash
  // the whole run — it should skip staging for its own slug only, while an
  // unrelated resolved campaign in the same plan is unaffected.
  // -------------------------------------------------------------------------

  it("invalid-brief: a corrupt adbriefs/<slug>.yaml for one campaign does not prevent an unrelated resolved campaign in the same plan from being staged", async () => {
    writeFileSync(briefPathB(), stagingBriefYamlB());
    writeFileSync(join(root, "adbriefs", `${STAGING_SLUG_B}.state.yaml`), stagingStateYamlB());
    // Corrupt campaign A's on-disk brief (unterminated YAML flow sequence). Its state
    // file is untouched, so the plan's adId still resolves to this slug via the
    // reverse index — loadBriefAtSlug must not crash the whole run when parsing it.
    writeFileSync(briefPath(), "adGroups: [this is not valid yaml");

    const budgetRows = [
      { campaign: { id: 501 }, campaign_budget: { resource_name: "customers/1/campaignBudgets/9", amount_micros: 25_000_000 } },
    ];
    const { client, mutations } = stagingClient(budgetRows);
    currentClient = client;

    const p = join(root, "plan.json");
    writeFileSync(
      p,
      JSON.stringify({
        customerId: "1111111111",
        rewrites: [
          {
            adId: "700",
            headlines: Array.from({ length: 15 }, (_, i) => `staged headline ${i}`),
            descriptions: Array.from({ length: 4 }, (_, i) => `staged description ${i}`),
          },
        ],
        budgets: [{ campaignId: 501, dailyMicros: 30_000_000 }],
      }),
    );

    const beforeB = readFileSync(briefPathB(), "utf8");
    const cap = captureStdout();
    const code = await main([p, "--apply"]);
    const out = cap.text();

    expect(code).toBe(0); // both mutations succeed live; only A's brief staging is skipped
    expect(mutations.length).toBeGreaterThan(0);

    const payload = JSON.parse(out.slice(out.indexOf("{")));
    const briefA = payload.briefs.find((b: { slug: string }) => b.slug === STAGING_SLUG);
    const briefB = payload.briefs.find((b: { slug: string }) => b.slug === STAGING_SLUG_B);
    expect(briefA.briefStagingSkipReason).toBe("invalid-brief");
    expect(briefA.briefSynced).toBe(false);

    // Campaign B, wholly unrelated to A's corrupt brief, still stages/diffs/writes normally.
    expect(briefB.briefSynced).toBe(true);
    expect(readFileSync(briefPathB(), "utf8")).not.toBe(beforeB);
  });

  // -------------------------------------------------------------------------
  // Unguarded writeBrief in the persist loop (fix #3): a write failure for one
  // slug must not prevent another slug's already-mutated brief from being written
  // and reported in the same run.
  // -------------------------------------------------------------------------

  it("a writeBrief failure for one slug still lets another slug in the same run write and report normally", async () => {
    writeFileSync(briefPathB(), stagingBriefYamlB());
    writeFileSync(join(root, "adbriefs", `${STAGING_SLUG_B}.state.yaml`), stagingStateYamlB());
    failWriteForCampaignName = "Demo Search"; // campaign A's writeBrief call throws

    const budgetRows = [
      { campaign: { id: 501 }, campaign_budget: { resource_name: "customers/1/campaignBudgets/9", amount_micros: 25_000_000 } },
    ];
    const { client } = stagingClient(budgetRows);
    currentClient = client;

    const p = join(root, "plan.json");
    writeFileSync(
      p,
      JSON.stringify({
        customerId: "1111111111",
        rewrites: [
          {
            adId: "700",
            headlines: Array.from({ length: 15 }, (_, i) => `staged headline ${i}`),
            descriptions: Array.from({ length: 4 }, (_, i) => `staged description ${i}`),
          },
        ],
        budgets: [{ campaignId: 501, dailyMicros: 30_000_000 }],
      }),
    );

    const beforeA = readFileSync(briefPath(), "utf8");
    const beforeB = readFileSync(briefPathB(), "utf8");
    const cap = captureStdout();
    const code = await main([p, "--apply"]);
    const out = cap.text();

    // A write failure surfaces the same way a mutation-step failure would — the run
    // reports failure overall, but crucially the .map() still completed for every slug.
    expect(code).toBe(1);
    const payload = JSON.parse(out.slice(out.indexOf("{")));
    const briefA = payload.briefs.find((b: { slug: string }) => b.slug === STAGING_SLUG);
    const briefB = payload.briefs.find((b: { slug: string }) => b.slug === STAGING_SLUG_B);

    // Campaign A's write failed: left unchanged on disk, reported unsynced.
    expect(briefA.briefSynced).toBe(false);
    expect(readFileSync(briefPath(), "utf8")).toBe(beforeA);

    // Campaign B's write still went through despite A's failure.
    expect(briefB.briefSynced).toBe(true);
    expect(readFileSync(briefPathB(), "utf8")).not.toBe(beforeB);
  });

  // -------------------------------------------------------------------------
  // bidding (US1/US2/US3, #53): campaign 500 (demo-search) is the on-disk brief's
  // default bidStrategy ("maximize-clicks", no ceiling). biddingGuardState's canned
  // rows are passed through stagingClient's `budgetRows` param — only one of
  // campaignBudgets/biddingGuardState ever calls searchStructured per test here, since
  // the other section's campaign-id list is always empty in these plans.
  // -------------------------------------------------------------------------

  function biddingPlan(bidding: Record<string, unknown>): string {
    const p = join(root, "plan.json");
    writeFileSync(p, JSON.stringify({ customerId: "1111111111", bidding: [bidding] }));
    return p;
  }

  it("US1 dry-run: stages the bidding diff and issues zero mutations", async () => {
    const biddingRows = [
      { campaign: { id: 500, bidding_strategy_type: "MAXIMIZE_CLICKS" }, metrics: { conversions: 0, average_cpc: 4_000_000 } },
    ];
    const { client, mutations } = stagingClient(biddingRows);
    currentClient = client;
    const before = readFileSync(briefPath(), "utf8");

    const cap = captureStdout();
    const code = await main([biddingPlan({ campaignId: 500, strategy: "maximize-clicks", cpcBidCeilingMicros: 5_500_000 })]);
    const out = cap.text();

    expect(code).toBe(0);
    expect(out).toContain("bidding campaign 500");
    expect(mutations.length).toBe(0);
    expect(readFileSync(briefPath(), "utf8")).toBe(before); // untouched (FR-004)
    const payload = JSON.parse(out.slice(out.indexOf("{")));
    expect(payload.briefs[0].briefDiff.changed).toBe(true);
  });

  it("US1 apply: issues a campaign update mutate op with the ceiling and persists it to the brief", async () => {
    const biddingRows = [
      { campaign: { id: 500, bidding_strategy_type: "MAXIMIZE_CLICKS" }, metrics: { conversions: 0, average_cpc: 4_000_000 } },
    ];
    const { client, mutations } = stagingClient(biddingRows);
    currentClient = client;

    const code = await main([
      biddingPlan({ campaignId: 500, strategy: "maximize-clicks", cpcBidCeilingMicros: 5_500_000 }),
      "--apply",
    ]);

    expect(code).toBe(0);
    const op = mutations.flatMap((m) => m.operations).find((o) => o.entity === "campaign");
    expect(op).toBeDefined();
    const resource = op!.resource as Record<string, unknown>;
    expect(resource.target_spend).toEqual({ cpc_bid_ceiling_micros: 5_500_000 });
    expect(onDiskBrief().campaign.cpcBidCeilingMicros).toBe(5_500_000);
  });

  it("US2 guardrail: refuses a downgrade at >=30 trailing-30-day conversions and issues zero mutations", async () => {
    const biddingRows = [
      { campaign: { id: 500, bidding_strategy_type: "MAXIMIZE_CONVERSIONS" }, metrics: { conversions: 30, average_cpc: 4_000_000 } },
    ];
    const { client, mutations } = stagingClient(biddingRows);
    currentClient = client;

    const cap = captureStdout();
    const code = await main([biddingPlan({ campaignId: 500, strategy: "maximize-clicks" }), "--apply"]);
    const out = cap.text();

    expect(code).toBe(1);
    expect(out).toContain("refusing maximize-conversions -> maximize-clicks");
    expect(mutations.length).toBe(0);
  });

  it("US2 override: acknowledgeStrategyDowngrade lets the same downgrade proceed", async () => {
    const biddingRows = [
      { campaign: { id: 500, bidding_strategy_type: "MAXIMIZE_CONVERSIONS" }, metrics: { conversions: 30, average_cpc: 4_000_000 } },
    ];
    const { client, mutations } = stagingClient(biddingRows);
    currentClient = client;

    const code = await main([
      biddingPlan({ campaignId: 500, strategy: "maximize-clicks", acknowledgeStrategyDowngrade: true }),
      "--apply",
    ]);

    expect(code).toBe(0);
    expect(mutations.flatMap((m) => m.operations).some((o) => o.entity === "campaign")).toBe(true);
  });

  it("US3 warning: a ceiling below trailing-30-day average CPC warns but still applies", async () => {
    const biddingRows = [
      { campaign: { id: 500, bidding_strategy_type: "MAXIMIZE_CLICKS" }, metrics: { conversions: 0, average_cpc: 6_000_000 } },
    ];
    const { client, mutations } = stagingClient(biddingRows);
    currentClient = client;

    const cap = captureStdout();
    const code = await main([biddingPlan({ campaignId: 500, strategy: "maximize-clicks", cpcBidCeilingMicros: 5_000_000 })]);
    const out = cap.text();

    expect(code).toBe(0);
    expect(out).toContain("WARNING: cpcBidCeilingMicros for campaign 500");
    expect(mutations.length).toBe(0); // still just a dry run
  });

  it("US3 no warning: a ceiling at/above the trailing-30-day average CPC prints nothing", async () => {
    const biddingRows = [
      { campaign: { id: 500, bidding_strategy_type: "MAXIMIZE_CLICKS" }, metrics: { conversions: 0, average_cpc: 4_000_000 } },
    ];
    const { client } = stagingClient(biddingRows);
    currentClient = client;

    const cap = captureStdout();
    await main([biddingPlan({ campaignId: 500, strategy: "maximize-clicks", cpcBidCeilingMicros: 5_000_000 })]);
    const out = cap.text();

    expect(out).not.toContain("WARNING: cpcBidCeilingMicros");
  });
});
