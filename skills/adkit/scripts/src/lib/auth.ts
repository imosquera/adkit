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

/**
 * One atomic mutate operation. Decoupled from the SDK's heavily-generic
 * `MutateOperation<Entity>` union so a heterogeneous batch (budgets + campaigns +
 * criteria + assets) shares one simple shape; {@link loadClient} casts to the SDK
 * type at the single call boundary.
 */
export interface AdsMutateOperation {
  entity: string;
  operation: "create" | "update" | "remove";
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
  /** Run a GAQL query against `customerId`, returning every row. */
  search<Row = GaqlRow>(customerId: string, query: string): Promise<Row[]>;
  /** Apply a batch of mutate operations atomically against `customerId`. */
  mutate(customerId: string, operations: AdsMutateOperation[]): Promise<MutateResult>;
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
    const cid = data.target_customer_id ?? data.login_customer_id;
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
    async mutate(customerId: string, operations: AdsMutateOperation[]): Promise<MutateResult> {
      const response = await customerFor(customerId).mutateResources(
        operations as unknown as MutateOperation<Record<string, unknown>>[],
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
