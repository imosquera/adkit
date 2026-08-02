import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashEmail, hashPhone } from "./hash.js";

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

describe("hashEmail", () => {
  it("hashes the trimmed, lowercased email", () => {
    expect(hashEmail("  John.Doe@Example.com  ")).toBe(sha256("john.doe@example.com"));
  });

  it("is stable for the same normalized input", () => {
    expect(hashEmail("a@b.com")).toBe(hashEmail("A@B.COM"));
  });

  it("never returns the plaintext value", () => {
    const raw = "sensitive@example.com";
    expect(hashEmail(raw)).not.toContain(raw);
    expect(hashEmail(raw)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("hashPhone", () => {
  it("normalizes a bare 10-digit US number to E.164 before hashing", () => {
    expect(hashPhone("555-123-4567")).toBe(sha256("+15551234567"));
  });

  it("preserves an already-E.164 number", () => {
    expect(hashPhone("+44 20 7946 0958")).toBe(sha256("+442079460958"));
  });

  it("never returns the plaintext value", () => {
    const raw = "555-000-1111";
    expect(hashPhone(raw)).not.toContain(raw);
    expect(hashPhone(raw)).toMatch(/^[0-9a-f]{64}$/);
  });
});
