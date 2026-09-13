/**
 * Pull the ad-platform API credentials from GCP Secret Manager into
 * `.adkit.secrets.yaml`.
 *
 * Faithful port of `ads_skill/bin/render_yaml.py`'s secret-fetching, retargeted at
 * the credentials half of the split config (see {@link "../lib/config.js"}). Each
 * field is pulled via `gcloud secrets versions access latest` and written to
 * {@link "../lib/config.js".secretsPath} — the `ADKIT_CONFIG` path when one is set,
 * else `.adkit.secrets.yaml` at the repo root.
 *
 * **Only the credential fields are ever written here.** The project preferences —
 * both customer ids, `secrets_project`, `read_backend`, the output dirs — live in
 * the committed `adkit.yaml` and are neither fetched nor copied into this file;
 * `mcc_customer_id`/`target_customer_id` in particular are account numbers, not
 * secrets. A credential already in the file survives when its secret is absent, so
 * an optional field is never blanked by a re-render.
 *
 * Required secrets that are missing abort (the `gcloud` call throws); optional ones
 * are skipped when absent. Which secrets are required follows the resolved platform
 * (`--platform` > `ADKIT_PLATFORM` > `platform` in `adkit.yaml` > `google`, see
 * {@link secretSpecsFor}): a Google project
 * requires the four Google Ads credentials and treats `psi_api_key` and the Meta
 * fields as optional, exactly as before; a Meta project requires only
 * `meta_access_token`, so absent Google secrets never abort it. The file is written atomically
 * (temp file + rename) with 0600 perms so the plaintext credentials never briefly
 * exist world-readable, and only after the guardrail in `lib/secrets-guard.ts`
 * confirms the target path is not committable.
 *
 * The project defaults to `your-project-prod`, overridable via the
 * `GOOGLE_ADS_SECRETS_PROJECT` env var or the config's `secrets_project`.
 *
 * The IO (child_process/fs) is isolated at the edges; the merge and the yaml body
 * are built by pure functions in `lib/config.ts`.
 */

import { execFileSync } from "node:child_process";
import { isMainModule } from "../cli/entry.js";
import { emitJson, errorEnvelope } from "../cli/output.js";
import { platformResult, type Platform } from "../cli/platform.js";
import {
  type AdkitConfig,
  buildConfigYamlBody,
  configToValueMap,
  CREDENTIAL_FIELDS,
  type ConfigYamlShape,
  isLegacyConfigFile,
  META_CREDENTIAL_FIELDS,
  COMBINED_YAML_SHAPE,
  type ConfigField,
  loadConfig,
  readConfigFile,
  resolveTier,
  SECRETS_YAML_SHAPE,
  secretsPath,
  writeYamlAtomic,
} from "../lib/config.js";
import { assertWritableSecretsPath, SecretsPathError } from "../lib/secrets-guard.js";

/** GCP project holding the secrets: env var, then the project config, then the Python-mirroring default. */
export const PROJECT = resolveTier(null, process.env["GOOGLE_ADS_SECRETS_PROJECT"], loadConfig().secrets_project, "your-project-prod")!;

/**
 * One credential field: the yaml key, its Secret Manager secret name, and whether
 * it is required. A `required: false` field is skipped rather than fatal when its
 * secret is absent.
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
  // Optional: not every operator has PSI access, and audit's PSI diagnosis
  // degrades gracefully (skips with a reason) without it.
  { field: "psi_api_key", secret: "google-pagespeed-api-key", required: false },
];

/**
 * The Meta credential fields, in fetch order after {@link SECRETS}. Optional by
 * default — only a Meta project has them, so their absence must never abort a
 * Google-only render; {@link secretSpecsFor} makes the token required on Meta.
 * Fetched values land via {@link withMetaCredentials}.
 */
export const META_SECRETS: readonly SecretSpec[] = [
  { field: "meta_access_token", secret: "meta-access-token", required: false },
  { field: "meta_app_secret", secret: "meta-app-secret", required: false },
];

