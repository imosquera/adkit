/**
 * Graph API (Marketing API) client — the only module that talks to Meta over HTTP.
 *
 * Pure core, exported and tested on its own:
 * - {@link encodeParams} — Graph param encoding (objects/arrays JSON, `fields` joined).
 * - {@link appsecretProof} — HMAC-SHA256 of the token keyed by the app secret.
 * - {@link graphFailureKind} / {@link classifyGraphError} — throttle / ambiguous / fatal,
 *   and retry vs fatal per HTTP method (POSTs never resend after an ambiguous failure).
 * - {@link retryDelayMs} — exponential backoff, stretched by Meta's usage headers.
 *
 * I/O shell: {@link createMetaClient} wraps an injected `fetch` with a small
 * recursive retry (max {@link MAX_ATTEMPTS}) and a per-attempt timeout, parses every 2xx body through the
 * caller's zod schema and every failure into {@link MetaApiError}. The access token
 * travels only as a request param; it is never logged and every error message is
 * passed through `redactMetaSecrets`.
 */

import { createHmac } from "node:crypto";

import { z } from "zod";

import type { MetaContext } from "./config.js";
import { MetaApiError, MetaConfigError, redactMetaSecrets } from "./errors.js";
import { GraphErrorSchema, ImageUploadSchema, VideoStatusSchema, createdIdSchema, pageSchema } from "./graph.js";
import { MetaVideoIdSchema, type ImageHash, type MetaAdAccountId, type MetaVideoId } from "./ids.js";

export const GRAPH_API_VERSION = "v26.0";
export const GRAPH_BASE_URL = "https://graph.facebook.com";

/** Attempts per request, including the first. */
export const MAX_ATTEMPTS = 4;
/** Backoff base: attempt 1 → 1s, 2 → 2s, 3 → 4s (before jitter). */
export const BASE_DELAY_MS = 1000;
/** Upper bound on a single header-driven wait, so a CLI run never sleeps for an hour. */
export const MAX_DELAY_MS = 5 * 60 * 1000;
/** Local ceiling for the single-request `source` video upload (research.md). */
export const MAX_VIDEO_BYTES = 1024 * 1024 * 1024;
export const VIDEO_POLL_ATTEMPTS = 60;
export const VIDEO_POLL_INTERVAL_MS = 5000;
/** Per-attempt timeout for JSON Graph calls. */
export const DEFAULT_TIMEOUT_MS = 60 * 1000;
/** Per-attempt timeout for multipart media uploads (a 1 GB video on a slow uplink). */
export const DEFAULT_UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;
/** Video statuses that never become `ready`. */
const TERMINAL_VIDEO_STATUSES: ReadonlySet<string> = new Set(["error", "expired"]);
/** 613 subcode "ad set budget changed too often" — does not clear with a short backoff. */
export const BUDGET_CHANGE_QUOTA_SUBCODE = 1487632;

/** Graph request params; `undefined` values are dropped. */
export type Params = Readonly<Record<string, unknown>>;

/** Per-call options: `step` labels a failure for the bin's error envelope. */
export interface CallOptions {
  readonly step?: string;
}

export interface MediaFile {
  readonly name: string;
  readonly bytes: Uint8Array;
}

export interface MetaClient {
  get<T>(path: string, params: Params, schema: z.ZodType<T, z.ZodTypeDef, unknown>, opts?: CallOptions): Promise<T>;
  /** Follows `paging.next` until absent (empty pages do not stop it). */
  getAll<T>(path: string, params: Params, item: z.ZodType<T, z.ZodTypeDef, unknown>, opts?: CallOptions): Promise<readonly T[]>;
  post<T>(path: string, body: Params, schema: z.ZodType<T, z.ZodTypeDef, unknown>, opts?: CallOptions): Promise<T>;
  uploadImage(account: MetaAdAccountId, file: MediaFile, opts?: CallOptions): Promise<ImageHash>;
  uploadVideo(account: MetaAdAccountId, file: MediaFile, opts?: CallOptions): Promise<MetaVideoId>;
}

