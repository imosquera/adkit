import { describe, expect, it } from "vitest";
import { normalizeId, resolveCustomer } from "./args.js";

describe("normalizeId", () => {
  it("strips dashes", () => {
    expect(normalizeId("891-192-5499")).toBe("8911925499");
    expect(normalizeId("8911925499")).toBe("8911925499");
  });

  it("passes through empty/null", () => {
    expect(normalizeId(null)).toBeNull();
    expect(normalizeId("")).toBe("");
  });
});

describe("resolveCustomer", () => {
  it("returns the first non-empty candidate", () => {
    expect(resolveCustomer(["111-111-1111", "2222222222"])).toBe("1111111111");
    expect(resolveCustomer([null, "", "333-333-3333"])).toBe("3333333333");
  });

  it("falls back to the yaml lookup", () => {
    const yamlLookup = () => "444-444-4444";
    expect(resolveCustomer([null], { yamlLookup })).toBe("4444444444");
    expect(resolveCustomer([null, null], { yamlLookup })).toBe("4444444444");
  });

  it("skips the yaml lookup when disabled", () => {
    const yamlLookup = () => "5555555555";
    expect(resolveCustomer([null], { fallbackYaml: false, yamlLookup })).toBeNull();
  });

  it("returns null when nothing resolves", () => {
    const yamlLookup = () => null;
    expect(resolveCustomer([null, ""], { yamlLookup })).toBeNull();
  });
});
