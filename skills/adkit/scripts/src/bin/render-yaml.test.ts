import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The gcloud shell-out is the only IO render-yaml does besides the config write.
// Mocked per-test so the credential fetch can be made to succeed or fail at will.
const execFileSync = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFileSync }));

import { CONFIG_FIELDS } from "../lib/config.js";
import { accessSecretArgs, main, mergeSecretsIntoConfig, SECRETS } from "./render-yaml.js";

// The guardrail shells out to git through the same `node:child_process` the mock
// above replaces. `createRequire` goes through Node's own loader, which vitest's
// module mocking does not intercept, so this is the real thing.
const realExecFileSync = createRequire(import.meta.url)("node:child_process").execFileSync as typeof import("node:child_process").execFileSync;

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

  // The credentials file holds credentials and nothing else: a preference that a
  // hand-edit (or a legacy file) left alongside them is dropped, not carried forward.
  it("drops non-credential fields rather than copying them into the secrets file", () => {
    const existing = { secrets_project: "proj-x", read_backend: "mcp", reports_dir: "custom/reports" };
    const merged = mergeSecretsIntoConfig(existing, new Map([["developer_token", "tok"]]));
    expect(merged).toEqual(new Map([["developer_token", "tok"]]));
  });

  it("keeps them when the caller passes the combined field set (a legacy target)", () => {
    const merged = mergeSecretsIntoConfig(
      { reports_dir: "custom/reports" },
      new Map([["developer_token", "tok"]]),
      CONFIG_FIELDS,
    );
    expect(merged.get("reports_dir")).toBe("custom/reports");
    expect(merged.get("developer_token")).toBe("tok");
  });

  // A missing optional secret must not blank a key the operator already has.
  it("keeps a credential already in the file when its secret is absent", () => {
    const merged = mergeSecretsIntoConfig({ psi_api_key: "kept" }, new Map([["developer_token", "tok"]]));
    expect(merged.get("psi_api_key")).toBe("kept");
  });

  it("starts from an empty config with no preferences set", () => {
    const merged = mergeSecretsIntoConfig({}, new Map([["developer_token", "tok"]]));
    expect(merged).toEqual(new Map([["developer_token", "tok"]]));
  });
});

describe("render-yaml writes only the credentials file", () => {
  let dir: string;
  let cwd: string;
  let prevConfig: string | undefined;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "adkit-render-")));
    cwd = process.cwd();
    process.chdir(dir);
    prevConfig = process.env["ADKIT_CONFIG"];
    process.env["ADKIT_CONFIG"] = join(dir, ".adkit.secrets.yaml");
    execFileSync.mockReset();
  });

  afterEach(() => {
    process.chdir(cwd);
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
  const secretsFile = (): string => readFileSync(join(dir, ".adkit.secrets.yaml"), "utf8");

  // Test 1: the committed preferences are neither fetched nor copied into the
  // credentials file — and, being in a different file, cannot be clobbered by it.
  it("leaves the committed adkit.yaml untouched and copies nothing out of it", () => {
    writeFileSync(
      join(dir, "adkit.yaml"),
      'target_customer_id: "1234567890"\nmcc_customer_id: "4444444444"\nsecrets_project: "proj-x"\n',
    );
    gcloudServing(CREDENTIAL_SECRETS);
    expect(main()).toBe(0);

    expect(readFileSync(join(dir, "adkit.yaml"), "utf8")).toBe(
      'target_customer_id: "1234567890"\nmcc_customer_id: "4444444444"\nsecrets_project: "proj-x"\n',
    );
    const written = secretsFile();
    expect(written).toContain('developer_token: "google-ads-developer-token-value"');
    expect(written).not.toContain("target_customer_id");
    expect(written).not.toContain("mcc_customer_id");
    expect(written).not.toContain("secrets_project");
    // And no gcloud call ever asked for an id secret.
    const requested = execFileSync.mock.calls.map((c) => (c[1] as string[])[(c[1] as string[]).indexOf("--secret") + 1]);
    expect(requested).not.toContain("google-ads-login-customer-id");
    expect(requested).not.toContain("google-ads-target-customer-id");
  });

  // Test 2: the case that aborted before the ids became preferences — neither id is
  // in Secret Manager, and that must not be fatal for the whole run.
  it("succeeds when neither id exists in Secret Manager", () => {
    // Only the four real credentials exist; the PSI key and both ids do not.
    gcloudServing(new Set(["google-ads-developer-token", "google-ads-client-id", "google-ads-client-secret", "google-ads-refresh-token"]));
    expect(main()).toBe(0);
    const written = secretsFile();
    expect(written).toContain('refresh_token: "google-ads-refresh-token-value"');
    // Absent is a legitimate state: neither id is invented, neither aborts the run.
    expect(written).not.toContain("target_customer_id");
    expect(written).not.toContain("mcc_customer_id");
  });

  it("writes the credentials file 0600", () => {
    gcloudServing(CREDENTIAL_SECRETS);
    expect(main()).toBe(0);
    expect(statSync(join(dir, ".adkit.secrets.yaml")).mode & 0o777).toBe(0o600);
  });

  // A hand-edit (or a legacy file used as the ADKIT_CONFIG target) can leave
  // preferences sitting in the credentials file; a re-render sweeps them out
  // rather than perpetuating them.
  it("strips preferences that were sitting in the credentials file", () => {
    writeFileSync(join(dir, ".adkit.secrets.yaml"), 'developer_token: "stale"\nreports_dir: "custom/reports"\n');
    gcloudServing(CREDENTIAL_SECRETS);
    expect(main()).toBe(0);
    const written = secretsFile();
    expect(written).toContain('developer_token: "google-ads-developer-token-value"');
    expect(written).not.toContain("reports_dir");
  });
});

