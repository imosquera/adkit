/**
 * Verify env + credentials + customer access before any mutation.
 *
 * Faithful port of `ads_skill/bin/preflight.py`. Runs the cheap, offline checks
 * first (the `GOOGLE_ADS_CUSTOMER_ID` env var is a 10-digit id; the
 * google-ads.yaml credentials file exists) WITHOUT touching the SDK, then does a
 * single live API check confirming the OAuth identity can see the target
 * customer. Every failure is emitted as the shared `{ ok: false, message, step }`
 * envelope; success as `{ ok: true, ... }`.
 *
 * Step names mirror the Python original: `"env"`, `"credentials"`, and — for the
 * live check — `"deps"` / `"auth"` / `"access"`.
 */

import { existsSync } from "node:fs";
import { credentialsPath, loadClient } from "../lib/auth.js";
import { emitJson, errorEnvelope, ok, sdkErrorMessage } from "../cli/output.js";
import { CUSTOMER_ID_PATTERN } from "../lib/schema.js";

/**
 * A resolved failure from one of the offline checks: the envelope `step` plus the
 * human message. `null` means the check passed.
 */
export interface CheckFailure {
  step: string;
  message: string;
}

/**
 * Validate the `GOOGLE_ADS_CUSTOMER_ID` env value. Returns a {@link CheckFailure}
 * (step `"env"`) when it is missing or not a bare 10-digit id, else `null`.
 *
 * Pure: takes the raw env value (possibly `undefined`) rather than reading
 * `process.env`, so it is trivially unit-testable.
 */
export function checkCustomerIdEnv(rawCustomerId: string | undefined): CheckFailure | null {
  const customerId = (rawCustomerId ?? "").trim();
  if (!customerId || !CUSTOMER_ID_PATTERN.test(customerId)) {
    return {
      step: "env",
      message: "GOOGLE_ADS_CUSTOMER_ID must be set to a 10-digit Google Ads customer id (no dashes).",
    };
  }
  return null;
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

/** Strip a leading `customers/` resource-name prefix, yielding the bare id. */
function bareCustomerId(resourceName: string): string {
  return resourceName.replace(/^customers\//, "");
}

/**
 * Run the preflight checks and emit the JSON envelope on stdout. Returns the
 * process exit code (0 on success, 1 on any failed check).
 */
export async function main(): Promise<number> {
  // --- simple checks (no SDK import required) ---
  const customerId = (process.env["GOOGLE_ADS_CUSTOMER_ID"] ?? "").trim();
  const envFailure = checkCustomerIdEnv(process.env["GOOGLE_ADS_CUSTOMER_ID"]);
  if (envFailure) {
    emitJson(errorEnvelope(envFailure.message, { step: envFailure.step }));
    return 1;
  }

  const credPath = credentialsPath();
  const credFailure = checkCredentialsExist(credPath);
  if (credFailure) {
    emitJson(errorEnvelope(credFailure.message, { step: credFailure.step }));
    return 1;
  }

  // --- live API check (requires the SDK) ---
  let client: ReturnType<typeof loadClient>;
  try {
    // login_customer_id = null: most preflight targets are directly-accessible.
    client = loadClient(null);
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
    emitJson(
      errorEnvelope(
        `customer ${customerId} is not accessible with these credentials: ${sdkErrorMessage(exc)}. ` +
          "Confirm the login_customer_id in google-ads.yaml is the MCC that manages this customer.",
        { step: "access" },
      ),
    );
    return 1;
  }

  emitJson(
    ok({
      customerIdEnv: customerId,
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
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((exc: unknown) => {
      emitJson(errorEnvelope(sdkErrorMessage(exc), { step: "unexpected" }));
      process.exitCode = 1;
    });
}
