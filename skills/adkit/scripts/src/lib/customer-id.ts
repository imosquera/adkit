/**
 * Parsing and resolution for the two Google Ads account numbers: the leaf
 * `target_customer_id` every command operates on, and the optional manager
 * `mcc_customer_id` header.
 *
 * Neither is a credential — both are 10-digit account ids printed in the Ads UI —
 * so they live in the committed `adkit.yaml` as ordinary preferences (see
 * {@link "./config.js".PREFERENCE_FIELDS}) and are never fetched from Secret
 * Manager. Nothing here reads a secret, and there is deliberately no fallback to
 * one: an id that exists only in a previously-seeded secret is gone as far as this
 * tool is concerned.
 *
 * Parse, don't validate: a raw string crosses {@link parseCustomerId} exactly once
 * — at the flag/env/config/prompt boundary — and everything downstream holds a
 * {@link CustomerId}, whose type is the proof that it is ten digits with the dashes
 * already stripped. No caller re-checks the shape.
 *
 * The asymmetry between the two ids is the whole point of this module:
 *  - **target** is required to operate. Nothing can guess it, so when no tier
 *    supplies one we ask (on a TTY) or fail loudly (everywhere else).
 *  - **login** is optional, and *absent is a legitimate answer* meaning the account
 *    is reached directly, without a manager. It must never prompt and never block.
 *
 * The IO (prompting, persisting) is injected, so the whole decision tree is pure
 * and unit-testable without a terminal or a config file.
 */

import { CUSTOMER_ID_PATTERN } from "./schema.js";
import type { AdkitConfig } from "./config.js";

/**
 * A parsed Google Ads account number: exactly ten digits, dashes already stripped.
 *
 * Branded so it cannot be produced by a bare string literal — the only way to hold
 * one is through {@link parseCustomerId}, which makes the type itself the evidence
 * that validation happened.
 */
export type CustomerId = string & { readonly __customerId: unique symbol };

/** The outcome of parsing one raw id: the proof, or the reason it isn't one. */
export type ParsedCustomerId =
  | { readonly ok: true; readonly value: CustomerId }
  | { readonly ok: false; readonly message: string };

/** How the operator writes an id when we ask for one, quoted back in error text. */
const ID_SHAPE = "10 digits, dashes optional (e.g. 123-456-7890 or 1234567890)";

/**
 * Parse one raw customer id into a {@link CustomerId}. Pure and total — never
 * throws; a bad value comes back as `{ ok: false, message }` naming `label`, what
 * was typed, and what was wrong with it specifically (too short, too long, or
 * non-digit characters) rather than a generic "invalid".
 *
 * Dashes are stripped first, so the 123-456-7890 form a human reads off the Ads UI
 * is accepted verbatim. Surrounding whitespace is trimmed. Blank/absent is not an
 * error here — it is simply "no value at this tier"; whether that is fatal is the
 * caller's decision (fatal for target, fine for login).
 *
 * `raw` is deliberately `unknown`-ish rather than `string`: one tier is a YAML
 * file, and an unquoted 10-digit id (`target_customer_id: 1234567890` — the form
 * a human hand-writes, and what the docs invite by saying "edit it directly")
 * parses as a NUMBER. `ads.sh init` happens to write the value quoted, which is
 * the only reason this was survivable; a hand-edited config used to crash the
 * run with `(raw ?? "").trim is not a function` — a TypeError from a function
 * whose contract says it never throws. Coercing here keeps that promise true for
 * every caller instead of making each one remember to `String()` first.
 */
export function parseCustomerId(
  label: string,
  raw: string | number | null | undefined,
): ParsedCustomerId | null {
  const trimmed = (raw === null || raw === undefined ? "" : String(raw)).trim();
  if (trimmed === "") {
    return null;
  }
  const digitsOnly = trimmed.replace(/-/g, "");
  if (!/^[0-9]*$/.test(digitsOnly)) {
    return { ok: false, message: `${label}: "${trimmed}" contains non-digit characters — expected ${ID_SHAPE}.` };
  }
  if (!CUSTOMER_ID_PATTERN.test(digitsOnly)) {
    const problem = digitsOnly.length < 10 ? "too short" : "too long";
    return {
      ok: false,
      message: `${label}: "${trimmed}" is ${problem} — it has ${digitsOnly.length} digits, expected ${ID_SHAPE}.`,
    };
  }
  return { ok: true, value: digitsOnly as CustomerId };
}

