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
        responsiveSearchAds: [
          {
            headlines: Array.from({ length: 15 }, (_, i) => ({ text: `Headline ${i}` })),
            descriptions: Array.from({ length: 4 }, (_, i) => ({ text: `Description ${i}` })),
            finalUrl: "https://www.example.com/x",
          },
          {
            headlines: Array.from({ length: 15 }, (_, i) => ({ text: `Alt headline ${i}` })),
            descriptions: Array.from({ length: 4 }, (_, i) => ({ text: `Alt description ${i}` })),
            finalUrl: "https://www.example.com/x",
          },
        ],
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
    // budget, campaign, target-location, create-ad-group, create-rsa x2 (sequential), create-keywords.
    expect(mutateCalls).toHaveLength(7);

    expect(outcome.results.adGroups).toHaveLength(1);
    const ag = outcome.results.adGroups[0]!;
    expect(ag.name).toBe("primary");
    expect(ag.adGroupId).not.toBeNull();
    expect(ag.responsiveSearchAdIds).toHaveLength(2);
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
    // 5/6 create-responsive-search-ad (x2, SEQUENTIAL — bug 1 fix), 7
    // create-keywords. Fail on the 5th (the first of the two RSA creates): the
    // sequential loop aborts immediately, so the 6th (its sibling) is never even
    // attempted — a rerun's findMissingResponsiveSearchAds is what fills it in
    // later (see the dedicated idempotent-rerun test below).
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
    expect(ag.responsiveSearchAdIds).toHaveLength(0); // the first RSA is the one that failed
    expect(ag.keywordResourceNames).toHaveLength(0); // never reached
  });

  it("mid-step failure on the SECOND RSA still records the first's id", async () => {
    // Fail on the 6th mutate call (the second, sequential RSA create) instead of
    // the 5th — the first RSA's id, already pushed into `slot` before the second
    // create is even attempted, must survive the throw.
    const { client } = makeFake({ throwOnCall: 6 });
    const brief = minimalBrief();

    const outcome = await publishV1(client, "1234567890", brief);

    expect(outcome.failure?.step).toBe("create-responsive-search-ad");
    const ag = outcome.results.adGroups[0]!;
    expect(ag.responsiveSearchAdIds).toHaveLength(1);
  });

  it("creates an ad group's RSAs sequentially — never two ad_group_ad mutates in flight at once (bug 1)", async () => {
    // Under the old Promise.allSettled fan-out, both RSA creates would be
    // dispatched before either resolved. With a fake mutate that yields mid-call,
    // that would push maxInFlight to 2; the sequential for-await fix keeps it at 1.
    let inFlight = 0;
    let maxInFlight = 0;
    const client: AdsClient = {
      search: async <Row = unknown>(): Promise<Row[]> => [] as Row[],
      searchStructured: async <Row = unknown>(): Promise<Row[]> => [] as Row[],
      mutate: async (_customerId, ops): Promise<MutateResult> => {
        const isRsaCreate = ops[0]?.entity === "ad_group_ad";
        if (isRsaCreate) {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await Promise.resolve();
          await Promise.resolve();
          inFlight -= 1;
        }
        return { results: ops.map((_, i) => ({ resource_name: `rn/${i}` })) };
      },
    };

    const outcome = await publishV1(client, "1234567890", minimalBrief());

    expect(outcome.failure).toBeNull();
    expect(maxInFlight).toBe(1);
  });

  it("reuses an existing campaign and ad group, still filling in the RSAs/keywords not already live", async () => {
    // find-existing-campaign and find-existing-ad-group both hit; the
    // RSA/keyword existing-content probes miss (nothing live yet on this ad
    // group), so both still get fully (re-)created for the reused ad group —
    // including keywords, which a reused ad group used to skip unconditionally
    // (bug 3).
    const client: AdsClient = {
      search: async <Row = unknown>(_customerId: string, query: string): Promise<Row[]> => {
        if (query.includes("FROM ad_group_ad")) {
          return [] as Row[]; // no RSAs live yet
        }
        if (query.includes("FROM ad_group_criterion")) {
          return [] as Row[]; // no keywords live yet
        }
        if (query.includes("FROM ad_group ")) {
          return [{ ad_group: { resource_name: "customers/1/adGroups/5" } }] as Row[];
        }
        if (query.includes("FROM campaign")) {
          return [{ campaign: { resource_name: "customers/1/campaigns/9", campaign_budget: "customers/1/campaignBudgets/7" } }] as Row[];
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
    expect(ag.responsiveSearchAdIds).toHaveLength(2); // both RSAs created: neither was live
    expect(ag.keywordResourceNames).toHaveLength(1); // bug 3: reused ad group still gets its keyword
  });

  it("bug 2 + bug 3: a rerun after a partial RSA failure creates exactly the missing RSA (no duplicate) and still creates keywords", async () => {
    // Simulates the real sequence from the bug report: run 1 creates the ad group,
    // lands RSA index 0 live, then RSA index 1 is rejected (CONCURRENT_MODIFICATION
    // in production; here, a scripted rejection keyed on content) before keywords
    // are ever reached. Run 2 reuses the now-partially-populated ad group and must
    // create only the missing RSA (not a duplicate of index 0) and the keyword that
    // was never created in run 1.
    const brief = minimalBrief();
    const rsa1FirstHeadline = brief.adGroups[0]!.responsiveSearchAds[1]!.headlines[0]!.text;

    let campaignRn: string | null = null;
    let budgetRn: string | null = null;
    let adGroupRn: string | null = null;
    const liveRsas: Array<{ headlines: string[]; descriptions: string[] }> = [];
    const liveKeywords: string[] = [];
    let rejectSecondRsa = true;

    const client: AdsClient = {
      search: async <Row = unknown>(_customerId: string, query: string): Promise<Row[]> => {
        if (query.includes("FROM ad_group_ad")) {
          return liveRsas.map((r) => ({
            ad_group_ad: {
              ad: {
                responsive_search_ad: {
                  headlines: r.headlines.map((text) => ({ text })),
                  descriptions: r.descriptions.map((text) => ({ text })),
                },
              },
            },
          })) as Row[];
        }
        if (query.includes("FROM ad_group_criterion")) {
          return liveKeywords.map((text) => ({
            ad_group_criterion: { keyword: { text, match_type: "PHRASE" } },
          })) as Row[];
        }
        if (query.includes("FROM ad_group ")) {
          return (adGroupRn ? [{ ad_group: { resource_name: adGroupRn } }] : []) as Row[];
        }
        if (query.includes("FROM campaign")) {
          return (campaignRn
            ? [{ campaign: { resource_name: campaignRn, campaign_budget: budgetRn } }]
            : []) as Row[];
        }
        return [] as Row[];
      },
      searchStructured: async <Row = unknown>(): Promise<Row[]> => [] as Row[],
      mutate: async (_customerId, ops): Promise<MutateResult> => ({
        results: ops.map((op): { resource_name: string } => {
          switch (op.entity) {
            case "campaign_budget":
              budgetRn = "customers/1/campaignBudgets/7";
              return { resource_name: budgetRn };
            case "campaign":
              campaignRn = "customers/1/campaigns/9";
              return { resource_name: campaignRn };
            case "ad_group":
              adGroupRn = "customers/1/adGroups/5";
              return { resource_name: adGroupRn };
            case "ad_group_ad": {
              const rsa = (
                op.resource["ad"] as {
                  responsive_search_ad: { headlines: Array<{ text: string }>; descriptions: Array<{ text: string }> };
                }
              ).responsive_search_ad;
              const headlines = rsa.headlines.map((h) => h.text);
              if (rejectSecondRsa && headlines[0] === rsa1FirstHeadline) {
                throw { database_error: "CONCURRENT_MODIFICATION" };
              }
              const descriptions = rsa.descriptions.map((d) => d.text);
              liveRsas.push({ headlines, descriptions });
              return { resource_name: `customers/1/adGroupAds/5~${liveRsas.length}` };
            }
            case "ad_group_criterion": {
              const text = (op.resource["keyword"] as { text: string }).text;
              liveKeywords.push(text);
              return { resource_name: `customers/1/adGroupCriteria/5~${text}` };
            }
            default:
              return { resource_name: "rn/other" };
          }
        }),
      }),
    };

    const run1 = await publishV1(client, "1234567890", brief);
    expect(run1.failure?.step).toBe("create-responsive-search-ad");
    expect(liveRsas).toHaveLength(1); // RSA index 0 landed live; index 1 was rejected
    expect(liveKeywords).toHaveLength(0); // never reached: the RSA step failed first

    rejectSecondRsa = false;
    const run2 = await publishV1(client, "1234567890", brief);

    expect(run2.failure).toBeNull();
    expect(liveRsas).toHaveLength(2); // exactly the missing RSA was added — no duplicate of index 0
    expect(run2.results.adGroups[0]!.responsiveSearchAdIds).toHaveLength(1); // only the missing one was created this run
    expect(liveKeywords).toHaveLength(brief.adGroups[0]!.keywords.length); // bug 3: keywords finally created on retry
  });
});
