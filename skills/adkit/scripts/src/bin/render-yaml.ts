/**
 * Render the google-ads.yaml credentials file from GCP Secret Manager.
 *
 * Faithful port of `ads_skill/bin/render_yaml.py`. Each field is pulled from
 * Secret Manager via `gcloud secrets versions access latest`, then serialized to
 * a local yaml at {@link credentialsPath}. Required secrets that are missing abort
 * (the `gcloud` call throws); the optional `target_customer_id` is skipped when
 * absent. The file is written atomically (temp file + rename) with 0600 perms so
 * the plaintext credentials never briefly exist world-readable.
 *
 * The project defaults to `your-project-prod`, overridable via the
 * `GOOGLE_ADS_SECRETS_PROJECT` env var.
 *
 * The IO (child_process/fs) is isolated at the edges; the yaml body is built by
 * the pure {@link buildYamlBody} from an already-resolved secrets map.
 */

import { execFileSync } from "node:child_process";
import { isMainModule } from "../cli/entry.js";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { credentialsPath } from "../lib/auth.js";

/** GCP project holding the secrets; env-overridable, mirroring the Python default. */
export const PROJECT = process.env["GOOGLE_ADS_SECRETS_PROJECT"] ?? "your-project-prod";

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

/** The credential fields, in yaml-emit order. Secret names are load-bearing. */
export const SECRETS: readonly SecretSpec[] = [
  { field: "developer_token", secret: "google-ads-developer-token", required: true },
  { field: "client_id", secret: "google-ads-client-id", required: true },
  { field: "client_secret", secret: "google-ads-client-secret", required: true },
  { field: "refresh_token", secret: "google-ads-refresh-token", required: true },
  { field: "login_customer_id", secret: "google-ads-login-customer-id", required: true },
  { field: "target_customer_id", secret: "google-ads-target-customer-id", required: false },
];

/**
 * Build the `gcloud secrets versions access latest` argument vector for `secret`
 * in `project`. Pure — returns the argv `execFileSync` will run.
 */
export function accessSecretArgs(secret: string, project: string): string[] {
  return ["secrets", "versions", "access", "latest", "--project", project, "--secret", secret];
}

/**
 * Serialize a resolved secrets map into the yaml body text (a trailing newline
 * included). Pure: takes an already-fetched `field -> value` map keyed in
 * {@link SECRETS} order and emits the two header comment lines, one `field: "value"`
 * line per present field (double-quotes in values escaped), then
 * `use_proto_plus: true`.
 *
 * Fields absent from `values` are skipped (mirroring the optional
 * `target_customer_id` being dropped when its secret is missing).
 */
export function buildYamlBody(values: ReadonlyMap<string, string>, project: string): string {
  const header: string[] = [
    `# Rendered by adkit render-yaml from Secret Manager project ${project}.`,
    "# Do not commit. Regenerate whenever secrets rotate.",
  ];
  const fieldLines = SECRETS.flatMap((spec) => {
    const value = values.get(spec.field);
    if (value === undefined) {
      return [];
    }
    const escaped = value.replace(/"/g, '\\"');
    return [`${spec.field}: "${escaped}"`];
  });
  const lines = [...header, ...fieldLines, "use_proto_plus: true"];
  return lines.join("\n") + "\n";
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
  const tmpPath = join(dir, `google-ads-${process.pid}-${Date.now()}.yaml`);
  writeFileSync(tmpPath, body, { mode: 0o600 });
  chmodSync(tmpPath, 0o600);
  renameSync(tmpPath, target);
}

/**
 * Render the yaml from Secret Manager and write it to {@link credentialsPath}.
 * Returns the process exit code. Emits `wrote <path>` to stdout on success,
 * matching the Python.
 */
export function main(): number {
  const target = credentialsPath();
  const values = readAllSecrets();
  const body = buildYamlBody(values, PROJECT);
  writeAtomic(target, body);
  process.stdout.write(`wrote ${target}\n`);
  return 0;
}

// Run as a CLI entrypoint (mirrors Python's `if __name__ == "__main__"`).
if (isMainModule(import.meta.url)) {
  process.exitCode = main();
}
