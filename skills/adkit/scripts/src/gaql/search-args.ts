/**
 * Structured, decomposed representation of a Google Ads read query.
 *
 * The official google-ads-mcp `search` tool does NOT accept a raw GAQL string; it
 * takes decomposed `fields[] / resource / conditions[] / orderings[] / limit` and
 * assembles the GAQL itself. To migrate our reads onto that tool without losing the
 * SDK path (which still consumes a GAQL string), every query builder emits a
 * {@link SearchArgs} — the single source of truth — and {@link toGaql} derives the
 * exact string the SDK backend still runs. A parsed value is a proof: once a builder
 * returns a `SearchArgs`, callers never re-check its parts.
 */

/** A decomposed Google Ads read query: `SELECT fields FROM resource WHERE … ORDER BY … LIMIT …`. */
export interface SearchArgs {
  /** FROM resource, e.g. `campaign`, `keyword_view`, `ad_group_criterion`. */
  readonly resource: string;
  /** SELECT field paths, e.g. `campaign.id`, `metrics.clicks`. */
  readonly fields: readonly string[];
  /** WHERE predicates, AND-joined. Ids interpolated here must already be `gaqlId()`-guarded. */
  readonly conditions: readonly string[];
  /** ORDER BY expressions, comma-joined. Omitted from the query when empty/absent. */
  readonly orderings?: readonly string[];
  /** LIMIT n. Omitted from the query when absent. */
  readonly limit?: number;
}

/**
 * Serialize a {@link SearchArgs} to a GAQL string — a pure domain-type → string
 * transform, not a parser (it adds no validation). Assembles
 * `SELECT {fields} FROM {resource}` and appends the `WHERE` / `ORDER BY` / `LIMIT`
 * clauses only when their inputs are present, reproducing the strings the builders
 * emitted before the structured refactor.
 */
export function toGaql(args: SearchArgs): string {
  const where = args.conditions.length > 0 ? ` WHERE ${args.conditions.join(" AND ")}` : "";
  const orderBy =
    args.orderings && args.orderings.length > 0 ? ` ORDER BY ${args.orderings.join(", ")}` : "";
  const limit = args.limit !== undefined ? ` LIMIT ${args.limit}` : "";
  return `SELECT ${args.fields.join(", ")} FROM ${args.resource}${where}${orderBy}${limit}`;
}
