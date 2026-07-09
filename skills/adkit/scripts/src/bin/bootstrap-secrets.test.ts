import { describe, expect, it } from "vitest";
import {
  addVersionArgs,
  createArgs,
  describeArgs,
  doneLine,
  isSensitive,
  promptFor,
  SECRETS,
  updatedLine,
} from "./bootstrap-secrets.js";

describe("SECRETS", () => {
  it("lists the exact secret names in prompt order", () => {
    expect(SECRETS).toEqual([
      "google-ads-developer-token",
      "google-ads-client-id",
      "google-ads-client-secret",
      "google-ads-refresh-token",
      "google-ads-login-customer-id",
      "google-ads-target-customer-id",
    ]);
  });
});

describe("isSensitive", () => {
  it("treats ids (client_id, login/target customer id) as non-sensitive", () => {
    expect(isSensitive("google-ads-client-id")).toBe(false);
    expect(isSensitive("google-ads-login-customer-id")).toBe(false);
    expect(isSensitive("google-ads-target-customer-id")).toBe(false);
  });

  it("treats tokens/secrets as sensitive", () => {
    expect(isSensitive("google-ads-developer-token")).toBe(true);
    expect(isSensitive("google-ads-client-secret")).toBe(true);
    expect(isSensitive("google-ads-refresh-token")).toBe(true);
  });
});

describe("messages", () => {
  it("formats the prompt, confirmation, and completion lines", () => {
    expect(promptFor("google-ads-client-id")).toBe("Enter value for google-ads-client-id: ");
    expect(updatedLine("google-ads-client-id")).toBe("  ✓ google-ads-client-id updated\n");
    expect(doneLine()).toBe("Done. Render with: ads.sh render-yaml\n");
  });
});

describe("gcloud argv builders", () => {
  it("builds describe args", () => {
    expect(describeArgs("google-ads-client-id", "p")).toEqual([
      "secrets",
      "describe",
      "google-ads-client-id",
      "--project",
      "p",
    ]);
  });

  it("builds create args with automatic replication", () => {
    expect(createArgs("google-ads-client-id", "p")).toEqual([
      "secrets",
      "create",
      "google-ads-client-id",
      "--project",
      "p",
      "--replication-policy=automatic",
    ]);
  });

  it("builds add-version args reading from stdin", () => {
    expect(addVersionArgs("google-ads-client-id", "p")).toEqual([
      "secrets",
      "versions",
      "add",
      "google-ads-client-id",
      "--project",
      "p",
      "--data-file=-",
    ]);
  });
});
