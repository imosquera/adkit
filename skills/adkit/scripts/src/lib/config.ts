/**
 * The project's local configuration, split across two files by trust level.
 *
 * | File | Tracked | Contents |
 * | --- | --- | --- |
 * | `adkit.yaml` | **committed** | the non-secret project preferences: `reports_dir`, `briefs_dir`, `ideas_dir`, `mcc_customer_id`, `target_customer_id`, `secrets_project`, `read_backend` |
 * | `.adkit.secrets.yaml` | git-ignored | the OAuth credentials: `developer_token`, `client_id`, `client_secret`, `refresh_token`, `psi_api_key` |
 * | `.adkit.yaml` | git-ignored | **legacy** — the old combined file, still read, with a deprecation notice |
 *
 * The split exists because the two halves have opposite handling. The preferences
 * describe the *project* — every collaborator, every CI job, and every git worktree
 * wants the same values, and they are safe in a ticket or a screenshot. The
 * credentials describe the *machine*, must never be committed, and are seeded into
 * and re-pulled from Secret Manager. Folding them into one file forced the
 * preferences to be git-ignored too, so a worktree got none of them and `/adkit`
 * needed an explicit `ADKIT_CONFIG=` to run there.
 *
 * The secrets file has two supported placements:
 *  - **repo root** (the default) — `$CWD/.adkit.secrets.yaml`, git-ignored by `init`;
 *  - **outside the repo** — e.g. `~/.config/adkit/<project>.secrets.yaml`, selected
 *    via `ADKIT_CONFIG`. This is the stronger option: nothing in the tree can commit
 *    it, and it survives into git worktrees.
 *
 * {@link loadConfig} merges defaults <- `adkit.yaml` <- the secrets file <- the
 * legacy `.adkit.yaml`, so an unmigrated project — whose legacy file holds both
 * halves — keeps behaving exactly as it did. Per-setting precedence (flag -> env ->
 * yaml -> default, {@link resolveTier}) is unchanged.
 *
 * Written by `ads.sh init` ({@link "../bin/init.js"}, both files) and `ads.sh
 * render-yaml` (the secrets file only). Every field is optional — absent files
 * resolve to `{}`.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { assertWritableSecretsPath } from "./secrets-guard.js";

/** The project config `init`/`render-yaml` write and every entrypoint may read. */
export interface AdkitConfig {
  developer_token?: string;
  client_id?: string;
  client_secret?: string;
  refresh_token?: string;
  /** Account numbers, not credentials — plain project preferences, never in Secret Manager. */
  mcc_customer_id?: string;
  target_customer_id?: string;
  /** PageSpeed Insights API key — optional; enables `audit`'s PSI auto-diagnosis (issue #40). */
  psi_api_key?: string;
  secrets_project?: string;
  read_backend?: string;
  reports_dir?: string;
  briefs_dir?: string;
  ideas_dir?: string;
}

/**
 * Default output directories, relative to the repo root.
 *
 * Named rather than inlined because each one is needed in two places that MUST
 * agree: the {@link PREFERENCE_FIELDS} prompt `init` shows, and the `resolve*Dir`
 * fallback tier below. A project that sets nothing keeps writing exactly where it
 * wrote before these settings were honoured.
 */
export const DEFAULT_REPORTS_DIR = "ads/output/reports";
export const DEFAULT_BRIEFS_DIR = "adbriefs";
export const DEFAULT_IDEAS_DIR = "ideas/processed";

/** One config field: its yaml key, prompt label, default value, and whether its input should be echoed. */
export interface ConfigField {
  key: keyof AdkitConfig;
  label: string;
  default: string;
  /** Read without echo (a credential), rather than shown in the clear (an id or preference). */
  sensitive: boolean;
}

