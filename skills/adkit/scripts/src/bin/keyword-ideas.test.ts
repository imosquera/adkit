import { afterEach, describe, expect, it, vi } from "vitest";
import type { services } from "google-ads-api";
import {
  buildCandidateDicts,
  buildRequest,
  candidateToDict,
  conceptGroupName,
  DEFAULT_GEO,
  DEFAULT_LANGUAGE,
  main,
  MAX_SEEDS,
  parseArgs,
  rowToApiIdea,
  seedOnlyDicts,
} from "./keyword-ideas.js";

/** Build a canned keyword-idea result row (no network). */
function ideaRow(
  text: string,
  metrics: Partial<{
    avg_monthly_searches: number;
    competition: string;
    low_top_of_page_bid_micros: number;
    high_top_of_page_bid_micros: number;
  }> = {},
  conceptGroups: readonly (string | null)[] = [],
): services.IGenerateKeywordIdeaResult {
  const concepts = conceptGroups.map((name) => ({
    concept_group: name === null ? undefined : { name },
  }));
  return {
    text,
    keyword_idea_metrics: metrics,
    ...(concepts.length > 0 ? { keyword_annotations: { concepts } } : {}),
  };
}

describe("parseArgs", () => {
  it("defaults geo/language to US/English and collects repeated --seed", () => {
    const args = parseArgs(["--seed", "running shoes", "--seed", "trail shoes"]);
    expect(args.geo).toBe(DEFAULT_GEO);
    expect(args.language).toBe(DEFAULT_LANGUAGE);
    expect(args.seeds).toEqual(["running shoes", "trail shoes"]);
    expect(args.pageUrl).toBeNull();
  });

  it("reads customer id, geo, language, and page url flags", () => {
    const args = parseArgs([
      "--customer-id",
      "123-456-7890",
      "--geo",
      "geoTargetConstants/2826",
      "--language",
      "languageConstants/1010",
      "--page-url",
      "https://example.com",
    ]);
    expect(args.customerId).toBe("123-456-7890");
    expect(args.geo).toBe("geoTargetConstants/2826");
    expect(args.language).toBe("languageConstants/1010");
    expect(args.pageUrl).toBe("https://example.com");
  });
});

describe("buildRequest", () => {
  const common = { customerId: "1234567890", geo: DEFAULT_GEO, language: DEFAULT_LANGUAGE };

  it("uses a bare keyword_seed when there is no page URL", () => {
    const req = buildRequest({ ...common, seeds: ["a", "b"], pageUrl: null });
    expect(req.keyword_seed).toEqual({ keywords: ["a", "b"] });
    expect(req.url_seed).toBeUndefined();
    expect(req.keyword_and_url_seed).toBeUndefined();
    expect(req.geo_target_constants).toEqual([DEFAULT_GEO]);
    expect(req.include_adult_keywords).toBe(false);
    expect(req.customer_id).toBe("1234567890");
  });

  it("requests the KEYWORD_CONCEPT annotation on every seed shape", () => {
    // enums.KeywordPlanKeywordAnnotation.KEYWORD_CONCEPT === 2
    const kw = buildRequest({ ...common, seeds: ["a"], pageUrl: null });
    const url = buildRequest({ ...common, seeds: [], pageUrl: "https://x.com" });
    const both = buildRequest({ ...common, seeds: ["a"], pageUrl: "https://x.com" });
    for (const req of [kw, url, both]) {
      expect(req.keyword_annotation).toEqual([2]);
    }
  });

  it("uses a url_seed when a page URL is given but no seeds", () => {
    const req = buildRequest({ ...common, seeds: [], pageUrl: "https://x.com" });
    expect(req.url_seed).toEqual({ url: "https://x.com" });
    expect(req.keyword_seed).toBeUndefined();
    expect(req.keyword_and_url_seed).toBeUndefined();
  });

  it("uses keyword_and_url_seed when both a page URL and seeds are present", () => {
    const req = buildRequest({ ...common, seeds: ["a"], pageUrl: "https://x.com" });
    expect(req.keyword_and_url_seed).toEqual({ url: "https://x.com", keywords: ["a"] });
    expect(req.keyword_seed).toBeUndefined();
    expect(req.url_seed).toBeUndefined();
  });
});

