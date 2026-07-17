/**
 * Shared credential resolution + the Google Ads client abstraction for the adkit
 * entrypoints.
 *
 * The Python package used `google-ads` (proto client) where `customer_id` was
 * threaded through every service call. `google-ads-api` (the TS SDK) instead binds
 * a `Customer` to a `customer_id`. To keep the ports faithful to the original
 * per-call shape — and to make the SDK layer unit-testable with a plain object —
 * everything talks to the small {@link AdsClient} interface: `search(customerId,
 * gaql)` and `mutate(customerId, operations)`. {@link loadClient} returns the real
 * implementation backed by `google-ads-api`; tests pass a hand-rolled fake.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { GoogleAdsApi, type MutateOperation } from "google-ads-api";
import { parse as parseYaml } from "yaml";
import { type SearchArgs, toGaql } from "../gaql/search-args.js";

/**
 * One atomic mutate operation. Decoupled from the SDK's heavily-generic
 * `MutateOperation<Entity>` union so a heterogeneous batch (budgets + campaigns +
 * criteria + assets) shares one simple shape; {@link loadClient} casts to the SDK
 * type at the single call boundary.
 */
export interface AdsMutateOperation {
  entity: string;
  operation: "create" | "update" | "remove";
  // Always a resource object here (create/update fields, or `{ resource_name }` for
  // a remove). loadClient's mutate unwraps a remove to the bare resource-name string
  // the SDK's proto `remove` field requires — see below.
  resource: Record<string, unknown>;
}

/** A single row returned from a GAQL `search` — a nested, snake_case record. */
export type GaqlValue = string | number | boolean | null | undefined | GaqlValue[] | { [key: string]: GaqlValue };
export type GaqlRow = { [key: string]: GaqlValue };

/** Result of a `mutate`: the created/updated resource names, in operation order. */
export interface MutateResult {
  results: Array<{ resource_name: string }>;
}

/**
 * The narrow surface every SDK-touching module depends on. Mirrors the two things
 * the Python code did with its client (search, and build-ops-then-mutate) so a test
 * can supply a fake without a live account.
 */
export interface AdsClient {
  /**
   * Run a raw GAQL query against `customerId`, returning every row. Retained for
   * the queries that are still authored as strings (the `preflight` access probe
   * and the inline `ads/entities.ts` resolution reads).
   */
  search<Row = GaqlRow>(customerId: string, query: string): Promise<Row[]>;
  /**
   * Run a structured {@link SearchArgs} read against `customerId`, returning every
   * row. This is the entrypoint the query builders feed and the shape the
   * google-ads-mcp `search` tool wants; the SDK backend satisfies it by deriving
   * GAQL via {@link toGaql} and delegating to {@link AdsClient.search}.
   */
  searchStructured<Row = GaqlRow>(customerId: string, args: SearchArgs): Promise<Row[]>;
  /** Apply a batch of mutate operations atomically against `customerId`. */
  mutate(customerId: string, operations: AdsMutateOperation[]): Promise<MutateResult>;
}

/**
 * Which backend serves structured reads. The SDK path is the default; `mcp` selects
 * the google-ads-mcp server (whose live wiring is gated on the MCP runtime being
 * present — see `lib/mcp-client.ts`). A closed union so an illegal value cannot flow
 * downstream.
 */
export type ReadBackend = "sdk" | "mcp";

/** Env var selecting the read backend (parsed once via {@link parseReadBackend}). */
export const READ_BACKEND_ENV = "ADKIT_READ_BACKEND";

/**
 * Parse a raw backend string (typically `process.env[READ_BACKEND_ENV]`) into a
 * {@link ReadBackend}, defaulting to `"sdk"` for anything absent or unrecognized —
 * the conservative, reversible default. Parse-don't-validate boundary: the raw env
 * string is narrowed to the closed union here, once, and never re-checked downstream.
 */
export function parseReadBackend(raw: string | undefined): ReadBackend {
  return raw?.trim().toLowerCase() === "mcp" ? "mcp" : "sdk";
}

/** The selected read backend, read once from the environment. */
export function readBackend(): ReadBackend {
  return parseReadBackend(process.env[READ_BACKEND_ENV]);
}

export const DEFAULT_CREDENTIALS_PATH = join(homedir(), ".config", "google-ads", "google-ads.yaml");

/**
 * Sentinel distinguishing "keep the yaml's login_customer_id header" (pass nothing)
 * from "override it" (pass a value, including `null` to clear the MCC header for
 * directly-accessible accounts).
 */
