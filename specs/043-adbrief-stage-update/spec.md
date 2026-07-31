# Feature Specification: Stage `ads.sh update` changes into the local adbrief before mutating live

**Feature Branch**: `043-adbrief-stage-update`

**Created**: 2026-07-27

**Status**: Draft

**Input**: User description: "Make `ads.sh update` stage changes into the local adbrief before mutating the live account — mirroring the write-brief → diff → apply gate that `ads.sh create` already implements, so update and create share one review flow. See GitHub issue #41."

## Clarifications

### Session 2026-07-27

- Q: When a single plan touches ad groups/ads belonging to multiple campaigns/briefs, how should staging behave? → A: Stage, diff, and write each affected brief independently — one diff and one write per resolved slug, not one combined diff across campaigns.
- Q: When a plan references an id (`adId`/`adGroupId`/`campaignId`) that its campaign's state file has no record of, does staging fail for the whole run or degrade per-entity? → A: Degrade per-entity — skip brief staging only for that entity's owning campaign, proceed with its live mutation as before this feature, and emit an explicit warning naming the unresolvable id; other entities in the same plan that do resolve are still staged and diffed normally.
- Q: What JSON field names report brief-sync status, and what indicates staging was skipped? → A: Reuse `create`'s existing envelope fields (`briefSynced`, `briefPath`) for consistency, and add `briefStagingSkipped: boolean` plus `briefStagingSkipReason: string` (e.g. `"no-state-file"`, `"unresolvable-id"`) for the skip case.
- Q: Is `appendHeadlines` dedup against existing brief headlines case-sensitive or case-insensitive? → A: Case-sensitive exact match, identical to the existing live-mutation dedup rule already in `apply-fixes.ts`.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Operator reviews a brief diff before an update goes live (Priority: P1)

An operator runs `ads.sh update <plan>` (no `--apply`) against an existing campaign. Today this dry-run only narrates the planned live-account changes; it never touches `adbriefs/<slug>.yaml`, so the operator has no way to see, ahead of time, exactly how the local brief would change. With this feature, the dry-run resolves the plan's ids back to the brief via the campaign's state file, stages the plan's edits into a proposed copy of the brief, and prints the brief-level diff against what's on disk — the same review gate `ads.sh create` already shows before a first-time publish.

**Why this priority**: This is the core of the request — a diff-before-apply gate is worthless if it doesn't exist for the most common operation (updating an existing campaign). Without it, `update` and `create` have two different review experiences and the operator can't trust the brief to reflect reality.

**Independent Test**: Run `ads.sh update <plan-with-a-rewrite>` without `--apply` against a campaign that already has an `adbriefs/<slug>.yaml` and `adbriefs/<slug>.state.yaml`. Confirm the printed brief diff is non-empty and correctly shows the rewritten ad's headlines/descriptions changing, and confirm no file under `adbriefs/` is modified.

**Acceptance Scenarios**:

1. **Given** a campaign with an existing brief and state file, **When** the operator runs `ads.sh update <plan>` with a rewrite for one of its ads and no `--apply`, **Then** the command prints a non-empty brief diff showing the proposed change and leaves `adbriefs/<slug>.yaml` unmodified on disk.
2. **Given** a plan whose edits already match what's live and already recorded in the brief (a no-op), **When** the operator runs `ads.sh update <plan>` without `--apply`, **Then** the command prints an empty brief diff.
3. **Given** a plan with edits split across `appendHeadlines`, `negatives`, `keywords`, `sitelinks`, `callouts`, `budgets`, and status sections in the same run, **When** the operator runs the dry-run, **Then** every section's change is reflected in a single combined brief diff, not one diff per section.

---

### User Story 2 - Applying an update keeps the local brief in sync automatically (Priority: P1)

An operator runs `ads.sh update <plan> --apply`. Today the live account changes but `adbriefs/<slug>.yaml` is never touched, so the brief silently drifts from live and someone has to hand-edit it back into sync later — this already happened once, after an RSA rewrite. With this feature, once the live mutation succeeds, the staged brief is written to `adbriefs/<slug>.yaml` automatically, so `git status` shows exactly the local file change that matches the live change, with no manual editing.

