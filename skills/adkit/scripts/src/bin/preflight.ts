/**
 * Verify credentials + customer access before any mutation.
 *
 * Faithful port of `ads_skill/bin/preflight.py`. Runs the cheap, offline checks
 * first (the customer id resolves; the credentials file exists) WITHOUT
 * touching the SDK, then does a single live API check confirming the OAuth
 * identity can see the target customer. Every failure is emitted as the shared
 * `{ ok: false, message, step }` envelope; success as `{ ok: true, ... }`.
 *
 * Step names mirror the Python original: `"credentials"` and — for the live check
 * — `"deps"` / `"auth"` / `"access"`; a customer id that cannot be resolved reports
 * the shared `"customer-id"` step every other entrypoint uses.
 *
 * **Preflight must construct its client exactly the way the commands it gates do.**
 * It is a precondition check: a client built differently from `create`/`audit`/
 * `report`'s is not checking what preflight claims to check, and can pass or fail
 * where they would do the opposite.
 */

import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { isMainModule } from "../cli/entry.js";
import { credentialsPath, loadClient, mccCustomerIdFromYaml } from "../lib/auth.js";
import { customerIdErrorEnvelope, resolveTargetCustomerId } from "../cli/customer-id.js";
import { managerRequiredHint } from "../lib/customer-id.js";
import { emitJson, errorEnvelope, ok, sdkErrorMessage } from "../cli/output.js";
import { secretsReadWarning } from "../lib/secrets-guard.js";

/**
 * A resolved failure from one of the offline checks: the envelope `step` plus the
 * human message. `null` means the check passed.
 */
export interface CheckFailure {
  step: string;
  message: string;
}

/**
 * Confirm the credentials file exists at `credPath`. Returns a {@link CheckFailure}
 * (step `"credentials"`) when it is missing, else `null`.
 *
 * Pure w.r.t. its inputs: `exists` is injected (defaulting to `fs.existsSync`) so
 * tests can drive the missing/present branches without a real file.
 */
export function checkCredentialsExist(
  credPath: string,
  exists: (path: string) => boolean = existsSync,
): CheckFailure | null {
  if (!exists(credPath)) {
    return {
      step: "credentials",
      message: `Missing ${credPath}. Render it with: adkit render-yaml`,
    };
  }
  return null;
}

/** Parse preflight's one flag. Pure over its input array. */
export function parsePreflightArgs(argv: readonly string[]): { customer: string | null } {
  const { values } = parseArgs({
    args: [...argv],
    options: { customer: { type: "string" } },
    allowPositionals: true,
    strict: false,
  });
  return { customer: (values["customer"] as string | undefined) ?? null };
}

