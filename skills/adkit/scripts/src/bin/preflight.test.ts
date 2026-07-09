import { describe, expect, it } from "vitest";
import { checkCredentialsExist, checkCustomerIdEnv } from "./preflight.js";

describe("checkCustomerIdEnv", () => {
  it("passes for a bare 10-digit id", () => {
    expect(checkCustomerIdEnv("1234567890")).toBeNull();
  });

  it("trims surrounding whitespace before validating", () => {
    expect(checkCustomerIdEnv("  1234567890  ")).toBeNull();
  });

  it("fails (step 'env') when unset", () => {
    const failure = checkCustomerIdEnv(undefined);
    expect(failure?.step).toBe("env");
    expect(failure?.message).toMatch(/10-digit/);
  });

  it("fails when empty", () => {
    expect(checkCustomerIdEnv("")?.step).toBe("env");
  });

  it("fails for a dashed id", () => {
    expect(checkCustomerIdEnv("123-456-7890")?.step).toBe("env");
  });

  it("fails for the wrong number of digits", () => {
    expect(checkCustomerIdEnv("123456789")?.step).toBe("env"); // 9 digits
    expect(checkCustomerIdEnv("12345678901")?.step).toBe("env"); // 11 digits
  });

  it("fails for non-numeric input", () => {
    expect(checkCustomerIdEnv("abcdefghij")?.step).toBe("env");
  });
});

describe("checkCredentialsExist", () => {
  it("passes when the file exists", () => {
    expect(checkCredentialsExist("/some/google-ads.yaml", () => true)).toBeNull();
  });

  it("fails (step 'credentials') when the file is missing", () => {
    const failure = checkCredentialsExist("/nope/google-ads.yaml", () => false);
    expect(failure?.step).toBe("credentials");
    expect(failure?.message).toContain("/nope/google-ads.yaml");
    expect(failure?.message).toMatch(/render-yaml/);
  });
});
