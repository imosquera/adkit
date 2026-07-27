/**
 * The project's single local config file: `.adkit.yaml`.
 *
 * Folds together two things that used to live in separate files:
 *  - the Google Ads API **credentials** (`developer_token`, `client_id`,
 *    `client_secret`, `refresh_token`, `login_customer_id`,
 *    `target_customer_id`) that `render-yaml` used to write to
 *    `~/.config/google-ads/google-ads.yaml`;
 *  - the **non-secret project defaults** `ads.sh init` scaffolds (the Secret
 *    Manager project, the read backend, and the `create`/`report` output
 *    directories) that an operator would otherwise re-pass as flags or
 *    re-export as env vars every session.
 *
 * The combined file carries real secrets, so — unlike the plain-defaults file
 * this replaced — it is git-ignored and per-machine, at the repo root (or the
 * `ADKIT_CONFIG` path). `render-yaml` merges freshly-pulled secrets into it
 * without clobbering the non-secret fields `init` (or a hand-edit) already set.
 *
 * Written by `ads.sh init` ({@link "../bin/init.js"}) and `ads.sh render-yaml`;
 * read via {@link loadConfig}. Every field is optional — an absent file
 * resolves to `{}`, and callers combine it with a flag/env tier via
 * {@link resolveTier}.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

/** The project config `init`/`render-yaml` write and every entrypoint may read. */
export interface AdkitConfig {
  developer_token?: string;
  client_id?: string;
  client_secret?: string;
  refresh_token?: string;
  login_customer_id?: string;
  target_customer_id?: string;
  secrets_project?: string;
  read_backend?: string;
  reports_dir?: string;
  briefs_dir?: string;
  ideas_dir?: string;
}

/** One config field: its yaml key, prompt label, default value, and whether its input should be echoed. */
export interface ConfigField {
  key: keyof AdkitConfig;
  label: string;
  default: string;
  /** Read without echo (a credential), rather than shown in the clear (an id or preference). */
  sensitive: boolean;
}

/** The credential fields — the ones `render-yaml` fetches from Secret Manager. Load-bearing: must match render-yaml's SECRETS. */
export const CREDENTIAL_FIELDS: readonly ConfigField[] = [
  { key: "developer_token", label: "Google Ads developer token", default: "", sensitive: true },
  { key: "client_id", label: "OAuth client id", default: "", sensitive: false },
  { key: "client_secret", label: "OAuth client secret", default: "", sensitive: true },
  { key: "refresh_token", label: "OAuth refresh token", default: "", sensitive: true },
  { key: "login_customer_id", label: "Default manager/login customer id (used as login-customer-id when no --manager flag is passed)", default: "", sensitive: false },
  { key: "target_customer_id", label: "Default target/leaf customer id", default: "", sensitive: false },
];

/** The non-secret project-preference fields. */
export const PREFERENCE_FIELDS: readonly ConfigField[] = [
  { key: "secrets_project", label: "GCP Secret Manager project", default: "your-project-prod", sensitive: false },
  { key: "read_backend", label: "Read backend (sdk|mcp)", default: "sdk", sensitive: false },
  { key: "reports_dir", label: "Reports output directory", default: "ads/output/reports", sensitive: false },
  { key: "briefs_dir", label: "Brief output directory", default: "adbriefs", sensitive: false },
  { key: "ideas_dir", label: "Processed-ideas directory", default: "ideas/processed", sensitive: false },
];

/** Every config field, in yaml-emit and prompt order: credentials first, then preferences. */
export const CONFIG_FIELDS: readonly ConfigField[] = [...CREDENTIAL_FIELDS, ...PREFERENCE_FIELDS];

/** Path to the project config file (env override wins), resolved against the current working directory. */
export function configPath(): string {
  return process.env["ADKIT_CONFIG"] || process.env["GOOGLE_ADS_CREDENTIALS"] || join(process.cwd(), ".adkit.yaml");
}

/** Whether a config file already exists at {@link configPath}. */
export function configExists(): boolean {
  return existsSync(configPath());
}

/** The `.gitignore` entry protecting `.adkit.yaml` from ever being committed with real credentials in it. */
export const GITIGNORE_ENTRY = "/.adkit.yaml";

/**
 * Add {@link GITIGNORE_ENTRY} to a `.gitignore`'s content, unless a line already
 * matches it exactly (ignoring surrounding whitespace). Pure: returns `content`
 * unchanged when the entry is already present, otherwise appends it after a
 * blank-line separator (none needed when `content` is empty).
 */
export function ensureGitignoreEntry(content: string, entry: string): string {
  const alreadyPresent = content.split("\n").some((line) => line.trim() === entry);
  if (alreadyPresent) {
    return content;
  }
  const trimmed = content.replace(/\n+$/, "");
  const prefix = trimmed.length > 0 ? `${trimmed}\n\n` : "";
  return `${prefix}${entry}\n`;
}

/**
 * Serialize resolved field values into the yaml body text (trailing newline
 * included). Pure: fields absent from `values` (or blank) are skipped. Always
 * ends with `use_proto_plus: true`, matching the value the google-ads client
 * libraries have historically expected in this file.
 */
export function buildConfigYamlBody(values: ReadonlyMap<string, string>): string {
  const header = [
    "# Written by adkit init/render-yaml. Contains secrets — do not commit.",
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
  return [...header, ...fieldLines, "use_proto_plus: true"].join("\n") + "\n";
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

/** The present (non-blank) fields of `config`, as a `field -> value` map in {@link CONFIG_FIELDS} order — the shape {@link buildConfigYamlBody} expects. */
export function configToValueMap(config: AdkitConfig): Map<string, string> {
  const entries = CONFIG_FIELDS.flatMap((field): Array<[string, string]> => {
    const value = config[field.key];
    return value ? [[field.key, String(value)]] : [];
  });
  return new Map(entries);
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
