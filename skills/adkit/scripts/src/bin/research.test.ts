import { afterEach, describe, expect, it, vi } from "vitest";
import type { services } from "google-ads-api";
import {
  aggregate,
  buildPayload,
  buildProbes,
  competitorLabel,
  indexHistory,
  keywordToDict,
  main,
  MAX_COMPETITORS,
  overlayHistory,
  parseArgs,
  type ProbeResult,
  type ResearchIdea,
  rowToResearchIdea,
  score,
  themes,
  UNTHEMED,
} from "./research.js";
import { DEFAULT_GEO, DEFAULT_LANGUAGE } from "./keyword-ideas.js";

/** Build a canned keyword-idea result row (no network), incl. competition_index. */
function ideaRow(
  text: string,
  metrics: Partial<{
    avg_monthly_searches: number;
    competition: string;
    competition_index: number;
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

/** A minimal ResearchIdea for the pure aggregate/score/theme tests. */
function idea(partial: Partial<ResearchIdea> & { phrase: string; source: string }): ResearchIdea {
  return {
    volume: 1000,
    competition: "MEDIUM",
    competitionIndex: null,
    lowMicros: null,
    highMicros: null,
    conceptGroup: null,
    ...partial,
  };
}

describe("parseArgs", () => {
  it("collects repeated --competitor and --seed, defaults geo/language", () => {
    const args = parseArgs([
      "--competitor",
      "https://acme.com",
      "--competitor",
      "https://beta.io/pricing",
      "--seed",
      "crm software",
    ]);
    expect(args.competitors).toEqual(["https://acme.com", "https://beta.io/pricing"]);
    expect(args.seeds).toEqual(["crm software"]);
    expect(args.geo).toBe(DEFAULT_GEO);
    expect(args.language).toBe(DEFAULT_LANGUAGE);
    expect(args.historyPath).toBeNull();
  });

  it("reads --customer-id, --geo, --language, and --history", () => {
    const args = parseArgs([
      "--customer-id",
      "123-456-7890",
      "--geo",
      "geoTargetConstants/2826",
      "--language",
      "languageConstants/1010",
      "--history",
      "ads/output/reports/2026-07-17-891-raw.yaml",
    ]);
    expect(args.customerId).toBe("123-456-7890");
    expect(args.geo).toBe("geoTargetConstants/2826");
    expect(args.language).toBe("languageConstants/1010");
    expect(args.historyPath).toBe("ads/output/reports/2026-07-17-891-raw.yaml");
  });
});

describe("competitorLabel", () => {
  it("reduces a URL to its host and strips www.", () => {
    expect(competitorLabel("https://www.acme.com/pricing?ref=1")).toBe("acme.com");
    expect(competitorLabel("http://beta.io")).toBe("beta.io");
  });

  it("falls back gracefully for a non-URL string", () => {
    expect(competitorLabel("acme.com/features")).toBe("acme.com");
  });
});

describe("buildProbes", () => {
  const common = { customerId: "1234567890", geo: DEFAULT_GEO, language: DEFAULT_LANGUAGE };

  it("makes one url_seed probe per competitor and one shared keyword_seed probe", () => {
    const probes = buildProbes({ ...common, competitors: ["https://acme.com"], seeds: ["crm software"] });
    expect(probes).toHaveLength(2);
    const acme = probes.find((p) => p.label === "acme.com");
    expect(acme?.request.url_seed).toEqual({ url: "https://acme.com" });
    const seeds = probes.find((p) => p.label === "seeds");
    expect(seeds?.request.keyword_seed).toEqual({ keywords: ["crm software"] });
  });

  it("competitor probes are URL-only (no seeds mixed in) for clean provenance", () => {
    const probes = buildProbes({ ...common, competitors: ["https://acme.com"], seeds: ["crm software"] });
    const acme = probes.find((p) => p.label === "acme.com");
    expect(acme?.request.keyword_and_url_seed).toBeUndefined();
    expect(acme?.request.keyword_seed).toBeUndefined();
  });

  it("omits the seed probe when there are no seeds", () => {
    const probes = buildProbes({ ...common, competitors: ["https://acme.com"], seeds: [] });
    expect(probes.map((p) => p.label)).toEqual(["acme.com"]);
  });
});

describe("rowToResearchIdea", () => {
  it("maps volume, competition, competition_index, bid micros, and source", () => {
    const r = rowToResearchIdea(
      ideaRow(
        "crm software",
        {
          avg_monthly_searches: 12_000,
          competition: "HIGH",
          competition_index: 84,
          low_top_of_page_bid_micros: 3_000_000,
          high_top_of_page_bid_micros: 9_000_000,
        },
        ["CRM"],
      ),
      "acme.com",
    );
    expect(r).toEqual({
      phrase: "crm software",
      source: "acme.com",
      volume: 12_000,
      competition: "HIGH",
      competitionIndex: 84,
      lowMicros: 3_000_000,
      highMicros: 9_000_000,
      conceptGroup: "CRM",
    });
  });

  it("leaves competitionIndex null when the row carries none, and collapses zero micros", () => {
    const r = rowToResearchIdea(ideaRow("crm", { avg_monthly_searches: 2000, low_top_of_page_bid_micros: 0 }), "seeds");
    expect(r.competitionIndex).toBeNull();
    expect(r.lowMicros).toBeNull();
    expect(r.highMicros).toBeNull();
  });
});

describe("aggregate", () => {
  it("dedupes across sources and unions provenance (overlap signal)", () => {
    const agg = aggregate([
      idea({ phrase: "CRM Software", source: "acme.com", volume: 12_000 }),
      idea({ phrase: "crm software", source: "beta.io", volume: 12_000 }),
      idea({ phrase: "pipeline tool", source: "acme.com", volume: 3000 }),
    ]);
    const crm = agg.find((k) => k.phrase.toLowerCase() === "crm software");
    expect(crm?.sources).toEqual(["acme.com", "beta.io"]);
    expect(agg.find((k) => k.phrase === "pipeline tool")?.sources).toEqual(["acme.com"]);
  });

  it("drops ideas below the 1000 volume floor", () => {
    const agg = aggregate([
      idea({ phrase: "popular", source: "seeds", volume: 2000 }),
      idea({ phrase: "obscure", source: "seeds", volume: 500 }),
    ]);
    expect(agg.map((k) => k.phrase)).toEqual(["popular"]);
  });

  it("takes the metric tuple from the highest-volume row (self-consistent)", () => {
    const agg = aggregate([
      idea({ phrase: "crm", source: "a", volume: 5000, competition: "LOW", highMicros: 2_000_000 }),
      idea({ phrase: "crm", source: "b", volume: 9000, competition: "HIGH", highMicros: 7_000_000 }),
    ]);
    expect(agg[0]).toMatchObject({ volume: 9000, competition: "HIGH", highMicros: 7_000_000 });
  });

  it("keeps the first non-null concept group across rows", () => {
    const agg = aggregate([
      idea({ phrase: "crm", source: "a", volume: 5000, conceptGroup: null }),
      idea({ phrase: "crm", source: "b", volume: 4000, conceptGroup: "CRM" }),
    ]);
    expect(agg[0].conceptGroup).toBe("CRM");
  });
});

describe("score", () => {
  it("scores competitiveness from index (65%) + relative CPC (35%)", () => {
    const [k] = score([
      { phrase: "a", volume: 1000, competition: "HIGH", competitionIndex: 100, lowMicros: null, highMicros: 10_000_000, conceptGroup: null, sources: ["x"] },
    ]);
    // Only keyword => it is the max CPC => cpcNorm = 1 => 0.65*100 + 0.35*100 = 100
    expect(k.competitiveness).toBe(100);
  });

  it("falls back to the competition label when no numeric index is present", () => {
    const [low] = score([
      { phrase: "a", volume: 1000, competition: "LOW", competitionIndex: null, lowMicros: null, highMicros: null, conceptGroup: null, sources: ["x"] },
    ]);
    // base LOW=20, no CPC => 0.65*20 = 13
    expect(low.competitiveness).toBe(13);
  });

  it("ranks a high-volume low-competition term above a low-volume high-competition one on opportunity", () => {
    const scored = score([
      { phrase: "easy win", volume: 50_000, competition: "LOW", competitionIndex: 10, lowMicros: null, highMicros: 1_000_000, conceptGroup: null, sources: ["x"] },
      { phrase: "hard grind", volume: 1000, competition: "HIGH", competitionIndex: 95, lowMicros: null, highMicros: 20_000_000, conceptGroup: null, sources: ["x"] },
    ]);
    const easy = scored.find((k) => k.phrase === "easy win")!;
    const hard = scored.find((k) => k.phrase === "hard grind")!;
    expect(easy.opportunity).toBeGreaterThan(hard.opportunity);
  });
});

describe("themes", () => {
  it("groups by concept group, orders by total volume desc, and rolls up", () => {
    const scored = score([
      { phrase: "crm software", volume: 12_000, competition: "HIGH", competitionIndex: 80, lowMicros: 3_000_000, highMicros: 9_000_000, conceptGroup: "CRM", sources: ["acme.com"] },
      { phrase: "sales crm", volume: 4000, competition: "MEDIUM", competitionIndex: 50, lowMicros: 2_000_000, highMicros: 6_000_000, conceptGroup: "CRM", sources: ["beta.io"] },
      { phrase: "email tool", volume: 30_000, competition: "LOW", competitionIndex: 20, lowMicros: 1_000_000, highMicros: 3_000_000, conceptGroup: "Email", sources: ["acme.com"] },
    ]);
    const t = themes(scored);
    expect(t.map((x) => x.name)).toEqual(["Email", "CRM"]); // Email has more total volume
    const crm = t.find((x) => x.name === "CRM")!;
    expect(crm.keyword_count).toBe(2);
    expect(crm.total_volume).toBe(16_000);
    expect(crm.competitors).toEqual(["acme.com", "beta.io"]);
    // per-kw competitiveness folds in relative CPC (max CPC = $9): crm software
    // 0.65*80+0.35*100=87, sales crm 0.65*50+0.35*(6/9*100)=56; volume-weighted
    // (87*12000 + 56*4000)/16000 = 79.25 -> 79
    expect(crm.avg_competitiveness).toBe(79);
    expect(crm.cpc_range).toBe("$2.00–$9.00");
    expect(crm.top_keywords[0].phrase).toBe("crm software");
  });

  it("collects unannotated keywords under UNTHEMED", () => {
    const scored = score([
      { phrase: "x", volume: 2000, competition: "LOW", competitionIndex: null, lowMicros: null, highMicros: null, conceptGroup: null, sources: ["seeds"] },
    ]);
    expect(themes(scored)[0].name).toBe(UNTHEMED);
  });
});

describe("indexHistory / overlayHistory", () => {
  const report = {
    keywords: [
      { text: "CRM Software", ctr: 0.062, avg_cpc: 4.1, clicks: 120, impressions: 1935 },
      { text: "sales crm", ctr: 0.031, avg_cpc: 3.2, clicks: 40, impressions: 1290 },
    ],
  };

  it("indexes report keyword rows by comparison key", () => {
    const idx = indexHistory(report);
    expect(idx.get("crm software")).toEqual({ ctr: 0.062, avg_cpc: 4.1, clicks: 120, impressions: 1935 });
  });

  it("returns an empty index for a report with no keywords array", () => {
    expect(indexHistory({}).size).toBe(0);
    expect(indexHistory(null).size).toBe(0);
  });

  it("overlays owned history only onto keywords the account has run", () => {
    const scored = score([
      { phrase: "crm software", volume: 12_000, competition: "HIGH", competitionIndex: 80, lowMicros: null, highMicros: 9_000_000, conceptGroup: "CRM", sources: ["acme.com"] },
      { phrase: "brand new term", volume: 5000, competition: "LOW", competitionIndex: 10, lowMicros: null, highMicros: 1_000_000, conceptGroup: "CRM", sources: ["beta.io"] },
    ]);
    const overlaid = overlayHistory(scored, indexHistory(report));
    expect(overlaid.find((k) => k.phrase === "crm software")?.owned?.ctr).toBe(0.062);
    expect(overlaid.find((k) => k.phrase === "brand new term")?.owned).toBeNull();
  });
});

describe("keywordToDict", () => {
  it("emits the snake_case wire shape with overlap = source count", () => {
    const [scored] = score([
      { phrase: "crm software", volume: 12_000, competition: "HIGH", competitionIndex: 80, lowMicros: 3_000_000, highMicros: 9_000_000, conceptGroup: "CRM", sources: ["acme.com", "beta.io"] },
    ]);
    const dict = keywordToDict({ ...scored, owned: null });
    expect(dict).toMatchObject({
      phrase: "crm software",
      bullet_text: "crm software (12k, HIGH, $3.00–$9.00)",
      competition_index: 80,
      cpc_range: "$3.00–$9.00",
      concept_group: "CRM",
      sources: ["acme.com", "beta.io"],
      overlap: 2,
      owned: null,
    });
  });
});

describe("buildPayload (pure pipeline)", () => {
  const probeResults: ProbeResult[] = [
    {
      label: "acme.com",
      error: null,
      ideas: [
        idea({ phrase: "crm software", source: "acme.com", volume: 12_000, competition: "HIGH", competitionIndex: 80, highMicros: 9_000_000, conceptGroup: "CRM" }),
        idea({ phrase: "email marketing tool", source: "acme.com", volume: 30_000, competition: "LOW", competitionIndex: 20, highMicros: 3_000_000, conceptGroup: "Email" }),
      ],
    },
    {
      label: "seeds",
      error: null,
      ideas: [idea({ phrase: "crm software", source: "seeds", volume: 12_000, competition: "HIGH", competitionIndex: 80, highMicros: 9_000_000, conceptGroup: "CRM" })],
    },
  ];

  it("assembles themes (by volume) and keywords (by opportunity), with overlap", () => {
    const payload = buildPayload({
      probeResults,
      competitors: ["https://acme.com"],
      seeds: ["crm software"],
      geo: DEFAULT_GEO,
      language: DEFAULT_LANGUAGE,
      history: new Map(),
    });
    expect(payload["keyword_count"]).toBe(2);
    expect(payload["theme_count"]).toBe(2);
    const themeNames = (payload["themes"] as Array<{ name: string }>).map((t) => t.name);
    expect(themeNames).toEqual(["Email", "CRM"]);
    const kws = payload["keywords"] as Array<{ phrase: string; overlap: number; opportunity: number }>;
    // email (high volume, low competition) should out-rank crm on opportunity
    expect(kws[0].phrase).toBe("email marketing tool");
    // crm software surfaced by both acme.com and seeds
    expect(kws.find((k) => k.phrase === "crm software")?.overlap).toBe(2);
  });

  it("surfaces probe errors under warnings", () => {
    const payload = buildPayload({
      probeResults: [...probeResults, { label: "dead.com", error: "URL not reachable", ideas: [] }],
      competitors: ["https://acme.com", "https://dead.com"],
      seeds: ["crm software"],
      geo: DEFAULT_GEO,
      language: DEFAULT_LANGUAGE,
      history: new Map(),
    });
    expect(payload["warnings"]).toEqual(["dead.com: URL not reachable"]);
  });
});

describe("main", () => {
  const errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const outSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

  afterEach(() => {
    errSpy.mockClear();
    outSpy.mockClear();
  });

  it("returns 2 when neither a competitor nor a seed is given", async () => {
    const code = await main(["--customer-id", "1234567890"], async () => []);
    expect(code).toBe(2);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("--competitor"));
  });

  it("routes url_seed vs keyword_seed probes and emits an ok:true envelope", async () => {
    const generate = async (req: services.IGenerateKeywordIdeasRequest) => {
      if (req.url_seed) {
        return [ideaRow("crm software", { avg_monthly_searches: 12_000, competition: "HIGH", competition_index: 80, high_top_of_page_bid_micros: 9_000_000 }, ["CRM"])];
      }
      return [ideaRow("sales crm", { avg_monthly_searches: 4000, competition: "MEDIUM", competition_index: 50, high_top_of_page_bid_micros: 6_000_000 }, ["CRM"])];
    };
    const code = await main(
      ["--customer-id", "1234567890", "--competitor", "https://acme.com", "--seed", "sales crm"],
      generate,
    );
    expect(code).toBe(0);
    const written = outSpy.mock.calls.map((c) => String(c[0])).join("");
    const parsed = JSON.parse(written) as { ok: boolean; keyword_count: number; themes: Array<{ name: string }> };
    expect(parsed.ok).toBe(true);
    expect(parsed.keyword_count).toBe(2);
    expect(parsed.themes[0].name).toBe("CRM");
  });

  it("returns 1 with an ok:false envelope when every probe fails", async () => {
    const code = await main(
      ["--customer-id", "1234567890", "--competitor", "https://acme.com"],
      async () => {
        throw new Error("quota exceeded");
      },
    );
    expect(code).toBe(1);
    const written = outSpy.mock.calls.map((c) => String(c[0])).join("");
    const parsed = JSON.parse(written) as { ok: boolean; step?: string; message?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.step).toBe("generate_keyword_ideas");
    expect(parsed.message).toContain("quota exceeded");
  });

  it("survives a partial probe failure and still reports the working source", async () => {
    const generate = async (req: services.IGenerateKeywordIdeasRequest) => {
      if (req.url_seed?.url === "https://dead.com") throw new Error("URL not reachable");
      return [ideaRow("crm software", { avg_monthly_searches: 12_000, competition: "HIGH", competition_index: 80 }, ["CRM"])];
    };
    const code = await main(
      ["--customer-id", "1234567890", "--competitor", "https://acme.com", "--competitor", "https://dead.com"],
      generate,
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(outSpy.mock.calls.map((c) => String(c[0])).join("")) as {
      ok: boolean;
      keyword_count: number;
      warnings?: string[];
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.keyword_count).toBe(1);
    expect(parsed.warnings?.[0]).toContain("dead.com");
  });

  it("truncates to MAX_COMPETITORS and warns", async () => {
    const many = Array.from({ length: MAX_COMPETITORS + 2 }, (_, i) => [`--competitor`, `https://c${i}.com`]).flat();
    let urlProbeCount = 0;
    await main(["--customer-id", "1234567890", ...many], async (req) => {
      if (req.url_seed) urlProbeCount += 1;
      return [];
    });
    expect(urlProbeCount).toBe(MAX_COMPETITORS);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("truncating to first"));
  });
});