/** The credential fields — the ones `render-yaml` fetches from Secret Manager, and the only ones written to the secrets file. Load-bearing: must match render-yaml's SECRETS. */
export const CREDENTIAL_FIELDS: readonly ConfigField[] = [
  { key: "developer_token", label: "Google Ads developer token", default: "", sensitive: true },
  { key: "client_id", label: "OAuth client id", default: "", sensitive: false },
  { key: "client_secret", label: "OAuth client secret", default: "", sensitive: true },
  { key: "refresh_token", label: "OAuth refresh token", default: "", sensitive: true },
  { key: "psi_api_key", label: "PageSpeed Insights API key (optional — enables `audit`'s PSI landing-page diagnosis; leave blank to skip)", default: "", sensitive: true },
];

/**
 * The non-secret project-preference fields — the committed `adkit.yaml`'s contents.
 *
 * The two customer ids lead the list: they are Google Ads **account numbers**, not
 * credentials — visible in the Ads UI, safe in a ticket or a screenshot — so they
 * live in the committed half rather than behind a Secret Manager round trip. Both
 * are optional: an account reached directly (no manager) simply omits
 * `mcc_customer_id`.
 */
export const PREFERENCE_FIELDS: readonly ConfigField[] = [
  { key: "mcc_customer_id", label: "Manager (MCC) account id — 10 digits, no dashes. Leave BLANK if you reach the account directly, without a manager", default: "", sensitive: false },
  { key: "target_customer_id", label: "Google Ads account id to operate on — 10 digits, no dashes", default: "", sensitive: false },
  { key: "secrets_project", label: "GCP Secret Manager project", default: "your-project-prod", sensitive: false },
  { key: "read_backend", label: "Read backend (sdk|mcp)", default: "sdk", sensitive: false },
  { key: "reports_dir", label: "Reports output directory", default: DEFAULT_REPORTS_DIR, sensitive: false },
  { key: "briefs_dir", label: "Brief output directory", default: DEFAULT_BRIEFS_DIR, sensitive: false },
  { key: "ideas_dir", label: "Processed-ideas directory", default: DEFAULT_IDEAS_DIR, sensitive: false },
];

/** Every config field, in yaml-emit and prompt order: credentials first, then preferences (the customer ids leading them). */
export const CONFIG_FIELDS: readonly ConfigField[] = [...CREDENTIAL_FIELDS, ...PREFERENCE_FIELDS];

/** The committed project-preferences file, at the repo root. */
export const PROJECT_CONFIG_FILENAME = "adkit.yaml";
/** The git-ignored credentials file, at the repo root unless `ADKIT_CONFIG` moves it. */
export const SECRETS_FILENAME = ".adkit.secrets.yaml";
/** The legacy combined file: both halves in one git-ignored file. Still read; never written by `init`. */
export const LEGACY_CONFIG_FILENAME = ".adkit.yaml";

/** Path to the committed preferences file, resolved against the current working directory. */
export function projectConfigPath(): string {
  return join(process.cwd(), PROJECT_CONFIG_FILENAME);
}

/** The `ADKIT_CONFIG` / `GOOGLE_ADS_CREDENTIALS` override, when either names a secrets file. */
function secretsPathOverride(): string | undefined {
  return process.env["ADKIT_CONFIG"] || process.env["GOOGLE_ADS_CREDENTIALS"] || undefined;
}

/**
 * Where the credentials are written: the `ADKIT_CONFIG` override (an out-of-repo
 * path is the recommended placement), else `.adkit.secrets.yaml` at the repo root.
 * This is a *write* target, so it never falls back to the legacy file — `init` and
 * `render-yaml` create the new file rather than reviving the old one.
 */
export function secretsPath(): string {
  return secretsPathOverride() ?? join(process.cwd(), SECRETS_FILENAME);
}

/** Path to the legacy combined config, resolved against the current working directory. */
export function legacyConfigPath(): string {
  return join(process.cwd(), LEGACY_CONFIG_FILENAME);
}

/**
 * The file the credentials are actually being READ from: the explicit override when
 * one is set, else the secrets file when it exists, else the legacy combined file
 * when *that* exists. Falls back to {@link secretsPath} so a "missing credentials"
 * message names the file the operator should create.
 */
