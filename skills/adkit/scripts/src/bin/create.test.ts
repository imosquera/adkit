import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildSkeleton, customerIdFor, ExitError, parseTopN, readBrief } from "./create.js";
import { extractNegatives, readThemeGroups, DEFAULT_TOP_N, MAX_KEYWORDS_PER_THEME } from "../ideas/parse.js";
import type { Brief } from "../lib/schema.js";

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

#### Informational

- what is a widget

#### Commercial

- buy widgets online
- compare widget prices

#### Negative Keywords

- jobs — reason: job seekers
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

  it("makes one ad group per non-empty tier, in tier order", () => {
    expect(skeleton.adGroups.map((ag) => ag.name)).toEqual(["Informational", "Commercial"]);
  });

  it("packs the tier keywords as PHRASE match", () => {
    const commercial = skeleton.adGroups.find((ag) => ag.name === "Commercial")!;
    expect(commercial.keywords).toEqual([
      { text: "buy widgets online", matchType: "PHRASE" },
      { text: "compare widget prices", matchType: "PHRASE" },
    ]);
  });

  it("emits the full 15-headline / 4-description RSA slots with TODO placeholders", () => {
    const rsa = skeleton.adGroups[0]!.responsiveSearchAd as {
      headlines: Array<{ text: string }>;
      descriptions: Array<{ text: string }>;
      finalUrl: string;
      path1: string;
      path2: string;
    };
    expect(rsa.headlines).toHaveLength(15);
    expect(rsa.descriptions).toHaveLength(4);
    expect(rsa.headlines[0]!.text).toContain("TODO headline 1");
    expect(rsa.finalUrl).toContain("TODO-published-slug");
    expect(rsa.path1).toBe("todo-keyword");
    expect(rsa.path2).toBe("todo-or-omit");
  });

  it("seeds campaign negatives from the idea and adds the placeholder assets", () => {
    const campaign = skeleton.campaign as {
      negativeKeywords: unknown[];
      sitelinks: unknown[];
      callouts: unknown[];
      priceAsset: { offerings: unknown[] };
      structuredSnippet: { values: unknown[] };
      budgetMicros: number;
      networkSettings: string;
      bidStrategy: string;
      aiMax: boolean;
    };
    expect(campaign.negativeKeywords).toEqual([{ text: "jobs", matchType: "PHRASE" }]);
    expect(campaign.sitelinks).toHaveLength(6);
    expect(campaign.callouts).toHaveLength(4);
    expect(campaign.priceAsset.offerings).toHaveLength(3);
    expect(campaign.structuredSnippet.values).toHaveLength(3);
    expect(campaign.budgetMicros).toBe(25_000_000);
    expect(campaign.networkSettings).toBe("search-partners-display");
    expect(campaign.bidStrategy).toBe("maximize-clicks");
    expect(campaign.aiMax).toBe(true);
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
