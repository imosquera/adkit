# Tasks: `/adkit audit` closes the loop — keyword IDs + landing-page PSI diagnosis

**Feature**: `030-adkit-audit-ids-enabled-psi` | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

## Format: `[ID] [P?] [Story] Description [(depends on ...)]`

## Path Conventions

All source under `skills/adkit/scripts/`. Run tests with `cd skills/adkit/scripts && npx vitest run`.

---

## Phase 1: Setup

- [ ] T001 Ensure `skills/adkit/scripts` deps are installed (`cd skills/adkit/scripts && npm install`); confirm baseline `npx vitest run` and `npx tsc --noEmit` are green before any change.

## Phase 2: Foundational

_No cross-cutting foundational work — each story is an additive slice on existing modules. Proceed to the story phases._

---

## Phase 3: User Story 1 — keyword `adGroupId` + `matchType` on every keyword row (P1)

**Goal**: Every audit per-keyword row carries numeric `adGroupId` and keyword `matchType`, so a keyword pause/update plan is authorable from one audit run.

**Independent test**: `npx vitest run` — builder selects the new fields; `normalizeKeywordMetricsRow` carries them; live audit JSON `.keywordCpc` rows include `adGroupId` + `matchType`.

- [ ] T002 [P] [US1] Extend `auditKeywordMetricsQuery` in `skills/adkit/scripts/src/gaql/builders.ts` to also select `ad_group.id` and `ad_group_criterion.keyword.match_type` (keep the existing `ad_group_criterion.status = 'ENABLED'` and `lastNDays` conditions). (depends on T001)
- [ ] T003 [P] [US1] Extend `RawKeywordMetricsRow` and `normalizeKeywordMetricsRow` in `skills/adkit/scripts/src/audit/rows.ts` to carry `ad_group.id` and widen `ad_group_criterion.keyword` to `{ text; match_type? }`, mapping to `adGroupId: number` and `matchType: string | null`. (depends on T001)
- [ ] T004 [US1] Add `adGroupId: number` and `matchType: string | null` to the `KeywordCpc` interface in `skills/adkit/scripts/src/audit/types.ts`. (depends on T003)
- [ ] T005 [US1] Thread the new fields through `keywordCpc()` in `skills/adkit/scripts/src/bin/audit.ts` (populate `adGroupId`/`matchType` from the normalized row into each `KeywordCpc`). (depends on T002, T003, T004)
- [ ] T006 [US1] Surface `matchType` (and, where useful, `adGroupId`) in `renderKeywordCpc` / the human table in `skills/adkit/scripts/src/audit/render.ts` without breaking existing columns. (depends on T005)
- [ ] T007 [P] [US1] Add/extend `skills/adkit/scripts/src/gaql/builders.test.ts` to assert `auditKeywordMetricsQuery` fields include `ad_group.id` and `ad_group_criterion.keyword.match_type` (and still contains the ENABLED condition — see US2). (depends on T002)
- [ ] T008 [P] [US1] Add `skills/adkit/scripts/src/audit/rows.test.ts` cases asserting `normalizeKeywordMetricsRow` yields `adGroupId` (number) and `matchType` (string, and `null` when `match_type` is absent). (depends on T003)

**Checkpoint**: US1 shippable — keyword rows are pause-plan-ready with no `report` round-trip.

---

## Phase 4: User Story 2 — ENABLED-filter regression-guard (confirmation) (P2)

**Goal**: Confirm paused keywords never feed the cluster-split math; the filter already shipped in PR #16.

**Independent test**: `npx vitest run gaql/builders.test.ts` — the ENABLED guard test passes.

- [ ] T009 [US2] Verify `auditKeywordMetricsQuery` in `skills/adkit/scripts/src/gaql/builders.ts` retains `ad_group_criterion.status = 'ENABLED'` and that the existing guard test in `builders.test.ts` covers it; confirm no sibling keyword read (`auditKeywordsQuery`, `auditQualityScoreQuery`) reintroduces paused-keyword spend into `keywordCpc`/`clusterSplits`. Record the confirmation in the PR description. If a gap is found, add the missing condition + a guard test; otherwise no code change. (depends on T007)

**Checkpoint**: US2 confirmed (expected: no new code).

---

## Phase 5: User Story 3 — PageSpeed Insights diagnosis on low landing-page scores (P3)

