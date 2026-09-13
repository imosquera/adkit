/**
 * The two Meta error types and the one pure formatter that turns any throwable
 * into a single human line.
 *
 * - {@link MetaApiError} — the Graph API said no (a non-2xx body parsed by the
 *   client's `GraphErrorSchema`), or a 2xx body failed its response schema
 *   (`code: "schema"` with the zod issues).
 * - {@link MetaConfigError} — adkit could not assemble a usable Meta context
 *   (missing token, bad ad account id, removed attribution window, ...).
 *
 * Both carry `step` so the bin shells can hand them to `errorEnvelope` exactly like
 * the Google-side errors. {@link formatMetaError} redacts `access_token` and
 * `appsecret_proof` values wherever they appear, because Graph error text and
 * `fetch` failures routinely echo the request URL back.
 */

import type { ZodIssue } from "zod";

/** Everything a Graph error body (or a schema failure) tells us. */
export interface MetaApiErrorFields {
  readonly step: string;
  readonly code: number | "schema";
  readonly message: string;
  readonly subcode?: number;
  readonly userTitle?: string;
  readonly userMessage?: string;
  readonly fbtraceId?: string;
  readonly issues?: readonly ZodIssue[];
}

/** A Graph API failure attributed to a step. Carries the envelope fields verbatim. */
export class MetaApiError extends Error {
  readonly step: string;
  readonly code: number | "schema";
  readonly subcode?: number;
  readonly userTitle?: string;
  readonly userMessage?: string;
  readonly fbtraceId?: string;
  readonly issues?: readonly ZodIssue[];

  constructor(fields: MetaApiErrorFields) {
    super(fields.message);
    this.name = "MetaApiError";
    this.step = fields.step;
    this.code = fields.code;
    this.subcode = fields.subcode;
    this.userTitle = fields.userTitle;
    this.userMessage = fields.userMessage;
    this.fbtraceId = fields.fbtraceId;
    this.issues = fields.issues;
  }
}

/** Thrown when the Meta context cannot be resolved. Names the offending field / file when known. */
export class MetaConfigError extends Error {
  constructor(
    readonly step: string,
    message: string,
    readonly field?: string,
    readonly path?: string,
  ) {
    super(message);
    this.name = "MetaConfigError";
  }
}

/** Query-string / form style: `access_token=EAAB...` up to the next delimiter. */
const SECRET_PARAM = /\b(access_token|appsecret_proof)=[^&\s"'#<>]+/g;
/** JSON style: `"access_token":"EAAB..."`. */
const SECRET_JSON = /"(access_token|appsecret_proof)"\s*:\s*"[^"]*"/g;

/** Replace every `access_token` / `appsecret_proof` value in `text` with `[REDACTED]`. Pure. */
export function redactMetaSecrets(text: string): string {
  return text.replace(SECRET_PARAM, "$1=[REDACTED]").replace(SECRET_JSON, '"$1":"[REDACTED]"');
}

const formatIssues = (issues: readonly ZodIssue[]): string =>
  issues.map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`).join("; ");

const formatApiError = (exc: MetaApiError): string => {
  const code = exc.code === "schema" ? "schema" : exc.subcode === undefined ? `${exc.code}` : `${exc.code}/${exc.subcode}`;
  const user = [exc.userTitle, exc.userMessage].filter((part): part is string => part !== undefined && part !== "").join(": ");
  const tail = [
    user === "" ? null : ` — ${user}`,
    exc.issues === undefined || exc.issues.length === 0 ? null : ` (${formatIssues(exc.issues)})`,
    exc.fbtraceId === undefined ? null : ` [fbtrace_id ${exc.fbtraceId}]`,
  ]
    .filter((part): part is string => part !== null)
    .join("");
  return `Meta API error ${code} at ${exc.step}: ${exc.message}${tail}`;
};

const formatConfigError = (exc: MetaConfigError): string => {
  const where = [exc.field, exc.path].filter((part): part is string => part !== undefined && part !== "").join(" in ");
  return where === "" ? exc.message : `${exc.message} (${where})`;
};

/**
 * One line for any throwable, with Meta secrets redacted. Meta errors get their
 * code/subcode/user-facing text/trace id; other `Error`s render as `<Name>:
 * <message>`; anything else via `String`. Pure.
 */
export function formatMetaError(exc: unknown): string {
  const text =
    exc instanceof MetaApiError
      ? formatApiError(exc)
      : exc instanceof MetaConfigError
        ? formatConfigError(exc)
        : exc instanceof Error
          ? `${exc.name}: ${exc.message}`
          : String(exc);
  return redactMetaSecrets(text);
}

/** The `{ step, message }` pair a bin hands to `errorEnvelope`. */
export interface EnvelopeFailure {
  readonly step: string;
  readonly message: string;
}

/**
 * Map a throwable to its envelope fields. Meta errors keep their own `step`;
 * anything else is attributed to `fallbackStep`. The message is
 * {@link formatMetaError}'s redacted line. Pure.
 */
export const envelopeFailure = (exc: unknown, fallbackStep: string): EnvelopeFailure => ({
  step: exc instanceof MetaApiError || exc instanceof MetaConfigError ? exc.step : fallbackStep,
  message: formatMetaError(exc),
});
