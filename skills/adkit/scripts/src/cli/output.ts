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

/** Max length of the last-resort serialized error before we truncate with an ellipsis. */
const SDK_ERROR_JSON_LIMIT = 500;

/** Read a property from an errors-array element, tolerating non-object elements (null, primitives). */
function readField(e: unknown, key: string): unknown {
  return e !== null && typeof e === "object" ? (e as Record<string, unknown>)[key] : undefined;
}

/** Best-effort stringify of a single value that never throws and never yields "[object Object]". */
function safeStringify(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    const s = JSON.stringify(value);
    if (s && s !== "[object Object]") {
      return s;
    }
  } catch {
    // fall through to the typeof tag
  }
  return `[${typeof value}]`;
}

/** '; '-join the `.message` fields of an errors array, or "" if none are strings. */
function joinErrorMessages(errors: unknown): string {
  if (!Array.isArray(errors)) {
    return "";
  }
  return errors
    .map((e) => readField(e, "message"))
    .filter((m): m is string => typeof m === "string" && m.length > 0)
    .join("; ");
}

/** '; '-join the error-code fields of an errors array (google-ads-api uses both spellings). */
function joinErrorCodes(errors: unknown): string {
  if (!Array.isArray(errors)) {
    return "";
  }
  return errors
    .map((e) => readField(e, "errorCode") ?? readField(e, "error_code"))
    .filter((c) => c !== undefined && c !== null)
    .map((c) => safeStringify(c))
    .join("; ");
}

/**
 * Last resort: a truncated JSON serialization that is *guaranteed* not to be the
 * useless `[object Object]` string. Only reached for object inputs with no known
 * error shape.
 */
function serializeUnknownError(exc: object): string {
  let s: string;
  try {
    s = JSON.stringify(exc) ?? "";
  } catch {
    // Circular reference, BigInt field, throwing toJSON, etc.
    s = "";
  }
  if (!s || s === "[object Object]") {
    // A null-prototype object has no `constructor`, and its default toString is
    // exactly "[object Object]" — so tag it by a constructor name when present,
    // else a generic label that can never be the string we promise to avoid.
    const ctor = (exc as { constructor?: { name?: string } }).constructor?.name;
    s = ctor ? `[${ctor}]` : "[unserializable error object]";
  }
  return s.length > SDK_ERROR_JSON_LIMIT ? s.slice(0, SDK_ERROR_JSON_LIMIT) + "…" : s;
}

/**
 * Unwrap an SDK error into a concise human-readable message.
 *
 * A `google-ads-api` GoogleAdsException carries the useful text under
 * `.failure.errors[].message`; other shapes expose it as top-level
 * `errors[].message`, an `error_string`, or an `errors[].errorCode`. Anything
 * else falls back to the error's own `message`, a primitive's string form, or a
 * truncated JSON serialization — never the meaningless `[object Object]`.
 */
export function sdkErrorMessage(exc: unknown): string {
  const failure = (exc as { failure?: { errors?: unknown } } | null | undefined)?.failure;
  const topErrors = (exc as { errors?: unknown } | null | undefined)?.errors;

  // 1. Message fields, from the deepest known shape outward.
  const messages = joinErrorMessages(failure?.errors) || joinErrorMessages(topErrors);
  if (messages) {
    return messages;
  }

  // 2. A top-level error_string (some SDK rejections carry only this).
  const errorString = (exc as { error_string?: unknown } | null | undefined)?.error_string;
  if (typeof errorString === "string" && errorString.length > 0) {
    return errorString;
  }

  // 3. Error codes when there is no human message at all.
  const codes = joinErrorCodes(failure?.errors) || joinErrorCodes(topErrors);
  if (codes) {
    return codes;
  }

  // 4. The error's own message (covers plain Error instances).
  const message = (exc as { message?: unknown } | null | undefined)?.message;
  if (typeof message === "string" && message.length > 0) {
    return message;
  }

  // 5. Primitives and nullish coerce cleanly ("boom", "42", "null", "undefined").
  if (exc === null || exc === undefined || typeof exc !== "object") {
    return String(exc);
  }

  // 6. Object with no known shape: serialize instead of coercing to [object Object].
  return serializeUnknownError(exc);
}
