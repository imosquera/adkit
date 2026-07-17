# Feature Specification: Migrate read commands to the official google-ads-mcp server

**Feature Branch**: `011-migrate-reads-google-ads-mcp`

**Created**: 2026-07-17

**Status**: Draft

**Input**: User description: "Migrate all read operations against the Google Ads API from direct google-ads-api SDK calls to the official google-ads-mcp server; writes/mutations stay on the SDK. (Full context in GitHub issue #11.)"

## Clarifications

### Session 2026-07-17 (auto-answered by autopilot — see issue #11 comment)

Answered from issue #11's own "Open questions", repo context, and the conservative-
reversible-default rule. The user delegated these ("make assumptions").

- **Q: Embedded stdio MCP client vs long-running HTTP server for the deterministic bins?**
  **A: Embedded stdio, with the seam written transport-agnostic.** — Stdio is the
  MCP server's default transport and is self-contained (no separate process to
  manage/health-check); the `McpAdsClient` seam takes `SearchArgs` so an HTTP
  transport can be swapped in later without touching call-sites.
- **Q: Reuse the existing `google-ads.yaml` (MCP Python-client auth option) or move to ADC + `GOOGLE_PROJECT_ID`?**
  **A: Reuse `google-ads.yaml` where the MCP Python client allows it; document ADC as
  the alternative.** — Avoids forcing a credential-model migration into this change;
  keeps the existing refresh-token flow the repo already provisions
  (`bootstrap-secrets` / `render-yaml`).
- **Q: Is depending on both SDK and MCP inside `apply-fixes` worth it?**
  **A: Keep `apply-fixes` reads on the SDK for now, but adopt the structured
  builders.** — The bin already needs the SDK for mutations; routing its reads
  through the same structured `SearchArgs` builders makes a later cutover mechanical
  without adding a second live dependency prematurely.
- **Q (scope): Can the live migration phases be completed in this unattended run?**
  **A: No — deferred.** Phase 0 spike round-trips, Phase 3 parity, and Phase 4
  cutover require a live Google Ads test account + running Python MCP server, absent
  here. This change delivers the offline foundation only.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Query builders expose structured search args, not raw GAQL strings (Priority: P1)

An engineer working on any adkit read command finds that every query builder in
`skills/adkit/scripts/src/gaql/builders.ts` returns a typed, decomposed
`SearchArgs` value (`{ resource, fields, conditions, orderings?, limit? }`) instead
of an opaque GAQL string. A pure `toGaql(SearchArgs)` helper reconstructs the exact
GAQL string the SDK path still consumes, so the decomposition is the single source
of truth and the string form is derived from it.

**Why this priority**: The MCP `search` tool accepts decomposed
`fields[]/resource/conditions[]/orderings[]/limit`, not raw GAQL. Restructuring the
builders to emit `SearchArgs` is the keystone that every later phase depends on, and
it is fully implementable and testable offline (no live account, no MCP runtime).

**Independent Test**: Run the `skills/adkit/scripts` test suite; confirm each builder
returns a `SearchArgs` whose `toGaql()` output equals the GAQL string that builder
produced before this change (byte-for-byte for the fixed queries, structurally for
id-parameterized ones), and that `gaqlId()` digit-guarding still throws on non-digit
ids routed through `conditions`.

**Acceptance Scenarios**:

1. **Given** `auditSearchTermsQuery(14, ["12345","67890"])`, **When** it is called, **Then** it returns a `SearchArgs` with `resource: "search_term_view"`, the expected `fields`, and a `conditions` entry constraining `campaign.id IN (12345,67890)`, and `toGaql()` of it reproduces the prior string.
2. **Given** any builder that interpolates ids, **When** it is called with a non-digit id (e.g. `"4x"`), **Then** it still throws via `gaqlId()` (the guard moved into condition construction, not lost).
3. **Given** a `SearchArgs` value, **When** `toGaql(args)` is called, **Then** it assembles `SELECT {fields} FROM {resource} WHERE {conditions AND-joined} ORDER BY {orderings} LIMIT {limit}`, omitting empty clauses.

---

### User Story 2 - Read backend is selectable behind an abstraction, defaulting to the SDK (Priority: P1)

An engineer can select which backend serves read queries via configuration. The
`AdsClient` abstraction in `skills/adkit/scripts/src/lib/auth.ts` gains a structured
search entrypoint that accepts `SearchArgs`; the existing SDK-backed client
implements it by deriving GAQL via `toGaql` and calling the current `query` path, so
behavior is unchanged. A backend selector (env flag) defaults to the SDK, keeping the
migration incremental and reversible.

**Why this priority**: A reversible seam with the SDK as default is what lets the
read migration land safely without a live cutover, and it is the contract the MCP
client will later implement. It is buildable and unit-testable offline with a fake
client.

**Independent Test**: With the backend flag unset or set to `sdk`, run each read
command's unit tests with a fake `AdsClient`; confirm reads flow through the
structured entrypoint and produce the same rows as before. Confirm the selector
returns the SDK backend by default and only returns the MCP backend when explicitly
requested.

**Acceptance Scenarios**:

1. **Given** no backend env flag, **When** the read-backend selector is consulted, **Then** it resolves to the SDK backend.
2. **Given** the SDK-backed `AdsClient`, **When** its structured search is called with a `SearchArgs`, **Then** it returns the same rows as calling `search()` with `toGaql(args)`.
3. **Given** the backend flag set to the MCP value, **When** the selector is consulted, **Then** it resolves to the MCP backend (whose live wiring is gated by the runtime being present).

---

### User Story 3 - The MCP integration path and auth model are documented and scaffolded (Priority: P2)

