/**
 * In-memory {@link MetaClient} test double. Test support only — production code
 * never imports this module.
 *
 * - `get(path, params)` serves both `get` (a single object) and `getAll` (an array
 *   of items, each parsed through the caller's item schema).
 * - `post(path, body)` answers writes; a missing response becomes `{ id }` and an
 *   object response without `id` gets one, from an incrementing numeric counter.
 * - `failOn(call)` runs before every call; a returned {@link MetaApiError} is thrown.
 * - `readOnly` makes every `post` / upload throw, so a read-only command proves it
 *   never writes.
 *
 * Every response goes through the caller's zod schema exactly like the real client,
 * and a mismatch throws `MetaApiError` with `code: "schema"`. Every call — including
 * ones that then fail — is recorded in `calls`.
 */

import type { z } from "zod";

import type { CallOptions, MediaFile, MetaClient, Params } from "./client.js";
import { MetaApiError } from "./errors.js";
import { ImageHashSchema, MetaVideoIdSchema, type ImageHash, type MetaAdAccountId, type MetaVideoId } from "./ids.js";

/** One recorded client call. `step` is resolved to the real client's default when not passed. */
export type FakeCall =
  | { readonly method: "get" | "getAll"; readonly path: string; readonly params: Params; readonly step: string }
  | { readonly method: "post" | "uploadImage" | "uploadVideo"; readonly path: string; readonly body: Params; readonly step: string };

export interface FakeMetaClientOptions {
  /** Response for `get` (an object) or `getAll` (an array of items). May be async. */
  readonly get?: (path: string, params: Params) => unknown;
  /** Response for `post`; `undefined` → `{ id: <next id> }`. May be async. */
  readonly post?: (path: string, body: Params) => unknown;
  /** Checked before each call; a non-null error is thrown instead of answering. */
  readonly failOn?: (call: FakeCall) => MetaApiError | null;
  /** Throw on any `post`, `uploadImage` or `uploadVideo`. */
  readonly readOnly?: boolean;
  /** First auto-assigned id (default 10001). */
  readonly firstId?: number;
}

export interface FakeMetaClient extends MetaClient {
  /** Every call in order, as a read-only view. */
  readonly calls: readonly FakeCall[];
}

/** Step placeholder used by {@link metaApiError}; the fake re-stamps it with the call's step. */
export const FAKE_STEP = "fake";

/** Build a Graph-style {@link MetaApiError} for `failOn`. Its step becomes the failing call's step. */
export const metaApiError = (code: number | "schema", message: string, subcode?: number): MetaApiError =>
  new MetaApiError({ step: FAKE_STEP, code, message, subcode });

const withStep = (e: MetaApiError, step: string): MetaApiError =>
  e.step !== FAKE_STEP
    ? e
    : new MetaApiError({
        step,
        code: e.code,
        message: e.message,
        subcode: e.subcode,
        userTitle: e.userTitle,
        userMessage: e.userMessage,
        fbtraceId: e.fbtraceId,
        issues: e.issues,
      });

const parseWith = <T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, body: unknown, call: FakeCall): T => {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  throw new MetaApiError({
    step: call.step,
    code: "schema",
    message: `unexpected response shape from fake ${call.method} ${call.path}`,
    issues: parsed.error.issues,
  });
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Hash-safe token for a file name: whitespace collapsed so `ImageHashSchema` accepts it. */
const hashFor = (name: string): ImageHash => ImageHashSchema.parse(`hash_${name.replace(/\s+/g, "_")}`);

export function fakeMetaClient(opts: FakeMetaClientOptions = {}): FakeMetaClient {
  // Test double: closure-owned mutable log and id counter, appended/advanced per
  // call. Callers only ever see `calls` through a readonly type.
  const calls: FakeCall[] = [];
  let nextId = opts.firstId ?? 10001;
  const takeId = (): string => String(nextId++);

  /** Record the call, then apply `readOnly` and `failOn`, in that order. */
  const begin = (call: FakeCall): void => {
    calls.push(call);
    if (opts.readOnly === true && call.method !== "get" && call.method !== "getAll") {
      throw new Error(`fakeMetaClient is read-only: unexpected ${call.method} ${call.path}`);
    }
    const failure = opts.failOn?.(call) ?? null;
    if (failure !== null) throw withStep(failure, call.step);
  };

  const get = async <T>(path: string, params: Params, schema: z.ZodType<T, z.ZodTypeDef, unknown>, o?: CallOptions): Promise<T> => {
    const call: FakeCall = { method: "get", path, params, step: o?.step ?? "graph-get" };
    begin(call);
    return parseWith(schema, await opts.get?.(path, params), call);
  };

  const getAll = async <T>(path: string, params: Params, item: z.ZodType<T, z.ZodTypeDef, unknown>, o?: CallOptions): Promise<readonly T[]> => {
    const call: FakeCall = { method: "getAll", path, params, step: o?.step ?? "graph-get" };
    begin(call);
    const response: unknown = await opts.get?.(path, params);
    if (!Array.isArray(response)) {
      throw new MetaApiError({ step: call.step, code: "schema", message: `fake getAll ${path}: expected an array of items` });
    }
    return response.map((entry: unknown) => parseWith(item, entry, call));
  };

  const post = async <T>(path: string, body: Params, schema: z.ZodType<T, z.ZodTypeDef, unknown>, o?: CallOptions): Promise<T> => {
    const call: FakeCall = { method: "post", path, body, step: o?.step ?? "graph-post" };
    begin(call);
    const response: unknown = await opts.post?.(path, body);
    const withId =
      response === undefined ? { id: takeId() } : isRecord(response) && !("id" in response) ? { id: takeId(), ...response } : response;
    return parseWith(schema, withId, call);
  };

  const uploadImage = async (account: MetaAdAccountId, file: MediaFile, o?: CallOptions): Promise<ImageHash> => {
    begin({ method: "uploadImage", path: `${account}/adimages`, body: { name: file.name }, step: o?.step ?? "upload-image" });
    return hashFor(file.name);
  };

  const uploadVideo = async (account: MetaAdAccountId, file: MediaFile, o?: CallOptions): Promise<MetaVideoId> => {
    begin({ method: "uploadVideo", path: `${account}/advideos`, body: { name: file.name }, step: o?.step ?? "upload-video" });
    return MetaVideoIdSchema.parse(takeId());
  };

  return { get, getAll, post, uploadImage, uploadVideo, calls };
}
