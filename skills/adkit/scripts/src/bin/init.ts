/**
 * One-time interactive scaffold of the project's local config (see
 * {@link "../lib/config.js"}), across the two files it now lives in:
 *
 *  - `adkit.yaml` — the non-secret project preferences (the two customer ids, the
 *    Secret Manager project, the read backend, the three output dirs). **Committed**:
 *    it describes the project, so a collaborator, a CI job, and a git worktree all
 *    get the same values without rediscovering them.
 *  - `.adkit.secrets.yaml` — the Google Ads credentials, written 0600 and
 *    git-ignored. `ADKIT_CONFIG` moves it out of the repo entirely, which is the
 *    stronger placement.
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
import {
  buildConfigYamlBody,
  type ConfigField,
  CREDENTIAL_FIELDS,
  ensureGitignoreEntries,
  GITIGNORE_ENTRIES,
  legacyConfigExists,
  legacyConfigPath,
  legacyDeprecationNotice,
  PREFERENCE_FIELDS,
  PROJECT_YAML_SHAPE,
  projectConfigExists,
  projectConfigPath,
  projectRoot,
  SECRETS_YAML_SHAPE,
  secretsExist,
  secretsPath,
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

/**
 * Prompt for each of `fields`, falling back to its default on a blank answer.
 * Sensitive fields (credentials) are read without echo. Returns a
 * `field -> value` map with only non-blank fields present, in the same shape
 * {@link buildConfigYamlBody} expects.
 *
 * `fields` is exactly the set belonging to the files about to be written, so
 * rerunning init after deleting one file asks only for that file's half.
 *
 * Reads answers via the readline `Interface`'s async iterator rather than
 * chained `rl.question()` calls: over a piped (non-TTY) stdin that delivers all
 * its lines in one chunk, a second `question()` issued after the first has
 * already resolved never gets a callback — the interface has nothing left to
 * hand it. Iterating `for await` over the same interface consumes exactly one
 * line per field and does not lose data either way.
 */
export async function promptAll(fields: readonly ConfigField[]): Promise<Map<string, string>> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const lines = rl[Symbol.asyncIterator]();
    const entries: Array<[string, string]> = [];
    for (const field of fields) {
      const text = promptFor(field.label, field.default);
      process.stdout.write(text);
      const unmute = field.sensitive ? muteEcho(rl, text) : null;
      const { value, done } = await lines.next();
      unmute?.();
      if (field.sensitive) {
        process.stdout.write("\n");
      }
      const answer = (done ? "" : value).trim();
      const resolved = answer || field.default;
      if (resolved) {
        entries.push([field.key, resolved]);
      }
    }
    return new Map(entries);
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
  const repoDir = projectRoot();
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

  const values = await promptAll([
    ...(needSecrets ? CREDENTIAL_FIELDS : []),
    ...(needProject ? PREFERENCE_FIELDS : []),
  ]);

  if (needProject) {
    writeYamlAtomic(project, buildConfigYamlBody(values, PROJECT_YAML_SHAPE), 0o644);
    process.stdout.write(doneLine(project));
  }
  if (needSecrets) {
    writeYamlAtomic(secrets, buildConfigYamlBody(values, SECRETS_YAML_SHAPE), 0o600);
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
