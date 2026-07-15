import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildSkeleton,
  customerIdFor,
  ExitError,
  keywordCountWarning,
  parseTopN,
  readBrief,
  TARGET_KEYWORDS,
} from "./create.js";
import { extractNegatives, readThemeGroups, DEFAULT_TOP_N, MAX_KEYWORDS_PER_THEME } from "../ideas/parse.js";
import { parseBrief, type Brief } from "../lib/schema.js";

// Silence the `error: ...` / scaffold-summary stderr writes the die-path emits.
vi.spyOn(process.stderr, "write").mockImplementation(() => true);

afterEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

/** A minimal valid brief YAML round-trippable through readBrief. */
function validBriefYaml(): string {
  const headlines = Array.from({ length: 15 }, (_, i) => `        - text: Headline number ${i + 1}`).join("\n");
  const descriptions = Array.from({ length: 4 }, (_, i) => `        - text: Description number ${i + 1} ok`).join("\n");
  return [
    "name: widget-launch",
    "version: 1",
    "campaign:",
    "  name: widget-launch-search",
    "  budgetMicros: 25000000",
    "adGroups:",
    "  - name: buyers",
    "    defaultBidMicros: 1500000",
    "    keywords:",
    "      - text: buy widgets",
    "    responsiveSearchAd:",
    "      finalUrl: https://www.example.com/ideas/widget",
    "      headlines:",
    headlines,
    "      descriptions:",
    descriptions,
    "",
  ].join("\n");
}

const SAMPLE_IDEA = `
## Go To Market

### Keywords

- what is a widget
- buy widgets online
- compare widget prices

#### Negative Keywords

- jobs — reason: job seekers

### Keyword Themes

> One ad group per theme (spend-trap excluded).

#### Widget Basics — category core
> Offer: low-threat guide

- what is a widget

#### Widget Purchase — buyer intent
> Offer: start free trial

- buy widgets online
- compare widget prices

#### Generic Tools [spend-trap] — keep-but-don't-lead

- generic scheduling tool
`;

describe("parseTopN", () => {
  it("defaults when flag absent", () => {
    expect(parseTopN(["some-idea", "--dry-run"])).toBe(DEFAULT_TOP_N);
  });

  it("reads the flag value", () => {
    expect(parseTopN(["some-idea", "--top-n", "5"])).toBe(5);
  });

  it("rejects a non-integer", () => {
    expect(() => parseTopN(["--top-n", "abc"])).toThrow(ExitError);
  });

  it("rejects out-of-range values", () => {
    expect(() => parseTopN(["--top-n", String(MAX_KEYWORDS_PER_THEME + 1)])).toThrow(ExitError);
    expect(() => parseTopN(["--top-n", "0"])).toThrow(ExitError);
  });
});

describe("keywordCountWarning", () => {
  it("is silent inside the ±10% band around the target (90-110)", () => {
    expect(keywordCountWarning(TARGET_KEYWORDS)).toBeNull();
    expect(keywordCountWarning(90)).toBeNull();
    expect(keywordCountWarning(110)).toBeNull();
  });

  it("warns to add more when below the band", () => {
    const w = keywordCountWarning(40);
    expect(w).toContain("40 keywords total");
    expect(w).toContain(`~${TARGET_KEYWORDS}`);
    expect(w).toContain("add more");
  });

  it("warns to trim when above the band", () => {
    const w = keywordCountWarning(140);
    expect(w).toContain("140 keywords total");
    expect(w).toContain("trim");
  });
});

describe("buildSkeleton", () => {
  const themes = readThemeGroups(SAMPLE_IDEA, 20);
  const negatives = extractNegatives(SAMPLE_IDEA);
  const skeleton = buildSkeleton("widget-launch", themes, negatives) as {
    name: string;
    version: number;
    campaign: Record<string, unknown>;
    adGroups: Array<Record<string, unknown>>;
  };

  it("carries the name, version, and campaign name", () => {
    expect(skeleton.name).toBe("widget-launch");
    expect(skeleton.version).toBe(1);
    expect(skeleton.campaign.name).toBe("widget-launch-search");
  });

  it("makes one ad group per keyword theme, in file order, spend-trap excluded", () => {
    expect(skeleton.adGroups.map((ag) => ag.name)).toEqual(["Widget Basics", "Widget Purchase"]);
  });

  it("packs the theme keywords as PHRASE match", () => {
    const purchase = skeleton.adGroups.find((ag) => ag.name === "Widget Purchase")!;
    expect(purchase.keywords).toEqual([
      { text: "buy widgets online", matchType: "PHRASE" },
      { text: "compare widget prices", matchType: "PHRASE" },
    ]);
  });

  it("emits the full 15-headline / 4-description RSA slots with TODO placeholders", () => {
    const rsa = skeleton.adGroups[0]!.responsiveSearchAd as {
      headlines: Array<{ text: string }>;
      descriptions: Array<{ text: string }>;
      finalUrl: string;
    };
    expect(rsa.headlines).toHaveLength(15);
    expect(rsa.descriptions).toHaveLength(4);
    expect(rsa.headlines[0]!.text).toContain("TODO headline 1");
    expect(rsa.finalUrl).toContain("TODO-published-slug");
  });

  it("omits the optional path1/path2 (a leftover placeholder is rejected at validation)", () => {
    const rsa = skeleton.adGroups[0]!.responsiveSearchAd as Record<string, unknown>;
    expect(rsa).not.toHaveProperty("path1");
    expect(rsa).not.toHaveProperty("path2");
  });

  it("seeds campaign negatives and omits the optional priceAsset/structuredSnippet blocks", () => {
    const campaign = skeleton.campaign as {
      negativeKeywords: unknown[];
      sitelinks: unknown[];
      callouts: unknown[];
      budgetMicros: number;
      networkSettings: string;
      bidStrategy: string;
      aiMax: boolean;
    };
    expect(campaign.negativeKeywords).toEqual([{ text: "jobs", matchType: "PHRASE" }]);
    expect(campaign.sitelinks).toHaveLength(6);
    expect(campaign.callouts).toHaveLength(4);
    // Optional asset blocks are omitted so a required-only brief validates (bug 3).
    expect(campaign).not.toHaveProperty("priceAsset");
    expect(campaign).not.toHaveProperty("structuredSnippet");
    expect(campaign.budgetMicros).toBe(25_000_000);
    expect(campaign.networkSettings).toBe("search-partners-display");
    expect(campaign.bidStrategy).toBe("maximize-clicks");
    expect(campaign.aiMax).toBe(true);
  });

  it("a scaffold with only its required TODO fields filled in passes validation (bug 3)", () => {
    // Simulate an operator filling the required placeholders with valid copy and
    // leaving every optional block untouched. This must parse without hand-deleting
    // priceAsset/structuredSnippet/path1/path2.
    const filled = structuredClone(skeleton) as {
      campaign: { sitelinks: Array<{ text: string; finalUrl: string }>; callouts: string[] };
      adGroups: Array<{
        responsiveSearchAd: { headlines: Array<{ text: string }>; descriptions: Array<{ text: string }>; finalUrl: string };
      }>;
    };
    for (const ag of filled.adGroups) {
      ag.responsiveSearchAd.headlines = ag.responsiveSearchAd.headlines.map((_, i) => ({ text: `Headline number ${i + 1}` }));
      ag.responsiveSearchAd.descriptions = ag.responsiveSearchAd.descriptions.map((_, i) => ({ text: `Description number ${i + 1} ok` }));
      ag.responsiveSearchAd.finalUrl = "https://www.example.com/ideas/widget";
    }
    filled.campaign.sitelinks = filled.campaign.sitelinks.map((_, i) => ({
      text: `Sitelink ${i + 1}`,
      finalUrl: "https://www.example.com/ideas/widget",
    }));
    filled.campaign.callouts = filled.campaign.callouts.map((_, i) => `Callout ${i + 1}`);
    expect(() => parseBrief(filled)).not.toThrow();
  });
});

