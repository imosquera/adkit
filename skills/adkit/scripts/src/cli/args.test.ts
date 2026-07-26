import { describe, expect, it } from "vitest";
import { KEEP_YAML_LOGIN } from "../lib/auth.js";
import { loginHeaderValue, normalizeId, resolveCustomer, resolveLoginCustomerId } from "./args.js";

describe("normalizeId", () => {
  it("strips dashes", () => {
    expect(normalizeId("111-111-1111")).toBe("1111111111");
    expect(normalizeId("1111111111")).toBe("1111111111");
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

// The login-customer-id chain: --manager flag -> GOOGLE_ADS_LOGIN_CUSTOMER_ID ->
// (inherit the yaml's login_customer_id, tagged `source: "yaml"`). `env` is a
// required parameter, so nothing here touches process.env.
describe("resolveLoginCustomerId", () => {
  it("prefers the --manager flag over the environment", () => {
    expect(
      resolveLoginCustomerId("1234567890", { GOOGLE_ADS_LOGIN_CUSTOMER_ID: "9999999999" }),
    ).toEqual({ source: "flag", value: "1234567890" });
  });

  it("uses GOOGLE_ADS_LOGIN_CUSTOMER_ID when the flag is absent", () => {
    expect(resolveLoginCustomerId(null, { GOOGLE_ADS_LOGIN_CUSTOMER_ID: "9999999999" })).toEqual({
      source: "env",
      value: "9999999999",
    });
    expect(
      resolveLoginCustomerId(undefined, { GOOGLE_ADS_LOGIN_CUSTOMER_ID: "9999999999" }),
    ).toEqual({ source: "env", value: "9999999999" });
  });

  it("defers to the credentials when neither tier supplies a value", () => {
    // Tagged "yaml", NOT collapsed to "no manager": a header is still sent whenever
    // google-ads.yaml carries a login_customer_id.
    expect(resolveLoginCustomerId(null, {})).toEqual({ source: "yaml" });
    expect(resolveLoginCustomerId(undefined, {})).toEqual({ source: "yaml" });
  });

  it("normalises a dashed id from either tier", () => {
    expect(resolveLoginCustomerId("222-222-2222", {})).toEqual({
      source: "flag",
      value: "2222222222",
    });
    expect(resolveLoginCustomerId(null, { GOOGLE_ADS_LOGIN_CUSTOMER_ID: "222-222-2222" })).toEqual({
      source: "env",
      value: "2222222222",
    });
  });

  it("treats a blank or whitespace-only env value as ABSENT, never as 'no manager'", () => {
    // FR-007: an exported-but-empty variable must not clear an MCC login.
    expect(resolveLoginCustomerId(null, { GOOGLE_ADS_LOGIN_CUSTOMER_ID: "" })).toEqual({
      source: "yaml",
    });
    expect(resolveLoginCustomerId(null, { GOOGLE_ADS_LOGIN_CUSTOMER_ID: "   " })).toEqual({
      source: "yaml",
    });
  });

  it("treats a blank flag as absent and falls through to the env tier", () => {
    expect(resolveLoginCustomerId("", { GOOGLE_ADS_LOGIN_CUSTOMER_ID: "9999999999" })).toEqual({
      source: "env",
      value: "9999999999",
    });
    expect(resolveLoginCustomerId("  ", { GOOGLE_ADS_LOGIN_CUSTOMER_ID: "9999999999" })).toEqual({
      source: "env",
      value: "9999999999",
    });
  });

  it("ignores unrelated environment keys", () => {
    expect(resolveLoginCustomerId(null, { GOOGLE_ADS_CUSTOMER_ID: "1111111111" })).toEqual({
      source: "yaml",
    });
  });

  it("rejects a non-digits --manager flag, naming the flag", () => {
    expect(() => resolveLoginCustomerId("not-an-id", {})).toThrow(/--manager must be digits only/);
  });

  it("rejects a non-digits env value, naming the VARIABLE and not the flag", () => {
    // The operator never passed --manager here; blaming it would send them to fix
    // the wrong thing.
    expect(() => resolveLoginCustomerId(null, { GOOGLE_ADS_LOGIN_CUSTOMER_ID: "1; DROP" })).toThrow(
      /GOOGLE_ADS_LOGIN_CUSTOMER_ID must be digits only/,
    );
    expect(() =>
      resolveLoginCustomerId(null, { GOOGLE_ADS_LOGIN_CUSTOMER_ID: "1; DROP" }),
    ).not.toThrow(/--manager/);
  });

  it("does not mutate the env map it is given", () => {
    const env = { GOOGLE_ADS_LOGIN_CUSTOMER_ID: "222-222-2222" };
    resolveLoginCustomerId(null, env);
    expect(env).toEqual({ GOOGLE_ADS_LOGIN_CUSTOMER_ID: "222-222-2222" });
  });
});

describe("loginHeaderValue", () => {
  it("maps the yaml tier to the inherit sentinel and the others to their id", () => {
    expect(loginHeaderValue({ source: "yaml" })).toBe(KEEP_YAML_LOGIN);
    expect(loginHeaderValue({ source: "flag", value: "1234567890" })).toBe("1234567890");
    expect(loginHeaderValue({ source: "env", value: "9999999999" })).toBe("9999999999");
  });
});
