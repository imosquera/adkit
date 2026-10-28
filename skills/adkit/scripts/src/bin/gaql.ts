/**
 * IO entry: `ads.sh gaql "<SELECT ...>" [--customer ID] [--manager ID]` — run one
 * ad-hoc GAQL query and print the rows as a JSON array on stdout. Errors are an
 * `ok:false` envelope on stdout with exit 1.
 */

import { parseArgs } from "node:util";
import { mccHeaderValue, type MccCustomerId, resolveMccCustomerId } from "../cli/args.js";
import { customerIdErrorEnvelope, resolveTargetCustomerId } from "../cli/customer-id.js";
import { isMainModule } from "../cli/entry.js";
import { emitJson, errorEnvelope, sdkErrorMessage } from "../cli/output.js";
import type { AdsClient, GaqlRow } from "../lib/auth.js";
import { loadReadClient } from "../lib/mcp-client.js";

export interface QueryFlags {
  customer?: string | undefined;
  manager?: string | undefined;
}

/** Resolve the account + client and run `query`; on failure emit the error envelope and return null. */
export async function runQuery(
  query: string,
  flags: QueryFlags,
  clientFactory: (login: MccCustomerId) => AdsClient = loadReadClient,
  env: Record<string, string | undefined> = process.env,
): Promise<GaqlRow[] | null> {
  let customer: string;
  try {
    customer = await resolveTargetCustomerId(flags.customer, env);
  } catch (exc) {
    emitJson(customerIdErrorEnvelope(exc));
    return null;
  }
  try {
    const client = clientFactory(mccHeaderValue(resolveMccCustomerId(flags.manager, env)));
    return await client.search(customer, query);
  } catch (exc) {
    emitJson(errorEnvelope(sdkErrorMessage(exc), { customer }));
    return null;
  }
}

export async function main(argv: string[], clientFactory?: (login: MccCustomerId) => AdsClient): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { customer: { type: "string" }, manager: { type: "string" } },
  });
  const query = positionals.join(" ").trim();
  if (!query) {
    emitJson(errorEnvelope('usage: ads.sh gaql "SELECT ... FROM ..." [--customer ID] [--manager ID]'));
    return 1;
  }
  const rows = await runQuery(query, values, clientFactory);
  if (rows === null) {
    return 1;
  }
  emitJson(rows);
  return 0;
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((exc) => {
      emitJson(errorEnvelope(String((exc as { message?: unknown })?.message ?? exc)));
      process.exit(1);
    });
}
