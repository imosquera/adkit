/**
 * One-time interactive seed of the ad-platform secrets into GCP Secret Manager.
 *
 * Faithful port of `ads_skill/bin/bootstrap_secrets.py`. Prompts for each secret
 * (sensitive values read without echo), creates the secret if it does not yet
 * exist, then adds a new version with the entered value — shelling out to `gcloud`
 * for all three operations. Only the resolved platform's secrets are prompted for
 * (`--platform` > `ADKIT_PLATFORM` > `platform` in `adkit.yaml` > `google`; see
 * {@link secretsFor}): a Google project sees the Google Ads secrets, a Meta project
 * only the Meta ones. A blank Meta answer skips that secret entirely — nothing is
 * created or versioned — including `meta-access-token`; note that `render-yaml`
 * still requires `meta-access-token` on a Meta project, so skipping it here only
 * defers the failure to the render. The project defaults to `your-project-prod`,
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
import { platformResult, type Platform } from "../cli/platform.js";
import { loadConfig, resolveTier } from "../lib/config.js";

/** GCP project the secrets live in: env var, then the project config, then the Python-mirroring default. */
export const PROJECT = resolveTier(null, process.env["GOOGLE_ADS_SECRETS_PROJECT"], loadConfig().secrets_project, "your-project-prod")!;

/**
 * The Google project's secret names, in prompt order. Load-bearing — must match
 * render-yaml. Only real credentials belong here: the target/MCC customer ids are
 * account numbers and live in the committed `adkit.yaml` instead (`ads.sh init`).
 */
export const SECRETS: readonly string[] = [
  "google-ads-developer-token",
  "google-ads-client-id",
  "google-ads-client-secret",
  "google-ads-refresh-token",
  // Optional — enables `audit`'s PSI landing-page diagnosis (issue #40). A blank
  // answer here still creates/updates the secret with an empty value; render-yaml
  // treats it as an optional field.
  "google-pagespeed-api-key",
];

/**
 * The Meta project's secret names, in prompt order (render-yaml maps them to
 * `meta_access_token` / `meta_app_secret`). A blank answer is skipped here, but
 * render-yaml requires `meta-access-token` on a Meta project.
 */
const META_SECRETS: readonly string[] = ["meta-access-token", "meta-app-secret"];

/** The secret names to seed for `platform`, in prompt order: `google` is exactly {@link SECRETS}. Pure. */
export function secretsFor(platform: Platform): readonly string[] {
  return platform === "google" ? SECRETS : META_SECRETS;
}

/** Secrets whose blank answer is skipped (no create, no version) rather than stored empty. */
const SKIP_WHEN_BLANK = new Set(META_SECRETS);

/**
 * True when `value` for `name` should be skipped: an optional (Meta) secret left
 * blank. Other secrets keep today's behaviour of storing whatever was entered. Pure.
 */
export function shouldSkip(name: string, value: string): boolean {
  return SKIP_WHEN_BLANK.has(name) && value.trim() === "";
}

/** The line printed when an optional secret is skipped. Pure. */
export function skippedLine(name: string): string {
  return `  - ${name} skipped (blank)\n`;
}

/**
 * The non-sensitive secrets: their prompt echoes (they are public identifiers, not
 * credentials). Everything else is read without echo.
 *
 * Down to one entry: the two customer ids used to sit here too, and that they did
 * was the tell that they were never secrets. They are now `adkit.yaml` preferences
 * (`ads.sh init`) and are absent from {@link SECRETS} entirely. The set stays a set
 * — the classification is a property of the list, not of the single name that
 * currently satisfies it.
 */
const NON_SENSITIVE = new Set(["google-ads-client-id"]);

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
  const platform = platformResult(process.argv.slice(2), process.env, loadConfig());
  if (platform.kind === "err") {
    emitJson(errorEnvelope(platform.message, { step: "platform" }));
    return 1;
  }
  for (const name of secretsFor(platform.value)) {
    const value = await prompt(promptFor(name), isSensitive(name));
    if (shouldSkip(name, value)) {
      process.stdout.write(skippedLine(name));
      continue;
    }
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
