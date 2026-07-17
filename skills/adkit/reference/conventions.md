---
description: "Shared reference for the /adkit * skills (invocation, customer-id resolution, JSON envelope, credentials, labor division). Not a command — loaded on demand by the ads skills, not invoked directly."
user-invocable: false
disable-model-invocation: true
---

# Ads skill conventions (shared reference)

Shared mechanics for the `/adkit *` lifecycle (`keywords → create → audit → fix → report`). The individual skills link here instead of re-inlining this boilerplate. Read it once when running any ads skill.

## Invoking `ads.sh`

Every ads subcommand goes through one wrapper:

```bash
ads.sh <subcommand> [args…]
```

- `ads.sh` resolves `node` (Node ≥ 24, https://nodejs.org), ensures the npm deps are installed on first run (`npm ci`, falling back to `npm install`), then runs the entry point directly from TypeScript via `tsx` (`node_modules/.bin/tsx src/bin/<cmd>.ts`). No build step and no `dist/` — `tsx` transpiles on the fly, so a source edit takes effect on the next run.
- **No persistent server, no MCP** — every invocation is a single Node process.
- Subcommands: `preflight`, `create`, `audit`, `update`, `keyword-ideas`, `report`, `render-yaml`, `bootstrap-secrets` (`apply-fixes` is a deprecated alias for `update`).

## Customer-id vs login-customer-id

- **`--customer <id>`** (a.k.a. `customerId` / `GOOGLE_ADS_CUSTOMER_ID`) is the **leaf account** the operation reads or mutates.
- **`--login-customer-id <MCC>`** (a.k.a. `--manager`) is only needed when the leaf is reached *through* a manager account. **Omit it for directly-accessible accounts** — the default `None` is correct for directly-accessible clients.
- **Format rule:** every customer/manager id is **10 digits, no dashes**. Strip any dashes a human typed before passing them through.

## JSON envelope contract

Machine-readable subcommands return a single JSON object on **stdout**:

```json
{ "ok": true,  "message": …, /* command-specific payload */ }
{ "ok": false, "error": { "step": "…", "message": "…" } }
```

- On `"ok": false`, surface `error.step` and `error.message` **verbatim** to the operator; do not paraphrase or fabricate a result.
- Human-readable summaries (tables, progress) go to **stderr** — redirect stdout (`> /tmp/out.json`) when you want only the payload.
- Non-zero exit always pairs with an `ok:false` / `failure` payload that names the failing step.

## Credentials & preflight

- Credentials live in `~/.config/google-ads/google-ads.yaml` (or the `GOOGLE_ADS_CREDENTIALS` env). Secrets are in Google Secret Manager (project `your-project-prod`).
- If the yaml is missing, render it once: `ads.sh render-yaml` (one-time seed of the secrets: `ads.sh bootstrap-secrets`).
- Run **`ads.sh preflight` once per session**. Non-zero exit ⇒ **stop**; surface its `step` and `message` verbatim. On success it confirms credentials work and the target customer is in the accessible list.

## Read backend (SDK vs google-ads-mcp)

Read queries are being migrated toward the official
[google-ads-mcp](https://github.com/googleads/google-ads-mcp) server. The migration is
built as a **reversible seam**, selected by one env var:

- **`ADKIT_READ_BACKEND`** — `sdk` (default) or `mcp`. Absent or unrecognized ⇒ `sdk`.
- Every read query builder emits a structured `SearchArgs`
  (`{ resource, fields, conditions, orderings?, limit? }`) — the shape the MCP `search`
  tool wants — and `toGaql(SearchArgs)` derives the exact GAQL string the SDK backend
  runs. The SDK backend (`ADKIT_READ_BACKEND=sdk`) is the tested default and behaves
  exactly as before.
- **MCP backend status: scaffolded, not yet wired.** Selecting `mcp` currently throws a
  descriptive `McpNotConfiguredError` (fails loudly, never silently degrades). Wiring the
  live transport is a deferred follow-up (see `specs/011-migrate-reads-google-ads-mcp`)
  and requires:
  - **Runtime**: the Python google-ads-mcp server, run via `pipx`
    (`pipx run --spec git+https://github.com/googleads/google-ads-mcp.git google-ads-mcp`),
    driven as an **embedded stdio MCP client** (an HTTP transport can be substituted at the
    same seam without changing call-sites).
  - **Auth**: reuse the existing `google-ads.yaml` via the MCP Python client's yaml option
    where possible; the alternative is ADC (`GOOGLE_APPLICATION_CREDENTIALS`) plus
    `GOOGLE_PROJECT_ID` and `GOOGLE_ADS_DEVELOPER_TOKEN`.

### Stays on the SDK (does NOT migrate to MCP)

- **All mutations** — `ads.sh update --apply` and `ads.sh create` (the MCP read tools are
  read-only).
- **`keyword-ideas` and `research`** — both driven by
  `KeywordPlanIdeaService.generate_keyword_ideas`, a non-GAQL RPC the MCP server does not
  expose. They keep using `google-ads-api` directly regardless of `ADKIT_READ_BACKEND`.

## Division of labor — the CLI is deterministic, the model is creative

- **The CLI is deterministic.** Counting/validation, finding duplicates, reading Google's own `ad_strength` / `action_items`, computing the per-ad `pathToExcellent`, schema validation, and all live mutations are the executor's job (`ads.sh audit`, `ads.sh update`, `ads.sh create`). It never invents copy.
- **The model is creative.** Authoring RSA headlines/descriptions tuned to an ad group's real keyword, tiering keywords by intent, picking sitelink/callout text, and judging *which* fixes to apply are yours. Templated, keyword-agnostic copy is exactly what grades POOR — write to the specific keyword.
- **Applying is the executor's again.** You hand the executor a structured plan (a brief or a fixes plan); it re-validates against the rules and mutates. Dry-run is the default; mutation needs an explicit `--apply` (or the live `create`).
