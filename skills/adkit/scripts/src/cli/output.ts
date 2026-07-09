/**
 * Shared stdout/stderr helpers for the adkit CLI entrypoints.
 *
 * Every entrypoint speaks the same machine-readable contract to the markdown
 * skills: pretty-printed JSON on stdout, with a `{ ok: boolean, ... }` envelope
 * for status payloads. Keep the contract here so it stays consistent.
 */

/**
 * JSON.stringify replacer mimicking Python's `json.dumps(..., default=str)`.
 *
 * Python only calls `default=str` for values it can't otherwise serialize, so
 * we coerce the non-JSON-native leftovers to strings: `bigint` and `undefined`
 * (which JSON.stringify would otherwise drop). Native-serializable values pass
 * through untouched so nested objects/arrays serialize normally.
 */
function defaultStrReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") {
    return String(value);
  }
  return value;
}

/**
 * Write a pretty-printed JSON payload to stdout — the channel the markdown
 * skills parse. Human-readable narration belongs on stderr. Non-JSON-native
 * values are coerced to strings (mirroring Python's `default=str`) rather than
 * raising mid-emit.
 */
export function emitJson(payload: unknown): void {
  process.stdout.write(JSON.stringify(payload, defaultStrReplacer, 2) + "\n");
}

/** Build a success envelope: `{ ok: true, ...fields }`. */
export function ok(fields: Record<string, unknown> = {}): { ok: true } & Record<string, unknown> {
  return { ok: true, ...fields };
}

/** Build a failure envelope: `{ ok: false, message, ...fields }`. */
export function errorEnvelope(
  message: string,
  fields: Record<string, unknown> = {},
): { ok: false; message: string } & Record<string, unknown> {
  return { ok: false, message, ...fields };
}

/**
 * Unwrap a GoogleAdsException into a concise '; '-joined message.
 *
 * A GoogleAdsException carries the useful text under `.failure.errors[].message`;
 * anything else falls back to the error's own `message` (or its string form).
 */
export function sdkErrorMessage(exc: unknown): string {
  const failure = (exc as { failure?: { errors?: unknown } } | null | undefined)?.failure;
  const errors = failure?.errors;
  if (Array.isArray(errors)) {
    const msgs = errors
      .map((e) => (e as { message?: unknown }).message)
      .filter((m): m is string => typeof m === "string")
      .join("; ");
    if (msgs) {
      return msgs;
    }
  }
  const message = (exc as { message?: unknown } | null | undefined)?.message;
  return String(typeof message === "string" ? message : exc);
}
