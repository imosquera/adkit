import { describe, expect, it } from "vitest";
import { lintDkiField } from "./lint.js";
import { parseDkiField } from "./parse.js";

const HEADLINE_LIMIT = 30;

describe("lintDkiField", () => {
  it("warns when a near-limit default leaves little headroom", () => {
    const field = parseDkiField("headline", `{keyword:${"x".repeat(28)}}`); // 28/30 chars
    const warnings = lintDkiField("headline", field, { fieldLimit: HEADLINE_LIMIT });
    expect(warnings.map((w) => w.category)).toContain("too-many-characters");
  });

  it("does not warn when there is comfortable headroom", () => {
    const field = parseDkiField("headline", "{keyword:Shoes}");
    const warnings = lintDkiField("headline", field, { fieldLimit: HEADLINE_LIMIT });
    expect(warnings.map((w) => w.category)).not.toContain("too-many-characters");
  });

  it("warns that DKI is unavailable for Dynamic Search Ads", () => {
    const field = parseDkiField("headline", "{keyword:Shoes}");
    const warnings = lintDkiField("headline", field, { fieldLimit: HEADLINE_LIMIT, isDsa: true });
    expect(warnings.map((w) => w.category)).toContain("dsa-unavailable");
  });

  it("does not warn about DSA for a field with no DKI codes", () => {
    const field = parseDkiField("headline", "Plain headline");
    const warnings = lintDkiField("headline", field, { fieldLimit: HEADLINE_LIMIT, isDsa: true });
    expect(warnings.map((w) => w.category)).not.toContain("dsa-unavailable");
  });

  it("warns for a restricted vertical (healthcare)", () => {
    const field = parseDkiField("headline", "{keyword:Shoes}");
    const warnings = lintDkiField("headline", field, { fieldLimit: HEADLINE_LIMIT, vertical: "healthcare" });
    expect(warnings.map((w) => w.category)).toContain("restricted-content");
  });

  it("warns for a restricted vertical (sexual content), case-insensitively", () => {
    const field = parseDkiField("headline", "{keyword:Shoes}");
    const warnings = lintDkiField("headline", field, { fieldLimit: HEADLINE_LIMIT, vertical: "Sexual-Content" });
    expect(warnings.map((w) => w.category)).toContain("restricted-content");
  });

  it("warns for a trademark-like token", () => {
    const field = parseDkiField("headline", "{keyword:Shoes} like Nike");
    const warnings = lintDkiField("headline", field, { fieldLimit: HEADLINE_LIMIT });
    expect(warnings.map((w) => w.category)).toContain("trademark");
  });

  it("warns for a likely misspelling in the default text", () => {
    const field = parseDkiField("headline", "{keyword:Recieve now}");
    const warnings = lintDkiField("headline", field, { fieldLimit: HEADLINE_LIMIT });
    expect(warnings.map((w) => w.category)).toContain("misspelling");
  });

  it("warns when a default trails on a dangling article/preposition", () => {
    const field = parseDkiField("headline", "{keyword:Best deals for}");
    const warnings = lintDkiField("headline", field, { fieldLimit: HEADLINE_LIMIT });
    expect(warnings.map((w) => w.category)).toContain("grammar");
  });

  it("warns when the landing page may not support dynamic text", () => {
    const field = parseDkiField("headline", "{keyword:Shoes}");
    const warnings = lintDkiField("headline", field, {
      fieldLimit: HEADLINE_LIMIT,
      landingPageSupportsDynamicText: false,
    });
    expect(warnings.map((w) => w.category)).toContain("landing-page");
  });

  it("produces no warnings for a clean, comfortably-sized DKI field", () => {
    const field = parseDkiField("headline", "{keyword:Shoes}");
    const warnings = lintDkiField("headline", field, { fieldLimit: HEADLINE_LIMIT });
    expect(warnings).toEqual([]);
  });
});
