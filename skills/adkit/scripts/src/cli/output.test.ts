import { describe, expect, it, vi } from "vitest";
import { emitJson, errorEnvelope, ok, sdkErrorMessage } from "./output.js";

describe("ok", () => {
  it("builds a success envelope", () => {
    expect(ok()).toEqual({ ok: true });
    expect(ok({ customer: "123", count: 2 })).toEqual({ ok: true, customer: "123", count: 2 });
  });
});

describe("errorEnvelope", () => {
  it("builds a failure envelope", () => {
    expect(errorEnvelope("boom")).toEqual({ ok: false, message: "boom" });
    expect(errorEnvelope("boom", { step: "auth" })).toEqual({ ok: false, message: "boom", step: "auth" });
  });
});

describe("emitJson", () => {
  it("writes pretty-printed JSON to stdout", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      emitJson(ok({ a: 1 }));
      const out = spy.mock.calls[0][0] as string;
      expect(JSON.parse(out)).toEqual({ ok: true, a: 1 });
      expect(out.endsWith("\n")).toBe(true);
      expect(out).toContain("\n  "); // indent=2 pretty-printing
    } finally {
      spy.mockRestore();
    }
  });

  it("coerces non-JSON-native values to strings", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      emitJson({ n: 10n });
      const out = spy.mock.calls[0][0] as string;
      expect(JSON.parse(out)).toEqual({ n: "10" });
    } finally {
      spy.mockRestore();
    }
  });
});

describe("sdkErrorMessage", () => {
  it("falls back to the error message", () => {
    expect(sdkErrorMessage(new Error("plain"))).toBe("plain");
  });

  it("unwraps a GoogleAdsException failure", () => {
    const exc = {
      failure: { errors: [{ message: "first bad thing" }, { message: "second bad thing" }] },
    };
    expect(sdkErrorMessage(exc)).toBe("first bad thing; second bad thing");
  });

  it("never returns [object Object] for a plain object without the failure shape", () => {
    const out = sdkErrorMessage({ some: "object", nested: { code: 7 } });
    expect(out).not.toBe("[object Object]");
    expect(out).not.toContain("[object Object]");
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain("some");
  });

  it("surfaces a top-level error_string", () => {
    expect(sdkErrorMessage({ error_string: "quota exhausted" })).toBe("quota exhausted");
  });

  it("surfaces errors[].message / errorCode when there is no failure wrapper", () => {
    const exc = { errors: [{ message: "bad field", errorCode: { queryError: "PROHIBITED_METRIC" } }] };
    const out = sdkErrorMessage(exc);
    expect(out).not.toContain("[object Object]");
    expect(out).toContain("bad field");
  });

  it("unwraps a nested failure object", () => {
    const exc = { failure: { errors: [{ message: "deep message" }] } };
    expect(sdkErrorMessage({ failure: exc.failure })).toBe("deep message");
  });

  it("handles primitives and nullish inputs legibly", () => {
    expect(sdkErrorMessage("boom")).toBe("boom");
    expect(sdkErrorMessage(null)).not.toContain("[object Object]");
    expect(sdkErrorMessage(undefined)).not.toContain("[object Object]");
    expect(sdkErrorMessage(42)).toBe("42");
  });

  it("truncates a very large serialized object", () => {
    const big = { blob: "x".repeat(2000) };
    const out = sdkErrorMessage(big);
    expect(out).not.toContain("[object Object]");
    expect(out.length).toBeLessThan(600);
    expect(out.endsWith("…")).toBe(true);
  });

  it("surfaces error codes when errors carry no message (code-only path)", () => {
    const out = sdkErrorMessage({ errors: [{ errorCode: { queryError: "PROHIBITED_METRIC" } }] });
    expect(out).not.toContain("[object Object]");
    expect(out).toContain("PROHIBITED_METRIC");
  });

  it("falls back to codes when a failure's messages are all non-strings", () => {
    const out = sdkErrorMessage({ failure: { errors: [{ error_code: { queryError: 59 } }] } });
    expect(out).not.toContain("[object Object]");
    expect(out).toContain("59");
  });

  it("never throws or leaks [object Object] on adversarial inputs", () => {
    // null element inside errors[]
    expect(() => sdkErrorMessage({ failure: { errors: [null] } })).not.toThrow();
    // BigInt error code (JSON.stringify would throw)
    expect(sdkErrorMessage({ errors: [{ errorCode: 59n }] })).not.toBe("[object Object]");
    // circular, null-prototype object with no known shape
    const circular = Object.create(null) as Record<string, unknown>;
    circular.self = circular;
    const out = sdkErrorMessage(circular);
    expect(out).not.toContain("[object Object]");
    expect(out.length).toBeGreaterThan(0);
  });
});
