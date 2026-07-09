import { afterEach, describe, expect, it, vi } from "vitest";
import { parseBrief, type Brief } from "../lib/schema.js";
import { finalUrls, unreachableUrls, urlUnreachableReason } from "./urls.js";

function briefForUrls(rsaUrl: string, sitelinkUrl: string): Brief {
  return parseBrief({
    name: "url-test",
    version: 1,
    campaign: {
      name: "url-test-search",
      budgetMicros: 10_000_000,
      networkSettings: "search-only",
      sitelinks: Array.from({ length: 6 }, (_, i) => ({ text: `L${i}`, finalUrl: sitelinkUrl })),
    },
    adGroups: [
      {
        name: "Ag",
        defaultBidMicros: 1_500_000,
        responsiveSearchAd: {
          headlines: Array.from({ length: 15 }, (_, i) => ({ text: `H${i}` })),
          descriptions: Array.from({ length: 4 }, (_, i) => ({ text: `D${i}` })),
          finalUrl: rsaUrl,
        },
        keywords: [{ text: "kw", matchType: "PHRASE" }],
      },
    ],
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("finalUrls", () => {
  it("dedupes RSA and sitelinks", () => {
    const same = "https://www.example.com/ideas/foo";
    expect(finalUrls(briefForUrls(same, same))).toEqual([same]);
  });

  it("keeps distinct URLs", () => {
    const rsa = "https://www.example.com/ideas/foo";
    const sl = "https://www.example.com/ideas/bar";
    expect(new Set(finalUrls(briefForUrls(rsa, sl)))).toEqual(new Set([rsa, sl]));
  });

  it("orders RSA before sitelinks", () => {
    const rsa = "https://www.example.com/ideas/foo";
    const sl = "https://www.example.com/ideas/bar";
    // RSA finalUrl comes first, then the sitelink URL — order-preserving dedupe.
    expect(finalUrls(briefForUrls(rsa, sl))).toEqual([rsa, sl]);
  });
});

describe("unreachableUrls", () => {
  it("reports each failure", async () => {
    const rsa = "https://www.example.com/ideas/foo";
    const sl = "https://www.example.com/ideas/bar";
    // Probe is stubbed via fetch — no real network. Every URL "fails" (404) so we
    // exercise the collect → probe → [url, reason] composition off the wire.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 404 }));
    expect(await unreachableUrls(briefForUrls(rsa, sl))).toEqual([
      [rsa, "HTTP 404"],
      [sl, "HTTP 404"],
    ]);
  });

  it("is empty when all reachable", async () => {
    const rsa = "https://www.example.com/ideas/foo";
    const sl = "https://www.example.com/ideas/bar";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    expect(await unreachableUrls(briefForUrls(rsa, sl))).toEqual([]);
  });
});

describe("urlUnreachableReason", () => {
  it("returns the exception name when the probe throws", async () => {
    // No network: force fetch to reject so we exercise the catch-all branch that
    // returns the error's type name (DNS/timeout/TLS family).
    class TypeErrorLike extends Error {
      override name = "TypeError";
    }
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeErrorLike("nope"));
    expect(await urlUnreachableReason("https://example.invalid/x")).toBe("TypeError");
  });

  it("returns null on a 2xx", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    expect(await urlUnreachableReason("https://ok.example/x")).toBeNull();
  });

  it("falls back to GET when HEAD is rejected 405", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 405 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    expect(await urlUnreachableReason("https://headless.example/x")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("HEAD");
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe("GET");
  });
});
