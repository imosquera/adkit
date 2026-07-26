import { describe, expect, it } from "vitest";
import { KEEP_YAML_LOGIN } from "../lib/auth.js";
import { normalizeId, resolveCustomer, resolveLoginCustomerId } from "./args.js";

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
// (inherit the yaml's login_customer_id, expressed as KEEP_YAML_LOGIN). `env` is
// injected, so nothing here touches process.env.
describe("resolveLoginCustomerId", () => {
  it("prefers the --manager flag over the environment", () => {
    expect(resolveLoginCustomerId("1234567890", { GOOGLE_ADS_LOGIN_CUSTOMER_ID: "9999999999" })).toBe(
      "1234567890",
    );
  });

  it("uses GOOGLE_ADS_LOGIN_CUSTOMER_ID when the flag is absent", () => {
    expect(resolveLoginCustomerId(null, { GOOGLE_ADS_LOGIN_CUSTOMER_ID: "9999999999" })).toBe(
      "9999999999",
    );
    expect(resolveLoginCustomerId(undefined, { GOOGLE_ADS_LOGIN_CUSTOMER_ID: "9999999999" })).toBe(
      "9999999999",
    );
  });

  it("inherits the yaml login when neither tier supplies a value", () => {
    expect(resolveLoginCustomerId(null, {})).toBe(KEEP_YAML_LOGIN);
    expect(resolveLoginCustomerId(undefined)).toBe(KEEP_YAML_LOGIN);
  });

  it("normalises a dashed id from either tier", () => {
    expect(resolveLoginCustomerId("222-222-2222", {})).toBe("2222222222");
    expect(resolveLoginCustomerId(null, { GOOGLE_ADS_LOGIN_CUSTOMER_ID: "222-222-2222" })).toBe(
      "2222222222",
    );
  });

  it("treats a blank or whitespace-only env value as ABSENT, never as 'no manager'", () => {
    // FR-007: an exported-but-empty variable must not clear an MCC login.
    expect(resolveLoginCustomerId(null, { GOOGLE_ADS_LOGIN_CUSTOMER_ID: "" })).toBe(KEEP_YAML_LOGIN);
    expect(resolveLoginCustomerId(null, { GOOGLE_ADS_LOGIN_CUSTOMER_ID: "   " })).toBe(
      KEEP_YAML_LOGIN,
    );
  });

  it("treats a blank flag as absent and falls through to the env tier", () => {
    expect(resolveLoginCustomerId("", { GOOGLE_ADS_LOGIN_CUSTOMER_ID: "9999999999" })).toBe(
      "9999999999",
    );
    expect(resolveLoginCustomerId("  ", { GOOGLE_ADS_LOGIN_CUSTOMER_ID: "9999999999" })).toBe(
      "9999999999",
    );
  });

  it("ignores unrelated environment keys", () => {
    expect(resolveLoginCustomerId(null, { GOOGLE_ADS_CUSTOMER_ID: "1111111111" })).toBe(
      KEEP_YAML_LOGIN,
    );
  });

  it("is pure: the same inputs give the same result and the env map is not mutated", () => {
    const env = { GOOGLE_ADS_LOGIN_CUSTOMER_ID: "222-222-2222" };
    expect(resolveLoginCustomerId(null, env)).toBe(resolveLoginCustomerId(null, env));
    expect(env).toEqual({ GOOGLE_ADS_LOGIN_CUSTOMER_ID: "222-222-2222" });
  });
});
