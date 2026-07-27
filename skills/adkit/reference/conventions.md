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

## `adbriefs/` — the local source of truth + diff-before-apply gate

Every campaign has one persisted brief under `adbriefs/<slug>.yaml` at the repo root — the local **source of truth** for that campaign's full state (campaign settings, ad groups, keywords, RSAs, negatives, budget). `<slug>` is a deterministic kebab-case slug of `campaign.name`, so the same campaign always maps to the same file. The brief file **is** the `/adkit create` brief format (the zod `Brief` schema in `src/lib/schema.ts`) — nothing new to learn.

The flow both mutating skills follow is **write-brief → diff → apply**:

1. **Stage** the proposed change into the campaign's brief (a new brief for `create`; the audit-driven edits for `update`).
2. **Diff** the proposed brief against the existing `adbriefs/<slug>.yaml` and surface it — an all-added diff the first time, an empty diff (nothing to apply) for a no-op. This is the review-the-change gate.
3. **Apply** to the live account only after the diff has been shown and confirmed. **Dry-run is the default; a live mutation requires the explicit flag** (`--apply` for `update`; a non-`--dry-run` run for `create`). After a *successful* apply the brief is (re)written so it reflects the applied state; a slug collision with a *different* campaign is **refused**, never silently overwritten.

Both `/adkit create` and `/adkit update` implement this end-to-end (persist/stage → diff → publish/mutate → sync). The shared machinery lives in `src/adbriefs/` — `store.ts` (slug/path/load/write), `diff.ts` (pure brief diff), `state.ts` (the `<slug>.state.yaml` reverse id index), and `apply-plan.ts` (`update`'s pure id-resolution + brief-staging). `update` resolves a plan's `adId`/`adGroupId`/`campaignId` references back to their owning brief via the state index — with **zero extra live queries** — then stages, diffs, and (on `--apply`) writes each resolved brief.

**Per-slug independence.** A single run's plan can touch more than one campaign/brief at once (e.g. a rewrite on campaign A alongside a budget change on campaign B). Each resolved slug gets its **own independent diff and its own independent write** — never one combined diff across campaigns. Edits within the *same* brief (e.g. a rewrite + a negative + a budget change, all on one campaign) are combined into one diff and one write.

**Mutate-then-write.** On `--apply`, the live mutation for a slug's entities runs first, exactly as it would without staging; only once it completes successfully is that slug's `adbriefs/<slug>.yaml` written. On a partial/failed apply the brief is **not** left asserting a fully-applied state — every affected brief is left byte-for-byte unchanged and the envelope's failure (`briefSynced: false`, plus a loud "diverged" message naming what didn't apply) is the brief↔live divergence signal.

**Per-slug failure isolation.** `update`'s live-mutation sequence runs each numbered step (or, where a step already loops per section/campaign entry, each entry within it) in its own try/catch. A thrown/rejected mutation is caught and attributed to the brief slug(s) that step's entries resolve to, via the SAME reverse `StateIndex` staging already resolved against (`slugsForIds` in `bin/apply-fixes.ts`) — no new query. Only those slugs are marked unsynced (`briefSynced: false`); a slug untouched by any failure in the same run still syncs normally, even when another campaign's mutation failed (proven by the "multi-campaign partial failure" test). The one caveat: the batched RSA rewrite/append step (`rewrites` + `appendHeadlines` in one `mutate` call) is atomic, so a failure there is conservatively attributed to **every** slug that step's rewrites/appends touch, not just the one entry that caused the rejection — the same conservative "never assert an untrue brief" read, just scoped to the one step instead of the whole run. A `writeBrief` failure (foreign-brief race, `EACCES`/`ENOSPC`/etc) after a slug's mutation already succeeded is caught the same way and marks only that slug unsynced — it does not prevent any other slug's write or report.

**Degrade paths.** A plan id with no record in any loaded state file skips staging only for that entity (a `WARNING:` names it; every other entity that does resolve is unaffected). A campaign with no state file at all (predates this feature) skips brief staging for that campaign entirely — the live mutation still runs unchanged. A campaign whose on-disk brief fails to parse (corrupt YAML or a schema violation) skips staging for that campaign alone — an unrelated resolved campaign in the same plan still stages/diffs/writes normally. A staged result that would itself violate `BriefSchema` (e.g. an append that would push an ad group over 15 headlines, or a keyword removal that would leave it with none) is caught before it is diffed or written, and that slug is skipped rather than corrupting `adbriefs/<slug>.yaml`. All of these report through the envelope: `briefStagingSkipped: boolean` + `briefStagingSkipReason: "no-state-file" | "unresolvable-id" | "collision" | "missing-brief" | "invalid-brief" | "invalid-result" | "live-mutation-failed"`.

## Division of labor — the CLI is deterministic, the model is creative

- **The CLI is deterministic.** Counting/validation, finding duplicates, reading Google's own `ad_strength` / `action_items`, computing the per-ad `pathToExcellent`, schema validation, and all live mutations are the executor's job (`ads.sh audit`, `ads.sh update`, `ads.sh create`). It never invents copy.
- **The model is creative.** Authoring RSA headlines/descriptions tuned to an ad group's real keyword, tiering keywords by intent, picking sitelink/callout text, and judging *which* fixes to apply are yours. Templated, keyword-agnostic copy is exactly what grades POOR — write to the specific keyword.
- **Applying is the executor's again.** You hand the executor a structured plan (a brief or a fixes plan); it re-validates against the rules and mutates. Dry-run is the default; mutation needs an explicit `--apply` (or the live `create`).
