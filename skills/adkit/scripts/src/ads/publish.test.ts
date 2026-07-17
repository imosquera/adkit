import { describe, expect, it } from "vitest";
import type { AdsClient, AdsMutateOperation, MutateResult } from "../lib/auth.js";
import { parseBrief } from "../lib/schema.js";
import { sdkVersion } from "./errors.js";
import { publishV1 } from "./publish.js";

/**
 * A minimal valid brief with all four devices targeted (so target-devices is a
 * no-op — no exclusions to mutate), no negatives, and no campaign-level assets.
 * That makes the mutate sequence deterministic for the mid-step failure test.
 */
function minimalBrief(): ReturnType<typeof parseBrief> {
  return parseBrief({
    name: "konnect-test",
    version: 1,
    campaign: {
      name: "konnect-test-search",
      budgetMicros: 10_000_000,
      networkSettings: "search-only",
      devices: ["computer", "mobile", "tablet", "tv"],
    },
    adGroups: [
      {
        name: "primary",
        defaultBidMicros: 1_500_000,
        responsiveSearchAd: {
          headlines: Array.from({ length: 15 }, (_, i) => ({ text: `Headline ${i}` })),
          descriptions: Array.from({ length: 4 }, (_, i) => ({ text: `Description ${i}` })),
          finalUrl: "https://www.example.com/x",
        },
        keywords: [{ text: "widget", matchType: "PHRASE" }],
      },
    ],
  });
}

/**
 * A fake AdsClient. `search` returns canned rows (default: none, so find-existing
 * probes miss). `mutate` returns synthetic per-op resource names, and optionally
 * throws on the `throwOnCall`-th mutate to simulate an SDK failure mid-run.
 */
function makeFake(options: { throwOnCall?: number; searchRows?: unknown[] } = {}): {
  client: AdsClient;
  mutateCalls: AdsMutateOperation[][];
} {
  const mutateCalls: AdsMutateOperation[][] = [];
  let n = 0;
  const client: AdsClient = {
    search: async <Row = unknown>(): Promise<Row[]> => (options.searchRows ?? []) as Row[],
    searchStructured: async <Row = unknown>(): Promise<Row[]> => (options.searchRows ?? []) as Row[],
    mutate: async (_customerId, ops): Promise<MutateResult> => {
      n += 1;
      if (options.throwOnCall !== undefined && n === options.throwOnCall) {
        throw new Error("simulated SDK failure");
      }
      mutateCalls.push(ops);
      return { results: ops.map((_, i) => ({ resource_name: `rn/call${n}/op${i}` })) };
    },
  };
  return { client, mutateCalls };
}

describe("publishV1", () => {
  it("happy path: publishes a minimal brief with no failure and populated results", async () => {
    const { client, mutateCalls } = makeFake();
    const brief = minimalBrief();

    const outcome = await publishV1(client, "1234567890", brief);

    expect(outcome.failure).toBeNull();
    expect(outcome.executorVersion).toBe(sdkVersion());
    expect(outcome.results.budgetId).not.toBeNull();
    expect(outcome.results.campaignId).not.toBeNull();
    // Deterministic mutate sequence for the minimal brief:
    // budget, campaign, target-location, create-ad-group, create-rsa, create-keywords.
    expect(mutateCalls).toHaveLength(6);

    expect(outcome.results.adGroups).toHaveLength(1);
    const ag = outcome.results.adGroups[0]!;
    expect(ag.name).toBe("primary");
    expect(ag.adGroupId).not.toBeNull();
    expect(ag.responsiveSearchAdId).not.toBeNull();
    expect(ag.keywordResourceNames.length).toBeGreaterThan(0);
  });

  it("injects the client (does not construct its own) — a fake AdsClient drives the whole run", async () => {
    // If publishV1 ignored the passed client and called loadClient() internally, a
    // throwing fake could not observe or fail the run. This asserts the DI signature.
    const { client } = makeFake({ throwOnCall: 1 });
    const outcome = await publishV1(client, "1234567890", minimalBrief());
    expect(outcome.failure?.step).toBe("create-campaign-budget");
  });

  it("mid-step failure: yields a RunOutcome tagged with the failing step and partial results", async () => {
    // Mutate sequence: 1 budget, 2 campaign, 3 target-location, 4 create-ad-group,
    // 5 create-responsive-search-ad, 6 create-keywords. Fail on the 5th (the RSA).
    const { client } = makeFake({ throwOnCall: 5 });
    const brief = minimalBrief();

    const outcome = await publishV1(client, "1234567890", brief);

    expect(outcome.failure).not.toBeNull();
    expect(outcome.failure?.step).toBe("create-responsive-search-ad");
    expect(outcome.failure?.adGroupName).toBe("primary");
    expect(outcome.executorVersion).toBe(sdkVersion());

    // Partial results reflect progress up to the failing step.
    expect(outcome.results.budgetId).not.toBeNull();
    expect(outcome.results.campaignId).not.toBeNull();
    const ag = outcome.results.adGroups[0]!;
    expect(ag.adGroupId).not.toBeNull(); // ad group was created before the RSA step
    expect(ag.responsiveSearchAdId).toBeNull(); // RSA is where it failed
    expect(ag.keywordResourceNames).toHaveLength(0); // never reached
  });

  it("reuses an existing campaign, skipping budget/campaign creation and keyword creation", async () => {
    // find-existing-campaign returns a row; find-existing-ad-group also returns a row.
    const client: AdsClient = {
      search: async <Row = unknown>(_customerId: string, query: string): Promise<Row[]> => {
        if (query.includes("FROM campaign")) {
          return [{ campaign: { resource_name: "customers/1/campaigns/9", campaign_budget: "customers/1/campaignBudgets/7" } }] as Row[];
        }
        if (query.includes("FROM ad_group")) {
          return [{ ad_group: { resource_name: "customers/1/adGroups/5" } }] as Row[];
        }
        return [] as Row[];
      },
      // create/publish resolve via raw `search`; searchStructured is unused here.
      searchStructured: async <Row = unknown>(): Promise<Row[]> => [] as Row[],
      mutate: async (_customerId, ops): Promise<MutateResult> => ({
        results: ops.map((_, i) => ({ resource_name: `rn/${i}` })),
      }),
    };

    const outcome = await publishV1(client, "1234567890", minimalBrief());

    expect(outcome.failure).toBeNull();
    expect(outcome.results.campaignId).toBe("customers/1/campaigns/9");
    expect(outcome.results.budgetId).toBe("customers/1/campaignBudgets/7");
    const ag = outcome.results.adGroups[0]!;
    expect(ag.adGroupId).toBe("customers/1/adGroups/5");
    expect(ag.responsiveSearchAdId).not.toBeNull(); // RSA still created
    expect(ag.keywordResourceNames).toHaveLength(0); // reused ad group: no keywords
  });
});
