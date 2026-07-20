# Implementation Plan: `/adkit audit` closes the loop — keyword IDs + landing-page PSI diagnosis

**Branch**: `030-adkit-audit-ids-enabled-psi` | **Date**: 2026-07-18 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/030-adkit-audit-ids-enabled-psi/spec.md`

## Summary

Close two manual second-pass loops in `/adkit audit`:

1. **Keyword IDs (US1, P1)** — thread the numeric `adGroupId` and keyword `matchType` from Google Ads through the keyword-CPC read into the audit's per-keyword rows, so a keyword pause/update plan (`{customerId, keywords:[{adGroupId, pause:[{text, matchType}]}]}`) is authorable from one audit run with no `report` round-trip.
2. **Landing-page diagnosis (US3, P3)** — when a final URL scores `landing_page_experience ≤ 2`, run PageSpeed Insights (mobile) against each distinct final URL using an **operator-supplied** API key, and fold LCP / render-blocking / unused-JS signals into both the JSON and the human table. Degrade gracefully (skip with a note) when no key is set.

US2 (the ENABLED filter) already shipped in PR #16 (`55de470`) with a guard test; this plan only **confirms** the regression-guard and checks no sibling keyword read reintroduces paused spend — no new code unless a gap surfaces.

## Technical Context

**Language/Version**: TypeScript (ESM, NodeNext) on Node 26; run via `tsx`.

**Primary Dependencies**: `google-ads-api` (behind the reversible SDK / google-ads-mcp `SearchArgs` seam), `zod` (already a dependency), built-in global `fetch` (available on Node 26) for the PageSpeed Insights HTTP call — no new runtime dependency.

**Storage**: N/A — the audit is a stateless read; output is JSON on stdout + a human table on stderr.

**Testing**: `vitest` (`npx vitest run`) in `skills/adkit/scripts`.

**Target Platform**: CLI (`ads.sh audit`) on developer/operator machines and CI.

**Project Type**: Single TypeScript CLI project (`skills/adkit/scripts`).

**Performance Goals**: PSI adds at most one HTTP call per *distinct* below-average final URL per run (deduped); zero PSI calls when no score is below-average or no key is set. No change to the Google Ads read count beyond the two extra selected fields on the existing keyword-metrics query.

**Constraints**: PSI is an external, best-effort dependency — a failed/timed-out/rate-limited call for one URL degrades that URL's diagnostic to unavailable-with-reason and never aborts the audit. No cloud-credential creation/deletion (operator supplies the key).

**Scale/Scope**: Small, additive change within one existing CLI; no new package, no new sub-config.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

The project constitution at `.specify/memory/constitution.md` is an unpopulated template — it defines no named principles, so `constitution_audit.py list` matches no principle headings and `validate` treats the gate as a no-op (exits zero). There are therefore no constitution principles to quote against.

The binding engineering rules for this change come instead from `CLAUDE.md` (functional style; parse-don't-validate) and the enabled `parse-dont-validate` / `functional-constitution` presets. Compliance against those is designed into the **Parse Boundaries** and **Functional-style design** sections below rather than asserted here. Verdict: **PASS** (no constitution principles defined; engineering-rule compliance carried by the Parse Boundaries section).

## Project Structure

### Documentation (this feature)

```text
specs/030-adkit-audit-ids-enabled-psi/
├── plan.md                 # This file (/speckit-plan output)
├── spec.md                 # Feature spec (/speckit-specify output)
├── requirements.md         # Spec quality checklist (under checklists/)
├── quickstart.md           # Validation guide (/speckit-plan output)
└── tasks.md                # /speckit-tasks output (not created here)
```

### Source Code (repository root)

```text
skills/adkit/scripts/src/
├── gaql/
│   └── builders.ts         # auditKeywordMetricsQuery: add ad_group.id + keyword.match_type fields
├── audit/
│   ├── rows.ts             # RawKeywordMetricsRow + normalizeKeywordMetricsRow: carry adGroupId/matchType
│   ├── types.ts            # KeywordCpc: add adGroupId + matchType; new PsiFinding / PsiResult types
│   └── render.ts           # renderKeywordCpc: surface matchType/adGroupId; render PSI block on stderr
├── lib/
│   └── psi.ts              # NEW — pure PSI response→PsiResult parser + pure request-URL shaping (no IO)
└── bin/
    └── audit.ts            # IO shell: keywordCpc() threads new fields; new runPsi() edge fn gated on key + low LP

skills/adkit/scripts/src/**/*.test.ts   # vitest units:
    gaql/builders.test.ts   # confirm ENABLED guard (exists); assert new ad_group.id/match_type fields present
    lib/psi.test.ts         # NEW — parse a PSI JSON fixture → PsiResult; dedup + threshold logic
    audit/rows.test.ts      # normalizeKeywordMetricsRow carries adGroupId/matchType (incl. missing matchType)
