/**
 * IO entry: `ads.sh audiences` — list / create-custom-intent / upload-customer-match.
 *
 * `list` and `create-custom-intent` go through the shared {@link AdsClient}
 * search/mutate abstraction (`loadClient`), matching every other adkit
 * entrypoint. `upload-customer-match` drives the Google Ads
 * `OfflineUserDataJobService` (create job -> add operations -> run job), an
 * RPC shape the search/mutate abstraction doesn't cover — mirroring
 * `keyword-ideas.ts`'s precedent of talking to the SDK directly for an RPC
 * outside that abstraction, injectable for testing (no live network in tests).
 *
 * Every plaintext customer-match identifier is hashed via `lib/hash.ts`
 * immediately upon being read from the CSV row and is never stored, logged, or
 * placed in any request field other than `hashed_email`/`hashed_phone_number`.
 *
 * Usage:
 *   ads.sh audiences list [--customer <id>]
 *   ads.sh audiences create-custom-intent [--customer <id>] --keywords <csv> --urls <csv>
 *   ads.sh audiences upload-customer-match [--customer <id>] --file <path.csv> --list-name <name>
 */

import { readFileSync } from "node:fs";
import { GoogleAdsApi } from "google-ads-api";
import { parse as parseYaml } from "yaml";
import { isMainModule } from "../cli/entry.js";
import { resolveCustomer } from "../cli/args.js";
import { emitJson, errorEnvelope, ok, sdkErrorMessage } from "../cli/output.js";
import { credentialsPath, loadClient, type AdsClient } from "../lib/auth.js";
import { hashEmail, hashPhone, type Sha256Hex } from "../lib/hash.js";

// ---------------------------------------------------------------------------
// `list` — enumerate available audience segments (FR-001).
// ---------------------------------------------------------------------------

/** One row of `audiences list` output. */
export interface AudienceListRow {
  id: number;
  name: string;
  type: "user-list" | "custom-audience" | "combined-audience" | "audience";
}

const AUDIENCE_LIST_TABLES: ReadonlyArray<{ type: AudienceListRow["type"]; table: string }> = [
  { type: "user-list", table: "user_list" },
  { type: "custom-audience", table: "custom_audience" },
  { type: "combined-audience", table: "combined_audience" },
  { type: "audience", table: "audience" },
];

/**
 * List every audience segment (in-market/affinity via `custom_audience`,
 * custom-intent via `custom_audience`/`combined_audience`, user-list/
 * remarketing/customer-match via `user_list`, plus the newer unified
 * `audience` resource) available on `customerId`. An account with none
 * returns a valid empty array (spec Edge Cases), never an error.
 */
