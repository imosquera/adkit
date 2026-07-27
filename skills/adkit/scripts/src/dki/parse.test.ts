import { describe, expect, it } from "vitest";
import { CASING_MODES, DkiFieldError, containsDkiSyntax, parseDkiField } from "./parse.js";

describe("parseDkiField", () => {
  it("parses plain text with zero codes; worst-case length is the string length", () => {
    const field = parseDkiField("headline", "Running Shoes For Sale");
    expect(field.codes).toEqual([]);
    expect(field.worstCaseLength).toBe("Running Shoes For Sale".length);
    expect(field.source).toBe("Running Shoes For Sale");
  });

  it.each(CASING_MODES)("recognizes the %s casing mode", (mode) => {
    const field = parseDkiField("headline", `{${mode}:Running Shoes}`);
    expect(field.codes).toHaveLength(1);
    expect(field.codes[0]).toEqual({ casing: mode, default: "Running Shoes", source: `{${mode}:Running Shoes}` });
  });

  it("rejects an unrecognized casing token", () => {
    expect(() => parseDkiField("headline", "{kEyword:Running Shoes}")).toThrow(DkiFieldError);
    expect(() => parseDkiField("headline", "{kEyword:Running Shoes}")).toThrow(/unrecognized casing/);
  });

  it("rejects a code with no default text (no colon)", () => {
    expect(() => parseDkiField("headline", "{KeyWord}")).toThrow(/requires a default text/);
  });

  it("rejects a code with an empty default text", () => {
    expect(() => parseDkiField("headline", "{keyword:}")).toThrow(/empty default text/);
  });

  it("rejects unclosed braces", () => {
    expect(() => parseDkiField("headline", "{keyword:a")).toThrow(/unclosed/);
  });

  it("rejects nested braces", () => {
    expect(() => parseDkiField("headline", "{keyword:{x}}")).toThrow(/nested/);
  });

  it("rejects a stray closing brace with no matching opener", () => {
    expect(() => parseDkiField("headline", "{keyword:a}b}")).toThrow(/unmatched/);
    expect(() => parseDkiField("headline", "oops}")).toThrow(/unmatched/);
  });

  it("computes worst-case length across multiple codes plus surrounding literal text", () => {
    const field = parseDkiField("description", "{keyword:a} for {keyword:bb} today");
    expect(field.codes).toHaveLength(2);
    // "" + "a" + " for " + "bb" + " today"
    expect(field.worstCaseLength).toBe("a for bb today".length);
  });

  it("preserves the default text verbatim, including internal whitespace", () => {
    const field = parseDkiField("headline", "{keyword:  spaced out  }");
    expect(field.codes[0]!.default).toBe("  spaced out  ");
  });

  it("preserves the exact source string for round-trip emission", () => {
    const source = "Best {KeyWord:Running Shoes} Deals";
    const field = parseDkiField("headline", source);
    expect(field.source).toBe(source);
    expect(field.codes[0]!.source).toBe("{KeyWord:Running Shoes}");
  });

  it("names the field in the thrown error", () => {
    expect(() => parseDkiField("path1", "{keyword:}")).toThrow(/^path1:/);
  });
});

describe("containsDkiSyntax", () => {
  it("detects braces in either direction", () => {
    expect(containsDkiSyntax("plain text")).toBe(false);
    expect(containsDkiSyntax("{keyword:shoes}")).toBe(true);
    expect(containsDkiSyntax("stray }")).toBe(true);
  });
});