export function activeSecretsPath(): string {
  const override = secretsPathOverride();
  if (override) {
    return override;
  }
  const secrets = join(process.cwd(), SECRETS_FILENAME);
  if (existsSync(secrets)) {
    return secrets;
  }
  const legacy = legacyConfigPath();
  return existsSync(legacy) ? legacy : secrets;
}

/**
 * Where a preference is WRITTEN back (the prompted-and-persisted
 * `target_customer_id`): the committed `adkit.yaml`, unless this is an unmigrated
 * project — a legacy `.adkit.yaml` and no `adkit.yaml` — in which case the legacy
 * file keeps receiving the write, exactly as before the split.
 */
export function preferencesPath(): string {
  const project = projectConfigPath();
  if (existsSync(project)) {
    return project;
  }
  const legacy = legacyConfigPath();
  return existsSync(legacy) ? legacy : project;
}

/** Whether the committed preferences file exists. */
export function projectConfigExists(): boolean {
  return existsSync(projectConfigPath());
}

/** Whether the credentials file exists at {@link secretsPath}. */
export function secretsExist(): boolean {
  return existsSync(secretsPath());
}

/** Whether a legacy combined `.adkit.yaml` is still in place. */
export function legacyConfigExists(): boolean {
  return existsSync(legacyConfigPath());
}

/**
 * Whether `path` names a legacy combined config, by filename, wherever it lives.
 *
 * By filename rather than by equality with {@link legacyConfigPath}, because an
 * existing setup may point `ADKIT_CONFIG` at a `.adkit.yaml` outside the repo. That
 * file holds both halves, so a writer must keep writing both halves to it — trimming
 * it to credentials would silently delete the operator's preferences.
 */
export function isLegacyConfigFile(path: string): boolean {
  return basename(path) === LEGACY_CONFIG_FILENAME;
}

/**
 * The notice printed when a legacy combined `.adkit.yaml` is still in place.
 *
 * Names both files to create and which fields go in each, so the hand-migration is
 * obvious — there is deliberately no automated `init --migrate` (tracked as a
 * follow-up); nothing has to move on a schedule, and the legacy file keeps working
 * untouched until it does.
 */
export function legacyDeprecationNotice(path: string = legacyConfigPath()): string {
  const credentials = CREDENTIAL_FIELDS.map((f) => f.key).join(", ");
  const preferences = PREFERENCE_FIELDS.map((f) => f.key).join(", ");
  return (
    `${path} is the legacy combined config — still read, but deprecated. Split it into two files:\n` +
    `  ${SECRETS_FILENAME}  (git-ignored, chmod 600) — ${credentials}\n` +
    `  ${PROJECT_CONFIG_FILENAME}        (commit it)              — ${preferences}\n` +
    `Then delete ${LEGACY_CONFIG_FILENAME}. Until you do, its values keep winning over both.\n`
  );
}

/** The `.gitignore` entry protecting the credentials file. */
export const SECRETS_GITIGNORE_ENTRY = `/${SECRETS_FILENAME}`;
/** The `.gitignore` entry protecting a legacy combined `.adkit.yaml`, kept so unmigrated projects stay covered. */
export const LEGACY_GITIGNORE_ENTRY = `/${LEGACY_CONFIG_FILENAME}`;
/** Every entry `init` guarantees, in the order it appends them. */
export const GITIGNORE_ENTRIES: readonly string[] = [SECRETS_GITIGNORE_ENTRY, LEGACY_GITIGNORE_ENTRY];

/**
 * Add `entry` to a `.gitignore`'s content, unless a line already matches it exactly
 * (ignoring surrounding whitespace). Pure: returns `content` unchanged when the
 * entry is already present, otherwise appends it after a blank-line separator (none
 * needed when `content` is empty).
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

/** {@link ensureGitignoreEntry} folded over several entries, in order. Pure. */
export function ensureGitignoreEntries(content: string, entries: readonly string[]): string {
  return entries.reduce(ensureGitignoreEntry, content);
}

/**
 * How one yaml file is rendered: which fields it may carry, the comment header
 * that opens it, and the trailing lines that close it.
 *
 * A shape is what keeps the credentials out of the committed file: the emitter
 * walks `fields`, so a value that has no field in this shape cannot be written,
 * however it got into the value map.
 */