export async function listAudiences(client: AdsClient, customerId: string): Promise<AudienceListRow[]> {
  const rows: AudienceListRow[] = [];
  for (const { type, table } of AUDIENCE_LIST_TABLES) {
    const query = `SELECT ${table}.id, ${table}.name FROM ${table} WHERE ${table}.id > 0`;
    const result = await client.search<Record<string, { id: number; name: string }>>(customerId, query);
    for (const row of result) {
      const entry = row[table];
      if (entry) {
        rows.push({ id: entry.id, name: entry.name, type });
      }
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// `create-custom-intent` — custom-intent/custom-segment audience from
// keyword/URL seeds (FR-002). Both seed kinds accepted together in one call
// (Clarifications session).
// ---------------------------------------------------------------------------

export interface CreateCustomIntentArgs {
  readonly customerId: string | null;
  readonly name: string | null;
  readonly keywords: readonly string[];
  readonly urls: readonly string[];
}

/**
 * Create a custom-intent audience (Google's `CustomAudience` resource, member
 * type `KEYWORD` and/or `URL`) from the given seeds. Returns the created
 * resource name.
 */
export async function createCustomIntentAudience(
  client: AdsClient,
  customerId: string,
  name: string,
  keywords: readonly string[],
  urls: readonly string[],
): Promise<string> {
  const members = [
    ...keywords.map((k) => ({ keyword: k })),
    ...urls.map((u) => ({ url: u })),
  ];
  const op = {
    entity: "custom_audience",
    operation: "create" as const,
    resource: {
      name,
      type: "AUTO", // Google infers INTEREST vs PURCHASE_INTENT from the seed mix.
      members,
    },
  };
  const result = await client.mutate(customerId, [op]);
  return result.results[0]!.resource_name;
}

// ---------------------------------------------------------------------------
// `upload-customer-match` — SHA-256-hash and upload a customer-match list
// (FR-003). Never sends plaintext.
// ---------------------------------------------------------------------------

/**
 * One successfully-parsed, already-hashed row ready to upload. Both fields
 * are `Sha256Hex` (the branded type from `lib/hash.ts`), not a bare `string`
 * — this is what actually prevents an unhashed CSV cell from being assigned
 * here undetected; only `hashEmail`/`hashPhone` can produce a value of this
 * type.
 */
export interface HashedIdentifier {
  hashedEmail?: Sha256Hex;
  hashedPhone?: Sha256Hex;
}

/** The result of parsing one CSV row: either a hashed identifier, or a skip reason. */
export type CustomerMatchRowResult =
  | { ok: true; value: HashedIdentifier }
  | { ok: false; reason: string };

/**
 * Parse + hash one customer-match CSV row (`{ email?, phone? }` columns,
 * either may be blank). Hashes immediately (destructure-and-hash) so the
 * plaintext value never survives past this function's stack frame. A row with
 * neither column populated is a skip, not a crash.
 */
export function parseCustomerMatchRow(row: Record<string, string | undefined>): CustomerMatchRowResult {
  const email = row.email?.trim();
  const phone = row.phone?.trim();
  if (!email && !phone) {
    return { ok: false, reason: "row has neither email nor phone" };
  }
  const value: HashedIdentifier = {
    ...(email ? { hashedEmail: hashEmail(email) } : {}),
    ...(phone ? { hashedPhone: hashPhone(phone) } : {}),
  };
  return { ok: true, value };
}

/** A minimal, dependency-free CSV parser for the two-column (email, phone) shape this command accepts. */
export function parseCustomerMatchCsv(csvText: string): Array<Record<string, string | undefined>> {
  const lines = csvText.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) {
    return [];
  }
  const header = lines[0]!.split(",").map((h) => h.trim().toLowerCase());
  return lines.slice(1).map((line) => {
    const cells = line.split(",").map((c) => c.trim());
    return Object.fromEntries(header.map((h, i) => [h, cells[i]]));
  });
}

/** Outcome of a customer-match upload. */
export interface UploadCustomerMatchResult {
  uploaded: number;
  skipped: number;
  skipReasons: string[];
}

/** Injectable job-runner — the OfflineUserDataJobService RPC sequence, isolated for testing. */
export type RunOfflineUserDataJob = (
  customerId: string,
  listName: string,
  identifiers: readonly HashedIdentifier[],
) => Promise<void>;

/**
 * Hash + upload a customer-match CSV. Rejects pre-flight (zero network calls)
 * if no row survives parsing (spec Edge Cases: "The upload is rejected before
 * any request is sent"). Never includes a plaintext identifier in any request,
 * log line, or return value — only `uploaded`/`skipped` counts and skip
 * reasons are surfaced.
 */
export async function uploadCustomerMatch(
  csvText: string,
  customerId: string,
  listName: string,
  runJob: RunOfflineUserDataJob,
): Promise<UploadCustomerMatchResult> {
  const rows = parseCustomerMatchCsv(csvText).map(parseCustomerMatchRow);
  const identifiers = rows.flatMap((r) => (r.ok ? [r.value] : []));
  const skipReasons = rows.flatMap((r) => (r.ok ? [] : [r.reason]));
  if (identifiers.length === 0) {
    throw new Error(
      `no valid rows to upload (${skipReasons.length} row(s) skipped: ${skipReasons.join("; ") || "no rows"})`,
    );
  }
  await runJob(customerId, listName, identifiers);
  return { uploaded: identifiers.length, skipped: skipReasons.length, skipReasons };
}

/**
 * The real `RunOfflineUserDataJob` — drives `OfflineUserDataJobService`:
 * create a CUSTOMER_MATCH_USER_LIST job, add one operation per hashed
 * identifier, then run the job. Builds its own `Customer` from
 * google-ads.yaml (like keyword-ideas.ts) since this RPC sequence is outside
 * the shared search/mutate `AdsClient` abstraction.
 *
 * NEEDS A REAL-CREDENTIALS SMOKE TEST before production use: the
 * `sdkCustomer.offlineUserDataJobs.{create,addOperations,run}` shape below is
 * cast from the SDK's `Customer` type (`as unknown as {...}`) because this
 * sandboxed environment has no installed `google-ads-api` type definitions to
 * verify the exact method/field names against. If the real SDK surface
 * differs, this fails loudly (a `TypeError` on the first call, caught by
 * `main`'s try/catch and surfaced as an error envelope) rather than silently
 * sending a wrong-shaped request — but it has zero test coverage against the
 * actual SDK, unlike every other SDK-touching path in this codebase. Confirm
 * against a real account before relying on this in production.
 */
export async function runOfflineUserDataJobViaSdk(
  customerId: string,
  listName: string,
  identifiers: readonly HashedIdentifier[],
): Promise<void> {
  interface AdsYaml {
    developer_token?: string;
    client_id?: string;
    client_secret?: string;
    refresh_token?: string;
    login_customer_id?: string | number;
  }
  const creds = (parseYaml(readFileSync(credentialsPath(), "utf8")) as AdsYaml | null) ?? {};
  const api = new GoogleAdsApi({
    client_id: creds.client_id ?? "",
    client_secret: creds.client_secret ?? "",
    developer_token: creds.developer_token ?? "",
  });
  const customer = api.Customer({
    customer_id: customerId,
    refresh_token: creds.refresh_token ?? "",
    ...(creds.login_customer_id !== undefined ? { login_customer_id: String(creds.login_customer_id) } : {}),
  });
  const sdkCustomer = customer as unknown as {
    offlineUserDataJobs: {
      create(request: Record<string, unknown>): Promise<{ resource_name: string }>;
      addOperations(request: Record<string, unknown>): Promise<unknown>;
      run(request: Record<string, unknown>): Promise<unknown>;
    };
  };
  const job = await sdkCustomer.offlineUserDataJobs.create({
    customer_id: customerId,
    job: {
      type: "CUSTOMER_MATCH_USER_LIST",
      customer_match_user_list_metadata: { user_list: listName },
    },
  });
  await sdkCustomer.offlineUserDataJobs.addOperations({
    resource_name: job.resource_name,
    operations: identifiers.map((id) => ({
      create: {
        user_identifiers: [
          ...(id.hashedEmail ? [{ hashed_email: id.hashedEmail }] : []),
          ...(id.hashedPhone ? [{ hashed_phone_number: id.hashedPhone }] : []),
        ],
      },
    })),
  });
  await sdkCustomer.offlineUserDataJobs.run({ resource_name: job.resource_name });
}

// ---------------------------------------------------------------------------
// CLI wiring
// ---------------------------------------------------------------------------

export interface AudiencesArgs {
  readonly subcommand: "list" | "create-custom-intent" | "upload-customer-match" | null;
  readonly customerId: string | null;
  readonly name: string | null;
  readonly keywords: readonly string[];
  readonly urls: readonly string[];
  readonly file: string | null;
  readonly listName: string | null;
}

function splitCsvArg(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/** Parse argv into {@link AudiencesArgs}. Pure over its input array. */
export function parseArgs(argv: readonly string[]): AudiencesArgs {
  const subcommand = (argv[0] as AudiencesArgs["subcommand"]) ?? null;
  let customerId: string | null = process.env["GOOGLE_ADS_CUSTOMER_ID"] ?? null;
  let name: string | null = null;
  let keywords: string[] = [];
  let urls: string[] = [];
  let file: string | null = null;
  let listName: string | null = null;

  for (let i = 1; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--customer":
        customerId = value ?? customerId;
        i += 1;
        break;
      case "--name":
        name = value ?? name;
        i += 1;
        break;
      case "--keywords":
        keywords = splitCsvArg(value);
        i += 1;
        break;
      case "--urls":
        urls = splitCsvArg(value);
        i += 1;
        break;
      case "--file":
        file = value ?? file;
        i += 1;
        break;
      case "--list-name":
        listName = value ?? listName;
        i += 1;
        break;
      default:
        break;
    }
  }
  return { subcommand, customerId, name, keywords, urls, file, listName };
}

/** Entry point. Returns the process exit code (2 on bad args, 1 on SDK error, 0 on success). */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  const customerId = resolveCustomer([args.customerId]);
  if (!customerId) {
    emitJson(errorEnvelope("--customer, GOOGLE_ADS_CUSTOMER_ID, or login_customer_id in google-ads.yaml required"));
    return 2;
  }

  if (args.subcommand === "list") {
    try {
      const rows = await listAudiences(loadClient(), customerId);
      emitJson(ok({ audiences: rows }));
      return 0;
    } catch (exc) {
      emitJson(errorEnvelope(`google-ads error: ${sdkErrorMessage(exc)}`));
      return 1;
    }
  }

  if (args.subcommand === "create-custom-intent") {
    if (!args.name || (args.keywords.length === 0 && args.urls.length === 0)) {
      emitJson(errorEnvelope("--name and at least one of --keywords/--urls required"));
      return 2;
    }
    try {
      const resourceName = await createCustomIntentAudience(
        loadClient(),
        customerId,
        args.name,
        args.keywords,
        args.urls,
      );
      emitJson(ok({ resourceName }));
      return 0;
    } catch (exc) {
      emitJson(errorEnvelope(`google-ads error: ${sdkErrorMessage(exc)}`));
      return 1;
    }
  }

  if (args.subcommand === "upload-customer-match") {
    if (!args.file || !args.listName) {
      emitJson(errorEnvelope("--file and --list-name required"));
      return 2;
    }
    try {
      const csvText = readFileSync(args.file, "utf8");
      const result = await uploadCustomerMatch(csvText, customerId, args.listName, runOfflineUserDataJobViaSdk);
      emitJson(ok({ ...result }));
      return 0;
    } catch (exc) {
      emitJson(errorEnvelope(exc instanceof Error ? exc.message : String(exc)));
      return 1;
    }
  }

  emitJson(errorEnvelope("usage: ads.sh audiences <list|create-custom-intent|upload-customer-match> [flags]"));
  return 2;
}

if (isMainModule(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((exc) => {
      emitJson(errorEnvelope(String((exc as { message?: unknown })?.message ?? exc)));
      process.exitCode = 1;
    });
}
