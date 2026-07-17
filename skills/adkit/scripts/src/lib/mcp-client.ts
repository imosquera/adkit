/**
 * google-ads-mcp read-client seam.
 *
 * The official google-ads-mcp server exposes a `search` tool that takes decomposed
 * params (`customer_id`, `resource`, `fields[]`, `conditions[]`, `orderings[]`,
 * `limit`) and assembles + runs the GAQL itself — which is exactly the shape our
 * {@link SearchArgs} builders already emit. This module is the seam that will drive
 * that tool once the MCP runtime is wired.
 *
 * SCOPE (issue #11): this change ships the offline-verifiable foundation. The pure
 * mapping {@link toMcpSearchParams} (SearchArgs → the MCP `search` tool's params) is
 * implemented and unit-testable here; the LIVE transport (spawning the Python
 * google-ads-mcp server over stdio and round-tripping the MCP protocol) is
 * deliberately deferred — it requires a live Google Ads account + the `pipx`-run
 * server + credentials, none of which are available offline. {@link createMcpReadClient}
 * therefore returns a client whose reads throw a descriptive "not configured" error
 * until the transport is wired, so selecting the MCP backend fails loudly rather than
 * silently, and the default SDK path is never affected.
 */

import type { AdsClient, GaqlRow } from "./auth.js";
import type { SearchArgs } from "../gaql/search-args.js";

/** The `search` tool's parameter object, per the google-ads-mcp tool signature. */
export interface McpSearchParams {
  readonly customer_id: string;
  readonly resource: string;
  readonly fields: readonly string[];
  readonly conditions: readonly string[];
  readonly orderings: readonly string[];
  readonly limit?: number;
}

/**
 * Map a {@link SearchArgs} to the google-ads-mcp `search` tool's params for
 * `customerId`. Pure: no defaults are guessed and no fields are invented (the tool
 * treats field-guessing as an error), so the decomposed args pass through verbatim,
 * with absent `orderings` normalized to `[]` and `limit` preserved as optional.
 */
export function toMcpSearchParams(customerId: string, args: SearchArgs): McpSearchParams {
  return {
    customer_id: customerId,
    resource: args.resource,
    fields: args.fields,
    conditions: args.conditions,
    orderings: args.orderings ?? [],
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
  };
}

/** Error thrown when the MCP backend is selected but its runtime is not yet wired. */
export class McpNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpNotConfiguredError";
  }
}

/**
 * The read surface of the google-ads-mcp backend: only the structured read path
 * maps to the MCP `search` tool. Raw-GAQL `search` and `mutate` are intentionally
 * absent — mutations and the raw probe stay on the SDK (issue #11).
 */
export type McpAdsClient = Pick<AdsClient, "searchStructured">;

const NOT_WIRED =
  "google-ads-mcp read backend selected (ADKIT_READ_BACKEND=mcp) but its transport " +
  "is not wired yet. The live MCP round-trip (pipx-run Python server over stdio + " +
  "credentials) is a deferred follow-up; see specs/011-migrate-reads-google-ads-mcp. " +
  "Unset ADKIT_READ_BACKEND (or set it to 'sdk') to use the SDK read backend.";

/**
 * Build the MCP read client. Until the live transport is wired, its reads throw
 * {@link McpNotConfiguredError} — so selecting the MCP backend fails loudly and the
 * default SDK path is never silently degraded. The pure {@link toMcpSearchParams}
 * mapping the live client will use is exported and tested independently above.
 */
export function createMcpReadClient(): McpAdsClient {
  return {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async searchStructured<Row = GaqlRow>(_customerId: string, _args: SearchArgs): Promise<Row[]> {
      throw new McpNotConfiguredError(NOT_WIRED);
    },
  };
}
