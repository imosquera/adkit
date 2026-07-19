# Implementation Plan: Encode headline & description best practices into `/adkit gtm` ad-copy authoring

**Branch**: `031-adcopy-best-practices` | **Date**: 2026-07-19 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/031-adcopy-best-practices/spec.md`

## Summary

Encode proven Google Ads headline & description best practices into the ad-copy authoring rules so `/adkit gtm` generates persuasion-driven, quality-score-aligned RSA copy by default. This is a **documentation-only** change to two reference markdown files the LLM-driven `/adkit gtm` phase reads: add "Persuasion Angles" and "Quality-Score Alignment" sections to `skills/adkit/reference/google/4-ad-copy.md`, and add one concise binding principle in the `/adkit gtm` Ad Copy Phase (`skills/adkit/reference/gtm.md`) that cites those sections. All existing hard structural constraints (15 headlines / 4 descriptions, char caps, no invented stats, no pinning) are preserved verbatim.

## Technical Context

**Language/Version**: N/A — no code. Prompt/reference markdown consumed by the LLM-driven `/adkit gtm` skill.
**Primary Dependencies**: None. Edits `skills/adkit/reference/google/4-ad-copy.md` and `skills/adkit/reference/gtm.md` only.
**Storage**: N/A (markdown files in the repo).
**Testing**: Documentation review + a manual read-through against the issue's acceptance criteria; no automated test surface is created or changed. Existing repo gates (typecheck/lint/vitest) must remain green — this change touches no TypeScript, so it cannot regress them.
**Target Platform**: The `/adkit gtm` authoring workflow (reference docs).
**Project Type**: Single project — reference-doc edit within `skills/adkit/reference/`.
**Performance Goals**: N/A.
**Constraints**: Must not change any existing numeric constraint in the Ad Copy Phase (15/4 counts, ≤30/≤90 char caps, ≥2 numbers, ≥1 CTA, keyword-in-≥3, no shared opening-3-words, no pins). Additions are qualitative. The two docs must stay mutually consistent (`gtm.md` cites `4-ad-copy.md` as canonical, no duplication that could drift).
**Scale/Scope**: Two files edited; ~2 new sections in `4-ad-copy.md`, ~1 new principle + light cross-reference in `gtm.md`. `/adkit create` consumes the resulting copy unchanged.

## Constitution Check

*GATE: Must pass before Phase 0. Re-check after design.*

The project constitution at `.specify/memory/constitution.md` is an unfilled template (placeholder principle names); `constitution_audit.py validate` treats it as a no-op (confirmed exit 0). The binding conventions for this repo live in `CLAUDE.md`; this feature ships no executable code, so most of them apply vacuously, and the ones about content discipline are honored:

- **Functional style** (CLAUDE.md rule 1): "same input → same output, no side effects in the core logic". No code is added or changed, so no side-effectful or class-based logic is introduced. **PASS**
- **Parse, don't validate** (CLAUDE.md rule 2): "Turn untrusted/loose input into a precise, well-typed value once, at the edge". No new input boundary or parsing path is created; the change is authoring guidance for copy generation, not data handling — nothing to re-validate. **PASS**
- **No redundant downstream checks** (CLAUDE.md rule 2): the design deliberately keeps `4-ad-copy.md` as the single canonical source and has `gtm.md` cite it rather than duplicate the rules, so the guidance is stated once and cannot drift into contradictory copies. **PASS**
- **No classes for logic** (CLAUDE.md rule 1): no code, hence no classes. **N/A**

No violations; Complexity Tracking is empty.

## Project Structure

### Documentation (this feature)

```
specs/031-adcopy-best-practices/
├── spec.md              # Feature specification (/speckit-specify)
├── plan.md              # This file (/speckit-plan)
├── tasks.md             # Task breakdown (/speckit-tasks)
└── requirements.md      # Spec quality checklist
```

### Source Code (repository root)

The change edits existing reference docs only — no new source files:

```
skills/adkit/reference/
├── gtm.md                    # EDIT: add one binding Ad Copy Phase principle citing 4-ad-copy.md
└── google/
    └── 4-ad-copy.md          # EDIT: add "Persuasion Angles" + "Quality-Score Alignment" sections
```

**Structure Decision**: Single project; a targeted two-file reference-doc edit under `skills/adkit/reference/`. No source, config, or test files are added. `4-ad-copy.md` remains the canonical home for the persuasion/quality-score guidance; `gtm.md`'s Ad Copy Phase references it (mirroring how it already delegates headline-pools/pinning), keeping the two documents consistent and drift-free (FR-009).

## Parse Boundaries

N/A — no TypeScript or Python in this feature. The change edits reference markdown (`skills/adkit/reference/google/4-ad-copy.md`, `skills/adkit/reference/gtm.md`) that the LLM-driven `/adkit gtm` skill reads as authoring guidance. It introduces no new trust boundary, no untrusted-input parsing path, and no domain types — there is nothing to parse. Existing runtime parse boundaries (e.g. the `zod` idea/plan schemas, the GAQL id escapers, CLI arg parsers) are untouched.

## Complexity Tracking

No Constitution Check violations; nothing to justify.