export interface MetaClientOptions {
  readonly token: string;
  readonly appSecret?: string;
  readonly fetch?: typeof fetch;
  readonly version?: string;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Jitter source in [0, 1); injectable for deterministic tests. */
  readonly random?: () => number;
  /** Per-attempt timeout for JSON calls, ms (default {@link DEFAULT_TIMEOUT_MS}). */
  readonly timeoutMs?: number;
  /** Per-attempt timeout for image/video uploads, ms (default {@link DEFAULT_UPLOAD_TIMEOUT_MS}). */
  readonly uploadTimeoutMs?: number;
}

/** Minimal header accessor so `retryDelayMs` works on `Headers` or a plain stub. */
export interface HeaderLookup {
  get(name: string): string | null;
}

// ---------------------------------------------------------------------------
// Pure core
// ---------------------------------------------------------------------------

const encodeValue = (key: string, value: unknown): string =>
  typeof value === "string"
    ? value
    : key === "fields" && Array.isArray(value)
      ? value.map(String).join(",")
      : typeof value === "object" && value !== null
        ? JSON.stringify(value)
        : String(value);

/**
 * Graph param encoding as `[key, value]` pairs: strings as-is, numbers/booleans
 * stringified, objects and arrays JSON-encoded, a `fields` array comma-joined,
 * `undefined` dropped. Pure.
 */
export const encodeParams = (params: Params): readonly (readonly [string, string])[] =>
  Object.entries(params)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => [key, encodeValue(key, value)] as const);

/** `appsecret_proof`: hex HMAC-SHA256 of the access token keyed by the app secret. Pure. */
export const appsecretProof = (token: string, appSecret: string): string =>
  createHmac("sha256", appSecret).update(token).digest("hex");

/** Throttling codes: Meta rejects the request before acting on it. */
const THROTTLE_CODES: ReadonlySet<number> = new Set([4, 17, 32, 613]);
/** Transient codes: Meta may have acted (e.g. created the object) before failing. */
const TRANSIENT_CODES: ReadonlySet<number> = new Set([1, 2]);
const isAdsThrottleCode = (code: number): boolean => code >= 80000 && code <= 80014;

export type HttpMethod = "GET" | "POST";

/**
 * How a non-2xx failed: `"throttle"` — rejected before acting (codes 4, 17, 32, 613,
 * 80000–80014), safe to resend; `"ambiguous"` — transient (codes 1, 2, `is_transient`,
 * HTTP 5xx), so a write may already have taken effect; `"fatal"` — everything else,
 * including budget-change quota subcode 1487632, which a short backoff never clears. Pure.
 */
export const graphFailureKind = (body: unknown, status: number): "throttle" | "ambiguous" | "fatal" => {
  const parsed = GraphErrorSchema.safeParse(body);
  if (!parsed.success) return status >= 500 ? "ambiguous" : "fatal";
  const { code, error_subcode, is_transient } = parsed.data.error;
  if (error_subcode === BUDGET_CHANGE_QUOTA_SUBCODE) return "fatal";
  if (THROTTLE_CODES.has(code) || isAdsThrottleCode(code)) return "throttle";
  return TRANSIENT_CODES.has(code) || is_transient === true || status >= 500 ? "ambiguous" : "fatal";
};

/**
 * `"retry"` or `"fatal"` for a non-2xx body. A GET (idempotent) retries throttle and
 * ambiguous failures; a POST retries throttles only — resending after an ambiguous
 * failure could create a duplicate object. Pure.
 */
export const classifyGraphError = (body: unknown, status: number, method: HttpMethod): "retry" | "fatal" => {
  const kind = graphFailureKind(body, status);
  return kind === "throttle" || (kind === "ambiguous" && method === "GET") ? "retry" : "fatal";
};

/** Appended to a POST failure whose outcome on Meta's side is unknown. */
export const AMBIGUOUS_POST_HINT =
  "the request may have taken effect before failing (an object may have been created); re-run to reconcile — creates are looked up by name first";

const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

const BusinessUseCaseUsageSchema = z.record(
  z.string(),
  z.array(z.object({ estimated_time_to_regain_access: z.coerce.number().optional() }).passthrough()),
);
const AdAccountUsageSchema = z.object({ reset_time_duration: z.coerce.number().optional() }).passthrough();

/** `X-Business-Use-Case-Usage` wait, in ms (the header reports minutes). */
const businessUseCaseWaitMs = (raw: string | null): number => {
  const parsed = raw === null ? null : BusinessUseCaseUsageSchema.safeParse(safeJson(raw));
  return parsed?.success === true
    ? Object.values(parsed.data)
        .flat()
        .reduce((max, entry) => Math.max(max, (entry.estimated_time_to_regain_access ?? 0) * 60_000), 0)
    : 0;
};