// Compatibility: an existing setup can have ADKIT_CONFIG pointing at the old
// combined `.adkit.yaml`. Writing only the credentials there would delete the
// operator's preferences, so that target keeps its combined shape.
describe("render-yaml against a legacy combined target", () => {
  let dir: string;
  let cwd: string;
  let prevConfig: string | undefined;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "adkit-render-legacy-")));
    cwd = process.cwd();
    process.chdir(dir);
    prevConfig = process.env["ADKIT_CONFIG"];
    process.env["ADKIT_CONFIG"] = join(dir, ".adkit.yaml");
    execFileSync.mockReset();
    // Only gcloud is faked; the guardrail's git calls go to the real binary, which
    // reports this temp dir as being in no repo at all.
    execFileSync.mockImplementation((bin: string, args: readonly string[], opts: object) => {
      if (bin === "git") {
        return realExecFileSync(bin, [...args], opts as never);
      }
      return `${args[args.indexOf("--secret") + 1] ?? ""}-value\n`;
    });
  });

  afterEach(() => {
    process.chdir(cwd);
    if (prevConfig === undefined) {
      delete process.env["ADKIT_CONFIG"];
    } else {
      process.env["ADKIT_CONFIG"] = prevConfig;
    }
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("refreshes the credentials around the preferences instead of trimming them", () => {
    writeFileSync(
      join(dir, ".adkit.yaml"),
      'developer_token: "stale"\ntarget_customer_id: "1234567890"\nmcc_customer_id: "4444444444"\nreports_dir: "custom/reports"\n',
    );
    expect(main()).toBe(0);
    const written = readFileSync(join(dir, ".adkit.yaml"), "utf8");
    expect(written).toContain('developer_token: "google-ads-developer-token-value"');
    expect(written).toContain('target_customer_id: "1234567890"');
    expect(written).toContain('mcc_customer_id: "4444444444"');
    expect(written).toContain('reports_dir: "custom/reports"');
  });
});

// The guardrail, as render-yaml surfaces it: credentials are never written to a
// path git would commit, and the refusal says which path and why.
describe("render-yaml refuses a committable target", () => {
  let dir: string;
  let cwd: string;
  let prevConfig: string | undefined;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "adkit-render-git-")));
    cwd = process.cwd();
    process.chdir(dir);
    prevConfig = process.env["ADKIT_CONFIG"];
    execFileSync.mockReset();
    // The guard shells out to git; only `gcloud` is faked, so let git through.
    execFileSync.mockImplementation((bin: string, args: readonly string[], opts: object) =>
      bin === "git" ? realExecFileSync(bin, args, opts as never) : "value\n",
    );
    realExecFileSync("git", ["init", "-q"], { cwd: dir });
  });

  afterEach(() => {
    process.chdir(cwd);
    if (prevConfig === undefined) {
      delete process.env["ADKIT_CONFIG"];
    } else {
      process.env["ADKIT_CONFIG"] = prevConfig;
    }
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("emits the ok:false envelope and writes nothing when the path is not ignored", () => {
    const target = join(dir, ".agents", "skills", "adkit", ".adkit.secrets.yaml");
    mkdirSync(join(dir, ".agents", "skills", "adkit"), { recursive: true });
    process.env["ADKIT_CONFIG"] = target;
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    const code = main();
    process.stdout.write = original;

    expect(code).toBe(1);
    const envelope = JSON.parse(chunks.join(""));
    expect(envelope.ok).toBe(false);
    expect(envelope.step).toBe("secrets-path");
    expect(envelope.reason).toBe("not-ignored");
    expect(envelope.message).toContain(target);
    expect(existsSync(target)).toBe(false);
  });
});
