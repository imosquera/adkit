/**
 * One-time interactive scaffold of the project's local config (see
 * {@link "../lib/config.js"}) into `.adkit.yaml`: both the Google Ads
 * credentials and the non-secret project preferences (Secret Manager project,
 * read backend, output dirs).
 *
 * Create-if-missing, mirroring `bootstrap-secrets.ts`: an existing config file is
 * never clobbered — rerun after deleting it, or hand-edit it directly. Running
 * `ads.sh render-yaml` afterward refreshes just the credential fields from
 * Secret Manager without disturbing the preferences entered here.
 *
 * Every run also makes sure `.gitignore` excludes `.adkit.yaml` — the file
 * carries real credentials, so this happens unconditionally (not only on a
 * fresh write), in case the file or an unprotected `.gitignore` predates this
 * command.
 *
 * The IO (terminal prompts, fs) is isolated at the edges; the prompt text and the
 * yaml body come from pure functions in `lib/config.ts`.
 */

import { createInterface, type Interface } from "node:readline";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isMainModule } from "../cli/entry.js";
import { emitJson, errorEnvelope } from "../cli/output.js";
import {
  AUCTION_INSIGHTS_CACHE_GITIGNORE_ENTRY,
  buildConfigYamlBody,
  configExists,
  configPath,
  CONFIG_FIELDS,
  ensureGitignoreEntry,
  GITIGNORE_ENTRY,
} from "../lib/config.js";

/** The prompt text for a field, showing its default inline. Pure. */
export function promptFor(label: string, defaultValue: string): string {
  return defaultValue ? `${label} [${defaultValue}]: ` : `${label}: `;
}

/** The line printed once the file is written. Pure. */
export function doneLine(path: string): string {
  return `wrote ${path}\n`;
}

/** The message printed when a config file already exists (init refuses to overwrite it). Pure. */
export function existsLine(path: string): string {
  return `${path} already exists — leaving it in place. Edit it directly, or delete it and rerun init.\n`;
}

/** The line printed when a `.gitignore` entry is added. Pure. */
export function gitignoredLine(path: string): string {
  return `added ${GITIGNORE_ENTRY} to ${path}\n`;
}

/**
 * Ensure the repo's `.gitignore` (alongside `.adkit.yaml`, same directory) excludes
 * it and the local Auction Insights cache file — the former carries real
 * credentials, the latter is per-machine local state — so neither gets committed
 * by accident, even if it already existed before this run. Writes only when an
 * entry is missing; a fresh `.gitignore` is created if none exists yet. Returns
 * whether it wrote.
 */
function ensureGitignored(configDir: string): boolean {
  const gitignorePath = join(configDir, ".gitignore");
  let existing = "";
  try {
    existing = readFileSync(gitignorePath, "utf8");
  } catch {
    // No .gitignore yet — ensureGitignoreEntry starts one.
  }
  const updated = ensureGitignoreEntry(
    ensureGitignoreEntry(existing, GITIGNORE_ENTRY),
    AUCTION_INSIGHTS_CACHE_GITIGNORE_ENTRY,
  );
  if (updated === existing) {
    return false;
  }
  writeFileSync(gitignorePath, updated);
  return true;
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
 * Prompt for every config field, falling back to its default on a blank answer.
 * Sensitive fields (credentials) are read without echo. Returns a
 * `field -> value` map with only non-blank fields present, in the same shape
 * {@link buildConfigYamlBody} expects.
 *
 * Reads answers via the readline `Interface`'s async iterator rather than
 * chained `rl.question()` calls: over a piped (non-TTY) stdin that delivers all
 * its lines in one chunk, a second `question()` issued after the first has
 * already resolved never gets a callback — the interface has nothing left to
 * hand it. Iterating `for await` over the same interface consumes exactly one
 * line per field and does not lose data either way.
 */
export async function promptAll(): Promise<Map<string, string>> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const lines = rl[Symbol.asyncIterator]();
    const entries: Array<[string, string]> = [];
    for (const field of CONFIG_FIELDS) {
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
 * Scaffold `.adkit.yaml` if it doesn't already exist. Returns the process exit
 * code (0 on success, whether that means it wrote the file or left an existing
 * one in place). Written with 0600 perms — the file carries real credentials.
 */
export async function main(): Promise<number> {
  const target = configPath();
  if (ensureGitignored(dirname(target))) {
    process.stdout.write(gitignoredLine(join(dirname(target), ".gitignore")));
  }
  if (configExists()) {
    process.stdout.write(existsLine(target));
    return 0;
  }
  const values = await promptAll();
  writeFileSync(target, buildConfigYamlBody(values), { mode: 0o600 });
  process.stdout.write(doneLine(target));
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