**Why this priority**: This closes the actual gap named in the request — it's the reason the feature exists. Without it, the diff in User Story 1 is just a preview with no effect, and the brief keeps drifting.

**Independent Test**: Run `ads.sh update <plan> --apply` against a campaign with an existing brief and state file. Confirm the live mutation succeeds, `adbriefs/<slug>.yaml` is rewritten to match the staged brief, and `git status`/`git diff` on that file shows only the change implied by the plan.

**Acceptance Scenarios**:

1. **Given** a campaign with an existing brief and state file, **When** the operator runs `ads.sh update <plan> --apply` and the live mutation succeeds, **Then** `adbriefs/<slug>.yaml` is overwritten with the staged brief content after the mutation completes, and the JSON envelope reports the brief as synced.
2. **Given** the same setup, **When** the apply succeeds, **Then** the written brief's content is exactly what the pre-apply dry-run diff previewed for the same plan.

---

### User Story 3 - A failed or partial apply never asserts a brief that isn't true (Priority: P1)

An operator runs `ads.sh update <plan> --apply` and the live mutation fails partway through (e.g. one ad rewrite succeeds, a later budget change is rejected by the API). Writing the fully-staged brief in this case would make the local brief claim a state the live account doesn't actually have. With this feature, the brief is left unchanged on any failed or partial apply, and the command's output loudly says the local and live states have diverged.

**Why this priority**: Silently asserting an untrue brief is worse than the current drift — it would make the brief actively wrong and undermine every future review that trusts the brief as source of truth. This must ship alongside User Story 2 for the "auto-sync" behavior to be safe.

**Independent Test**: Simulate an apply that fails partway (e.g. the live API rejects one part of the plan). Confirm `adbriefs/<slug>.yaml` is left byte-for-byte unchanged and the JSON envelope reports the brief as not synced.

**Acceptance Scenarios**:

1. **Given** a plan whose live mutation fails partway through `--apply`, **When** the command finishes, **Then** `adbriefs/<slug>.yaml` on disk is unchanged from before the run, and the JSON envelope's brief-synced indicator is `false`.
2. **Given** the same failure, **When** the operator inspects the command's output, **Then** it clearly states the local brief and the live account have diverged and by how much (which planned changes did not apply).

---

### User Story 4 - Updating a campaign that predates state files degrades gracefully (Priority: P3)

An operator runs `ads.sh update <plan> --apply` against a campaign that was created before state files existed, so `adbriefs/<slug>.state.yaml` doesn't exist and the plan's live ids can't be resolved back to brief entities. Rather than blocking the update entirely, the command proceeds with the live mutation as it does today, skips brief staging, and says so clearly in its output so the operator knows the brief still needs manual attention.

**Why this priority**: Lower priority than the core sync behavior because it's a fallback for legacy campaigns, but it must not regress `update`'s existing ability to mutate accounts that predate this feature.

**Independent Test**: Run `ads.sh update <plan> --apply` against a campaign whose `adbriefs/<slug>.state.yaml` does not exist. Confirm the live mutation still applies, no file under `adbriefs/` is touched or created, and the command's output contains an explicit warning that brief staging was skipped.

**Acceptance Scenarios**:

1. **Given** a campaign with no state file, **When** the operator runs `ads.sh update <plan> --apply`, **Then** the live mutation still runs to completion as it did before this feature, and no brief file is created or modified.
2. **Given** the same run, **When** the operator inspects the JSON envelope, **Then** it contains a loud, explicit indicator that brief staging was skipped due to a missing state file — not a silent omission.

---

### Edge Cases

