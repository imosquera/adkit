/**
 * Reusable, non-secret project defaults for the adkit entrypoints.
 *
 * Distinct from `google-ads.yaml` (the API *credentials* file rendered by
 * `render-yaml` from Secret Manager — see {@link "./auth.js".credentialsPath}):
 * this file holds per-project preferences an operator would otherwise have to
 * re-pass as flags or re-export as env vars every session — the default
 * manager/target customer id, the Secret Manager project, the read backend, and
 * the output directories `create`/`report` write into. It carries no secrets and
 * is safe to commit.
 *
 * Written by `ads.sh init` ({@link "../bin/init.js"}); read via {@link loadConfig}.
 * Every field is optional — an absent file resolves to `{}`, and callers combine
 * it with a flag/env tier via {@link resolveTier}.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

/** The non-secret project defaults `init` writes and every entrypoint may read. */
export interface AdkitConfig {
  login_customer_id?: string;
  target_customer_id?: string;
  secrets_project?: string;
  read_backend?: string;
  reports_dir?: string;
  briefs_dir?: string;
  ideas_dir?: string;
}

/** One config field: its yaml key, prompt label, and default value. Emit/prompt order. */
export interface ConfigField {
  key: keyof AdkitConfig;
  label: string;
  default: string;
}

/** The config fields, in yaml-emit and prompt order. Defaults mirror the hardcoded values elsewhere in this codebase. */
export const CONFIG_FIELDS: readonly ConfigField[] = [
  { key: "login_customer_id", label: "Default manager/login customer id (used as login-customer-id when no --manager flag is passed)", default: "" },
  { key: "target_customer_id", label: "Default target/leaf customer id", default: "" },
  { key: "secrets_project", label: "GCP Secret Manager project", default: "your-project-prod" },
  { key: "read_backend", label: "Read backend (sdk|mcp)", default: "sdk" },
  { key: "reports_dir", label: "Reports output directory", default: "ads/output/reports" },
  { key: "briefs_dir", label: "Brief output directory", default: "adbriefs" },
  { key: "ideas_dir", label: "Processed-ideas directory", default: "ideas/processed" },
];

/** Path to the project config file (env override wins), resolved against the current working directory. */
export function configPath(): string {
  return process.env["ADKIT_CONFIG"] || join(process.cwd(), ".adkit.yaml");
}

/** Whether a config file already exists at {@link configPath}. */
export function configExists(): boolean {
  return existsSync(configPath());
}

/**
 * Serialize resolved field values into the yaml body text (trailing newline
 * included). Pure: fields absent from `values` (or blank) are skipped, mirroring
 * `render-yaml`'s `buildYamlBody`.
 */
export function buildConfigYamlBody(values: ReadonlyMap<string, string>): string {
  const header = [
    "# Written by adkit init. Reusable project defaults — no secrets.",
    "# Explicit flags and env vars still override these values at run time.",
  ];
  const fieldLines = CONFIG_FIELDS.flatMap((field) => {
    const value = values.get(field.key);
    if (!value) {
      return [];
    }
    const escaped = value.replace(/"/g, '\\"');
    return [`${field.key}: "${escaped}"`];
  });
  return [...header, ...fieldLines].join("\n") + "\n";
}

/** Parse a config yaml body into an {@link AdkitConfig}. Pure; unknown/missing fields are simply absent. */
export function parseConfig(text: string): AdkitConfig {
  return (parseYaml(text) as AdkitConfig | null) ?? {};
}

/** Load the project config from {@link configPath}, or `{}` when the file is absent or unreadable. */
export function loadConfig(): AdkitConfig {
  try {
    return parseConfig(readFileSync(configPath(), "utf8"));
  } catch {
    return {};
  }
}

/**
 * Resolve one setting through the flag -> env -> config -> fallback tiers,
 * the same shape as `resolveCustomer`/`resolveLoginCustomerId` in `cli/args.ts`.
 * The first non-blank tier wins; blank/whitespace is treated as absent.
 */
export function resolveTier(
  flag: string | null | undefined,
  envValue: string | undefined,
  configValue: string | undefined,
  fallback?: string,
): string | undefined {
  for (const candidate of [flag, envValue, configValue]) {
    if (candidate && candidate.trim()) {
      return candidate;
    }
  }
  return fallback;
}