export interface ConfigYamlShape {
  readonly fields: readonly ConfigField[];
  readonly header: readonly string[];
  readonly trailer: readonly string[];
}

/**
 * The legacy combined file: every field, secrets included.
 *
 * `use_proto_plus: true` closes it — the value the google-ads client libraries have
 * historically expected in this file.
 */
export const COMBINED_YAML_SHAPE: ConfigYamlShape = {
  fields: CONFIG_FIELDS,
  header: [
    "# Written by adkit init/render-yaml. Contains secrets — do not commit.",
    "# Explicit flags and env vars still override these values at run time.",
  ],
  trailer: ["use_proto_plus: true"],
};

/** The git-ignored credentials file: the credential fields and nothing else. */
export const SECRETS_YAML_SHAPE: ConfigYamlShape = {
  fields: CREDENTIAL_FIELDS,
  header: [
    "# Written by adkit init/render-yaml. CREDENTIALS — never commit this file.",
    "# Project preferences live in the committed adkit.yaml, not here.",
  ],
  trailer: ["use_proto_plus: true"],
};

/** The committed preferences file: the non-secret fields and nothing else. */
export const PROJECT_YAML_SHAPE: ConfigYamlShape = {
  fields: PREFERENCE_FIELDS,
  header: [
    "# Written by adkit init. Project preferences — safe to commit.",
    "# Credentials live in the git-ignored .adkit.secrets.yaml, never here.",
    "# Explicit flags and env vars still override these values at run time.",
  ],
  trailer: [],
};

/**
 * Serialize resolved field values into the yaml body text (trailing newline
 * included), emitting only the fields `shape` admits. Pure: fields absent from
 * `values` (or blank) are skipped.
 */
