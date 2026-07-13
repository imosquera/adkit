import { describe, expect, it } from "vitest";
import { extractNegatives, readThemeGroups } from "./parse.js";

describe("readThemeGroups", () => {
  it("makes one ad group per Keyword Theme in file order, name stripped of role note", () => {
    const md = `
## Go To Market

### Keyword Themes

#### Widget Software — category core

- widget software
- widget platform

#### Free / freemium intent

- free widget tool
`;
    expect(readThemeGroups(md, 20)).toEqual([
      ["Widget Software", ["widget software", "widget platform"]],
      ["Free / freemium intent", ["free widget tool"]],
    ]);
  });

  it("strips offer suffix and markdown from theme keywords", () => {
    const md = `
## Go To Market

### Keyword Themes

#### Agency

- hire widget agency — offer: 15-minute walkthrough
- *widget pricing* now (12k, HIGH, $2–$8)
`;
    expect(readThemeGroups(md, 20)).toEqual([["Agency", ["hire widget agency", "widget pricing now"]]]);
  });

  it("excludes [spend-trap] themes regardless of marker position or case", () => {
    const before = `
## Go To Market

### Keyword Themes

#### Core

- widget software

#### [spend-trap] Generic Scheduling — keep-but-don't-lead

- scheduling tool
`;
    expect(readThemeGroups(before, 20)).toEqual([["Core", ["widget software"]]]);

    const after = `
## Go To Market

### Keyword Themes

#### Generic Scheduling [Spend-Trap] — keep-but-don't-lead

- scheduling tool

#### Core

- widget software
`;
    expect(readThemeGroups(after, 20)).toEqual([["Core", ["widget software"]]]);
  });

  it("dedups a keyword across themes (first-seen wins — no cannibalization)", () => {
    const md = `
## Go To Market

### Keyword Themes

#### Theme A

- shared widget
- only a

#### Theme B

- shared widget
- only b
`;
    expect(readThemeGroups(md, 20)).toEqual([
      ["Theme A", ["shared widget", "only a"]],
      ["Theme B", ["only b"]],
    ]);
  });

  it("caps keywords per theme", () => {
    const md = `
## Go To Market

### Keyword Themes

#### Theme

- one
- two
- three
- four
`;
    expect(readThemeGroups(md, 2)).toEqual([["Theme", ["one", "two"]]]);
  });

  it("returns empty when there is no ### Keyword Themes section (create then requires a gtm re-run)", () => {
    const onlyTiers = `
## Go To Market

### Keywords

#### Commercial

- buy widgets
`;
    expect(readThemeGroups(onlyTiers, 20)).toEqual([]);
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
