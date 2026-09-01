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
- Subcommands: `init`, `preflight`, `create`, `audit`, `update`, `keyword-ideas`, `report`, `render-yaml`, `bootstrap-secrets` (`apply-fixes` is a deprecated alias for `update`).

## `target_customer_id` vs `mcc_customer_id`

The two ids answer different questions, and the names say which: the **target** is
what you operate on, the **MCC** is what you go through to reach it.

- **`target_customer_id`** (`--customer <id>` / `GOOGLE_ADS_CUSTOMER_ID`) is the **leaf account** the operation reads or mutates. **Required** — every command needs to know what it is acting on.
- **`mcc_customer_id`** (`--mcc-customer-id <MCC>`, a.k.a. `--manager`) is the manager account the leaf is reached *through*, sent as the login header. **Optional, and absent is a real answer**: omit it entirely for a directly-accessible account — no header is the correct behaviour there, not a missing setting. Nothing ever prompts for it or blocks on it.
- **Format rule:** every customer/manager id is **10 digits**. Dashes are accepted on input (`123-456-7890`, the form the Ads UI shows) and stripped once at the boundary; anything that is not 10 digits after stripping is rejected, naming the tier it came from and what was wrong with it.
- **When `target_customer_id` resolves nowhere** — no flag, no env var, no yaml entry — the command does not guess. On a terminal it asks once and saves the answer to `adkit.yaml`, the committed half (it is an account number, not a credential); with no terminal (CI, a pipe) it exits non-zero with the standard `ok:false` envelope naming the field, the config path, and the fix. There is no fallback to Secret Manager.
- If the API rejects a call in a way that means the leaf is only reachable through a manager, the error names `mcc_customer_id` as the thing to set.

> **Naming note:** the wire/SDK field is still Google's `login_customer_id`, and the
> environment variable is still `GOOGLE_ADS_LOGIN_CUSTOMER_ID` — both are Google's
> names, kept as-is at the boundary. Everywhere adkit owns the name (the
> `adkit.yaml` key, the flags, the code) it is `mcc_customer_id`, because "login"
> reads like a credential and this is an account number.

## JSON envelope contract

Machine-readable subcommands return a single JSON object on **stdout**:

```json
{ "ok": true,  "message": …, /* command-specific payload */ }
{ "ok": false, "error": { "step": "…", "message": "…" } }
```

- On `"ok": false`, surface `error.step` and `error.message` **verbatim** to the operator; do not paraphrase or fabricate a result.
- Human-readable summaries (tables, progress) go to **stderr** — redirect stdout (`> /tmp/out.json`) when you want only the payload.
- Non-zero exit always pairs with an `ok:false` / `failure` payload that names the failing step.

## Credentials, project config, & preflight

Local config lives in **two files**, split by trust level. The line between them is
the one adkit has always drawn in prose — the customer ids are account numbers, the
tokens are credentials — made physical:

| File | Tracked | Contents |
| --- | --- | --- |
| `adkit.yaml` | **committed** | `reports_dir`, `briefs_dir`, `ideas_dir`, `mcc_customer_id`, `target_customer_id`, `secrets_project`, `read_backend` |
| `.adkit.secrets.yaml` | git-ignored | `developer_token`, `client_id`, `client_secret`, `refresh_token`, `psi_api_key` |
| `.adkit.yaml` | git-ignored | **legacy** — the old combined file. Still read, with a deprecation notice. |

- **Why two.** The preferences describe the *project*: every collaborator, every CI
  job and every git worktree wants the same values, and none of them is a secret.
  Folding them in with the credentials forced the whole file to be git-ignored, so a
  worktree got none of them — which is why running `/adkit gtm` from a worktree used
  to need an explicit `ADKIT_CONFIG=`. The filename now also says what is inside:
  `.adkit.secrets.yaml` warns you before you paste it into an issue; `.adkit.yaml`
  did not.
