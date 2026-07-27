/**
 * One-time interactive scaffold of the project's reusable, non-secret defaults
 * (see {@link "../lib/config.js"}) into `.adkit.yaml`.
 *
 * Create-if-missing, mirroring `bootstrap-secrets.ts`: an existing config file is
 * never clobbered — rerun after deleting it, or hand-edit it directly.
 *
 * The IO (terminal prompts, fs) is isolated at the edges; the prompt text and the
 * yaml body come from pure functions in `lib/config.ts`.
 */

import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
import { isMainModule } from "../cli/entry.js";
import { emitJson, errorEnvelope } from "../cli/output.js";
import { buildConfigYamlBody, configExists, configPath, CONFIG_FIELDS } from "../lib/config.js";

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

/**
 * Prompt for every config field, falling back to its default on a blank answer.
 * Returns a `field -> value` map with only non-blank fields present, in the same
 * shape {@link buildConfigYamlBody} expects.
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
      process.stdout.write(promptFor(field.label, field.default));
      const { value, done } = await lines.next();
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
 * one in place).
 */
export async function main(): Promise<number> {
  const target = configPath();
  if (configExists()) {
    process.stdout.write(existsLine(target));
    return 0;
  }
  const values = await promptAll();
  writeFileSync(target, buildConfigYamlBody(values));
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
