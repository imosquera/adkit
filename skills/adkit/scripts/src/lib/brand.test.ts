/** Unit tests for the immutable differentiation reference (no SDK needed). */
import { describe, expect, it } from "vitest";

import { DIFFERENTIATION_AXES, GENERIC_AI_PHRASES } from "./brand.js";

describe("differentiation reference", () => {
  it("has the three expected axes", () => {
    expect(DIFFERENTIATION_AXES.map((a) => a.name)).toEqual(["integration", "consistency", "outcome"]);
    // every axis carries at least one trigger lexeme
    expect(DIFFERENTIATION_AXES.every((a) => a.triggers.length > 0)).toBe(true);
  });

  it("contains the expected generic AI phrases", () => {
    expect(GENERIC_AI_PHRASES).toContain("ai writer");
    expect(GENERIC_AI_PHRASES).toContain("ai chatbot");
  });
});
