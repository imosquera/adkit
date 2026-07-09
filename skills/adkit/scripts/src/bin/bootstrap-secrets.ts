/**
 * One-time interactive seed of Google Ads secrets into GCP Secret Manager.
 *
 * Faithful port of `ads_skill/bin/bootstrap_secrets.py`. Prompts for each secret
 * (sensitive values read without echo), creates the secret if it does not yet
 * exist, then adds a new version with the entered value — shelling out to `gcloud`
 * for all three operations. The project defaults to `your-project-prod`,
 * overridable via the `GOOGLE_ADS_SECRETS_PROJECT` env var.
 *
 * The IO (child_process, terminal prompts) is isolated at the edges; the argv
 * construction, sensitivity classification, and message formatting are pure and
 * unit-tested.
 */

import { execFileSync } from "node:child_process";
import { isMainModule } from "../cli/entry.js";
import { createInterface } from "node:readline";
import { emitJson, errorEnvelope } from "../cli/output.js";

/** GCP project the secrets live in; env-overridable, mirroring the Python default. */
export const PROJECT = process.env["GOOGLE_ADS_SECRETS_PROJECT"] ?? "your-project-prod";

/** The secret names to seed, in prompt order. Load-bearing — must match render-yaml. */
export const SECRETS: readonly string[] = [
  "google-ads-developer-token",
  "google-ads-client-id",
  "google-ads-client-secret",
  "google-ads-refresh-token",
  "google-ads-login-customer-id",
  "google-ads-target-customer-id",
];

/**
 * The non-sensitive secrets: their prompt echoes (they are ids, not credentials).
 * Everything else is read without echo.
 */
const NON_SENSITIVE = new Set([
  "google-ads-client-id",
  "google-ads-login-customer-id",
  "google-ads-target-customer-id",
]);

/** True when `name`'s value is sensitive (read without echo). Pure. */
export function isSensitive(name: string): boolean {
  return !NON_SENSITIVE.has(name);
}

/** The prompt text shown for a given secret. Pure. */
export function promptFor(name: string): string {
  return `Enter value for ${name}: `;
}

/** The per-secret confirmation line printed after a successful update. Pure. */
export function updatedLine(name: string): string {
  return `  ✓ ${name} updated\n`;
}

/** The final completion line, pointing at the render command. Pure. */
export function doneLine(): string {
  return "Done. Render with: ads.sh render-yaml\n";
}

/** `gcloud secrets describe` argv checking whether a secret exists. Pure. */
export function describeArgs(name: string, project: string): string[] {
  return ["secrets", "describe", name, "--project", project];
}

/** `gcloud secrets create` argv (automatic replication). Pure. */
export function createArgs(name: string, project: string): string[] {
  return ["secrets", "create", name, "--project", project, "--replication-policy=automatic"];
}

/** `gcloud secrets versions add` argv (value piped via stdin `--data-file=-`). Pure. */
export function addVersionArgs(name: string, project: string): string[] {
  return ["secrets", "versions", "add", name, "--project", project, "--data-file=-"];
}

/** Whether the secret already exists (a zero-exit `gcloud secrets describe`). */
function secretExists(name: string): boolean {
  try {
    execFileSync("gcloud", describeArgs(name, PROJECT), { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Create the secret (throws on non-zero exit). */
function createSecret(name: string): void {
  execFileSync("gcloud", createArgs(name, PROJECT), { stdio: "inherit" });
}

/** Add a new version whose payload is `value`, piped over stdin. */
function addVersion(name: string, value: string): void {
  execFileSync("gcloud", addVersionArgs(name, PROJECT), { input: value, stdio: ["pipe", "inherit", "inherit"] });
}

/**
 * Read one line from the terminal. `sensitive` suppresses the echo (the typed
 * characters are muted) so credentials are not left on screen. Resolves with the
 * entered value (trailing newline stripped by readline).
 */
function prompt(text: string, sensitive: boolean): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (sensitive) {
      // Mute echo: overwrite each keystroke the muted-writer would emit.
      const asMuted = rl as unknown as { output: NodeJS.WriteStream; _writeToOutput?: (s: string) => void };
      asMuted._writeToOutput = (stringToWrite: string): void => {
        // Still show the prompt itself; hide typed characters.
        asMuted.output.write(stringToWrite.includes(text) ? stringToWrite : "");
      };
    }
    rl.question(text, (answer) => {
      rl.close();
      if (sensitive) {
        process.stdout.write("\n");
      }
      resolve(answer);
    });
  });
}

/**
 * Seed every secret: prompt, create-if-absent, add a version, confirm. Returns the
 * process exit code (0 on success). Emits the completion hint on stdout.
 */
export async function main(): Promise<number> {
  for (const name of SECRETS) {
    const value = await prompt(promptFor(name), isSensitive(name));
    if (!secretExists(name)) {
      createSecret(name);
    }
    addVersion(name, value);
    process.stdout.write(updatedLine(name));
  }
  process.stdout.write(doneLine());
  return 0;
}

// Run as a CLI entrypoint (mirrors Python's `if __name__ == "__main__"`).
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
