/**
 * Shared customer-id resolution for the adkit entrypoints.
 *
 * The brief->flag->env->yaml precedence and the dash-stripping (111-111-1111 ->
 * 1111111111) live here so every entrypoint agrees. Each caller keeps its own
 * "nothing resolved" error UX, so this returns null rather than throwing.
 */

import { requireDigits } from "../audit/scoring.js";
import { customerIdFromYaml, KEEP_YAML_MCC } from "../lib/auth.js";

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

/** Environment tier of the mcc-customer-id chain (matches the SDK's own field name). */
export const MCC_CUSTOMER_ID_ENV = "GOOGLE_ADS_LOGIN_CUSTOMER_ID";

/**
 * The value {@link loadClient} / `loadReadClient` accept as their mcc-customer-id:
 *  - a `string` MCC id → reach the leaf through that manager,
 *  - `null` → send no login header (direct access),
 *  - {@link KEEP_YAML_MCC} → inherit whatever .adkit.yaml carries.
 */
export type MccCustomerId = string | null | typeof KEEP_YAML_MCC;

/**
 * The parsed mcc-customer-id decision, TAGGED with the tier that supplied it.
 *
 * The tier is part of the answer, not bookkeeping: `{ source: "yaml" }` means "defer
 * to the credentials", under which a header IS still sent whenever .adkit.yaml
 * carries a `mcc_customer_id`. Collapsing it into a bare `null` would make an
 * MCC-routed run report and blame "no manager" (FR-008).
 *
 * A `value` here is already trimmed, dash-stripped, and digit-checked, so a holder
 * never re-checks or re-normalizes it.
 */
export type ResolvedMcc =
  | { readonly source: "flag" | "env"; readonly value: string }
  | { readonly source: "yaml" };

/**
 * Resolve the mcc-customer-id header: `--manager` flag → `GOOGLE_ADS_LOGIN_CUSTOMER_ID`
 * → the credentials' own `mcc_customer_id` (inherited, tagged `"yaml"`).
 *
 * First non-blank candidate wins, dash-stripped. A blank/whitespace-only value at
 * any tier is ABSENT (fall through), never an instruction to clear the header — so
 * an exported-but-empty env var can't silently break an MCC-nested account.
 *
 * The digits guard lives HERE, where the winning tier is still known, so junk in the
 * environment is reported against `GOOGLE_ADS_LOGIN_CUSTOMER_ID` rather than against
 * a `--manager` flag the operator never passed. Throws (like the rest of the
 * `requireDigits` call sites) on a malformed value; otherwise total.
 *
 * Pure: `env` is a required parameter — never read from ambient state inside the
 * body, and never defaulted, so no caller can silently skip the env tier.
 */
export function resolveMccCustomerId(
  managerFlag: string | null | undefined,
  env: Record<string, string | undefined>,
): ResolvedMcc {
  const tiers = [
    { source: "flag", label: "--manager", raw: managerFlag },
    { source: "env", label: MCC_CUSTOMER_ID_ENV, raw: env[MCC_CUSTOMER_ID_ENV] },
  ] as const;
  const hit = tiers.find((tier) => typeof tier.raw === "string" && tier.raw.trim() !== "");
  if (hit === undefined) {
    return { source: "yaml" };
  }
  const value = normalizeId(String(hit.raw).trim());
  requireDigits(hit.label, value);
  return { source: hit.source, value };
}

/**
 * The client-seam value for a {@link ResolvedMcc}: an explicit id for the flag/env
 * tiers, the inherit sentinel for the yaml tier.
 */
export function mccHeaderValue(login: ResolvedMcc): MccCustomerId {
  return login.source === "yaml" ? KEEP_YAML_MCC : login.value;
}