```

**Structure Decision**: Single existing TypeScript CLI. The two Google-Ads-field additions ride the existing `SearchArgs` builder + row-normalizer + `KeywordCpc` type chain (no new query resource). The PSI integration is a new pure module `lib/psi.ts` (request-URL shaping + response parsing) plus a thin IO edge function `runPsi()` in `bin/audit.ts` that performs the `fetch` calls; all decision logic (which URLs qualify, dedup, threshold, response→finding mapping) is pure and unit-tested.

## Design detail (folded Phase 0 research + Phase 1 data model)

### Decisions (research)

- **Decision**: Surface `adGroupId` + `matchType` by extending the *existing* `auditKeywordMetricsQuery` (`keyword_view`) rather than joining a second read.
  **Rationale**: `keyword_view` already exposes `ad_group.id` and `ad_group_criterion.keyword.match_type` on the same row as `metrics.average_cpc`; one extra field pair avoids a second round-trip and keeps the cluster math on a single row source. **Alternatives**: reuse `auditKeywordsQuery` (has `ad_group.name` but not id/matchType, and no metrics) — rejected, would need a join keyed on ad-group name.
- **Decision**: PSI credential is operator-supplied (`PAGESPEED_API_KEY` env or `--psi-key`), never auto-provisioned.
  **Rationale**: recorded in spec Clarifications (2026-07-18) — auto-creating an unrestricted GCP key needs `apikeys.admin` IAM and leaks a live key on any crash. **Alternatives**: temp-key create/delete lifecycle from the issue — rejected as audit behavior, preserved as an operator runbook in `quickstart.md`.
- **Decision**: Use built-in global `fetch` (Node 26) for `https://pagespeedonline.googleapis.com/pagespeedapi/v5/runPagespeed`, mobile strategy; parse the response with a `zod` schema.
  **Rationale**: no new dependency; `zod` is already used across the project and gives a single boundary parser. **Alternatives**: `node-fetch`/`undici` — rejected, redundant on Node 26.
- **Decision**: PSI runs only when (a) a key is present AND (b) at least one qualifying final URL has `landing_page_experience ≤ 2`; each distinct URL is hit at most once.
  **Rationale**: FR-006 — no surprise external calls; dedup avoids redundant hits when one URL is shared across ad groups.

### Data model (types)

- **`KeywordCpc`** (extend, `audit/types.ts`): add `adGroupId: number` and `matchType: string | null` (null when a criterion has no populated match type). Existing `text`, `avg_cpc`, `avg_cpc_micros` unchanged; the open `[key: string]: unknown` index stays for the generic cluster helpers.
- **`RawKeywordMetricsRow`** (extend, `audit/rows.ts`): add `ad_group?: { id: number }` and widen `ad_group_criterion.keyword` to `{ text: string; match_type?: string }`.
- **`PsiResult`** (new, `audit/types.ts`): `{ url: string; lcpMs: number | null; renderBlocking: PsiOpportunity[]; unusedJs: PsiOpportunity[] }` where `PsiOpportunity = { title: string; savingsMs: number | null }`. A failed URL is represented as `PsiResult` with an `error: string` discriminant field (`{ url; error }`), so downstream rendering handles success/failure as a tagged shape rather than a null soup.
- **PSI report attachment**: keyed by distinct final URL; rendered under the existing landing-page/quality-score section (stderr) and added as a `psi` object in the JSON envelope (stdout).

## Parse Boundaries

This feature is TypeScript. Trust boundaries and their parsers:

1. **Trust boundaries** (untrusted data in):
   - **Google Ads rows** for the keyword-metrics read arrive as loose plain objects from the SDK / google-ads-mcp seam (`RawKeywordMetricsRow`). Kept as the explicit `Raw…` interface (never `any`) and passed straight to the existing normalizer.
   - **PageSpeed Insights JSON** from `fetch(...).json()` — the response is `unknown` (never `any`) until parsed.
   - **CLI/env credential** — `PAGESPEED_API_KEY` env and `--psi-key` flag are untyped strings read once at the edge.
2. **Domain types** (earned, trusted downstream): `KeywordCpc` (now carrying `adGroupId: number`, `matchType: string | null`), `KeywordMetricsRow`, and the new `PsiResult` / `PsiOpportunity`. `adGroupId` is a numeric Google Ads id already guarded digits-only by `gaqlId` at the query boundary; it is confusable with `campaign.id`, so both remain distinct named fields on their row types (not bare `number` params passed positionally).
3. **Parsers** (raw → domain, one home each):
   - `normalizeKeywordMetricsRow` (in `audit/rows.ts`) maps `RawKeywordMetricsRow → KeywordMetricsRow`, zero-filling metrics and carrying the new id/matchType fields. It is the single place the loose row is narrowed.
   - `parsePsiResponse` (new, in `lib/psi.ts`) maps the `unknown` PSI JSON to `PsiResult` via a **zod** schema, returning a discriminated result: a successful `PsiResult` or a `{ url, error }` variant on parse failure — never a bare boolean, never a thrown error escaping the module. The zod `.safeParse` boundary lives only in `lib/psi.ts`.
4. **Library choice**: **zod** (already a project dependency) for the PSI response parser — preferred over a hand-rolled cast so the boundary is declarative and the `unused-js` / `render-blocking` audit shapes are validated once. The Google Ads row normalizer stays hand-rolled to match the existing `rows.ts` convention (all sibling normalizers are hand-rolled there; introducing zod for one row type would split the convention).

## Functional-style design (CLAUDE.md compliance)

- New logic — field selection in the builder, row shaping, PSI request-URL construction, PSI response→`PsiResult` mapping, distinct-URL dedup, `≤ 2` threshold filtering — are **pure functions** returning new values (`map`/`filter`/`reduce`/spread), no parameter mutation, no in-loop accumulation.
- All I/O stays at the edges: Google Ads reads (existing `search()`), the PSI `fetch` calls (new `runPsi()` edge fn in `bin/audit.ts`), credential reads, and stdout/stderr emission. `lib/psi.ts` imports no SDK and performs no network I/O — it only shapes request URLs and parses responses.
- No new classes (per CLAUDE.md); the only permitted class would be a typed PSI error, and even that is modeled as a discriminated `{ url, error }` result rather than a thrown class.

## Complexity Tracking

> No Constitution Check violations to justify (no principles defined). PSI is additive and gated; it introduces one new pure module and one edge function, both small.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| (none)    | —          | —                                    |
