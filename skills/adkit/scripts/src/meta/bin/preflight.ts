/**
 * Meta preflight: verify the token, the ad account and the token's permissions
 * before any Meta command runs (plan D9).
 *
 * The Meta counterpart of `bin/preflight.ts`, reached through its `--platform meta`
 * delegation (plan D1) or run directly. Steps, in order, each a named `step` in the
 * `{ ok: false, message, step }` envelope when it fails:
 *
 * 1. `credentials` — token + ad account resolved ({@link resolveMetaContext}). A
 *    {@link MetaConfigError} keeps its own step (`credentials` for the token,
 *    `ad-account` for the account, `config` for a malformed page/pixel id), the
 *    same steps every other Meta command reports.
 * 2. `auth` — `GET me?fields=id,name`: the token is valid.
 * 3. `access` — `GET act_<id>?fields=name,account_status,currency,disable_reason`:
 *    the token can see the account and it is active (`account_status` 1).
 * 4. `permissions` — `GET me/permissions`: `ads_read` and `ads_management` granted.
 *
 * Success emits `{ ok: true, platform: "meta", adAccountId, accountName, currency }`.
 * Exit code 0 on success, 1 on any failed step. stdout carries only the envelope.
 *
 * The client is built from the resolved context exactly the way the Meta commands
 * build theirs — preflight is their precondition, so it must check the same thing.
 */

import { parseArgs } from "node:util";

import { isMainModule } from "../../cli/entry.js";
import { emitJson, errorEnvelope, ok } from "../../cli/output.js";
import { createMetaClient, type MetaClient } from "../client.js";
import { resolveMetaContextFromProcess, type MetaContext, type MetaContextFlags } from "../config.js";
import { MetaApiError, MetaConfigError, formatMetaError } from "../errors.js";
import { AdAccountSchema, MeSchema, PermissionSchema, type AdAccount, type Permission } from "../graph.js";

/** The permissions every Meta command needs; preflight names whichever are missing. */
export const REQUIRED_PERMISSIONS = ["ads_read", "ads_management"] as const;

/** Meta's documented `account_status` values (AdAccount reference). 1 is the only usable one. */
const ACCOUNT_STATUS_NAMES: Readonly<Record<number, string>> = {
  1: "ACTIVE",
  2: "DISABLED",
  3: "UNSETTLED",
  7: "PENDING_RISK_REVIEW",
  8: "PENDING_SETTLEMENT",
  9: "IN_GRACE_PERIOD",
  100: "PENDING_CLOSURE",
  101: "CLOSED",
  201: "ANY_ACTIVE",
  202: "ANY_CLOSED",
};

/** Injected effects: how the context is resolved and how the client is built from it. */
export interface PreflightDeps {
  readonly clientFactory: (ctx: MetaContext) => MetaClient;
  readonly resolveContext: (flags: MetaContextFlags) => Promise<MetaContext>;
}

/** The client every Meta command builds: token plus `appsecret_proof` when an app secret is set. */
export const defaultClientFactory = (ctx: MetaContext): MetaClient =>
  createMetaClient({ token: ctx.token, appSecret: ctx.appSecret ?? undefined });

/** Parse preflight's one flag. Pure over its input array. */
export function parsePreflightArgs(argv: readonly string[]): MetaContextFlags {
  const { values } = parseArgs({
    args: [...argv],
    options: { "ad-account": { type: "string" } },
    allowPositionals: true,
    strict: false,
  });
  const raw = values["ad-account"];
  return { adAccount: typeof raw === "string" ? raw : null };
}

/** `ACTIVE (1)`-style label for an `account_status`, `status 42` when undocumented. Pure. */
export const describeAccountStatus = (status: number): string =>
  ACCOUNT_STATUS_NAMES[status] === undefined ? `status ${status}` : `${ACCOUNT_STATUS_NAMES[status]} (${status})`;