/** `X-Ad-Account-Usage` wait, in ms (the header reports seconds). */
const adAccountWaitMs = (raw: string | null): number => {
  const parsed = raw === null ? null : AdAccountUsageSchema.safeParse(safeJson(raw));
  return parsed?.success === true ? (parsed.data.reset_time_duration ?? 0) * 1000 : 0;
};

/**
 * Wait before retry number `attempt` (1-based: the wait after the first failure is
 * attempt 1). Exponential backoff `1s·2^(attempt-1)` plus up to 25% jitter, raised to
 * Meta's own estimate from `X-Business-Use-Case-Usage.estimated_time_to_regain_access`
 * or `X-Ad-Account-Usage.reset_time_duration` when larger, capped at
 * {@link MAX_DELAY_MS}. Pure given `jitter` in [0, 1).
 */
export const retryDelayMs = (attempt: number, headers: HeaderLookup, jitter = 0): number => {
  const backoff = BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1);
  const withJitter = Math.round(backoff * (1 + 0.25 * jitter));
  const hinted = Math.max(
    businessUseCaseWaitMs(headers.get("x-business-use-case-usage")),
    adAccountWaitMs(headers.get("x-ad-account-usage")),
  );
  return Math.min(MAX_DELAY_MS, Math.max(withJitter, hinted));
};

/** Map a non-2xx response body to a {@link MetaApiError}, redacting any echoed secrets. */
export const toMetaApiError = (body: unknown, status: number, rawText: string, step: string, hint?: string): MetaApiError => {
  const withHint = (message: string): string => (hint === undefined ? message : `${message} (${hint})`);
  const parsed = GraphErrorSchema.safeParse(body);
  if (!parsed.success) {
    const snippet = redactMetaSecrets(rawText.slice(0, 300));
    return new MetaApiError({ step, code: status, message: withHint(`HTTP ${status}${snippet === "" ? "" : `: ${snippet}`}`) });
  }
  const e = parsed.data.error;
  return new MetaApiError({
    step,
    code: e.code,
    subcode: e.error_subcode,
    message: redactMetaSecrets(
      withHint(
        e.error_subcode === BUDGET_CHANGE_QUOTA_SUBCODE
          ? `${e.message} (Meta allows at most 4 budget changes per ad set per hour; try again later)`
          : e.message,
      ),
    ),
    userTitle: e.error_user_title === undefined ? undefined : redactMetaSecrets(e.error_user_title),
    userMessage: e.error_user_msg === undefined ? undefined : redactMetaSecrets(e.error_user_msg),
    fbtraceId: e.fbtrace_id,
  });
};

// ---------------------------------------------------------------------------
// I/O shell
// ---------------------------------------------------------------------------

const toSearchParams = (pairs: readonly (readonly [string, string])[]): URLSearchParams =>
  new URLSearchParams(pairs.map(([k, v]): [string, string] => [k, v]));

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Strip query string (it may carry the token) so a URL is safe to put in a message. */
const describeUrl = (url: string): string => redactMetaSecrets(url.split("?")[0] ?? url);

const NO_HEADERS: HeaderLookup = { get: () => null };

const CauseDetailSchema = z.object({ code: z.string().optional(), message: z.string().optional() });

/**
 * A fetch rejection as text, including the underlying socket cause Node's `fetch`
 * hides behind "fetch failed" (e.g. `ECONNRESET: socket hang up`). Pure.
 */
const describeCause = (cause: unknown): string => {
  const outer = cause instanceof Error ? cause.message : String(cause);
  const inner = cause instanceof Error ? CauseDetailSchema.safeParse(cause.cause) : undefined;
  const detail = inner?.success === true ? [inner.data.code, inner.data.message].filter((s) => s !== undefined && s !== "").join(": ") : "";
  return detail === "" ? outer : `${outer} (${detail})`;
};

type Exchange =
  | { readonly kind: "response"; readonly res: Response; readonly text: string }
  | { readonly kind: "timeout"; readonly cause: unknown }
  | { readonly kind: "network"; readonly cause: unknown };