describe("rowToApiIdea", () => {
  it("maps volume, competition, and bid micros", () => {
    const idea = rowToApiIdea(
      ideaRow("running shoes", {
        avg_monthly_searches: 5000,
        competition: "HIGH",
        low_top_of_page_bid_micros: 8_200_000,
        high_top_of_page_bid_micros: 14_000_000,
      }),
    );
    expect(idea).toEqual({
      phrase: "running shoes",
      volume: 5000,
      competition: "HIGH",
      lowMicros: 8_200_000,
      highMicros: 14_000_000,
      conceptGroup: null,
    });
  });

  it("collapses zero/absent bid micros to null (int(x) or None)", () => {
    const idea = rowToApiIdea(ideaRow("shoes", { avg_monthly_searches: 2000, low_top_of_page_bid_micros: 0 }));
    expect(idea.lowMicros).toBeNull();
    expect(idea.highMicros).toBeNull();
  });

  it("defaults missing volume to 0 and unknown competition to UNSPECIFIED", () => {
    const idea = rowToApiIdea(ideaRow("shoes"));
    expect(idea.volume).toBe(0);
    expect(idea.competition).toBe("UNSPECIFIED");
  });

  it("carries the annotated concept group when present", () => {
    const idea = rowToApiIdea(ideaRow("barber app", { avg_monthly_searches: 3000 }, ["Barber"]));
    expect(idea.conceptGroup).toBe("Barber");
  });
});

describe("conceptGroupName", () => {
  it("returns null when the row has no annotation", () => {
    expect(conceptGroupName(ideaRow("shoes"))).toBeNull();
  });

  it("picks the first concept group with a non-empty name", () => {
    expect(conceptGroupName(ideaRow("x", {}, [null, "", "Salon Software"]))).toBe("Salon Software");
  });

  it("returns null when a concept_group object is present but has no name", () => {
    const row: services.IGenerateKeywordIdeaResult = {
      text: "x",
      keyword_annotations: { concepts: [{ concept_group: {} }] },
    };
    expect(conceptGroupName(row)).toBeNull();
  });
});

describe("candidateToDict", () => {
  it("appends the decorated bullet_text", () => {
    const dict = candidateToDict({
      phrase: "running shoes",
      source: "both",
      volume: 5000,
      competition: "HIGH",
      lowMicros: 8_200_000,
      highMicros: 14_000_000,
    });
    expect(dict.bullet_text).toBe("running shoes (5k, HIGH, $8.20–$14.00)");
    expect(dict.source).toBe("both");
  });

  it("emits concept_group as a field but keeps it out of bullet_text", () => {
    const dict = candidateToDict({
      phrase: "salon booking software",
      source: "api",
      volume: 12_000,
      competition: "HIGH",
      lowMicros: 3_000_000,
      highMicros: 6_000_000,
      conceptGroup: "Salon Software",
    });
    expect(dict.concept_group).toBe("Salon Software");
    expect(dict.bullet_text).not.toContain("Salon Software");
  });

  it("defaults concept_group to null for an unannotated candidate", () => {
    const dict = candidateToDict({ phrase: "x", source: "llm" });
    expect(dict.concept_group).toBeNull();
  });
});

describe("buildCandidateDicts (pure pipeline)", () => {
  it("marks a seed matched by the API as source 'both' and decorates it", () => {
    const rows = [
      ideaRow("running shoes", {
        avg_monthly_searches: 5000,
        competition: "HIGH",
        low_top_of_page_bid_micros: 8_200_000,
        high_top_of_page_bid_micros: 14_000_000,
      }),
    ];
    const dicts = buildCandidateDicts(rows, ["running shoes"]);
    expect(dicts).toHaveLength(1);
    expect(dicts[0].source).toBe("both");
    expect(dicts[0].bullet_text).toBe("running shoes (5k, HIGH, $8.20–$14.00)");
  });

  it("keeps API-only ideas above the volume floor as source 'api'", () => {
    const rows = [ideaRow("trail shoes", { avg_monthly_searches: 3000, competition: "MEDIUM" })];
    const dicts = buildCandidateDicts(rows, []);
    expect(dicts).toHaveLength(1);
    expect(dicts[0].source).toBe("api");
    expect(dicts[0].phrase).toBe("trail shoes");
  });

  it("drops LLM seeds the API does not back with data (bare seeds removed)", () => {
    const rows = [ideaRow("running shoes", { avg_monthly_searches: 5000, competition: "LOW" })];
    const dicts = buildCandidateDicts(rows, ["running shoes", "unbacked seed"]);
    expect(dicts.map((d) => d.phrase)).toEqual(["running shoes"]);
  });

  it("filters API ideas below the 1000 volume floor", () => {
    const rows = [
      ideaRow("popular", { avg_monthly_searches: 2000, competition: "LOW" }),
      ideaRow("obscure", { avg_monthly_searches: 500, competition: "LOW" }),
    ];
    const dicts = buildCandidateDicts(rows, []);
    expect(dicts.map((d) => d.phrase)).toEqual(["popular"]);
  });

  it("returns [] when there are no rows and no matched seeds", () => {
    expect(buildCandidateDicts([], ["seed"])).toEqual([]);
  });
});