An engineer picking up the live migration finds the chosen integration path
(embedded stdio MCP client vs long-running HTTP) and auth model (reuse existing
`google-ads.yaml` vs ADC + `GOOGLE_PROJECT_ID`) written down, and an `McpAdsClient`
seam in place that consumes `SearchArgs`. Reads that cannot move (`keyword-ideas` and
`research` — both KeywordPlanIdeaService — and all mutations) are explicitly recorded
as staying on the SDK.

**Why this priority**: Phase 0 of the issue is a spike that *blocks* live cutover and
*requires a live account + running MCP server* — impossible to complete without
credentials. Capturing the decision and scaffolding the seam is the maximum safe,
offline-verifiable progress and unblocks a human to finish the live phases.

**Independent Test**: Read the updated `skills/adkit/reference/` setup docs; confirm
they state the integration path, the auth/runtime prerequisites (pipx + MCP server +
env), and that `keyword-ideas` and all mutations remain on the SDK. Confirm an
`McpAdsClient` type/seam exists that accepts `SearchArgs`.

**Acceptance Scenarios**:

1. **Given** the reference docs, **When** an engineer looks for how reads reach Google Ads under the MCP backend, **Then** the integration path and required env/runtime are documented.
2. **Given** the codebase, **When** an engineer looks for the MCP read client, **Then** an `McpAdsClient` seam consuming `SearchArgs` exists, with its live round-trip clearly marked as requiring the MCP runtime.
3. **Given** the reference docs, **When** an engineer looks for what did not migrate, **Then** `keyword-ideas`, `research` (both KeywordPlanIdeaService), and all mutations are recorded as SDK-only.

### Edge Cases

- A query the MCP `search` grammar cannot express as decomposed args (e.g. GAQL
  `PARAMETERS`, exotic segment gymnastics): flagged during the structured refactor;
  such a query keeps a raw-GAQL escape hatch and stays on the SDK path rather than
  being forced into `SearchArgs`.
- Live MCP round-trips, field-for-field parity vs the SDK, and flipping the default
  backend to MCP require a live Google Ads test account and a running Python MCP
  server — out of scope for this change (no credentials available in the automated
  run); deferred to a human follow-up and documented as such.
- Response-shape drift (MCP `format_output_row` field-path dicts vs SDK snake_case
  nested objects with enum-name strings): normalizers are re-checked only when a
  command is actually cut over to MCP, which is deferred; the SDK-default path keeps
  today's shapes.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: A typed `SearchArgs` structure MUST be defined as `{ resource: string, fields: string[], conditions: string[], orderings?: string[], limit?: number }`, expressing a decomposed Google Ads read query.
- **FR-002**: Every read-query builder in `skills/adkit/scripts/src/gaql/builders.ts` (report, audit, and apply-fixes read builders) MUST return a `SearchArgs` value instead of a GAQL string.
- **FR-003**: A pure `toGaql(args: SearchArgs)` helper MUST assemble `SELECT {fields} FROM {resource} WHERE {conditions AND-joined} ORDER BY {orderings} LIMIT {limit}`, omitting the WHERE/ORDER BY/LIMIT clauses when their inputs are empty, and MUST reproduce the GAQL string each builder produced before this change.
- **FR-004**: Id interpolation MUST continue to be guarded digits-only via `gaqlId()` (from `gaql/escape.ts`) when constructing `conditions`; a non-digit id MUST still throw.
- **FR-005**: The `AdsClient` abstraction in `lib/auth.ts` MUST gain a structured read entrypoint accepting `SearchArgs`; the SDK-backed implementation MUST satisfy it by deriving GAQL via `toGaql` and using the existing `query` path, leaving observable read behavior unchanged.
- **FR-006**: A read-backend selector MUST resolve to the SDK backend by default (flag unset or `sdk`) and to the MCP backend only when explicitly requested via configuration, so the migration is incremental and reversible.
- **FR-007**: An `McpAdsClient` seam consuming `SearchArgs` MUST exist; its live wire behavior (spawning/ calling the google-ads-mcp server) MUST be gated so that absence of the MCP runtime does not break the default SDK path or the test suite.
- **FR-008**: `keyword-ideas` and `research` (both driven by `KeywordPlanIdeaService.generate_keyword_ideas`, a non-GAQL RPC the MCP server does not expose) and all mutations (`apply-fixes --apply`, `create`) MUST remain on the `google-ads-api` SDK and MUST NOT be routed through the MCP backend.
- **FR-009**: The existing unit tests for `gaql/builders.ts` MUST be updated for the structured-args refactor, asserting both the `SearchArgs` shape and `toGaql` equivalence, and the full `skills/adkit/scripts` test suite MUST pass.
- **FR-010**: Setup/reference docs under `skills/adkit/reference/` MUST record the chosen MCP integration path, the new runtime + credential prerequisites, that the SDK backend remains the default, and what did not migrate.
- **FR-011**: Command read call-sites (`report`, `audit`, `apply-fixes` reads, `preflight`) MUST obtain their query via the structured builders + backend seam without changing the data each command returns under the default SDK backend.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of the `skills/adkit/scripts` automated test suite passes after the refactor, including new assertions that `toGaql(builder(...))` reproduces each builder's prior GAQL string.
- **SC-002**: Under the default (SDK) backend, every read command (`report`, `audit`, `apply-fixes` reads, `preflight`) returns data identical to before the change — no query-visible regression.
- **SC-003**: Switching the read-backend flag between SDK and MCP requires no code change (configuration only), demonstrating the seam is reversible.
- **SC-004**: A repository search confirms no read builder still returns a raw GAQL `string` type (each returns `SearchArgs`), while `keyword-ideas` and mutation paths remain on the SDK.