export const KEEP_YAML_LOGIN = Symbol("keep-yaml-login");

interface AdsYaml {
  developer_token?: string;
  client_id?: string;
  client_secret?: string;
  refresh_token?: string;
  login_customer_id?: string | number;
  target_customer_id?: string | number;
}

/**
 * Convert abstraction ops to the shape the SDK's `mutateResources` expects: a
 * `remove` op's resource is unwrapped from `{ resource_name }` to the bare
 * resource-name string (the Google Ads proto `remove` field is a string).
 * create/update ops pass through unchanged. Pure — the SDK-boundary transform.
 */
export function toSdkMutateOperations(operations: AdsMutateOperation[]): Array<Record<string, unknown>> {
  return operations.map((op) =>
    op.operation === "remove"
      ? { entity: op.entity, operation: op.operation, resource: (op.resource as { resource_name?: string }).resource_name ?? "" }
      : { entity: op.entity, operation: op.operation, resource: op.resource },
  );
}

/** Path to the google-ads.yaml credentials file (env override wins). */
export function credentialsPath(): string {
  return process.env["GOOGLE_ADS_CREDENTIALS"] || DEFAULT_CREDENTIALS_PATH;
}

function readCredentials(): AdsYaml {
  return (parseYaml(readFileSync(credentialsPath(), "utf8")) as AdsYaml | null) ?? {};
}

/** The leaf/target customer id from the yaml (target first, then login), dash-free — or null. */
export function customerIdFromYaml(): string | null {
  try {
    const data = readCredentials();
    // target_customer_id is the leaf operating account; login_customer_id is the MCC.
    // `||` (not `??`) so a falsy-but-present target (0/"") falls through, matching
    // the Python `target or login`.
    const cid = data.target_customer_id || data.login_customer_id;
    return cid ? String(cid) : null;
  } catch {
    return null;
  }
}

/**
 * Build the real {@link AdsClient} from the google-ads.yaml credentials.
 *
 * `loginCustomerId` semantics mirror the Python `load_client`:
 *  - omitted ({@link KEEP_YAML_LOGIN}) → keep the yaml's login_customer_id (the MCC).
 *  - `null` → clear the header for accounts you access DIRECTLY (an MCC header would
 *    otherwise break with USER_PERMISSION_DENIED). Most audit targets are direct.
 *  - a string MCC id → reach a leaf account through that manager.
 */
export function loadClient(
  loginCustomerId: string | null | typeof KEEP_YAML_LOGIN = KEEP_YAML_LOGIN,
): AdsClient {
  const creds = readCredentials();
  const api = new GoogleAdsApi({
    client_id: creds.client_id ?? "",
    client_secret: creds.client_secret ?? "",
    developer_token: creds.developer_token ?? "",
  });
  const refreshToken = creds.refresh_token ?? "";
  const yamlLogin = creds.login_customer_id !== undefined ? String(creds.login_customer_id) : undefined;
  const resolvedLogin = loginCustomerId === KEEP_YAML_LOGIN ? yamlLogin : loginCustomerId ?? undefined;

  const customerFor = (customerId: string) =>
    api.Customer({
      customer_id: customerId,
      refresh_token: refreshToken,
      ...(resolvedLogin !== undefined ? { login_customer_id: resolvedLogin } : {}),
    });

  return {
    async search<Row = GaqlRow>(customerId: string, query: string): Promise<Row[]> {
      return (await customerFor(customerId).query(query)) as Row[];
    },
    async searchStructured<Row = GaqlRow>(customerId: string, args: SearchArgs): Promise<Row[]> {
      return (await customerFor(customerId).query(toGaql(args))) as Row[];
    },
    async mutate(customerId: string, operations: AdsMutateOperation[]): Promise<MutateResult> {
      const response = await customerFor(customerId).mutateResources(
        toSdkMutateOperations(operations) as unknown as MutateOperation<Record<string, unknown>>[],
      );
      const responses =
        (response as unknown as { mutate_operation_responses?: Array<Record<string, { resource_name?: string }>> })
          .mutate_operation_responses ?? [];
      // Each atomic response is keyed by a `<entity>_result` field carrying the resource_name.
      const results = responses.map((entry) => {
        const first = Object.values(entry)[0];
        return { resource_name: first?.resource_name ?? "" };
      });
      return { results };
    },
  };
}
