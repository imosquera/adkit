/**
 * Shared customer-id resolution for the adkit entrypoints.
 *
 * The brief->flag->env->yaml precedence and the dash-stripping (891-192-5499 ->
 * 8911925499) live here so every entrypoint agrees. Each caller keeps its own
 * "nothing resolved" error UX, so this returns null rather than throwing.
 */

import { customerIdFromYaml } from "../lib/auth.js";

/**
 * Strip the human-readable dashes from a customer/manager id (`891-192-5499 ->
 * 8911925499`). Null/empty passes through unchanged.
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