/**
 * Every secret render-yaml fetches for `platform`, with its requiredness. Pure.
 *
 * `google` is {@link SECRETS} unchanged followed by the optional
 * {@link META_SECRETS}, so a Google render requires exactly what it did before.
 * `meta` fetches the same secrets but requires `meta_access_token` alone — every
 * Meta command needs it, even though `bootstrap-secrets` lets a blank answer skip
 * seeding it — and makes the Google credentials optional, so a Meta-only project
 * whose Secret Manager holds no Google secrets still renders.
 */
export function secretSpecsFor(platform: Platform): readonly SecretSpec[] {
  const all = [...SECRETS, ...META_SECRETS];
  return platform === "google" ? all : all.map((spec) => ({ ...spec, required: spec.field === "meta_access_token" }));
}

/**
 * `shape` widened to also admit the Meta credential fields. Pure.
 *
 * The file shapes themselves stay per-platform; render-yaml alone widens them so a
 * fetched Meta secret is written (and one already in the file survives) instead of
 * being filtered out. A Google-only project has no Meta values, and blank fields
 * are never emitted, so its output is byte-identical to the unwidened shape.
 */
export function withMetaCredentials(shape: ConfigYamlShape): ConfigYamlShape {
  const present = new Set(shape.fields.map((f) => f.key));
  return { ...shape, fields: [...shape.fields, ...META_CREDENTIAL_FIELDS.filter((f) => !present.has(f.key))] };
}

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

/** Fetch every secret in `specs`, returning a `field -> value` map (absent optionals omitted). */
function readAllSecrets(specs: readonly SecretSpec[]): Map<string, string> {
  const entries = specs.flatMap((spec): Array<[string, string]> => {
    const value = readSecret(spec);
    return value === null ? [] : [[spec.field, value]];
  });
  return new Map(entries);
}

/**
 * The credentials to write: the ones already in the secrets file, overlaid with the
 * freshly fetched ones. Pure.
 *
 * `existing` is narrowed to `fields` on the way in — {@link CREDENTIAL_FIELDS} for
 * the secrets file, so a preference that a hand-edit left alongside the credentials
 * is dropped rather than copied forward; that file holds secrets and nothing else.
 * A legacy combined target passes the full field set instead, because there the
 * preferences share the file and trimming them would delete them.
 */
export function mergeSecretsIntoConfig(
  existing: AdkitConfig,
  secrets: ReadonlyMap<string, string>,
  fields: readonly ConfigField[] = CREDENTIAL_FIELDS,
): Map<string, string> {
  return new Map([...configToValueMap(existing, fields), ...secrets]);
}

/**
 * Render the credentials from Secret Manager into {@link secretsPath}. Returns the
 * process exit code. Emits `wrote <path>` to stdout on success, matching the
 * Python; a target path the guardrail refuses emits the standard `ok:false`
 * envelope and writes nothing.
 */
export function main(): number {
  const platform = platformResult(process.argv.slice(2), process.env, loadConfig());
  if (platform.kind === "err") {
    emitJson(errorEnvelope(platform.message, { step: "platform" }));
    return 1;
  }
  const target = secretsPath();
  try {
    const warning = assertWritableSecretsPath(target);
    if (warning) {
      process.stderr.write(`${warning}\n`);
    }
  } catch (exc) {
    if (exc instanceof SecretsPathError) {
      emitJson(errorEnvelope(exc.message, { step: exc.step, path: exc.path, reason: exc.reason }));
      return 1;
    }
    throw exc;
  }
  // A legacy `.adkit.yaml` target keeps its combined shape: both halves live in that
  // one file, so writing only the credentials would delete the operator's preferences.
  const shape = withMetaCredentials(isLegacyConfigFile(target) ? COMBINED_YAML_SHAPE : SECRETS_YAML_SHAPE);
  // Only the target file is re-read — never the merged config — so a preference
  // from adkit.yaml can never be written back into the credentials file.
  const merged = mergeSecretsIntoConfig(readConfigFile(target), readAllSecrets(secretSpecsFor(platform.value)), shape.fields);
  writeYamlAtomic(target, buildConfigYamlBody(merged, shape), 0o600);
  process.stdout.write(`wrote ${target}\n`);
  return 0;
}

// Run as a CLI entrypoint (mirrors Python's `if __name__ == "__main__"`).
if (isMainModule(import.meta.url)) {
  process.exitCode = main();
}
