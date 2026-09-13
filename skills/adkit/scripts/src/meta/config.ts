/**
 * Resolve the Meta context every Meta command runs against — token, ad account,
 * optional page / pixel ids, app secret and PSI key — parsed exactly once (plan D2).
 *
 * Parse, don't validate: raw text from flags, env and the merged config crosses
 * {@link resolveMetaContext} once, and downstream code holds a {@link MetaContext}
 * whose branded fields are the proof. Nothing re-checks the shapes.
 *
 * Mirrors the Google `target_customer_id` flow (`lib/customer-id.ts` +
 * `cli/customer-id.ts`): the decision tree is a pure-ish async function over
 * injected effects (TTY check, prompt, save), and {@link resolveMetaContextFromProcess}
 * is the thin wrapper binding those effects to the real terminal, config files and
 * stderr.
 *
 * Asymmetry, as on Google: the token and ad account are required (missing →
 * {@link MetaConfigError}); on a TTY the ad account is asked once and written to
 * `adkit.yaml` so later runs never ask again. The token is never prompted for —
 * it is a credential and belongs in the secrets file via `ads.sh init`. Page,
 * pixel, app secret and PSI key are optional: absent is `null`, only a malformed
 * value fails.
 */

import { createInterface } from "node:readline";
import {
  PROJECT_CONFIG_FILENAME,
  SECRETS_FILENAME,
  activeSecretsPath,
  loadConfig,
  preferencesPath,
  resolveMetaSetting,
  resolveTier,
  writeConfigField,
  type AdkitConfig,
} from "../lib/config.js";
import { MetaConfigError } from "./errors.js";
import {
  MetaAccessTokenSchema,
  MetaPageIdSchema,
  MetaPixelIdSchema,
  parseMetaAdAccountId,
  type MetaAccessToken,
  type MetaAdAccountId,
  type MetaPageId,
  type MetaPixelId,
} from "./ids.js";

/** Everything a Meta command needs to reach the Graph API, already parsed. */
export interface MetaContext {
  readonly token: MetaAccessToken;
  readonly adAccountId: MetaAdAccountId;
  readonly pageId: MetaPageId | null;
  readonly pixelId: MetaPixelId | null;
  readonly appSecret: string | null;
  readonly psiApiKey: string | null;
}

/** Command-line tiers that outrank env and config. */
export interface MetaContextFlags {
  /** `--ad-account`. */
  readonly adAccount?: string | null;
  /** `--psi-key` (audit only). */
  readonly psiKey?: string | null;
}

/** The IO {@link resolveMetaContext} needs, injected so the decision tree is testable. */
export interface MetaContextDeps {
  /** Whether stdin is a terminal — the difference between asking and failing. */
  readonly isTty: boolean;
  /** Ask the operator once. Only called when `isTty` and no tier supplies an ad account. */
  readonly prompt: (question: string) => Promise<string>;
  /** Persist a prompted preference (`meta_ad_account_id`). Only called after a successful parse. */
  readonly save: (field: string, value: string) => void;
  /** Secrets file named in the missing-token error. Defaults to `.adkit.secrets.yaml`. */
  readonly secretsPath?: string;
  /** Preferences file named in ad-account errors. Defaults to `adkit.yaml`. */
  readonly configPath?: string;
}

/** Env var for the PageSpeed Insights key — the same one Google's audit reads. */
export const PSI_ENV = "PAGESPEED_API_KEY";

/** The prompt shown when no tier supplies an ad account and we can ask. */
export const AD_ACCOUNT_PROMPT = "Meta ad account id to operate on (digits, optionally act_-prefixed, e.g. act_1234567890): ";

const missingTokenError = (secretsPath: string): MetaConfigError =>
  new MetaConfigError(
    "credentials",
    `no meta_access_token — set it in ${secretsPath} (run \`ads.sh init\`) or export META_ACCESS_TOKEN.`,
    "meta_access_token",
    secretsPath,
  );

const missingAdAccountError = (configPath: string): MetaConfigError =>
  new MetaConfigError(
    "ad-account",
    `no meta_ad_account_id — nothing to operate on. Pass --ad-account, export META_AD_ACCOUNT_ID, ` +
      `or set meta_ad_account_id in ${configPath} (run \`ads.sh init\`). It is an account number, not a secret.`,
    "meta_ad_account_id",
    configPath,
  );

/** Parse the token tier (env > secrets), throwing a `credentials` error when absent or malformed. Pure. */
function parseToken(env: NodeJS.ProcessEnv, config: AdkitConfig, secretsPath: string): MetaAccessToken {
  const raw = resolveMetaSetting("meta_access_token", env, config);
  if (raw === undefined) {
    throw missingTokenError(secretsPath);
  }
  const parsed = MetaAccessTokenSchema.safeParse(raw);
  if (!parsed.success) {
    throw new MetaConfigError("credentials", "meta_access_token is malformed (expected a token without whitespace)", "meta_access_token", secretsPath);
  }
  return parsed.data;
}

