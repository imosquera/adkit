# Feature Specification: `update` rewrites can set the RSA display path (path1/path2)

**Feature Branch**: `014-adkit-launch-fixes`

**Created**: 2026-07-18

**Status**: Draft

**Input**: Issue #14 "adkit skill: bugs & friction found in a live campaign-launch session" — item 5(a). Items 1, 2, 3, 4, 5(b), 6, 7 were already fixed on `main` by PR #10 (commit `6565ada`), verified during the autopilot audit (see the issue thread). This spec covers only the one remaining gap: `update`'s `rewrites` op cannot change an existing Responsive Search Ad's display-URL path (`path1`/`path2`).

## Clarifications

### Session 2026-07-18 (auto-answered by autopilot)

- Q: Reuse the create-side display-path validation, or a separate one? → A: Reuse the same rules (`displayPath` in `lib/schema.ts`: ≤15 chars, lowercase-transform, no space/`/`, TODO-placeholder guard, `path2`-requires-`path1`) so create and update cannot drift.
- Q: Should `update` be able to *clear* a display path (send empty to remove)? → A: No — out of scope. Omitting `path1`/`path2` leaves the existing path untouched; there is no remove verb.
- Q: Lowercase-transform paths on the update path too? → A: Yes, mirror create — Google display paths are case-insensitive and create already lowercases.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Fix a bad display path via `update` (Priority: P1)

An operator launched a campaign whose RSA display path is `free-demo`, which trips Google's FREE_DESKTOP_SOFTWARE policy and gets the ad disapproved. They want to change the display path to a compliant value (e.g. `demo`/`trial`) through the supported `update` workflow — a `rewrites` entry — without hand-rolling a raw `mutate_ads` call with a field mask.

**Why this priority**: This is the only unfixed item in issue #14 and it caused real friction (a hand-rolled mutate on a live ad). The create path already supports `path1`/`path2`; `update` should have parity so display-path fixes are a first-class, dry-runnable, guard-railed operation.

**Independent Test**: Author a `rewrites` plan entry that includes `path1` (and optionally `path2`) alongside `adId`/`headlines`/`descriptions`, run `update` against it, and confirm the built RSA update op carries `path1`/`path2` on the `responsive_search_ad` resource. Fully testable at the op-builder level with no live API call.

**Acceptance Scenarios**:

1. **Given** a `rewrites` entry with `path1: "demo"`, **When** the update op is built, **Then** the `responsive_search_ad` resource includes `path1: "demo"` and the SDK-derived update mask therefore updates the display path.
2. **Given** a `rewrites` entry with `path1: "demo"` and `path2: "trial"`, **When** the update op is built, **Then** both `path1` and `path2` are present on the resource.
3. **Given** a `rewrites` entry with **no** `path1`/`path2`, **When** the update op is built, **Then** neither field is present on the resource and the existing display path is left untouched (unchanged behavior for callers that only rewrite copy).

### Edge Cases

- **`path2` without `path1`**: rejected at the boundary with a clear message ("path2 requires path1"), matching the create schema — Google fills the display path in order, so a lone `path2` is invalid.
- **Empty-string path**: rejected with "must be non-empty when provided (omit it instead)" rather than silently sending an empty segment.
- **Path with a space or `/`**: rejected ("may not contain spaces or '/'") — a display path is a single URL segment.
- **Leftover scaffold `TODO` in a path**: rejected, consistent with the create schema's placeholder guard.
- **Path longer than 15 chars**: rejected — Google's hard limit on each display-path segment.
- **`appendHeadlines` op**: unaffected — appends never touch the display path.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The `update` `rewrites` op MUST accept optional `path1` and `path2` fields on a rewrite entry and, when present, set them on the `responsive_search_ad` resource so the display path is updated.
- **FR-002**: When a rewrite entry omits `path1`/`path2`, the built op MUST NOT include those fields, leaving the ad's existing display path unchanged (no regression for copy-only rewrites).
- **FR-003**: The system MUST reject a rewrite entry whose `path2` is provided without `path1`, with the message "path2 requires path1".
- **FR-004**: The system MUST reject a display-path value that is empty, contains whitespace or `/`, exceeds 15 characters, or still holds a `TODO` scaffold placeholder — reusing the same rules the create path enforces so create and update stay consistent.
- **FR-005**: Path validation MUST happen once, at the plan boundary (parse step), so the op-builder receives already-valid values and performs no re-validation.
- **FR-006**: The dry-run summary line for a rewrite that changes the display path SHOULD indicate the path change so an operator can see it before `--apply`.

## Functional Programming Constraints

- The path parse/validation and the op construction MUST be pure functions (input → output, no I/O). Network mutation stays at the existing imperative IO edge in `apply-fixes.ts`.
- No parameter mutation; build the `responsive_search_ad` resource by constructing a new object (spread / conditional field inclusion), consistent with `createResponsiveSearchAd`.

## Platform Constraints

- TypeScript, run via `tsx`; validation via `zod`, reusing the existing `displayPath` schema / rules in `src/lib/schema.ts` where practical.
- No new runtime dependencies.
