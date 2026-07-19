# Feature Specification: Stage campaign changes into an `adbriefs/` brief with a diff-before-apply gate

**Feature Branch**: `026-adbriefs-stage-diff`

**Created**: 2026-07-18

**Status**: Draft

**Input**: User description: GitHub issue #26 — "adkit: stage all campaign changes into an adbriefs/ brief and show a diff before applying"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Persist a new campaign's full brief before publishing (Priority: P1)

When an operator runs `/adkit create` on a processed idea, the full, filled campaign brief is written to a committed file under `adbriefs/` **before** anything is published to Google Ads — so there is one local, reviewable source of truth for that campaign instead of a throwaway temp file that is discarded on publish.

**Why this priority**: This is the foundation the rest of the feature stands on. Without a persisted per-campaign brief there is nothing to diff against and no local source of truth. It also independently delivers value: the operator gains a durable, version-controllable record of exactly what was published.

**Independent Test**: Run `/adkit create` (dry-run) on a processed idea and confirm a brief file appears under `adbriefs/` holding the complete campaign state (campaign, ad groups, keywords, RSAs, negatives, budget), and that publishing does not require re-scaffolding a temp brief.

**Acceptance Scenarios**:

1. **Given** a processed idea with keyword themes, **When** the operator runs `/adkit create`, **Then** a brief file `adbriefs/<campaign-slug>.yaml` is written holding the campaign's full state before any live publish is attempted.
2. **Given** a successful publish, **When** it completes, **Then** the `adbriefs/` brief on disk matches what was published (the local file is the source of truth, not a discarded temp file).
3. **Given** an existing `adbriefs/<campaign-slug>.yaml` for the same campaign, **When** the operator re-runs `/adkit create`, **Then** the operator is shown the diff between the existing brief and the proposed brief and no live change is applied until it is confirmed.

---

### User Story 2 - Stage an update into the brief and review the diff before mutating live ads (Priority: P1)

When an operator runs `/adkit update` with audit-driven changes, those changes are applied to the campaign's `adbriefs/` brief **first** (producing a proposed new brief), and the operator is shown the diff between the current brief and the proposed brief. No live mutation happens until the operator confirms — dry-run remains the default, and applying still requires the explicit `--apply` flag.

**Why this priority**: This is the core "review-the-change gate" the issue asks for — the protection against mutating live ads without first seeing exactly what will change. It is the highest-value behavior change and is independently demonstrable.

**Independent Test**: Run `/adkit update` (default dry-run) with a plan against a campaign that has an `adbriefs/` brief, and confirm the command shows a diff of the proposed brief change and applies nothing live; re-run with `--apply` and confirm the live mutation happens only then.

**Acceptance Scenarios**:

1. **Given** a campaign with an `adbriefs/` brief and a set of audit-driven changes, **When** the operator runs `/adkit update` without `--apply`, **Then** the changes are staged into a proposed brief and the diff (current → proposed) is shown, and no live mutation occurs.
2. **Given** the operator has seen the diff, **When** they re-run with `--apply`, **Then** the live campaign is mutated and the diff shown matches the change that was applied.
3. **Given** a proposed change that is a no-op (produces an identical brief), **When** the operator runs `/adkit update`, **Then** the diff is empty and the operator is told there is nothing to apply.

---

### User Story 3 - Keep the brief in sync as the local source of truth after apply (Priority: P2)

After a successful live apply (via `/adkit create` publish or `/adkit update --apply`), the campaign's `adbriefs/` brief is updated to reflect the new live state, so the brief a operator reads tomorrow matches what is actually running.

**Why this priority**: Without post-apply sync the brief drifts from reality after the first update and stops being trustworthy as a source of truth. It depends on Stories 1 and 2 existing first, hence P2.

**Independent Test**: Apply an update with `--apply`, then inspect the `adbriefs/` brief and confirm it now contains the changed values (e.g. the new budget, the appended keywords) rather than the pre-change state.

**Acceptance Scenarios**:

1. **Given** a successful `--apply`, **When** it completes, **Then** the `adbriefs/` brief is overwritten with the proposed brief so it reflects the just-applied live state.
2. **Given** a failed or partial apply, **When** it errors, **Then** the on-disk brief is not silently left in a state that misrepresents the live account (the operator can tell brief and account diverged).

---

### Edge Cases

- **Update with no local brief yet** (a campaign created before this feature, or created elsewhere): when `adbriefs/<slug>.yaml` is absent for an `/adkit update` target, the tool hydrates a best-effort base brief from the live account read (the same read the audit already performs) so a diff can always be shown and the gate is never silently skipped; the hydrated brief is persisted on a successful apply and becomes the source of truth going forward.
- **Slug collision**: two campaigns whose names slugify to the same filename must not silently clobber each other's brief.
- **Manually edited brief drift**: the on-disk brief has been hand-edited and no longer matches live; the diff should still be computed against the on-disk brief (the declared intent) and the operator sees the difference.
- **Empty / no-change update**: a plan that changes nothing produces an empty diff and applies nothing.
- **Partial live apply failure**: a mutation that succeeds for some entities and fails for others must not leave the brief claiming a fully-applied state.
- **Multiple campaigns in one operation**: an update plan that touches more than one campaign must show a per-campaign diff and keep each campaign's brief separate.

## Clarifications

### Session 2026-07-18 (auto-answered by autopilot — see issue #26 comment)

