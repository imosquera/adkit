/**
 * Pull the Google Ads API credentials from GCP Secret Manager into `.adkit.yaml`.
 *
 * Faithful port of `ads_skill/bin/render_yaml.py`'s secret-fetching, retargeted at
 * the combined `.adkit.yaml` (see {@link "../lib/config.js"}) rather than a
 * dedicated `google-ads.yaml`. Each field is pulled via `gcloud secrets versions
 * access latest`, then **merged** into whatever config already exists at
 * {@link "../lib/config.js".configPath} — an operator's `secrets_project`,
 * `read_backend`, or output-dir preferences (set by `ads.sh init`, or hand-edited)
 * survive a re-render; only the credential fields are replaced. Required secrets
 * that are missing abort (the `gcloud` call throws); the optional
 * `target_customer_id` and `psi_api_key` fields are skipped when absent. The file
 * is written atomically
 * (temp file + rename) with 0600 perms so the plaintext credentials never briefly
 * exist world-readable.
 *
 * The project defaults to `your-project-prod`, overridable via the
 * `GOOGLE_ADS_SECRETS_PROJECT` env var or the config's `secrets_project`.
 *
 * The IO (child_process/fs) is isolated at the edges; the merge and the yaml body
 * are built by pure functions in `lib/config.ts`.
 */

import { execFileSync } from "node:child_process";
import { isMainModule } from "../cli/entry.js";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildConfigYamlBody, configPath, configToValueMap, loadConfig, resolveTier } from "../lib/config.js";

/** GCP project holding the secrets: env var, then the project config, then the Python-mirroring default. */
export const PROJECT = resolveTier(null, process.env["GOOGLE_ADS_SECRETS_PROJECT"], loadConfig().secrets_project, "your-project-prod")!;

/**
 * One credential field: the yaml key, its Secret Manager secret name, and whether
 * it is required. `target_customer_id` is skill-local (not a real google-ads client
 * field), so it is optional — skipped rather than fatal when its secret is absent.
 */
export interface SecretSpec {
  field: string;
  secret: string;
  required: boolean;
}

/** The credential fields, in fetch order. Secret names are load-bearing; must match `lib/config.ts`'s CREDENTIAL_FIELDS keys. */
export const SECRETS: readonly SecretSpec[] = [
  { field: "developer_token", secret: "google-ads-developer-token", required: true },
  { field: "client_id", secret: "google-ads-client-id", required: true },
  { field: "client_secret", secret: "google-ads-client-secret", required: true },
  { field: "refresh_token", secret: "google-ads-refresh-token", required: true },
  { field: "login_customer_id", secret: "google-ads-login-customer-id", required: true },
  { field: "target_customer_id", secret: "google-ads-target-customer-id", required: false },
  // Optional, like target_customer_id: not every operator has PSI access, and
  // audit's PSI diagnosis degrades gracefully (skips with a reason) without it.
  { field: "psi_api_key", secret: "google-pagespeed-api-key", required: false },
];

/**
 * Build the `gcloud secrets versions access latest` argument vector for `secret`
 * in `project`. Pure — returns the argv `execFileSync` will run.
 */
export function accessSecretArgs(secret: string, project: string): string[] {
  return ["secrets", "versions", "access", "latest", "--project", project, "--secret", secret];
}

/**
 * Fetch a single secret's latest version from Secret Manager via `gcloud`.
 * Returns the trimmed value, or `null` when an optional secret is missing (the
 * `gcloud` failure is swallowed only for non-required secrets — a missing required
 * secret rethrows). stderr is discarded to keep the noise off the terminal.
 */
function readSecret(spec: SecretSpec): string | null {
  try {
    const out = execFileSync("gcloud", accessSecretArgs(spec.secret, PROJECT), {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim();
  } catch (exc) {
    if (spec.required) {
      throw exc;
    }
    return null;
  }
}

/** Fetch every secret, returning a `field -> value` map (absent optionals omitted). */
function readAllSecrets(): Map<string, string> {
  const entries = SECRETS.flatMap((spec): Array<[string, string]> => {
    const value = readSecret(spec);
    return value === null ? [] : [[spec.field, value]];
  });
  return new Map(entries);
}

/** Atomically write `body` to `target` with 0600 perms (temp file + rename). */
function writeAtomic(target: string, body: string): void {
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true });
  const tmpPath = join(dir, `adkit-${process.pid}-${Date.now()}.yaml`);
  writeFileSync(tmpPath, body, { mode: 0o600 });
  chmodSync(tmpPath, 0o600);
  renameSync(tmpPath, target);
}

/**
 * Fetch every secret from Secret Manager and merge it into the existing config
 * (fresh credential values win; every other field — `secrets_project`,
 * `read_backend`, the output dirs — is carried over unchanged). Pure given an
 * already-fetched secrets map and the existing config.
 */
export function mergeSecretsIntoConfig(existing: ReturnType<typeof loadConfig>, secrets: ReadonlyMap<string, string>): Map<string, string> {
  const merged = configToValueMap(existing);
  for (const [field, value] of secrets) {
    merged.set(field, value);
  }
  return merged;
}

/**
 * Render the credentials from Secret Manager and merge them into
 * {@link configPath}. Returns the process exit code. Emits `wrote <path>` to
 * stdout on success, matching the Python.
 */
export function main(): number {
  const target = configPath();
  const merged = mergeSecretsIntoConfig(loadConfig(), readAllSecrets());
  writeAtomic(target, buildConfigYamlBody(merged));
  process.stdout.write(`wrote ${target}\n`);
  return 0;
}

// Run as a CLI entrypoint (mirrors Python's `if __name__ == "__main__"`).
if (isMainModule(import.meta.url)) {
  process.exitCode = main();
}