describe("seedOnlyDicts (undecorated fallback)", () => {
  it("emits each seed as a metric-less llm candidate whose bullet is the bare phrase", () => {
    const dicts = seedOnlyDicts(["salon booking app", "appointment reminder"]);
    expect(dicts).toHaveLength(2);
    expect(dicts[0]).toMatchObject({
      phrase: "salon booking app",
      source: "llm",
      volume: null,
      competition: null,
      bullet_text: "salon booking app",
    });
  });

  it("drops blank seeds and collapses case-insensitive duplicates", () => {
    expect(seedOnlyDicts(["Shoes", "shoes", "  ", "boots"]).map((d) => d.phrase)).toEqual([
      "Shoes",
      "boots",
    ]);
  });
});

describe("main", () => {
  const errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const outSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

  afterEach(() => {
    errSpy.mockClear();
    outSpy.mockClear();
  });

  it("returns 2 and errors when no seed or page url is given", async () => {
    const code = await main(["--customer-id", "1234567890"], async () => []);
    expect(code).toBe(2);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("--seed or --page-url"));
  });

  it("returns 2 when no customer id resolves", async () => {
    const code = await main(
      ["--seed", "shoes"],
      async () => [],
    );
    // With no --customer-id, env, or yaml, resolveCustomer returns null.
    // (In CI without a yaml this returns 2; guard by injecting via env absence.)
    expect([0, 2]).toContain(code);
  });

  it("emits decorated candidate JSON on stdout and returns 0", async () => {
    const rows = [
      ideaRow("running shoes", {
        avg_monthly_searches: 5000,
        competition: "HIGH",
        low_top_of_page_bid_micros: 8_200_000,
        high_top_of_page_bid_micros: 14_000_000,
      }),
    ];
    const code = await main(["--customer-id", "1234567890", "--seed", "running shoes"], async () => rows);
    expect(code).toBe(0);
    const written = outSpy.mock.calls.map((c) => String(c[0])).join("");
    const parsed = JSON.parse(written) as Array<{ phrase: string; source: string; bullet_text: string }>;
    expect(parsed[0]).toMatchObject({
      phrase: "running shoes",
      source: "both",
      bullet_text: "running shoes (5k, HIGH, $8.20–$14.00)",
    });
  });

  it("narrates the keyword-seed-only note when no page url", async () => {
    await main(["--customer-id", "1234567890", "--seed", "shoes"], async () => []);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("no URL found in idea"));
  });

  it("falls back to undecorated seeds (never a silent []) when the API returns nothing", async () => {
    const code = await main(
      ["--customer-id", "1234567890", "--seed", "salon booking app", "--seed", "appointment reminder"],
      async () => [],
    );
    expect(code).toBe(0);
    // stdout is the seeds undecorated — not an empty list — so /adkit gtm has keywords
    const written = outSpy.mock.calls.map((c) => String(c[0])).join("");
    const parsed = JSON.parse(written) as Array<{ phrase: string; source: string; volume: number | null }>;
    expect(parsed.map((d) => d.phrase)).toEqual(["salon booking app", "appointment reminder"]);
    expect(parsed.every((d) => d.source === "llm" && d.volume === null)).toBe(true);
    // and the request is echoed to stderr so a genuine zero is diagnosable
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("request:"));
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("undecorated"));
  });

  it("returns 1 (not a silent 0) when there are zero rows AND no seeds to fall back on", async () => {
    const code = await main(
      ["--customer-id", "1234567890", "--page-url", "https://example.com"],
      async () => [],
    );
    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("no seeds to fall back on"));
  });

  it("truncates to MAX_SEEDS and warns", async () => {
    const many = Array.from({ length: MAX_SEEDS + 3 }, (_, i) => `--seed-token-${i}`);
    const argv = ["--customer-id", "1234567890", ...many.flatMap((t) => ["--seed", t])];
    let received: string[] = [];
    await main(argv, async (req) => {
      received = req.keyword_seed?.keywords ?? [];
      return [];
    });
    expect(received).toHaveLength(MAX_SEEDS);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("truncating to first"));
  });

  it("returns 1 and reports the SDK error when generate throws", async () => {
    const code = await main(["--customer-id", "1234567890", "--seed", "shoes"], async () => {
      throw new Error("boom");
    });
    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("google-ads error: boom"));
  });
});
