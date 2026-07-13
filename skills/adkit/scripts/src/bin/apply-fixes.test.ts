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

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AdsClient, AdsMutateOperation, MutateResult } from "../lib/auth.js";

// The shell resolves its client via loadClient; the test swaps in a fake (mirrors the
// Python monkeypatch of `af.load_client`). `currentClient` is what loadClient returns.
let currentClient: AdsClient;
vi.mock("../lib/auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/auth.js")>();
  return { ...actual, loadClient: () => currentClient };
});

const { main } = await import("./apply-fixes.js");

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