/** Thrown when a customer id was supplied but is not a well-formed account number. */
export class InvalidCustomerIdError extends Error {
  readonly step = "customer-id";
}

/**
 * Thrown when `target_customer_id` resolves nowhere and we cannot ask for it (no
 * TTY: CI, a pipe). Carries the envelope fields the entrypoint emits verbatim —
 * the field name, the config path, and the one-line fix — so every command reports
 * the same failure the same way.
 */
export class MissingTargetCustomerIdError extends Error {
  readonly step = "customer-id";
  constructor(
    readonly field: string,
    readonly configPath: string,
  ) {
    super(
      `no ${field} — nothing to operate on. Pass --customer-id, export GOOGLE_ADS_CUSTOMER_ID, ` +
        `or set ${field} in ${configPath} (run \`ads.sh init\`). ` +
        "It is a 10-digit Google Ads account number, not a secret.",
    );
  }
}

/** Parse a tier's raw value, throwing {@link InvalidCustomerIdError} on a malformed one. Pure. */
function parseOrThrow(label: string, raw: string | number | null | undefined): CustomerId | null {
  const parsed = parseCustomerId(label, raw);
  if (parsed === null) {
    return null;
  }
  if (!parsed.ok) {
    throw new InvalidCustomerIdError(parsed.message);
  }
  return parsed.value;
}

/**
 * First tier that supplies a well-formed id, or `null` when none does. Pure.
 *
 * Each tier is labelled by where it came from, so a malformed value is reported
 * against the thing the operator actually set (`GOOGLE_ADS_CUSTOMER_ID`, say)
 * rather than against a flag they never passed.
 */
function firstParsed(tiers: ReadonlyArray<readonly [string, string | number | null | undefined]>): CustomerId | null {
  for (const [label, raw] of tiers) {
    const parsed = parseOrThrow(label, raw);
    if (parsed !== null) {
      return parsed;
    }
  }
  return null;
}

/** The environment variable naming the leaf account to operate on. */
export const CUSTOMER_ID_ENV = "GOOGLE_ADS_CUSTOMER_ID";

/** The prompt shown when the leaf account id is missing and we can ask for it. */
export function targetCustomerIdPrompt(): string {
  return `Google Ads account id to operate on (${ID_SHAPE}): `;
}

/** Confirmation printed after the prompted id is persisted, so the write is never silent. */
export function persistedLine(field: string, id: string, path: string): string {
  return `saved ${field}: ${id} to ${path} — you won't be asked again.\n`;
}

/** The IO {@link requireTargetCustomerId} needs, injected so the decision tree stays testable. */
export interface TargetCustomerIdDeps {
  /** `--customer` / `--customer-id` flag, or a brief's own field. */
  readonly flag?: string | null | undefined;
  /** The environment to read {@link CUSTOMER_ID_ENV} from. Required — never ambient. */
  readonly env: Record<string, string | undefined>;
  /** The already-loaded, merged config. */
  readonly config: AdkitConfig;
  /** Where that config lives, for the error text and the persist. */
  readonly configPath: string;
  /** Whether stdin is a terminal — the difference between asking and failing. */
  readonly isTty: boolean;
  /** Ask the operator once. Only ever called when `isTty`. */
  readonly prompt: (text: string) => Promise<string>;
  /** Write the answer into the preferences file. Only ever called after a successful parse. */
  readonly persist: (id: CustomerId) => void;
  /** Where the "saved …" confirmation goes (stderr: stdout carries the JSON envelope). */
  readonly notify: (line: string) => void;
}

