/**
 * One-time interactive scaffold of the project's local config (see
 * {@link "../lib/config.js"}), across the two files it now lives in:
 *
 *  - `adkit.yaml` — the non-secret project preferences (the two customer ids, the
 *    Secret Manager project, the read backend, the three output dirs; for a Meta
 *    project `platform: meta` and the ad account / page / pixel ids instead). **Committed**:
 *    it describes the project, so a collaborator, a CI job, and a git worktree all
 *    get the same values without rediscovering them.
 *  - `.adkit.secrets.yaml` — the platform's credentials, written 0600 and
 *    git-ignored. `ADKIT_CONFIG` moves it out of the repo entirely, which is the
 *    stronger placement.
 *
 * The first prompt is the platform (`google/meta`, blank → `google`); only that
 * platform's fields are asked for after it, and a Google run writes exactly what it
 * did before the platform existed.
 *
 * Create-if-missing per file, mirroring `bootstrap-secrets.ts`: an existing file is
 * never clobbered, and only the fields belonging to a file that is actually being
 * written are prompted for. A legacy combined `.adkit.yaml` stops the scaffold
 * altogether and prints the deprecation notice naming the two files to create.
 *
 * Every run also makes sure `.gitignore` excludes both the secrets file and the
 * legacy `.adkit.yaml` — they carry real credentials, so this happens
 * unconditionally (not only on a fresh write), in case a file or an unprotected
 * `.gitignore` predates this command. Before the credentials are written the target
 * path is judged by the guardrail in `lib/secrets-guard.ts`; a committable path is
 * refused with the standard `ok:false` envelope rather than written to.
 *
 * The IO (terminal prompts, fs) is isolated at the edges; the prompt text and the
 * yaml bodies come from pure functions in `lib/config.ts`.
 */

import { createInterface, type Interface } from "node:readline";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isMainModule } from "../cli/entry.js";
import { emitJson, errorEnvelope } from "../cli/output.js";
import { parsePlatform, type Platform } from "../cli/platform.js";
import {
  buildConfigYamlBody,
  type ConfigField,
  credentialFieldsFor,
  ensureGitignoreEntries,
  GITIGNORE_ENTRIES,
  legacyConfigExists,
  legacyConfigPath,
  legacyDeprecationNotice,
  PLATFORM_FIELD,
  preferenceFieldsFor,
  projectConfigExists,
  projectConfigPath,
  projectYamlShapeFor,
  secretsExist,
  secretsPath,
  secretsYamlShapeFor,
  writeYamlAtomic,
} from "../lib/config.js";
import { assertWritableSecretsPath, SecretsPathError } from "../lib/secrets-guard.js";

/** The prompt text for a field, showing its default inline. Pure. */
export function promptFor(label: string, defaultValue: string): string {
  return defaultValue ? `${label} [${defaultValue}]: ` : `${label}: `;
}

/** The line printed once a file is written. Pure. */
export function doneLine(path: string): string {
  return `wrote ${path}\n`;
}

/** The message printed when a config file already exists (init refuses to overwrite it). Pure. */
export function existsLine(path: string): string {
  return `${path} already exists — leaving it in place. Edit it directly, or delete it and rerun init.\n`;
}

/** The line printed when `.gitignore` entries are added. Pure. */
export function gitignoredLine(entries: readonly string[], path: string): string {
  return `added ${entries.join(", ")} to ${path}\n`;
}

/**
 * Ensure the repo's `.gitignore` excludes both the credentials file and the legacy
 * combined `.adkit.yaml`, so a file carrying real credentials never gets committed
 * by accident — even if it already existed before this run. Writes only when an
 * entry is missing; a fresh `.gitignore` is created if none exists yet. Returns the
 * entries it added.
 */
function ensureGitignored(repoDir: string): readonly string[] {
  const gitignorePath = join(repoDir, ".gitignore");
  let existing = "";
  try {
    existing = readFileSync(gitignorePath, "utf8");
  } catch {
    // No .gitignore yet — ensureGitignoreEntries starts one.
  }
  const updated = ensureGitignoreEntries(existing, GITIGNORE_ENTRIES);
  if (updated === existing) {
    return [];
  }
  writeFileSync(gitignorePath, updated);
  return GITIGNORE_ENTRIES.filter((entry) => !existing.split("\n").some((line) => line.trim() === entry));
}

/**
 * Mute echo of the characters typed in response to `promptText` — used for
 * credential fields — until `unmute()` is called. Same trick as
 * `bootstrap-secrets.ts`: overwrite each keystroke the readline writer would
 * otherwise echo, while still letting the prompt text itself through.
 */
function muteEcho(rl: Interface, promptText: string): () => void {
  const asMuted = rl as unknown as { output: NodeJS.WriteStream; _writeToOutput?: (s: string) => void };
  asMuted._writeToOutput = (stringToWrite: string): void => {
    asMuted.output.write(stringToWrite.includes(promptText) ? stringToWrite : "");
  };
  return () => {
    delete asMuted._writeToOutput;
  };
}

/** One answer read from the terminal: the trimmed line, or `""` once input is exhausted. */
type Ask = (text: string, sensitive: boolean) => Promise<string>;

