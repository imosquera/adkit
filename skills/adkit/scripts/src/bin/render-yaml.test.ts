import { describe, expect, it } from "vitest";
import { accessSecretArgs, buildYamlBody, SECRETS } from "./render-yaml.js";

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

describe("buildYamlBody", () => {
  const full = new Map<string, string>([
    ["developer_token", "dev-tok"],
    ["client_id", "cid"],
    ["client_secret", "csecret"],
    ["refresh_token", "rtok"],
    ["login_customer_id", "1234567890"],
    ["target_customer_id", "0987654321"],
  ]);

  it("emits the header comments, quoted fields in order, and use_proto_plus", () => {
    expect(buildYamlBody(full, "proj-x")).toBe(
      [
        "# Rendered by adkit render-yaml from Secret Manager project proj-x.",
        "# Do not commit. Regenerate whenever secrets rotate.",
        'developer_token: "dev-tok"',
        'client_id: "cid"',
        'client_secret: "csecret"',
        'refresh_token: "rtok"',
        'login_customer_id: "1234567890"',
        'target_customer_id: "0987654321"',
        "use_proto_plus: true",
        "",
      ].join("\n"),
    );
  });

  it("skips fields absent from the map (optional target_customer_id)", () => {
    const partial = new Map(full);
    partial.delete("target_customer_id");
    const body = buildYamlBody(partial, "p");
    expect(body).not.toContain("target_customer_id");
    expect(body).toContain('login_customer_id: "1234567890"');
    expect(body.endsWith("use_proto_plus: true\n")).toBe(true);
  });

  it("escapes double quotes in values", () => {
    const values = new Map<string, string>([["developer_token", 'a"b']]);
    expect(buildYamlBody(values, "p")).toContain('developer_token: "a\\"b"');
  });
});