- Q: When `/adkit update` targets a campaign with no `adbriefs/` brief yet, hydrate a base brief from the live account read, or refuse until a brief exists? → A: Hydrate a best-effort base brief from the live account read (the read the audit already does) so the diff gate always works; persist it on a successful apply. Refusing would force manual brief-authoring for every pre-existing campaign and is high-friction; hydrating is the reversible, low-friction default.
- Q: Is the "wait for confirmation" gate a new interactive y/n prompt, or the existing dry-run/`--apply` two-step? → A: The existing dry-run-by-default / `--apply` two-step — dry-run shows the diff and applies nothing, re-running with `--apply` is the confirmation. Keeps the flow scriptable/unattended-friendly and matches `/adkit update`'s current contract; a blocking prompt would break non-interactive use.
- Q: How is a filename collision between two distinct campaigns that slugify to the same name handled? → A: Refuse and surface the collision rather than overwrite; a brief file is only reused for the same campaign it already describes. Silent overwrite would destroy another campaign's source of truth — the one outcome the feature exists to prevent.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: `/adkit create` MUST write the new campaign's full, filled brief to a committed file under `adbriefs/` (one file per campaign, e.g. `adbriefs/<campaign-slug>.yaml`) as a step that completes **before** any live publish is attempted.
- **FR-002**: The `adbriefs/` brief MUST hold the complete current state of the campaign it names — campaign settings, ad groups, keywords, RSAs, negatives, and budget — sufficient to serve as the single local source of truth for that campaign. It reuses the existing brief format so it stays a valid input to the publish path.
- **FR-003**: `/adkit update` MUST apply audit-driven changes to the campaign's brief **first**, producing a proposed new brief, rather than mutating the live account directly from the plan.
- **FR-004**: Whenever a campaign brief changes (create over an existing brief, or update), the tool MUST show the diff between the existing brief and the proposed new brief before any live mutation.
- **FR-005**: No live change MUST be applied until the diff has been shown and the operator has confirmed. The confirmation mechanism MUST be the existing dry-run-by-default / `--apply` two-step (no new interactive prompt): a dry-run run shows the diff and applies nothing, and re-running with `--apply` is the confirmation that performs the live mutation — keeping the flow scriptable and consistent with `/adkit update`'s current contract. `/adkit create`'s publish MUST likewise surface the diff (against any existing brief) on a dry-run before a publish run applies it.
- **FR-006**: After a successful live apply, the `adbriefs/` brief MUST be updated to reflect the new live state so it stays the accurate local source of truth.
- **FR-007**: A no-op change (a proposed brief identical to the existing one) MUST produce an empty diff and apply nothing, and MUST tell the operator there is nothing to apply.
- **FR-008**: The brief filename MUST be derived deterministically from the campaign identity (a slug of the campaign name) so the same campaign always maps to the same file. If writing a brief would overwrite an existing `adbriefs/` file that belongs to a **different** campaign (same slug, distinct campaign), the tool MUST refuse and surface the collision to the operator rather than silently overwriting one brief with another's contents.
- **FR-013**: When `/adkit update` targets a campaign that has no `adbriefs/` brief yet, the tool MUST hydrate a best-effort base brief from the live account read (the audit read) to diff against, so the gate is never skipped for pre-existing or externally-created campaigns; that hydrated brief is persisted on a successful apply.
- **FR-009**: The diff shown MUST be human-readable and scoped to the campaign changing (a per-campaign diff when an operation touches multiple campaigns), so an operator can audit exactly what will change before confirming.
- **FR-010**: On a failed or partial apply, the tool MUST NOT leave the on-disk brief asserting a fully-applied state; the operator MUST be able to tell that brief and live account diverged.
- **FR-011**: The shared brief format and the write-brief → diff → apply flow MUST be documented in a shared reference so both `/adkit create` and `/adkit update` describe one consistent behavior, and `create.md`/`update.md` MUST be updated to reflect the new gate (removing the stale "Publishes are not persisted locally" guidance).
- **FR-012**: `adbriefs/` MUST be a tracked directory in the repository so campaign briefs are versioned alongside the code.

### Functional Programming Constraints

- The diff and brief-serialization logic MUST be pure functions of their inputs (existing brief + proposed change → new brief; two briefs → a diff value), with no side effects; filesystem reads/writes and Google Ads API calls stay isolated at the command edges.
- Applying a plan to a brief MUST return a new brief value rather than mutating the input brief in place (immutable data, per the repo's functional-style constitution).
- The brief MUST be parsed once at the boundary into the existing strongly-typed brief type ("parse, don't validate"); downstream diff/apply/persist code operates on the parsed type and does not re-validate fields the boundary already established.
- No classes for logic; only error types and unavoidable third-party SDK objects may be classes.

### Platform Constraints

- Change is confined to the `adkit` skill: its TypeScript CLI under `skills/adkit/scripts/src` (the `create`/`update` entrypoints and shared libs) and its `reference/*.md` workflow docs. Reuse the existing brief schema; introduce no new runtime dependency unless a diff renderer is genuinely required, in which case keep it minimal.
- Existing CLI invocation surfaces MUST keep working: `/adkit create <processed-file>` and `/adkit update <plan> [--apply]` with their current arguments; the dry-run-by-default / `--apply` contract is preserved.
- Briefs are written under a new top-level `adbriefs/` directory in the repo root; the JSON-envelope contract on stdout for machine-readable subcommands is preserved.

## Notes

- Generated/updated by /speckit-specify from GitHub issue #26.
- The `adbriefs/` brief becomes the local source of truth; today `create` scaffolds a brief to a throwaway `$TMPDIR` path and discards it on publish (`create.md` states "Publishes are not persisted locally"). This feature persists it and adds a review-the-change gate before any live mutation. A human reviews the draft PR before merge.
