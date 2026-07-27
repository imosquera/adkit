import { describe, expect, it } from "vitest";
import { accessSecretArgs, mergeSecretsIntoConfig, SECRETS } from "./render-yaml.js";

describe("SECRETS", () => {
  it("has the exact secret names and required flags in emit order", () => {
    expect(SECRETS.map((s) => [s.field, s.secret, s.required])).toEqual([
      ["developer_token", "google-ads-developer-token", true],
      ["client_id", "google-ads-client-id", true],
      ["client_secret", "google-ads-client-secret", true],
      ["refresh_token", "google-ads-refresh-token", true],
      ["login_customer_id", "google-ads-login-customer-id", true],
      ["target_customer_id", "google-ads-target-customer-id", false],
    ]);
  });
});

describe("accessSecretArgs", () => {
  it("builds the gcloud access argv", () => {
    expect(accessSecretArgs("google-ads-client-id", "proj-x")).toEqual([
      "secrets",
      "versions",
      "access",
      "latest",
      "--project",
      "proj-x",
      "--secret",
      "google-ads-client-id",
    ]);
  });
});

describe("mergeSecretsIntoConfig", () => {
  it("overwrites credential fields with the freshly fetched secrets", () => {
    const existing = { developer_token: "stale-tok", secrets_project: "proj-x" };
    const secrets = new Map([
      ["developer_token", "fresh-tok"],
      ["client_id", "cid"],
    ]);
    const merged = mergeSecretsIntoConfig(existing, secrets);
    expect(merged.get("developer_token")).toBe("fresh-tok");
    expect(merged.get("client_id")).toBe("cid");
  });

  it("carries over non-credential preferences untouched", () => {
    const existing = { secrets_project: "proj-x", read_backend: "mcp", reports_dir: "custom/reports" };
    const merged = mergeSecretsIntoConfig(existing, new Map([["developer_token", "tok"]]));
    expect(merged.get("secrets_project")).toBe("proj-x");
    expect(merged.get("read_backend")).toBe("mcp");
    expect(merged.get("reports_dir")).toBe("custom/reports");
  });

  it("starts from an empty config with no preferences set", () => {
    const merged = mergeSecretsIntoConfig({}, new Map([["developer_token", "tok"]]));
    expect(merged).toEqual(new Map([["developer_token", "tok"]]));
  });
});