export function buildConfigYamlBody(
  values: ReadonlyMap<string, string>,
  shape: ConfigYamlShape = COMBINED_YAML_SHAPE,
): string {
  const fieldLines = shape.fields.flatMap((field) => {
    const value = values.get(field.key);
    if (!value) {
      return [];
    }
    const escaped = value.replace(/"/g, '\\"');
    return [`${field.key}: "${escaped}"`];
  });
  return [...shape.header, ...fieldLines, ...shape.trailer].join("\n") + "\n";
}

/**
 * The config with `key` set to `value` — a new object, never a mutation of `config`.
 * Pure; the write itself is {@link writeConfigField}'s job.
 */
export function withConfigField(config: AdkitConfig, key: keyof AdkitConfig, value: string): AdkitConfig {
  return { ...config, [key]: value };
}

/** Parse a config yaml body into an {@link AdkitConfig}. Pure; unknown/missing fields are simply absent. */
export function parseConfig(text: string): AdkitConfig {
  return (parseYaml(text) as AdkitConfig | null) ?? {};
}

/**
 * Layer configs left-to-right, later layers winning per field. Pure. A field a
 * layer does not carry never overwrites an earlier layer's value.
 */
export function mergeConfigs(layers: readonly AdkitConfig[]): AdkitConfig {
  return layers.reduce<AdkitConfig>((acc, layer) => ({ ...acc, ...layer }), {});
}

/** Read and parse one config file, or `{}` when it is absent or unreadable. */
export function readConfigFile(path: string): AdkitConfig {
  try {
    return parseConfig(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

/**
 * The effective config: `adkit.yaml` <- the secrets file <- the legacy
 * `.adkit.yaml`.
 *
 * The secrets file wins over the committed preferences where they overlap (it
 * should not overlap, but a hand-edit is not going to be argued with), and the
 * legacy combined file is overlaid last — it holds both halves, so an unmigrated
 * project simply keeps winning and behaves exactly as it did before the split.
 */
export function loadConfig(): AdkitConfig {
  return mergeConfigs([
    readConfigFile(projectConfigPath()),
    readConfigFile(activeSecretsPath()),
    readConfigFile(legacyConfigPath()),
  ]);
}

/** The present (non-blank) fields of `config`, as a `field -> value` map in `fields` order — the shape {@link buildConfigYamlBody} expects. */
export function configToValueMap(
  config: AdkitConfig,
  fields: readonly ConfigField[] = CONFIG_FIELDS,
): Map<string, string> {
  const entries = fields.flatMap((field): Array<[string, string]> => {
    const value = config[field.key];
    return value ? [[field.key, String(value)]] : [];
  });
  return new Map(entries);
}

/** Atomically write `body` to `target` with `mode` perms (temp file + rename). */
export function writeYamlAtomic(target: string, body: string, mode: number): void {
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true });
  const tmpPath = join(dir, `adkit-${process.pid}-${Date.now()}.yaml`);
  writeFileSync(tmpPath, body, { mode });
  chmodSync(tmpPath, mode);
  renameSync(tmpPath, target);
}

/**
 * Set a single preference in the preferences file ({@link preferencesPath}),
 * carrying every other field in THAT file through untouched.
 *
 * Only the file being written is re-read — never the merged config — so a
 * credential from the secrets file can never be copied into the committed
 * `adkit.yaml`. On an unmigrated project the target is the legacy combined file,
 * which does carry credentials: it is written under the combined shape at 0600, and
 * only after {@link assertWritableSecretsPath} confirms the path is not committable.
 *
 * The read-modify-write is deliberate: this is called on a config that may have
 * been edited since it was loaded, and it must never drop a field it doesn't know
 * about the way a blind overwrite would. Used by the prompt-and-persist path in
 * `lib/customer-id.ts` — see the note there about a read-only command writing this
 * file.
 */
export function writeConfigField(key: keyof AdkitConfig, value: string): void {
  const target = preferencesPath();
  const isLegacy = isLegacyConfigFile(target);
  const shape = isLegacy ? COMBINED_YAML_SHAPE : PROJECT_YAML_SHAPE;
  if (isLegacy) {
    assertWritableSecretsPath(target);
  }
  const merged = withConfigField(readConfigFile(target), key, value);
  writeYamlAtomic(target, buildConfigYamlBody(configToValueMap(merged, shape.fields), shape), isLegacy ? 0o600 : 0o644);
}

/**
 * Resolve one setting through the flag -> env -> config -> fallback tiers,
 * the same shape as `resolveCustomer`/`resolveMccCustomerId` in `cli/args.ts`.
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

/**
 * The three output directories, resolved through the same flag -> env -> yaml ->
 * default chain as every other setting ({@link resolveTier}).
 *
 * `config` is injectable so a caller can resolve several directories against one
 * already-loaded config rather than re-reading the yaml files per call; it defaults
 * to {@link loadConfig} for the common single-lookup case.
 *
 * Each returns a directory RELATIVE to the repo root — callers `join` it onto the
 * root they already thread, so an operator can point all three at one folder
 * (`ads/ideas`, `ads/briefs`, `ads/reports`) without any call site learning about
 * absolute paths.
 */
export function resolveReportsDir(flag?: string | null, config: AdkitConfig = loadConfig()): string {
  return resolveTier(flag, process.env["ADKIT_REPORTS_DIR"], config.reports_dir, DEFAULT_REPORTS_DIR) ?? DEFAULT_REPORTS_DIR;
}

/** The brief store's directory — see {@link resolveReportsDir}. */
export function resolveBriefsDir(flag?: string | null, config: AdkitConfig = loadConfig()): string {
  return resolveTier(flag, process.env["ADKIT_BRIEFS_DIR"], config.briefs_dir, DEFAULT_BRIEFS_DIR) ?? DEFAULT_BRIEFS_DIR;
}

/** The processed-ideas directory `/adkit gtm` reads and writes — see {@link resolveReportsDir}. */
export function resolveIdeasDir(flag?: string | null, config: AdkitConfig = loadConfig()): string {
  return resolveTier(flag, process.env["ADKIT_IDEAS_DIR"], config.ideas_dir, DEFAULT_IDEAS_DIR) ?? DEFAULT_IDEAS_DIR;
}
