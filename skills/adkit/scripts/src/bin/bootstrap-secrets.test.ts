import { describe, expect, it } from "vitest";
import {
  addVersionArgs,
  createArgs,
  describeArgs,
  doneLine,
  isSensitive,
  promptFor,
  secretsFor,
  shouldSkip,
  skippedLine,
  updatedLine,
} from "./bootstrap-secrets.js";
import { SECRETS as RENDER_SECRETS } from "./render-yaml.js";

describe("secretsFor", () => {
  it("lists exactly the Google secret names, in prompt order, on google", () => {
    expect(secretsFor("google")).toEqual([
      "google-ads-developer-token",
      "google-ads-client-id",
      "google-ads-client-secret",
      "google-ads-refresh-token",
      "google-pagespeed-api-key",
    ]);
  });

  it("lists only the Meta secret names on meta", () => {
    expect(secretsFor("meta")).toEqual(["meta-access-token", "meta-app-secret"]);
  });

  // Load-bearing: every secret seeded here is one render-yaml fetches, and vice versa.
  it("covers exactly the secrets render-yaml fetches", () => {
    const seeded = [...secretsFor("google"), ...secretsFor("meta")];
    expect(seeded).toEqual(RENDER_SECRETS.map((s) => s.secret));
  });

  // Account numbers, not credentials: they live in `.adkit.yaml` via `ads.sh init`.
  it("does not seed either customer id", () => {
    // The historical secret names, pinned so a revert would fail loudly.
    const seeded = [...secretsFor("google"), ...secretsFor("meta")];
    expect(seeded).not.toContain("google-ads-login-customer-id");
    expect(seeded).not.toContain("google-ads-target-customer-id");
  });
});

describe("isSensitive", () => {
  it("treats the OAuth client id (a public identifier) as non-sensitive", () => {
    expect(isSensitive("google-ads-client-id")).toBe(false);
  });

  it("treats tokens/secrets as sensitive", () => {
    expect(isSensitive("google-ads-developer-token")).toBe(true);
    expect(isSensitive("google-ads-client-secret")).toBe(true);
    expect(isSensitive("google-ads-refresh-token")).toBe(true);
  });

  it("treats the PSI API key as sensitive (issue #40)", () => {
    expect(isSensitive("google-pagespeed-api-key")).toBe(true);
  });
});

describe("optional Meta secrets", () => {
  it("treats both Meta secrets as sensitive", () => {
    expect(isSensitive("meta-access-token")).toBe(true);
    expect(isSensitive("meta-app-secret")).toBe(true);
  });

  it("skips a blank Meta answer rather than storing it empty", () => {
    expect(shouldSkip("meta-access-token", "")).toBe(true);
    expect(shouldSkip("meta-app-secret", "   ")).toBe(true);
  });

  it("stores a non-blank Meta answer", () => {
    expect(shouldSkip("meta-access-token", "EAAB-token")).toBe(false);
  });

  it("keeps today's behaviour for the Google secrets, blank or not", () => {
    expect(shouldSkip("google-pagespeed-api-key", "")).toBe(false);
    expect(shouldSkip("google-ads-developer-token", "")).toBe(false);
  });

  it("formats the skip line", () => {
    expect(skippedLine("meta-app-secret")).toBe("  - meta-app-secret skipped (blank)\n");
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