**Goal**: When `landing_page_experience ≤ 2` and an operator-supplied PSI key is present, fold mobile LCP / render-blocking / unused-JS per distinct final URL into the report; degrade gracefully otherwise.

**Independent test**: `npx vitest run lib/psi.test.ts`; live audit with/without `PAGESPEED_API_KEY` produces a `psi` block or a clear skip note; a URL is hit at most once.

- [ ] T010 [P] [US3] Add `PsiResult`, `PsiOpportunity`, and the discriminated failure variant (`{ url, error }`) types to `skills/adkit/scripts/src/audit/types.ts`. (depends on T001)
- [ ] T011 [US3] Create pure module `skills/adkit/scripts/src/lib/psi.ts`: `buildPsiRequestUrl(finalUrl, apiKey)` (mobile strategy) and `parsePsiResponse(unknown): PsiResult | { url, error }` via a `zod` schema (extract LCP ms, render-blocking + unused-JS opportunities). No network/SDK imports. (depends on T010)
- [ ] T012 [US3] Add pure selection helper in `lib/psi.ts` (or `audit/scoring.ts`): from quality-score entries + per-ad final URLs, compute the **distinct** set of final URLs whose `landingPageExp` is below-average (`≤ 2`). (depends on T010)
- [ ] T013 [US3] Add the IO edge function `runPsi()` in `skills/adkit/scripts/src/bin/audit.ts`: read `PAGESPEED_API_KEY` / `--psi-key`; when absent OR no qualifying URL, skip with an explicit note and make zero calls; otherwise `fetch` each distinct URL once, parse via `parsePsiResponse`, and collect results (per-URL failure recorded, never aborts). (depends on T011, T012)
- [ ] T014 [US3] Fold the PSI results into output: a `psi` object (keyed by final URL) in the JSON envelope on stdout, and a human summary under the landing-page/quality-score section on stderr in `skills/adkit/scripts/src/audit/render.ts` + `bin/audit.ts`. (depends on T013)
- [ ] T015 [US3] Wire the `--psi-key` flag into the audit arg parser in `skills/adkit/scripts/src/bin/audit.ts` (and `cli/args.ts` if shared), documented in `audit.md`/skill help. (depends on T013)
- [ ] T016 [P] [US3] Add `skills/adkit/scripts/src/lib/psi.test.ts`: parse a captured PSI JSON fixture → `PsiResult`; assert threshold (`≤ 2`) + distinct-URL dedup selection; assert a malformed response yields `{ url, error }` without throwing. (depends on T011, T012)

**Checkpoint**: US3 shippable — low-LP findings carry an actionable per-URL diagnostic; graceful without a key.

---

## Phase 6: Polish & Cross-Cutting

- [ ] T017 Update `skills/adkit/audit.md` (skill doc) to describe the new keyword-row fields, the `--psi-key`/`PAGESPEED_API_KEY` option, and the graceful-skip behavior. (depends on T006, T014, T015)
- [ ] T018 Run full gates from `skills/adkit/scripts`: `npx vitest run`, `npx tsc --noEmit`, `npx eslint .`, the adkit constitution audit, and the parse-dont-validate scanner over `lib/psi.ts`; drive all to green. (depends on T006, T009, T014, T015, T016, T017)

---

## Dependencies (story completion order)

- **US1 (P1)** → independent; ships first (MVP).
- **US2 (P2)** → touches the same builder/test file as US1 (T007), so ordered after it to avoid churn; expected to be a no-op confirmation.
- **US3 (P3)** → independent of US1/US2 at the type/module level; can proceed in parallel but is sequenced last by priority.

## Execution Wave DAG

- **Wave 0**: T001
- **Wave 1** (parallel, after T001): T002, T003, T010
- **Wave 2** (parallel): T004 (after T003), T007 (after T002), T008 (after T003), T011 (after T010), T012 (after T010)
- **Wave 3** (parallel): T005 (after T002,T003,T004), T009 (after T007), T016 (after T011,T012), T013 (after T011,T012)
- **Wave 4** (parallel): T006 (after T005), T014 (after T013), T015 (after T013)
- **Wave 5**: T017 (after T006,T014,T015)
- **Wave 6**: T018 (after T006,T009,T014,T015,T016,T017)

## Implementation strategy

MVP = US1 (Wave 0→3 for the US1 tasks): the highest-frequency loop closes first and is independently shippable. US2 is a cheap confirmation. US3 is the largest slice and is deliberately last so it can be reviewed on its own without blocking the keyword-id win.
