import { describe, expect, it } from "vitest";
import { extractNegatives, readThemeGroups } from "./parse.js";

describe("readThemeGroups", () => {
  it("makes one ad group per tier in order", () => {
    const md = `
## Go To Market

### Keywords

#### Informational

- what is a widget

#### Commercial

- buy widgets online
- compare widget prices

#### Transactional

- widget checkout
`;
    expect(readThemeGroups(md, 20)).toEqual([
      ["Informational", ["what is a widget"]],
      ["Commercial", ["buy widgets online", "compare widget prices"]],
      ["Transactional", ["widget checkout"]],
    ]);
  });

  it("strips offer suffix and markdown", () => {
    const md = `
## Go To Market

### Keywords

#### Commercial

- hire widget agency — offer: 15-minute walkthrough
- *widget pricing* now
`;
    expect(readThemeGroups(md, 20)).toEqual([["Commercial", ["hire widget agency", "widget pricing now"]]]);
  });

  it("reads tiers verbatim (no grouping decision)", () => {
    const md = `
## Go To Market

### Keywords

#### Commercial

- widget pricing
- compare widgets

#### Transactional

- buy widgets
`;
    expect(readThemeGroups(md, 20)).toEqual([
      ["Commercial", ["widget pricing", "compare widgets"]],
      ["Transactional", ["buy widgets"]],
    ]);
  });

  it("caps keywords per theme", () => {
    const md = `
## Go To Market

### Keywords

#### Commercial

- one
- two
- three
- four
`;
    expect(readThemeGroups(md, 2)).toEqual([["Commercial", ["one", "two"]]]);
  });

  it("returns empty when no gtm section", () => {
    expect(readThemeGroups("## Something Else\n\n- foo\n", 20)).toEqual([]);
  });
});

describe("extractNegatives", () => {
  it("parses the section and strips the reason", () => {
    const md = `
## Go To Market

### Keywords

#### Commercial

- buy widgets

#### Negative Keywords

- jobs — reason: job seekers
- *free* download
- near me
`;
    expect(extractNegatives(md)).toEqual([
      { text: "jobs", matchType: "PHRASE" },
      { text: "free download", matchType: "PHRASE" },
      { text: "near me", matchType: "PHRASE" },
    ]);
  });

  it("returns empty when absent", () => {
    const md = "## Go To Market\n\n### Keywords\n\n#### Commercial\n\n- buy widgets\n";
    expect(extractNegatives(md)).toEqual([]);
  });
});
