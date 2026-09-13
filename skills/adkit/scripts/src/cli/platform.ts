/**
 * Which ad platform a command runs against (plan D1).
 *
 * The tiers are `--platform` / `--platform=` > `ADKIT_PLATFORM` > `adkit.yaml
 * platform` > `google`, so an unconfigured project keeps today's Google
 * behaviour. How each command uses the resolved platform:
 *
 * - `preflight`, `report`, `audit`, `create` and `apply-fixes` route through
 *   {@link routePlatform}: `meta` delegates to the matching `src/meta/bin/*`
 *   module (`apply-fixes` to `meta/bin/update`) with {@link stripPlatformFlag}'d
 *   argv.
 * - `research` and `keyword-ideas` refuse a Meta run via {@link googleOnlyRefusal}.
 * - `bootstrap-secrets` and `render-yaml` branch on the platform in place.
 */

import { emitJson, errorEnvelope } from "./output.js";

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

/** The entry point every `src/meta/bin/*` module exports. */
export type MetaMain = (argv: string[], env: NodeJS.ProcessEnv) => Promise<number>;

/** Lazily loads a Meta bin module, so a Google run never imports Meta code. */
export type MetaLoader = () => Promise<{ main: MetaMain }>;

/** Where a Google bin goes next: run its own Google path on `argv`, or exit with `code`. */
export type PlatformRoute = { kind: "google"; argv: string[] } | { kind: "exit"; code: number };

/**
 * Load and run a Meta bin on `argv` with `--platform` stripped, returning its exit
 * code. A throw escaping the Meta main (or its import) is unexpected — Meta bins
 * envelope their own failures — so it becomes a redacted `{ ok: false, step }`
 * envelope (step `unexpected` unless it is a Meta error carrying its own) and exit
 * 1, rather than falling into the calling Google bin's Google-specific handlers.
 */
export async function runMeta(argv: readonly string[], env: NodeJS.ProcessEnv, loadMeta: MetaLoader): Promise<number> {
  try {
    return await (await loadMeta()).main(stripPlatformFlag(argv), env);
  } catch (exc) {
    const { envelopeFailure } = await import("../meta/errors.js");
    const failure = envelopeFailure(exc, "unexpected");
    emitJson(errorEnvelope(failure.message, { step: failure.step }));
    return 1;
  }
}

/**
 * Resolve the platform for a Google bin (plan D1). An unparseable platform emits a
 * `step: "platform"` envelope and exits 1; `meta` — or `google` when
 * `declaresMeta(strippedArgv)` says the input itself is a Meta one (create's
 * `type: meta` brief) — runs the Meta bin via {@link runMeta} and exits with its
 * code; otherwise the Google path continues on the stripped argv.
 */
export async function routePlatform(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  config: { platform?: string },
  loadMeta: MetaLoader,
  declaresMeta: (strippedArgv: readonly string[]) => boolean = () => false,
): Promise<PlatformRoute> {
  const platform = platformResult(argv, env, config);
  if (platform.kind === "err") {
    emitJson(errorEnvelope(platform.message, { step: "platform" }));
    return { kind: "exit", code: 1 };
  }
  const stripped = stripPlatformFlag(argv);
  return platform.value === "meta" || declaresMeta(stripped)
    ? { kind: "exit", code: await runMeta(stripped, env, loadMeta) }
    : { kind: "google", argv: stripped };
}