describe("readBrief", () => {
  function writeTemp(name: string, body: string): string {
    const dir = mkdtempSync(join(tmpdir(), "adkit-create-"));
    const path = join(dir, name);
    writeFileSync(path, body);
    return path;
  }

  it("parses a valid brief into a typed Brief", () => {
    const path = writeTemp("brief.yaml", validBriefYaml());
    const brief = readBrief(path);
    expect(brief.name).toBe("widget-launch");
    expect(brief.adGroups).toHaveLength(1);
    expect(brief.adGroups[0]!.name).toBe("buyers");
  });

  it("dies listing the zod issues on a validation error", () => {
    // Missing required adGroups and campaign → validation fails.
    const path = writeTemp("bad.yaml", "name: widget-launch\nversion: 1\n");
    expect(() => readBrief(path)).toThrow(ExitError);
  });

  it("dies when the brief file is absent", () => {
    expect(() => readBrief(join(tmpdir(), "definitely-missing-brief-xyz.yaml"))).toThrow(ExitError);
  });

  it("round-trips a double-quoted description containing a colon-space (bug 2)", () => {
    // A realistic RSA line: "Protect earned trust: start free ...". Double-quoted,
    // the colon is safe and the brief parses.
    const yaml = validBriefYaml().replace(
      "        - text: Description number 1 ok",
      '        - text: "Protect earned trust: start free today"',
    );
    const path = writeTemp("colon.yaml", yaml);
    const brief = readBrief(path);
    expect(brief.adGroups[0]!.responsiveSearchAd.descriptions[0]!.text).toBe(
      "Protect earned trust: start free today",
    );
  });

  it("surfaces an actionable message when an unquoted colon-space breaks the YAML (bug 2)", () => {
    // Same line WITHOUT quotes → YAMLParseError ("nested mappings"). readBrief must
    // catch it and tell the operator to quote the value, not leak the raw trace.
    const yaml = validBriefYaml().replace(
      "        - text: Description number 1 ok",
      "        - text: Protect earned trust: start free today",
    );
    const path = writeTemp("bad-colon.yaml", yaml);
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    expect(() => readBrief(path)).toThrow(ExitError);
    const out = writes.join("");
    expect(out).toContain("not valid YAML");
    expect(out).toContain("double quotes");
  });
});

describe("customerIdFor", () => {
  const briefWith = (customerId?: string): Brief =>
    ({ customerId, adGroups: [], campaign: {} }) as unknown as Brief;

  it("prefers the brief's customerId, dash-stripped", () => {
    const prev = process.env["GOOGLE_ADS_CUSTOMER_ID"];
    delete process.env["GOOGLE_ADS_CUSTOMER_ID"];
    try {
      expect(customerIdFor(briefWith("891-192-5499"))).toBe("8911925499");
    } finally {
      if (prev !== undefined) {
        process.env["GOOGLE_ADS_CUSTOMER_ID"] = prev;
      }
    }
  });

  it("falls back to the GOOGLE_ADS_CUSTOMER_ID env when the brief has none", () => {
    const prev = process.env["GOOGLE_ADS_CUSTOMER_ID"];
    process.env["GOOGLE_ADS_CUSTOMER_ID"] = "1234567890";
    try {
      expect(customerIdFor(briefWith())).toBe("1234567890");
    } finally {
      if (prev === undefined) {
        delete process.env["GOOGLE_ADS_CUSTOMER_ID"];
      } else {
        process.env["GOOGLE_ADS_CUSTOMER_ID"] = prev;
      }
    }
  });
});
