/**
 * Cross-cutting executor helpers: SDK version probe, GAQL escaping re-export, and
 * the step-error machinery ({@link StepError} + {@link step}) that gives
 * {@link publishV1} its step-granular partial-success/failure reporting. No
 * dependency on the entity builders or the publish orchestration — those import
 * from here.
 */

import { createRequire } from "node:module";
import type { FailureStep } from "../lib/schema.js";
// Re-exported under the historical name used across the ads layer.
export { gaqlString as gaqlStringLiteral } from "../gaql/escape.js";

/** The installed `google-ads-api` version, or "unknown" if it can't be read. */
export function sdkVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    return (require("google-ads-api/package.json") as { version: string }).version;
  } catch {
    return "unknown";
  }
}

/**
 * A failure attributed to a specific publish step. Carries the step name, the
 * human message, the raw SDK error text, and (optionally) the ad group it happened
 * in — everything {@link publishV1} needs to build a `Failure`.
 */
export class StepError extends Error {
  readonly step: FailureStep;
  readonly raw: string | null;
  readonly adGroupName: string | null;

  constructor(step: FailureStep, message: string, raw: string | null, adGroupName: string | null = null) {
    super(message);
    this.name = "StepError";
    this.step = step;
    this.raw = raw;
    this.adGroupName = adGroupName;
  }
}

/**
 * Run one publish step, converting any non-{@link StepError} throwable into a
 * `StepError` tagged with `name`. A `StepError` from a nested step passes through
 * untouched (so the innermost step name wins).
 */
export async function step<T>(
  name: FailureStep,
  fn: () => Promise<T> | T,
  adGroupName: string | null = null,
): Promise<T> {
  try {
    return await fn();
  } catch (exc) {
    if (exc instanceof StepError) {
      throw exc;
    }
    throw new StepError(name, formatGoogleAdsError(exc), errorToString(exc), adGroupName);
  }
}

function errorToString(exc: unknown): string {
  if (exc instanceof Error) {
    return exc.message;
  }
  return String(exc);
}

interface GoogleAdsLikeError {
  errors?: Array<{
    error_code?: unknown;
    message?: string;
    location?: { field_path_elements?: Array<{ field_name?: string }> };
  }>;
}

/**
 * Unwrap a `google-ads-api` GoogleAdsFailure into a concise `; `-joined message,
 * each entry `<error_code>: <message> (at <field.path>)`. Falls back to
 * `<Name>: <exc>` for any non-Google throwable.
 */
export function formatGoogleAdsError(exc: unknown): string {
  const errors = (exc as GoogleAdsLikeError | null)?.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const parts = errors.map((err) => {
      const path = (err.location?.field_path_elements ?? []).map((part) => part.field_name ?? "").join(".");
      const code = JSON.stringify(err.error_code ?? {});
      return `${code}: ${err.message ?? ""} (at ${path})`;
    });
    return parts.join("; ");
  }
  const name = exc instanceof Error ? exc.name : typeof exc;
  return `${name}: ${String(exc)}`;
}
