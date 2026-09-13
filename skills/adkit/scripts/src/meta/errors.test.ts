import { describe, expect, it } from "vitest";
import { z } from "zod";
import { MetaApiError, MetaConfigError, envelopeFailure, formatMetaError, redactMetaSecrets } from "./errors.js";

describe("MetaApiError", () => {
  it("carries the envelope fields and is an Error", () => {
    const err = new MetaApiError({
      step: "campaign",
      code: 100,
      subcode: 1487390,
      message: "Invalid parameter",
      userTitle: "Bad budget",
      userMessage: "Budget too low",
      fbtraceId: "AbC123",
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("MetaApiError");
    expect(err).toMatchObject({ step: "campaign", code: 100, subcode: 1487390, message: "Invalid parameter", fbtraceId: "AbC123" });
  });
});

describe("MetaConfigError", () => {
  it("carries step, field and path", () => {
    const err = new MetaConfigError("credentials", "missing meta_access_token", "meta_access_token", "/x/.adkit.secrets.yaml");
    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject({ name: "MetaConfigError", step: "credentials", field: "meta_access_token", path: "/x/.adkit.secrets.yaml" });
  });
});

describe("formatMetaError", () => {
  it("formats a full Graph error", () => {
    const err = new MetaApiError({
      step: "adset",
      code: 100,
      subcode: 33,
      message: "Unsupported post request",
      userTitle: "Oops",
      userMessage: "Try again",
      fbtraceId: "T1",
    });
    expect(formatMetaError(err)).toBe("Meta API error 100/33 at adset: Unsupported post request — Oops: Try again [fbtrace_id T1]");
  });

  it("formats a minimal Graph error", () => {
    expect(formatMetaError(new MetaApiError({ step: "ad", code: 190, message: "Token expired" }))).toBe(
      "Meta API error 190 at ad: Token expired",
    );
  });

  it("includes zod issues for schema failures", () => {
    const parsed = z.object({ id: z.string() }).safeParse({ id: 1 });
    const issues = parsed.success ? [] : parsed.error.issues;
    const text = formatMetaError(new MetaApiError({ step: "campaign", code: "schema", message: "unexpected response", issues }));
    expect(text).toMatch(/^Meta API error schema at campaign: unexpected response \(id: /);
  });

  it("formats config errors with field and path", () => {
    expect(formatMetaError(new MetaConfigError("ad-account", "bad id", "meta_ad_account_id", "adkit.yaml"))).toBe(
      "bad id (meta_ad_account_id in adkit.yaml)",
    );
    expect(formatMetaError(new MetaConfigError("platform", "unknown platform"))).toBe("unknown platform");
  });

  it("formats other throwables", () => {
    expect(formatMetaError(new TypeError("fetch failed"))).toBe("TypeError: fetch failed");
    expect(formatMetaError("boom")).toBe("boom");
    expect(formatMetaError(42)).toBe("42");
  });

  it("redacts access_token and appsecret_proof in URLs and messages", () => {
    const url = "https://graph.facebook.com/v23.0/act_1/campaigns?access_token=EAABsecret123&appsecret_proof=deadbeef&fields=id";
    const text = formatMetaError(new TypeError(`fetch failed for ${url}`));
    expect(text).not.toContain("EAABsecret123");
    expect(text).not.toContain("deadbeef");
    expect(text).toBe(
      "TypeError: fetch failed for https://graph.facebook.com/v23.0/act_1/campaigns?access_token=[REDACTED]&appsecret_proof=[REDACTED]&fields=id",
    );
  });

  it("redacts secrets inside Meta error fields", () => {
    const err = new MetaApiError({
      step: "insights",
      code: 1,
      message: "failed: access_token=EAAtok",
      userMessage: "see ?appsecret_proof=abc123 ",
    });
    const text = formatMetaError(err);
    expect(text).not.toContain("EAAtok");
    expect(text).not.toContain("abc123");
  });

  it("redacts non-Error throwables too", () => {
    expect(formatMetaError("GET /me?access_token=EAAx")).toBe("GET /me?access_token=[REDACTED]");
  });
});

describe("redactMetaSecrets", () => {
  it("redacts JSON-shaped secrets", () => {
    expect(redactMetaSecrets('{"access_token":"EAAx","appsecret_proof": "abc","id":"1"}')).toBe(
      '{"access_token":"[REDACTED]","appsecret_proof":"[REDACTED]","id":"1"}',
    );
  });

  it("redacts the PageSpeed Insights key= query parameter", () => {
    const url = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=https%3A%2F%2Fx.com&strategy=mobile&key=AIzaSecret";
    expect(redactMetaSecrets(`fetch failed for ${url}`)).toBe(
      "fetch failed for https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=https%3A%2F%2Fx.com&strategy=mobile&key=[REDACTED]",
    );
    expect(redactMetaSecrets("?key=AIza1 monkey=business")).toBe("?key=[REDACTED] monkey=business");
  });

  it("leaves text without secrets unchanged", () => {
    expect(redactMetaSecrets("nothing to see")).toBe("nothing to see");
  });
});

describe("envelopeFailure", () => {
  it("keeps a MetaApiError's own step", () => {
    const exc = new MetaApiError({ step: "campaign", code: 100, message: "Invalid parameter" });
    expect(envelopeFailure(exc, "fallback")).toEqual({ step: "campaign", message: formatMetaError(exc) });
  });

  it("keeps a MetaConfigError's own step", () => {
    expect(envelopeFailure(new MetaConfigError("ad-account", "no ad account"), "fallback")).toEqual({
      step: "ad-account",
      message: "no ad account",
    });
  });

  it("attributes any other throwable to the fallback step, redacted", () => {
    expect(envelopeFailure(new Error("GET /me?access_token=EAAx"), "auth")).toEqual({
      step: "auth",
      message: "Error: GET /me?access_token=[REDACTED]",
    });
  });
});