/** The first non-blank ad account tier with its source label, or `null`. Pure. */
function firstAdAccountTier(
  flags: MetaContextFlags,
  env: NodeJS.ProcessEnv,
  config: AdkitConfig,
  configPath: string,
): { readonly source: string; readonly raw: string } | null {
  const tiers: ReadonlyArray<readonly [string, string | null | undefined]> = [
    ["--ad-account", flags.adAccount],
    ["META_AD_ACCOUNT_ID", env["META_AD_ACCOUNT_ID"]],
    [`meta_ad_account_id in ${configPath}`, resolveTier(null, undefined, config.meta_ad_account_id)],
  ];
  const hit = tiers.find(([, raw]) => raw !== null && raw !== undefined && raw.trim() !== "");
  return hit === undefined ? null : { source: hit[0], raw: hit[1] as string };
}

/** Parse one ad account value, throwing an `ad-account` error naming its source when malformed. Pure. */
function parseAdAccountOrThrow(raw: string, source: string, configPath: string): MetaAdAccountId {
  const parsed = parseMetaAdAccountId(raw, source);
  if (parsed.kind === "err") {
    throw new MetaConfigError("ad-account", parsed.message, "meta_ad_account_id", configPath);
  }
  return parsed.value;
}

/** Resolve the ad account: flag > env > config > prompt-and-save on a TTY > error. */
async function resolveAdAccount(
  flags: MetaContextFlags,
  env: NodeJS.ProcessEnv,
  config: AdkitConfig,
  deps: MetaContextDeps,
  configPath: string,
): Promise<MetaAdAccountId> {
  const tier = firstAdAccountTier(flags, env, config, configPath);
  if (tier !== null) {
    return parseAdAccountOrThrow(tier.raw, tier.source, configPath);
  }
  if (!deps.isTty) {
    throw missingAdAccountError(configPath);
  }
  const answer = (await deps.prompt(AD_ACCOUNT_PROMPT)).trim();
  if (answer === "") {
    throw missingAdAccountError(configPath);
  }
  const adAccountId = parseAdAccountOrThrow(answer, "meta_ad_account_id", configPath);
  deps.save("meta_ad_account_id", adAccountId);
  return adAccountId;
}

/** Parse an optional numeric id from config; blank → `null`, malformed → `config` error. Pure. */
function parseOptionalId<T>(
  field: "meta_page_id" | "meta_pixel_id",
  raw: string | undefined,
  schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false } },
  configPath: string,
): T | null {
  const text = resolveTier(null, undefined, raw);
  if (text === undefined) {
    return null;
  }
  const parsed = schema.safeParse(text);
  if (!parsed.success) {
    throw new MetaConfigError("config", `${field} is malformed: ${JSON.stringify(text)} (expected a numeric Meta id)`, field, configPath);
  }
  return parsed.data;
}

/**
 * Resolve and parse the full {@link MetaContext}. Throws {@link MetaConfigError}
 * (step `credentials` for the token, `ad-account` for the account, `config` for a
 * malformed page/pixel id). The only effects are the injected `prompt` / `save`,
 * each reached solely when a TTY run has no ad account from any tier.
 */
export async function resolveMetaContext(
  flags: MetaContextFlags,
  env: NodeJS.ProcessEnv,
  config: AdkitConfig,
  deps: MetaContextDeps,
): Promise<MetaContext> {
  const secretsPath = deps.secretsPath ?? SECRETS_FILENAME;
  const configPath = deps.configPath ?? PROJECT_CONFIG_FILENAME;
  const token = parseToken(env, config, secretsPath);
  const adAccountId = await resolveAdAccount(flags, env, config, deps, configPath);
  return {
    token,
    adAccountId,
    pageId: parseOptionalId("meta_page_id", config.meta_page_id, MetaPageIdSchema, configPath),
    pixelId: parseOptionalId("meta_pixel_id", config.meta_pixel_id, MetaPixelIdSchema, configPath),
    appSecret: resolveMetaSetting("meta_app_secret", env, config)?.trim() ?? null,
    psiApiKey: resolveTier(flags.psiKey, env[PSI_ENV], config.psi_api_key)?.trim() ?? null,
  };
}

/** Ask one question on the terminal (stderr prompt; stdout carries the JSON envelope). */
function askOnTerminal(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * {@link resolveMetaContext} wired to the real process: merged config from disk,
 * real stdin TTY check and prompt, and a save into the preferences file announced
 * on stderr. `env` and `isTty` are injectable so bins' tests can drive the no-TTY path.
 */
export function resolveMetaContextFromProcess(
  flags: MetaContextFlags,
  env: NodeJS.ProcessEnv = process.env,
  isTty: boolean = process.stdin.isTTY === true,
): Promise<MetaContext> {
  const configPath = preferencesPath();
  return resolveMetaContext(flags, env, loadConfig(), {
    isTty,
    prompt: askOnTerminal,
    save: (field, value) => {
      writeConfigField(field as keyof AdkitConfig, value);
      process.stderr.write(`saved ${field}: ${value} to ${configPath} — you won't be asked again.\n`);
    },
    secretsPath: activeSecretsPath(),
    configPath,
  });
}
