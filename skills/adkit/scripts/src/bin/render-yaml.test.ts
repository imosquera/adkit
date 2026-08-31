import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The gcloud shell-out is the only IO render-yaml does besides the config write.
// Mocked per-test so the credential fetch can be made to succeed or fail at will.
const execFileSync = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFileSync }));

import { accessSecretArgs, main, mergeSecretsIntoConfig, SECRETS } from "./render-yaml.js";

describe("SECRETS", () => {
  it("has the exact secret names and required flags in emit order", () => {
    expect(SECRETS.map((s) => [s.field, s.secret, s.required])).toEqual([
      ["developer_token", "google-ads-developer-token", true],
      ["client_id", "google-ads-client-id", true],
      ["client_secret", "google-ads-client-secret", true],
      ["refresh_token", "google-ads-refresh-token", true],
      ["psi_api_key", "google-pagespeed-api-key", false],
    ]);
  });

  // The customer ids are locally-authored preferences now; render-yaml must neither
  // fetch them nor be able to clobber what `init` or a hand-edit put in `.adkit.yaml`.
  it("does not fetch either customer id", () => {
    expect(SECRETS.map((s) => s.field)).not.toContain("mcc_customer_id");
    expect(SECRETS.map((s) => s.field)).not.toContain("target_customer_id");
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

describe("render-yaml leaves the customer ids alone (they are not secrets)", () => {
  let dir: string;
  let prevConfig: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "adkit-render-"));
    prevConfig = process.env["ADKIT_CONFIG"];
    process.env["ADKIT_CONFIG"] = join(dir, ".adkit.yaml");
    execFileSync.mockReset();
  });

  afterEach(() => {
    if (prevConfig === undefined) {
      delete process.env["ADKIT_CONFIG"];
    } else {
      process.env["ADKIT_CONFIG"] = prevConfig;
    }
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /** Every credential secret resolves to `<field>-value`; anything else is "not found". */
  function gcloudServing(available: ReadonlySet<string>): void {
    execFileSync.mockImplementation((_bin: string, args: readonly string[]) => {
      const secret = args[args.indexOf("--secret") + 1] ?? "";
      if (!available.has(secret)) {
        throw new Error(`NOT_FOUND: ${secret}`);
      }
      return `${secret}-value\n`;
    });
  }

  const CREDENTIAL_SECRETS = new Set(SECRETS.map((s) => s.secret));

  // Test 1: an id put there by `init` or a hand-edit survives a re-render verbatim.
  it("leaves an existing target_customer_id and mcc_customer_id untouched", async () => {
    writeFileSync(
      process.env["ADKIT_CONFIG"]!,
      'target_customer_id: "1234567890"\nmcc_customer_id: "4444444444"\nsecrets_project: "proj-x"\nuse_proto_plus: true\n',
    );
    gcloudServing(CREDENTIAL_SECRETS);
    expect(main()).toBe(0);
    const written = readFileSync(process.env["ADKIT_CONFIG"]!, "utf8");
    expect(written).toContain('target_customer_id: "1234567890"');
    expect(written).toContain('mcc_customer_id: "4444444444"');
    expect(written).toContain('secrets_project: "proj-x"');
    // The credentials were refreshed around them.
    expect(written).toContain('developer_token: "google-ads-developer-token-value"');
    // And no gcloud call ever asked for an id secret.
    const requested = execFileSync.mock.calls.map((c) => (c[1] as string[])[(c[1] as string[]).indexOf("--secret") + 1]);
    expect(requested).not.toContain("google-ads-login-customer-id");
    expect(requested).not.toContain("google-ads-target-customer-id");
  });

  // Test 2: the case that aborts today — neither id is in Secret Manager, and the
  // old `mcc_customer_id: required: true` spec made that fatal for the whole run.
  it("succeeds when neither id exists in Secret Manager", async () => {
    writeFileSync(process.env["ADKIT_CONFIG"]!, 'secrets_project: "proj-x"\nuse_proto_plus: true\n');
    // Only the four real credentials exist; the PSI key and both ids do not.
    gcloudServing(new Set(["google-ads-developer-token", "google-ads-client-id", "google-ads-client-secret", "google-ads-refresh-token"]));
    expect(main()).toBe(0);
    const written = readFileSync(process.env["ADKIT_CONFIG"]!, "utf8");
    expect(written).toContain('refresh_token: "google-ads-refresh-token-value"');
    // Absent is a legitimate state: neither id is invented, neither aborts the run.
    expect(written).not.toContain("target_customer_id");
    expect(written).not.toContain("mcc_customer_id");
  });
});
