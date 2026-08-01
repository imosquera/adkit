import { describe, expect, it } from "vitest";
import {
  diffNewCompetitors,
  parseAuctionInsightsCache,
  updateCache,
  type AuctionInsightsCache,
} from "./auction-insights-cache.js";

describe("parseAuctionInsightsCache", () => {
  it("round-trips a valid customer -> campaign -> domain-list shape", () => {
    const data = { "111": { "222": ["a.com", "b.com"] } };
    expect(parseAuctionInsightsCache(data)).toEqual(data);
  });

  it("accepts an empty object", () => {
    expect(parseAuctionInsightsCache({})).toEqual({});
  });

  it("throws on a malformed shape", () => {
    expect(() => parseAuctionInsightsCache({ "111": { "222": "not-an-array" } })).toThrow();
    expect(() => parseAuctionInsightsCache("not-an-object")).toThrow();
    expect(() => parseAuctionInsightsCache(null)).toThrow();
  });
});

describe("diffNewCompetitors", () => {
  const cache: AuctionInsightsCache = { "111": { "222": ["a.com", "b.com"] } };

  it("reports isFirstRun with no prior entry for this customer/campaign", () => {
    const result = diffNewCompetitors({}, "111", 222, ["a.com"]);
    expect(result).toEqual({ isFirstRun: true, newDomains: [] });
  });

  it("returns the new-domain set difference when a prior entry exists", () => {
    const result = diffNewCompetitors(cache, "111", 222, ["a.com", "b.com", "c.com"]);
    expect(result).toEqual({ isFirstRun: false, newDomains: ["c.com"] });
  });

  it("returns no new domains when everything overlaps", () => {
    const result = diffNewCompetitors(cache, "111", 222, ["a.com", "b.com"]);
    expect(result).toEqual({ isFirstRun: false, newDomains: [] });
  });

  it("treats a different customer id's cache as no prior entry", () => {
    const result = diffNewCompetitors(cache, "999", 222, ["a.com"]);
    expect(result).toEqual({ isFirstRun: true, newDomains: [] });
  });
});

describe("updateCache", () => {
  it("does not mutate its input and returns a new cache with the campaign's domains replaced", () => {
    const original: AuctionInsightsCache = { "111": { "222": ["a.com"] } };
    const updated = updateCache(original, "111", 222, ["a.com", "c.com"]);
    expect(original).toEqual({ "111": { "222": ["a.com"] } });
    expect(updated).toEqual({ "111": { "222": ["a.com", "c.com"] } });
  });

  it("preserves other campaigns/customers already in the cache", () => {
    const original: AuctionInsightsCache = { "111": { "222": ["a.com"] }, "999": { "333": ["z.com"] } };
    const updated = updateCache(original, "111", 444, ["d.com"]);
    expect(updated).toEqual({
      "111": { "222": ["a.com"], "444": ["d.com"] },
      "999": { "333": ["z.com"] },
    });
  });
});
