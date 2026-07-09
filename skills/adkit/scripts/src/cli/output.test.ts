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
});