/**
 * Build an {@link Ask} over one readline `Interface`. Sensitive answers
 * (credentials) are read without echo.
 *
 * Reads answers via the interface's async iterator rather than chained
 * `rl.question()` calls: over a piped (non-TTY) stdin that delivers all its lines
 * in one chunk, a second `question()` issued after the first has already resolved
 * never gets a callback — the interface has nothing left to hand it. Iterating
 * the same interface consumes exactly one line per prompt and does not lose data
 * either way. For the same reason every prompt of a run (platform included)
 * shares the one interface: a second interface would miss lines the first had
 * already buffered.
 */
function askVia(rl: Interface): Ask {
  const lines = rl[Symbol.asyncIterator]();
  return async (text, sensitive) => {
    process.stdout.write(text);
    const unmute = sensitive ? muteEcho(rl, text) : null;
    const { value, done } = await lines.next();
    unmute?.();
    if (sensitive) {
      process.stdout.write("\n");
    }
    return (done ? "" : String(value)).trim();
  };
}

/** The line printed when the platform answer does not parse, before asking again. Pure. */
export function invalidPlatformLine(message: string): string {
  return `${message}\n`;
}

/**
 * Ask which platform to scaffold for (blank means `google`), parsing the answer
 * with {@link parsePlatform}; an unknown answer is reported and asked again.
 * Exhausted input reads as blank, so this cannot loop forever.
 */
async function promptPlatform(ask: Ask): Promise<Platform> {
  const parsed = parsePlatform(await ask(promptFor(PLATFORM_FIELD.label, PLATFORM_FIELD.default), false), "platform answer");
  if (parsed.kind === "ok") {
    return parsed.value;
  }
  process.stderr.write(invalidPlatformLine(parsed.message));
  return promptPlatform(ask);
}

/**
 * Prompt for each of `fields` in order, falling back to its default on a blank
 * answer. Returns a `field -> value` map with only non-blank fields present, in
 * the same shape {@link buildConfigYamlBody} expects.
 */
async function promptFields(ask: Ask, fields: readonly ConfigField[]): Promise<Map<string, string>> {
  const entries = await fields.reduce<Promise<ReadonlyArray<readonly [string, string]>>>(async (soFar, field) => {
    const done = await soFar;
    const resolved = (await ask(promptFor(field.label, field.default), field.sensitive)) || field.default;
    return resolved ? [...done, [field.key, resolved] as const] : done;
  }, Promise.resolve([]));
  return new Map(entries);
}

/**
 * The whole interactive session: the platform first, then the fields `select`
 * returns for it. `select` is given exactly the halves about to be written, so
 * rerunning init after deleting one file asks only for that file's half.
 *
 * For `meta` the map also carries `platform -> "meta"` so the Meta project shape
 * writes it; a Google map never does, keeping Google output byte-identical.
 */
export async function promptAll(
  select: (platform: Platform) => readonly ConfigField[],
): Promise<{ platform: Platform; values: Map<string, string> }> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ask = askVia(rl);
    const platform = await promptPlatform(ask);
    const fields = await promptFields(ask, select(platform));
    const values = platform === "meta" ? new Map<string, string>([[PLATFORM_FIELD.key, platform], ...fields]) : fields;
    return { platform, values };
  } finally {
    rl.close();
  }
}

/**
 * Scaffold whichever of the two config files is missing. Returns the process exit
 * code (0 on success, whether that means it wrote a file or left existing ones in
 * place; 1 when the guardrail refuses the credentials path).
 */
export async function main(): Promise<number> {
  const repoDir = process.cwd();
  const added = ensureGitignored(repoDir);
  if (added.length > 0) {
    process.stdout.write(gitignoredLine(added, join(repoDir, ".gitignore")));
  }

  // An unmigrated project holds both halves in one file: leave it exactly as it is
  // (it still wins over both new files) and say what to create by hand.
  if (legacyConfigExists()) {
    process.stdout.write(existsLine(legacyConfigPath()));
    process.stdout.write(legacyDeprecationNotice());
    return 0;
  }

  const project = projectConfigPath();
  const secrets = secretsPath();
  const needProject = !projectConfigExists();
  const needSecrets = !secretsExist();
  if (!needProject) {
    process.stdout.write(existsLine(project));
  }
  if (!needSecrets) {
    process.stdout.write(existsLine(secrets));
  }
  if (!needProject && !needSecrets) {
    return 0;
  }

  // Judge the credentials path BEFORE prompting: the verdict does not depend on the
  // answers, and refusing after four credentials have been typed would be rude.
  if (needSecrets) {
    try {
      const warning = assertWritableSecretsPath(secrets);
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
  }

  const { platform, values } = await promptAll((chosen) => [
    ...(needSecrets ? credentialFieldsFor(chosen) : []),
    ...(needProject ? preferenceFieldsFor(chosen) : []),
  ]);

  if (needProject) {
    writeYamlAtomic(project, buildConfigYamlBody(values, projectYamlShapeFor(platform)), 0o644);
    process.stdout.write(doneLine(project));
  }
  if (needSecrets) {
    writeYamlAtomic(secrets, buildConfigYamlBody(values, secretsYamlShapeFor(platform)), 0o600);
    process.stdout.write(doneLine(secrets));
  }
  return 0;
}

// Run as a CLI entrypoint (mirrors the other bins' run-guard).
if (isMainModule(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((exc: unknown) => {
      emitJson(errorEnvelope(String((exc as { message?: unknown })?.message ?? exc)));
      process.exitCode = 1;
    });
}