interface SendRequest {
  readonly url: string;
  /** Rebuilt per attempt so a multipart retry resends the file. */
  readonly init: () => RequestInit;
  readonly step: string;
  readonly method: HttpMethod;
  readonly timeoutMs: number;
}

export function createMetaClient(opts: MetaClientOptions): MetaClient {
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const uploadTimeoutMs = opts.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS;
  const base = `${GRAPH_BASE_URL}/${opts.version ?? GRAPH_API_VERSION}`;
  const authParams: Params = {
    access_token: opts.token,
    appsecret_proof: opts.appSecret === undefined ? undefined : appsecretProof(opts.token, opts.appSecret),
  };

  const urlFor = (path: string): string => `${base}/${path.replace(/^\/+/, "")}`;
  const query = (params: Params): string => toSearchParams(encodeParams({ ...params, ...authParams })).toString();

  /** Add auth params to an absolute `paging.next` URL only where Meta left them out. */
  const withAuth = (absolute: string): string => {
    const url = new URL(absolute);
    const missing = encodeParams(authParams).filter(([key]) => !url.searchParams.has(key));
    return missing.length === 0 ? absolute : `${absolute}${absolute.includes("?") ? "&" : "?"}${toSearchParams(missing).toString()}`;
  };

  /**
   * One HTTP exchange (fetch + body read) under a per-attempt timeout signal.
   * Never rejects: a timeout or network failure comes back as a tagged value.
   */
  const exchange = async (url: string, init: RequestInit, timeoutMs: number): Promise<Exchange> => {
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const res = await doFetch(url, { ...init, signal });
      return { kind: "response", res, text: await res.text() };
    } catch (cause: unknown) {
      return signal.aborted ? { kind: "timeout", cause } : { kind: "network", cause };
    }
  };

  /** Recursive retry around {@link exchange}; resolves to the parsed JSON body of a 2xx. */
  const send = async (req: SendRequest, attempt = 1): Promise<unknown> => {
    const { url, init, step, method, timeoutMs } = req;
    const where = `${step} (${method} ${describeUrl(url)})`;
    const result = await exchange(url, init(), timeoutMs);
    if (result.kind === "network") {
      throw new Error(redactMetaSecrets(`network error at ${where}: ${describeCause(result.cause)}`), { cause: result.cause });
    }
    if (result.kind === "timeout") {
      if (method === "GET" && attempt < MAX_ATTEMPTS) {
        await sleep(retryDelayMs(attempt, NO_HEADERS, random()));
        return send(req, attempt + 1);
      }
      const outcome = method === "POST" ? `; outcome unknown — ${AMBIGUOUS_POST_HINT}` : "";
      throw new Error(redactMetaSecrets(`request timed out after ${timeoutMs}ms at ${where}${outcome}`), { cause: result.cause });
    }
    const { res, text } = result;
    const body = safeJson(text);
    if (res.ok) return body;
    if (attempt < MAX_ATTEMPTS && classifyGraphError(body, res.status, method) === "retry") {
      await sleep(retryDelayMs(attempt, res.headers, random()));
      return send(req, attempt + 1);
    }
    const hint = method === "POST" && graphFailureKind(body, res.status) === "ambiguous" ? AMBIGUOUS_POST_HINT : undefined;
    throw toMetaApiError(body, res.status, text, step, hint);
  };

  const parseWith = <T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, body: unknown, url: string, step: string): T => {
    const parsed = schema.safeParse(body);
    if (parsed.success) return parsed.data;
    throw new MetaApiError({
      step,
      code: "schema",
      message: `unexpected response shape from ${describeUrl(url)}`,
      issues: parsed.error.issues,
    });
  };

  const getUrl = async <T>(url: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, step: string): Promise<T> =>
    parseWith(schema, await send({ url, init: () => ({ method: "GET" }), step, method: "GET", timeoutMs }), url, step);

  const get = <T>(path: string, params: Params, schema: z.ZodType<T, z.ZodTypeDef, unknown>, o?: CallOptions): Promise<T> =>
    getUrl(`${urlFor(path)}?${query(params)}`, schema, o?.step ?? "graph-get");

  const getAll = async <T>(path: string, params: Params, item: z.ZodType<T, z.ZodTypeDef, unknown>, o?: CallOptions): Promise<readonly T[]> => {
    const step = o?.step ?? "graph-get";
    const schema = pageSchema(item) as unknown as z.ZodType<{ data: T[]; paging?: { next?: string } }, z.ZodTypeDef, unknown>;
    const collect = async (url: string, acc: readonly T[]): Promise<readonly T[]> => {
      const page = await getUrl(url, schema, step);
      const all = [...acc, ...page.data];
      const next = page.paging?.next;
      return next === undefined || next === "" ? all : collect(withAuth(next), all);
    };
    return collect(`${urlFor(path)}?${query(params)}`, []);
  };

  const post = async <T>(path: string, body: Params, schema: z.ZodType<T, z.ZodTypeDef, unknown>, o?: CallOptions): Promise<T> => {
    const step = o?.step ?? "graph-post";
    const url = urlFor(path);
    const init = (): RequestInit => ({
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: query(body),
    });
    return parseWith(schema, await send({ url, init, step, method: "POST", timeoutMs }), url, step);
  };

  /** Multipart POST; the `FormData` is rebuilt per attempt so a retry resends the file. */
  const postMultipart = async <T>(
    path: string,
    fields: Params,
    file: { field: string } & MediaFile,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    step: string,
  ): Promise<T> => {
    const url = urlFor(path);
    const init = (): RequestInit => {
      const form = new FormData();
      encodeParams({ ...fields, ...authParams }).forEach(([k, v]) => form.append(k, v));
      form.append(file.field, new Blob([file.bytes]), file.name);
      return { method: "POST", body: form };
    };
    return parseWith(schema, await send({ url, init, step, method: "POST", timeoutMs: uploadTimeoutMs }), url, step);
  };

  const uploadImage = async (account: MetaAdAccountId, file: MediaFile, o?: CallOptions): Promise<ImageHash> => {
    const step = o?.step ?? "upload-image";
    const res = await postMultipart(`${account}/adimages`, {}, { field: "filename", ...file }, ImageUploadSchema, step);
    const entries = Object.entries(res.images);
    const match = res.images[file.name] ?? (entries.length === 1 ? entries[0]?.[1] : undefined);
    if (match === undefined) {
      throw new MetaApiError({ step, code: "schema", message: `adimages response has no hash for ${file.name}` });
    }
    return match.hash;
  };

  const pollVideo = async (id: MetaVideoId, step: string, attempt = 1): Promise<MetaVideoId> => {
    const { status } = await get(id, { fields: "status" }, VideoStatusSchema, { step });
    if (status.video_status === "ready") return id;
    if (TERMINAL_VIDEO_STATUSES.has(status.video_status) || status.processing_phase?.status === "error") {
      const first = status.processing_phase?.errors?.[0];
      const reason = status.video_status === "expired" ? "upload expired before processing" : (first?.message ?? "unknown error");
      throw new MetaApiError({ step, code: first?.code ?? 0, message: `video ${id} failed processing (status "${status.video_status}"): ${reason}` });
    }
    if (attempt >= VIDEO_POLL_ATTEMPTS) {
      throw new MetaApiError({
        step,
        code: 0,
        message: `video ${id} still "${status.video_status}" after ${VIDEO_POLL_ATTEMPTS} status checks`,
      });
    }
    await sleep(VIDEO_POLL_INTERVAL_MS);
    return pollVideo(id, step, attempt + 1);
  };

  const uploadVideo = async (account: MetaAdAccountId, file: MediaFile, o?: CallOptions): Promise<MetaVideoId> => {
    const step = o?.step ?? "upload-video";
    if (file.bytes.byteLength > MAX_VIDEO_BYTES) {
      throw new MetaConfigError(
        step,
        `video ${file.name} is ${file.bytes.byteLength} bytes; single-request uploads are limited to 1 GB`,
        undefined,
        file.name,
      );
    }
    const { id } = await postMultipart(
      `${account}/advideos`,
      { name: file.name },
      { field: "source", ...file },
      createdIdSchema(MetaVideoIdSchema),
      step,
    );
    return pollVideo(id, step);
  };

  return { get, getAll, post, uploadImage, uploadVideo };
}

/**
 * The client every Meta command builds from its resolved context: the token, plus
 * `appsecret_proof` when an app secret is configured.
 */
export const metaClientFor = (ctx: Pick<MetaContext, "token" | "appSecret">): MetaClient =>
  createMetaClient({ token: ctx.token, appSecret: ctx.appSecret ?? undefined });
