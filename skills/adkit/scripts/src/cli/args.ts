/**
 * Shared customer-id resolution for the adkit entrypoints.
 *
 * The brief->flag->env->yaml precedence and the dash-stripping (111-111-1111 ->
 * 1111111111) live here so every entrypoint agrees. Each caller keeps its own
 * "nothing resolved" error UX, so this returns null rather than throwing.
 */

import { customerIdFromYaml, KEEP_YAML_LOGIN } from "../lib/auth.js";

/**
 * Strip the human-readable dashes from a customer/manager id (`111-111-1111 ->
 * 1111111111`). Null/empty passes through unchanged.
 */
export function normalizeId<T extends string | null | undefined>(value: T): T {
  return (value ? (value.replace(/-/g, "") as T) : value);
}

export interface ResolveCustomerOptions {
  /** When true (default), fall back to the yaml's target/login id if no candidate resolves. */
  fallbackYaml?: boolean;
  /** Injectable yaml lookup (defaults to {@link customerIdFromYaml}); overridden in tests. */
  yamlLookup?: () => string | null;
}

/**
 * First non-empty candidate (brief field, flag, env), dash-stripped; else the
 * yaml's target/login id when `fallbackYaml`. Null if nothing resolves.
 *
 * Naming note: the Python `resolve_customer(*candidates, fallback_yaml=True)` used
 * varargs; here candidates are passed as an array with the flag in an options
 * object, the idiomatic TS shape.
 */
export function resolveCustomer(
  candidates: Array<string | null | undefined>,
  { fallbackYaml = true, yamlLookup = customerIdFromYaml }: ResolveCustomerOptions = {},
): string | null {
  for (const candidate of candidates) {
    if (candidate) {
      return normalizeId(String(candidate));
    }
  }
  return fallbackYaml ? normalizeId(yamlLookup()) : null;
}

/** Environment tier of the login-customer-id chain (matches the SDK's own field name). */
export const LOGIN_CUSTOMER_ID_ENV = "GOOGLE_ADS_LOGIN_CUSTOMER_ID";

/**
 * The parsed login-customer-id decision — exactly the value {@link loadClient} /
 * `loadReadClient` accept, so a caller that holds one never re-checks or
 * re-normalizes it:
 *  - a `string` MCC id → reach the leaf through that manager,
 *  - `null` → send no login header (direct access),
 *  - {@link KEEP_YAML_LOGIN} → inherit whatever google-ads.yaml carries.
 */
export type LoginCustomerId = string | null | typeof KEEP_YAML_LOGIN;

/**
 * Resolve the login-customer-id header: `--manager` flag → `GOOGLE_ADS_LOGIN_CUSTOMER_ID`
 * → the credentials' own `login_customer_id` (inherited via {@link KEEP_YAML_LOGIN}).
 *
 * First non-blank candidate wins, dash-stripped. A blank/whitespace-only value at
 * any tier is ABSENT (fall through), never an instruction to clear the header — so
 * an exported-but-empty env var can't silently break an MCC-nested account.
 *
 * Pure and total: `env` is a parameter (never read from ambient state inside the
 * body), so precedence is testable without mutating `process.env`.
 */
export function resolveLoginCustomerId(
  managerFlag: string | null | undefined,
  env: Record<string, string | undefined> = {},
): LoginCustomerId {
  const candidates: Array<string | null | undefined> = [managerFlag, env[LOGIN_CUSTOMER_ID_ENV]];
  const found = candidates.find((c): c is string => typeof c === "string" && c.trim() !== "");
  return found === undefined ? KEEP_YAML_LOGIN : normalizeId(found.trim());
}