- **Where the credentials go.** Two supported placements:
  - **repo root** (the default) — `$CWD/.adkit.secrets.yaml`, git-ignored by `init`;
  - **outside the repo** — e.g. `~/.config/adkit/<project>.secrets.yaml`, selected
    with `export ADKIT_CONFIG=…`. **Prefer this one.** Nothing in the tree can commit
    it, and it survives into git worktrees. (`GOOGLE_ADS_CREDENTIALS` is a legacy
    alias for the same override.) `ADKIT_CONFIG` moves only the credentials;
    `adkit.yaml` is always read from the repo root.
- **Resolution.** `loadConfig()` merges defaults ← `adkit.yaml` ← the credentials
  file ← any legacy `.adkit.yaml`. The legacy file is overlaid last, so a project
  that has not migrated — one file holding both halves — keeps behaving exactly as it
  did. Per-setting precedence is unchanged: an explicit flag, then the matching env
  var, then the merged yaml, then a hardcoded default (`lib/config.ts`'s
  `resolveTier`). Nothing needs migrating on a schedule.
- **The two customer ids are not secrets.** They are 10-digit Google Ads account
  numbers, visible in the Ads UI and safe in a ticket or a screenshot, so they live
  in the committed `adkit.yaml` — set by `ads.sh init` or a hand-edit, never in
  Secret Manager, never fetched or overwritten by `render-yaml`. Both are optional:
  an account reached directly (no manager) simply omits `mcc_customer_id`, and
  `target_customer_id` is asked for once (on a terminal) or reported as a named
  `ok:false` failure (off one) rather than guessed. There is no fallback to Secret
  Manager for either — see the section above.
- `ads.sh init` scaffolds **both** files with a one-time interactive prompt —
  **create-if-missing per file**; it never overwrites an existing one, and it prompts
  only for the half it is about to write. Every run also makes sure `.gitignore`
  excludes `/.adkit.secrets.yaml` *and* the legacy `/.adkit.yaml` (adding whichever
  entry is missing), whether or not either file already existed — a `.gitignore`
  predating this command is retrofitted.