- A plan names an `adId`/`adGroupId`/`campaignId` that the campaign's state file has no record of (e.g. an ad added outside `adkit`, or the state file is stale) — the command cannot resolve that id to a brief entity for staging purposes. Staging is skipped only for that entity's owning campaign; the live mutation for it proceeds as before this feature, and an explicit warning names the unresolvable id. Other entities in the same plan that do resolve are still staged and diffed normally.
- A plan's slug (from `campaign.name`) collides with an on-disk brief that names a *different* campaign — staging must refuse this exactly as `create` already does, without silently overwriting, and this refusal must surface even in dry-run so the operator catches it before a real apply.
- A plan touches ad groups or ads belonging to more than one campaign/brief in a single run — each affected brief is staged, diffed, and (on `--apply`) written independently, keyed by resolved slug: one diff and one write per brief, never one combined diff across campaigns.
- The on-disk brief was hand-edited since the last sync and no longer matches what the state file implies is live — the diff must be computed against the brief that is actually on disk, not an assumption about it.
- `appendHeadlines` adds headlines that duplicate ones already in the brief — staged headlines are deduplicated using the same case-sensitive exact-match rule the live mutation already uses (`apply-fixes.ts`), so staged content never diverges from what the live mutation would produce.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: `ads.sh update <plan>` MUST resolve every `adId`, `adGroupId`, and `campaignId` referenced by the plan back to its owning brief and brief entity using the campaign's state file, without issuing additional live queries for that resolution. If a given id has no record in any loaded state file, resolution fails only for that id's owning entity: staging is skipped for that entity's campaign specifically (with an explicit warning naming the id) while resolution and staging proceed normally for every other entity in the same plan whose ids do resolve.
- **FR-002**: `ads.sh update <plan>` MUST stage the plan's edits into a proposed in-memory copy of the resolved brief: rewrites replace the targeted ad's assets, `appendHeadlines` merges into the existing headline set, and negatives, keywords, sitelinks, callouts, budgets, and status changes are all reflected in the corresponding brief fields.
- **FR-003**: `ads.sh update <plan>` MUST diff the staged brief against the on-disk brief using the same diff logic `create` uses, and MUST print that diff on every run, dry-run or `--apply`.
- **FR-004**: When `--apply` is not passed, `ads.sh update <plan>` MUST NOT mutate the live account and MUST NOT write, create, or modify any file under `adbriefs/`.
- **FR-005**: When `--apply` is passed, `ads.sh update <plan>` MUST perform the live mutation first and MUST write the staged brief to `adbriefs/<slug>.yaml` only after that mutation completes successfully.
- **FR-006**: On a partial or failed `--apply`, `ads.sh update <plan>` MUST leave `adbriefs/<slug>.yaml` unchanged and MUST report the brief as not synced in its output.
- **FR-007**: `ads.sh update <plan>` MUST refuse to stage a brief when the plan's resolved slug already names a different campaign on disk, and this refusal MUST apply on dry-run as well as `--apply`, mirroring `create`'s existing collision refusal.
- **FR-008**: When a plan references a campaign whose state file does not exist, `ads.sh update <plan>` MUST warn explicitly, proceed with the live mutation exactly as it did before this feature existed, and skip brief staging entirely rather than failing the command.
- **FR-009**: The command's JSON output MUST always report whether the run succeeded, the actions taken or planned, and whether the local brief matches the live account state after the run, using field names consistent with `create`'s existing envelope: `briefSynced: boolean` and `briefPath` report sync state per brief written, and `briefStagingSkipped: boolean` with `briefStagingSkipReason: string` (e.g. `"no-state-file"`, `"unresolvable-id"`) report when staging was skipped and why.
- **FR-010**: A single `update` run touching multiple plan sections (rewrites, appends, negatives, keywords, sitelinks, callouts, budgets, statuses) for the same campaign MUST produce one combined brief diff and one combined write, not one per section. When a run touches multiple campaigns/briefs, each resolved brief still gets its own independent diff and write; only edits within the same brief are combined.
- **FR-011**: A plan whose staged edits produce no change relative to the on-disk brief MUST produce an empty diff and, on `--apply`, MUST NOT rewrite the brief file unnecessarily.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After `ads.sh update <plan> --apply` completes successfully, `git status` shows exactly the `adbriefs/<slug>.yaml` change implied by the plan, with zero manual editing required.
- **SC-002**: A dry-run of any plan that changes ad content, sitelinks, callouts, negatives, keywords, budgets, or status shows a non-empty, human-readable brief diff before any live mutation occurs.
- **SC-003**: A dry-run of an already-applied (no-op) plan shows an empty brief diff.
- **SC-004**: 100% of simulated partial/failed applies leave the on-disk brief byte-for-byte unchanged and are distinguishable from a fully-synced apply by inspecting the command's output alone.
- **SC-005**: Running `update` against a campaign with no state file completes the live mutation exactly as it did before this feature, with the missing-state condition visible in the command's output every time.