/** Strip a leading `customers/` resource-name prefix, yielding the bare id. */
function bareCustomerId(resourceName: string): string {
  return resourceName.replace(/^customers\//, "");
}

/**
 * Run the preflight checks and emit the JSON envelope on stdout. Returns the
 * process exit code (0 on success, 1 on any failed check).
 *
 * `clientFactory` is injectable so tests can assert on HOW the client is built
 * (which login-customer-id argument it receives) without a live account.
 */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  clientFactory: typeof loadClient = loadClient,
): Promise<number> {
  // --- simple checks (no SDK import required) ---
  // Same flag -> env -> yaml tiering as every other command (conventions.md): an
  // operator who answered `init`'s prompts must not also have to export anything.
  let customerId: string;
  try {
    customerId = await resolveTargetCustomerId(parsePreflightArgs(argv).customer);
  } catch (exc) {
    emitJson(customerIdErrorEnvelope(exc));
    return 1;
  }

  const credPath = credentialsPath();
  const credFailure = checkCredentialsExist(credPath);
  if (credFailure) {
    emitJson(errorEnvelope(credFailure.message, { step: credFailure.step }));
    return 1;
  }

  // Read-side guardrail (issue #71): a credentials file sitting somewhere git can
  // commit gets a loud warning, never a failed run. Refusing to READ a file that
  // already exists makes nothing safer, and the recommended out-of-repo placement
  // is outside any work tree, where `git check-ignore` has nothing to say — there
  // this is silent. stderr, so the JSON envelope on stdout stays parseable.
  const pathWarning = secretsReadWarning(credPath);
  if (pathWarning) {
    process.stderr.write(`${pathWarning}\n`);
  }

  // --- live API check (requires the SDK) ---
  let client: ReturnType<typeof loadClient>;
  try {
    // The DEFAULT (KEEP_YAML_MCC), deliberately — the same construction `create`,
    // `audit`, and `apply-fixes` use, because preflight is their precondition.
    //
    // It must not be `loadClient(null)`: null CLEARS the login-customer-id header,
    // so preflight would send no manager id no matter what the config carries,
    // and every MCC-managed account would fail USER_PERMISSION_DENIED while the
    // very commands preflight gates succeeded. The default already covers both
    // shapes — it sends the yaml's mcc_customer_id when set, and no header at all
    // when the field is blank, which is the directly-accessible case.
    client = clientFactory();
  } catch (exc) {
    // A module-not-found here means the SDK / deps aren't installed.
    const message = sdkErrorMessage(exc);
    if (isModuleNotFound(exc)) {
      emitJson(
        errorEnvelope("google-ads-api is not installed. Run: npm install inside the scripts/ directory.", {
          step: "deps",
        }),
      );
      return 1;
    }
    emitJson(errorEnvelope(`failed to load credentials from ${credPath}: ${message}`, { step: "auth" }));
    return 1;
  }

  let accessibleIds: string[];
  try {
    // One cheap row confirms the OAuth identity can actually read this customer.
    const rows = await client.search<{ customer?: { id?: string | number } }>(
      customerId,
      "SELECT customer.id FROM customer LIMIT 1",
    );
    accessibleIds = rows
      .map((row) => (row.customer?.id !== undefined ? bareCustomerId(String(row.customer.id)) : ""))
      .filter((id) => id !== "");
  } catch (exc) {
    if (isModuleNotFound(exc)) {
      emitJson(
        errorEnvelope("google-ads-api is not installed. Run: npm install inside the scripts/ directory.", {
          step: "deps",
        }),
      );
      return 1;
    }
    // Advice that is actually followable, which requires knowing which of the two
    // shapes we just tried: with a manager id set the id itself is the suspect;
    // with none set, the account may simply need one. The old message named
    // mcc_customer_id unconditionally — unfollowable when preflight was the thing
    // discarding it, and wrong when the field was legitimately blank.
    // Tolerate an unreadable config here: we are already reporting a failure, and
    // "could not tell" must degrade to the generic hint, not throw over the top of it.
    const configuredMcc = ((): string | undefined => {
      try {
        return mccCustomerIdFromYaml();
      } catch {
        return undefined;
      }
    })();
    emitJson(
      errorEnvelope(
        `customer ${customerId} is not accessible with these credentials: ${sdkErrorMessage(exc)}. ` +
          (configuredMcc
            ? `The run sent mcc_customer_id ${configuredMcc} as the login header — confirm that manager ` +
              `account manages customer ${customerId}.`
            : managerRequiredHint(credPath)),
        { step: "access" },
      ),
    );
    return 1;
  }

  emitJson(
    ok({
      customerId,
      credentialsYaml: credPath,
      accessibleCustomerCount: accessibleIds.length,
    }),
  );
  return 0;
}

/** True when `exc` looks like a Node module-resolution failure (missing dep). */
function isModuleNotFound(exc: unknown): boolean {
  const code = (exc as { code?: unknown } | null | undefined)?.code;
  return code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND";
}

// Run as a CLI entrypoint (mirrors Python's `if __name__ == "__main__"`).
if (isMainModule(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((exc: unknown) => {
      emitJson(errorEnvelope(sdkErrorMessage(exc), { step: "unexpected" }));
      process.exitCode = 1;
    });
}