- `ads.sh render-yaml` pulls the credential fields from Secret Manager and writes
  **only** the credentials file, and only the credential fields: the preferences in
  `adkit.yaml` are neither fetched nor touched. (The one exception is a target still
  *named* `.adkit.yaml` — an unmigrated project, or an `ADKIT_CONFIG` pointing at the
  old combined file. There both halves share one file, so both are written back;
  trimming it to credentials would delete the operator's preferences.) One-time seed of the secrets
  themselves: `ads.sh bootstrap-secrets` (credentials only; it never prompts for a
  customer id).

### The guardrail: credentials never land somewhere committable

Before writing any file that carries credential fields, adkit judges the target path
against git and **refuses** rather than writing, reporting the standard `ok:false`
envelope with `step: "secrets-path"`, the path, a `reason`, and the fix. The checks,
in order:

| Check | Reason | What happens |
| --- | --- | --- |
| `git check-ignore --no-index <path>` says not ignored | `not-ignored` | **Refuse.** Nothing is written. Fix: add the entry to `.gitignore`, or move the file out of the repo with `ADKIT_CONFIG`. |
| `git ls-files --error-unmatch <path>` says already tracked | `already-tracked` | **Refuse.** The existing file is left untouched. Fix: `git rm --cached`, ignore it, and **rotate every credential it has carried** — it is in the repo's history. |
| An ancestor directory below the repo root itself holds tracked files | `tracked-ancestor` | **Warn loudly**, naming that directory, and continue. |

A path outside any git work tree — the recommended `~/.config/adkit/…` placement —
passes every check: there is nothing there that could commit it. The failure is never
silently downgraded to a different path.

The third check is not hypothetical. A vendored skill commonly lives at
`.claude/skills/adkit` → `.agents/skills/adkit`, and "put the secrets next to adkit,
which is gitignored" is a natural-sounding, wrong instinct: those trees are committed
wholesale (hundreds of tracked files), so the file would be committed on the next `git
add` — and wiped whenever the vendored skill is reinstalled.

There is a **read-side** check too: when `preflight` loads a credentials file that git
does not ignore, or that it already tracks, it prints a prominent warning on stderr
and carries on. It never fails the run — a file that already exists is not made safer
by refusing to read it, and the out-of-repo placement makes `check-ignore` meaningless
anyway.

- Run **`ads.sh preflight` once per session**. Non-zero exit ⇒ **stop**; surface its `step` and `message` verbatim. On success it confirms credentials work and the target customer is in the accessible list.
- Preflight resolves its customer id through the same `--customer` → `GOOGLE_ADS_CUSTOMER_ID` → yaml tiering as everything else, and builds its client the **same way** the commands it gates do — honouring `mcc_customer_id` when set, sending no login header when blank. That is the point of a precondition check: a client built differently is not checking what preflight claims to check. (It previously cleared the header unconditionally, so no MCC-managed account could pass.)

## Output directories

adkit writes three kinds of artifact, and each one's directory is a setting — resolved
through the same flag → env → yaml → default chain as everything else. All three are
`adkit.yaml` keys — the committed half, so a collaborator, a CI job and a worktree all
write to the same places:

| Artifact | `adkit.yaml` key | Env var | Default |
| --- | --- | --- | --- |
| Campaign briefs + state (`create`, `update`) | `briefs_dir` | `ADKIT_BRIEFS_DIR` | `adbriefs` |
| Raw/analysis/dashboard reports (`report`) | `reports_dir` | `ADKIT_REPORTS_DIR` | `ads/output/reports` |
| Processed idea markdown (`gtm`, `create`) | `ideas_dir` | `ADKIT_IDEAS_DIR` | `ideas/processed` |

All three are **relative to the repo root**, and all three are optional — a project that
sets none of them writes exactly where adkit has always written. Setting them is how a
project puts every adkit artifact under one folder, e.g.:

```yaml
briefs_dir:  "ads/briefs"
reports_dir: "ads/reports"
ideas_dir:   "ads/ideas/processed"
```

`gtm` derives the **raw**-ideas directory as a sibling of `ideas_dir` named `raw`
(`ideas/processed` → `ideas/raw`; `ads/ideas/processed` → `ads/ideas/raw`) — see
`reference/gtm.md`.

> These settings were declared and prompted for long before anything read them; a value
> set in the config moved no file until issue #69. **The rest of these docs spell out
> the default paths** (`adbriefs/<slug>.yaml`, `ads/output/reports/…`, `ideas/processed/…`)
> because they read better as concrete examples — read them as "the configured directory,
> which defaults to this".

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
  - **Auth**: reuse the existing credentials file via the MCP Python client's yaml option
    where possible; the alternative is ADC (`GOOGLE_APPLICATION_CREDENTIALS`) plus
    `GOOGLE_PROJECT_ID` and `GOOGLE_ADS_DEVELOPER_TOKEN`.

### Stays on the SDK (does NOT migrate to MCP)

- **All mutations** — `ads.sh update --apply` and `ads.sh create` (the MCP read tools are
  read-only).
- **`keyword-ideas` and `research`** — both driven by
  `KeywordPlanIdeaService.generate_keyword_ideas`, a non-GAQL RPC the MCP server does not
  expose. They keep using `google-ads-api` directly regardless of `ADKIT_READ_BACKEND`.

## `adbriefs/` — the local source of truth + diff-before-apply gate

Every campaign has one persisted brief under `adbriefs/<slug>.yaml` at the repo root (or wherever `briefs_dir` points — see *Output directories* above) — the local **source of truth** for that campaign's full state (campaign settings, ad groups, keywords, RSAs, negatives, budget). `<slug>` is a deterministic kebab-case slug of `campaign.name`, so the same campaign always maps to the same file. The brief file **is** the `/adkit create` brief format (the zod `Brief` schema in `src/lib/schema.ts`) — nothing new to learn.

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