/** The failure message for an unusable account, or `null` when `account_status` is 1. Pure. */
export const accountStatusProblem = (account: AdAccount): string | null =>
  account.account_status === 1
    ? null
    : `ad account ${account.id} (${account.name}) is not active: account_status ${describeAccountStatus(account.account_status)}` +
      (account.disable_reason === undefined || account.disable_reason === 0 ? "" : `, disable_reason ${account.disable_reason}`) +
      ". Resolve it in Meta Ads Manager before running any command.";

/** Required permissions not currently `granted`, in {@link REQUIRED_PERMISSIONS} order. Pure. */
export const missingPermissions = (granted: readonly Permission[]): readonly string[] =>
  REQUIRED_PERMISSIONS.filter((name) => !granted.some((p) => p.permission === name && p.status === "granted"));

/** A step failure: the envelope `step` plus the human message. */
interface StepFailure {
  readonly step: string;
  readonly message: string;
}

/** Map a throwable from `step` to its envelope fields; Meta errors keep their own step. Pure. */
export const failureFrom = (exc: unknown, step: string): StepFailure => ({
  step: exc instanceof MetaApiError || exc instanceof MetaConfigError ? exc.step : step,
  message: formatMetaError(exc),
});

type StepResult<T> = { readonly kind: "ok"; readonly value: T } | { readonly kind: "err"; readonly failure: StepFailure };

/** Run one step's effect, turning a throw into a {@link StepFailure} labelled `step`. */
const runStep = async <T>(step: string, effect: () => Promise<T>): Promise<StepResult<T>> => {
  try {
    return { kind: "ok", value: await effect() };
  } catch (exc) {
    return { kind: "err", failure: failureFrom(exc, step) };
  }
};

const fail = (failure: StepFailure): number => {
  emitJson(errorEnvelope(failure.message, { step: failure.step }));
  return 1;
};

/**
 * Run the Meta preflight and emit the JSON envelope on stdout. Returns the process
 * exit code (0 on success, 1 on any failed step). `deps` is injectable so tests
 * drive every step without a terminal, config files or the network.
 */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  deps: Partial<PreflightDeps> = {},
): Promise<number> {
  const clientFactory = deps.clientFactory ?? defaultClientFactory;
  const resolveContext = deps.resolveContext ?? ((flags: MetaContextFlags) => resolveMetaContextFromProcess(flags, env));

  const ctx = await runStep("credentials", () => resolveContext(parsePreflightArgs(argv)));
  if (ctx.kind === "err") return fail(ctx.failure);
  const { adAccountId } = ctx.value;

  const client = await runStep("credentials", async () => clientFactory(ctx.value));
  if (client.kind === "err") return fail(client.failure);

  const me = await runStep("auth", () => client.value.get("me", { fields: ["id", "name"] }, MeSchema, { step: "auth" }));
  if (me.kind === "err") return fail(me.failure);

  const account = await runStep("access", () =>
    client.value.get(
      adAccountId,
      { fields: ["name", "account_status", "currency", "disable_reason"] },
      AdAccountSchema,
      { step: "access" },
    ),
  );
  if (account.kind === "err") return fail(account.failure);
  const statusProblem = accountStatusProblem(account.value);
  if (statusProblem !== null) return fail({ step: "access", message: statusProblem });

  const permissions = await runStep("permissions", () =>
    client.value.getAll("me/permissions", {}, PermissionSchema, { step: "permissions" }),
  );
  if (permissions.kind === "err") return fail(permissions.failure);
  const missing = missingPermissions(permissions.value);
  if (missing.length > 0) {
    return fail({
      step: "permissions",
      message:
        `the Meta access token is missing required permission(s): ${missing.join(", ")}. ` +
        "Generate a new token with ads_read and ads_management granted and update meta_access_token (run `ads.sh init`).",
    });
  }

  emitJson(ok({ platform: "meta", adAccountId, accountName: account.value.name, currency: account.value.currency }));
  return 0;
}

// Run as a CLI entrypoint when invoked directly (not through bin/preflight.ts).
if (isMainModule(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((exc: unknown) => {
      emitJson(errorEnvelope(formatMetaError(exc), { step: "unexpected" }));
      process.exitCode = 1;
    });
}
