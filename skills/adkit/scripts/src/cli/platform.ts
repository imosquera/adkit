/**
 * Which ad platform a command runs against (plan D1).
 *
 * Every Google bin resolves the platform first and, for `meta`, delegates to the
 * matching `src/meta/bin/*` module with {@link stripPlatformFlag}'d argv. The
 * tiers are `--platform` / `--platform=` > `ADKIT_PLATFORM` > `adkit.yaml
 * platform` > `google`, so an unconfigured project keeps today's Google
 * behaviour.
 */

import { errorEnvelope } from "./output.js";

/** The ad platforms adkit can drive. */
export type Platform = "google" | "meta";

/** Local copy of the parser result shape (`src/meta/ids.ts` owns the shared one). */
export type Result<T> = { kind: "ok"; value: T } | { kind: "err"; message: string };

/** A platform value that failed to parse; `step` feeds the error envelope. */
export class PlatformError extends Error {
  readonly step = "platform" as const;

  constructor(message: string) {
    super(message);
    this.name = "PlatformError";
  }
}

const PLATFORMS: readonly Platform[] = ["google", "meta"];

const isPlatform = (text: string): text is Platform => (PLATFORMS as readonly string[]).includes(text);

/**
 * Parse an untrusted platform value. `undefined`/`null`/blank → `google`;
 * `google`/`meta` (surrounding whitespace ignored) → itself; anything else is
 * an error naming `source` (e.g. `--platform`, `ADKIT_PLATFORM`, `adkit.yaml`).
 */
export function parsePlatform(raw: unknown, source: string): Result<Platform> {
  if (raw === undefined || raw === null) {
    return { kind: "ok", value: "google" };
  }
  if (typeof raw !== "string") {
    return { kind: "err", message: `${source}: platform must be "google" or "meta", got ${JSON.stringify(raw)}` };
  }
  const text = raw.trim();
  if (text === "") {
    return { kind: "ok", value: "google" };
  }
  return isPlatform(text)
    ? { kind: "ok", value: text }
    : { kind: "err", message: `${source}: unknown platform ${JSON.stringify(text)} (expected "google" or "meta")` };
}

const FLAG = "--platform";
const FLAG_EQ = `${FLAG}=`;

/**
 * The raw `--platform` value from argv: the first `--platform <v>` or
 * `--platform=<v>`; `undefined` when the flag is absent. A bare trailing
 * `--platform` yields `""` so the caller can report the missing value.
 */
function platformFlagValue(argv: readonly string[]): string | undefined {
  const index = argv.findIndex((arg) => arg === FLAG || arg.startsWith(FLAG_EQ));
  if (index === -1) {
    return undefined;
  }
  const arg = argv[index] ?? "";
  return arg === FLAG ? (argv[index + 1] ?? "") : arg.slice(FLAG_EQ.length);
}

const isBlank = (value: string | undefined): boolean => value === undefined || value.trim() === "";

/**
 * Resolve the platform for a run. Throws {@link PlatformError} when the
 * `--platform` flag is given without a value or the winning tier holds an
 * unknown platform.
 *
 * Tier selection is done here rather than through `resolveTier` because the
 * error must name the tier the bad value came from, which `resolveTier` does
 * not report.
 */
export function resolvePlatform(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  config: { platform?: string },
): Platform {
  const flag = platformFlagValue(argv);
  if (flag !== undefined && isBlank(flag)) {
    throw new PlatformError(`${FLAG} requires a value ("google" or "meta")`);
  }
  const tiers: readonly { source: string; value: string | undefined }[] = [
    { source: FLAG, value: flag },
    { source: "ADKIT_PLATFORM", value: env.ADKIT_PLATFORM },
    { source: "adkit.yaml platform", value: config.platform },
  ];
  const winner = tiers.find((tier) => !isBlank(tier.value));
  const parsed = winner === undefined ? parsePlatform(undefined, "default") : parsePlatform(winner.value, winner.source);
  if (parsed.kind === "err") {
    throw new PlatformError(parsed.message);
  }
  return parsed.value;
}

/**
 * `argv` without any `--platform <v>` / `--platform=<v>` occurrences, so a
 * delegated Meta bin sees only its own flags.
 */
export function stripPlatformFlag(argv: readonly string[]): string[] {
  return argv.reduce<{ kept: readonly string[]; skipNext: boolean }>(
    (state, arg) =>
      state.skipNext
        ? { kept: state.kept, skipNext: false }
        : arg === FLAG
          ? { kept: state.kept, skipNext: true }
          : arg.startsWith(FLAG_EQ)
            ? state
            : { kept: [...state.kept, arg], skipNext: false },
    { kept: [], skipNext: false },
  ).kept.slice();
}

/** {@link resolvePlatform} as a `Result`, for callers that branch instead of catching. */
export function platformResult(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  config: { platform?: string },
): Result<Platform> {
  try {
    return { kind: "ok", value: resolvePlatform(argv, env, config) };
  } catch (exc) {
    if (exc instanceof PlatformError) {
      return { kind: "err", message: exc.message };
    }
    throw exc;
  }
}

/**
 * The failure envelope that stops a Google-only `command` before any work (plan
 * D10), or `null` when the resolved platform is `google`. A Meta run is refused
 * because Meta has no Keyword Planner; an unparseable platform value is refused
 * the same way, naming the offending tier. Pure over its inputs.
 */
export function googleOnlyRefusal(
  command: string,
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  config: { platform?: string },
): ReturnType<typeof errorEnvelope> | null {
  const platform = platformResult(argv, env, config);
  return platform.kind === "err"
    ? errorEnvelope(platform.message, { step: "platform" })
    : platform.value === "meta"
      ? errorEnvelope(`${command} is Google-only; Meta has no keyword planner equivalent`, { step: "platform" })
      : null;
}