/**
 * Resolve the leaf account to operate on: flag → env → the config → ask.
 *
 * Required to operate, so there is no "resolved to nothing" outcome — this either
 * returns a {@link CustomerId} or throws. On a TTY the operator is asked once, the
 * answer is validated, and it is **written into `adkit.yaml`** so no later run
 * asks again. Off a TTY (CI, a pipe) it throws {@link MissingTargetCustomerIdError},
 * which the entrypoint turns into the standard `ok:false` envelope; it never
 * prompts into a pipe that cannot answer, and never guesses.
 *
 * NOTE — the persist deliberately lets a read-only command (`audit`, `report`,
 * `research`) write the config. Nothing but `init` and `render-yaml` does that
 * today, so it is a real widening of who touches the file and is called out here
 * rather than left to be discovered. The trade is one prompt per project against
 * one prompt per run: the value is an account number the operator just typed by
 * hand, it lands in the committed `adkit.yaml` (it is an account number, safe to
 * share), and only the single missing field is added — every other field in that
 * file is carried through untouched. The write is
 * announced on stderr ({@link persistedLine}), never silent.
 *
 * A malformed value at any tier — including the typed answer — throws
 * {@link InvalidCustomerIdError} naming what was wrong. The prompt is asked once,
 * not in a retry loop: a second chance at a value the operator can paste from the
 * dashboard is not worth an unbounded wait on stdin.
 */
export async function requireTargetCustomerId(deps: TargetCustomerIdDeps): Promise<CustomerId> {
  const resolved = firstParsed([
    ["--customer-id", deps.flag],
    [CUSTOMER_ID_ENV, deps.env[CUSTOMER_ID_ENV]],
    [`target_customer_id in ${deps.configPath}`, deps.config.target_customer_id],
  ]);
  if (resolved !== null) {
    return resolved;
  }
  if (!deps.isTty) {
    throw new MissingTargetCustomerIdError("target_customer_id", deps.configPath);
  }
  const answer = await deps.prompt(targetCustomerIdPrompt());
  const parsed = parseCustomerId("target_customer_id", answer);
  if (parsed === null) {
    throw new MissingTargetCustomerIdError("target_customer_id", deps.configPath);
  }
  if (!parsed.ok) {
    throw new InvalidCustomerIdError(parsed.message);
  }
  deps.persist(parsed.value);
  deps.notify(persistedLine("target_customer_id", parsed.value, deps.configPath));
  return parsed.value;
}

/**
 * Resolve the manager (MCC) login header: flag → `GOOGLE_ADS_LOGIN_CUSTOMER_ID` →
 * the config, or `null` when no tier carries one.
 *
 * `null` is a RESULT, not a failure: an account reached directly has no manager, and
 * conventions.md says to omit the header entirely for it. So this never prompts and
 * never blocks — the only way it throws is a value that was supplied but malformed.
 * If the API later rejects the call for want of a manager, {@link managerRequiredHint}
 * is what names the field to set.
 */
export function resolveOptionalMccCustomerId(
  flag: string | null | undefined,
  env: Record<string, string | undefined>,
  config: AdkitConfig,
  configPathText: string,
): CustomerId | null {
  return firstParsed([
    ["--manager", flag],
    ["GOOGLE_ADS_LOGIN_CUSTOMER_ID", env["GOOGLE_ADS_LOGIN_CUSTOMER_ID"]],
    [`mcc_customer_id in ${configPathText}`, config.mcc_customer_id],
  ]);
}

/**
 * Guidance for an API rejection that means "this leaf is only reachable through a
 * manager account" — the one case where an absent `mcc_customer_id` is the cause
 * rather than the correct answer. Names the field so the fix is not a guess.
 */
export function managerRequiredHint(configPathText: string): string {
  return (
    "the account appears to be reachable only through a manager (MCC) account. " +
    `Set mcc_customer_id in ${configPathText} to the manager's 10-digit id ` +
    "(or pass --manager <mcc-id>). Leave it unset only for a directly-accessible account."
  );
}
