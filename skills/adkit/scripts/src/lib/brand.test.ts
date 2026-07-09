/** Unit tests for the dynamic differentiation profile parser (no SDK needed). */
import { describe, expect, it } from "vitest";

import { EMPTY_PROFILE, parseDifferentiationProfile } from "./brand.js";

describe("parseDifferentiationProfile", () => {
  it("parses a full profile", () => {
    const profile = parseDifferentiationProfile({
      competitors: ["ChatGPT"],
      genericPhrases: ["ai chatbot"],
      axes: [{ name: "integration", triggers: ["crm", "hubspot"] }],
    });
    expect(profile.competitors).toEqual(["ChatGPT"]);
    expect(profile.axes[0].name).toBe("integration");
  });

  it("defaults missing parts to empty", () => {
    expect(parseDifferentiationProfile({})).toEqual(EMPTY_PROFILE);
  });

  it("rejects an axis with no triggers", () => {
    expect(() => parseDifferentiationProfile({ axes: [{ name: "x", triggers: [] }] })).toThrow();
  });

  it("rejects unknown keys", () => {
    expect(() => parseDifferentiationProfile({ nope: true })).toThrow();
  });
});
