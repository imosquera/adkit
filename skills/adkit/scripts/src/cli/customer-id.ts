/**
 * The live IO wiring for {@link "../lib/customer-id.js".requireTargetCustomerId}.
 *
 * `lib/customer-id.ts` holds the whole decision tree as a pure function over
 * injected effects; this is the one place those effects are bound to the real
 * terminal, the real `.adkit.yaml`, and the real stderr. Entrypoints call
 * {@link resolveTargetCustomerId} and never assemble the deps themselves.
 */

import { createInterface } from "node:readline";
import { errorEnvelope } from "./output.js";
import { configPath, loadConfig, writeConfigField } from "../lib/config.js";
import {
  type CustomerId,
  InvalidCustomerIdError,
  MissingTargetCustomerIdError,
  requireTargetCustomerId,
  resolveOptionalMccCustomerId,
} from "../lib/customer-id.js";

/**
 * Ask one question on the terminal and resolve with the typed line.
 *
 * Only ever reached on a TTY (the caller checks first), so the piped-stdin hazard
 * `init.ts` documents — a second `question()` never getting a callback once a
 * single chunk has been consumed — cannot arise here: this asks exactly once.
 */
function askOnTerminal(text: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(text, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * Resolve the leaf account id for an entrypoint: flag → `GOOGLE_ADS_CUSTOMER_ID` →
 * `.adkit.yaml` → prompt-and-persist on a TTY, throwing otherwise.
 *
 * Throws `MissingTargetCustomerIdError` / `InvalidCustomerIdError`; the caller
 * turns either into the standard `ok:false` envelope. `env` and `isTty` are
 * injectable so tests drive the no-TTY branch without a pseudo-terminal.
 */
export function resolveTargetCustomerId(
  flag: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
  isTty: boolean = process.stdin.isTTY === true,
): Promise<CustomerId> {
  return requireTargetCustomerId({
    flag,
    env,
    config: loadConfig(),
    configPath: configPath(),
    isTty,
    prompt: askOnTerminal,
    // The read-only-command-writes-config trade is documented at the lib call site.
    persist: (id) => writeConfigField("target_customer_id", id),
    // stderr, not stdout: stdout carries the JSON envelope the skills parse.
    notify: (line) => process.stderr.write(line),
  });
}

/**
 * The manager login header for an entrypoint, or `null` when there is none.
 * Never prompts, never blocks — absent means "directly-accessible account".
 */
export function resolveMccCustomerIdOrNull(
  flag: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): CustomerId | null {
  return resolveOptionalMccCustomerId(flag, env, loadConfig(), configPath());
}

/**
 * Turn a customer-id failure into the standard `ok:false` envelope, so every
 * entrypoint reports a missing or malformed id identically. Both error types carry
 * their own `step`; anything else is rethrown rather than swallowed into a
 * misleading customer-id failure.
 */
export function customerIdErrorEnvelope(exc: unknown): ReturnType<typeof errorEnvelope> {
  if (exc instanceof MissingTargetCustomerIdError) {
    return errorEnvelope(exc.message, { step: exc.step, field: exc.field, config_path: exc.configPath });
  }
  if (exc instanceof InvalidCustomerIdError) {
    return errorEnvelope(exc.message, { step: exc.step });
  }
  throw exc;
}
