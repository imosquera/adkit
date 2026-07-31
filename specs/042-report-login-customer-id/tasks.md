# Tasks: `report` resolves the login-customer-id instead of hardcoding a placeholder

**Feature**: `042-report-login-customer-id` | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

**Package root**: `skills/adkit/scripts/` — all `src/...` paths below are relative to it.

**Tests**: Requested. FR-010 mandates a regression guard, and the spec's acceptance
scenarios are written as a resolution matrix, so test tasks are first-class here.

## Phase 1: Setup

- [ ] T001 Confirm the package toolchain runs clean before any edit: `npm ci` (or `npm install`) then `npx tsc --noEmit`, `npx vitest run`, `npx eslint .` in `skills/adkit/scripts/`, recording the pre-change baseline pass counts

## Phase 2: Foundational

**Blocking**: T002 defines the type the whole feature is expressed in; T003 is what makes
that type expressible at the `report` seam. Every user story depends on both.

- [ ] T002 Add the pure `resolveLoginCustomerId(managerFlag, env)` resolver to `src/cli/args.ts`, returning `string | null | typeof KEEP_YAML_LOGIN` — first non-blank candidate of (flag, `env["GOOGLE_ADS_LOGIN_CUSTOMER_ID"]`) wins and is `normalizeId`'d, otherwise `KEEP_YAML_LOGIN`; no I/O, no `process.env` read inside the body (depends on T001)
- [ ] T003 Widen the injected client-factory type in `src/bin/report.ts` from `(manager: string) => AdsClient` to `(login: string | null | typeof KEEP_YAML_LOGIN) => AdsClient` so `loadReadClient` fits the seam unnarrowed, importing `KEEP_YAML_LOGIN` from `../lib/auth.js` (depends on T001)

---

## Phase 3: User Story 1 — Direct leaf, no manager flag (P1)

**Goal**: `report <leaf> --days 7` with no manager flag sends no fabricated login header
and produces a report.

**Independent test**: Call `main` with no `--manager`, an env map with no
`GOOGLE_ADS_LOGIN_CUSTOMER_ID`, and a spy factory; assert the factory received
`KEEP_YAML_LOGIN` and never the string `"2222222222"`.

- [ ] T004 [US1] Delete `export const DEFAULT_MANAGER = "2222222222"` from `src/bin/report.ts` and change `parseArgs` to default `manager` to `null` (flag absent) instead of the placeholder (depends on T003)
- [ ] T005 [US1] In `main` in `src/bin/report.ts`, resolve once via `resolveLoginCustomerId(args.manager, process.env)`, call `requireDigits("manager", ...)` once on the resolved value when it is a string, then pass the resolved value to `clientFactory` — replacing the current `clientFactory(normalizeId(args.manager))` call (depends on T002, T004)
- [ ] T006 [P] [US1] Update the `manager_id` output field in `buildReport`/its shape in `src/bin/report.ts` to carry the resolved id or explicit `null`, keeping the key always present (depends on T005)
- [ ] T007 [P] [US1] Update the failure text in `src/bin/report.ts` so it names the manager actually used, and says no manager was used when none resolved, instead of interpolating a fabricated id (depends on T005)
- [ ] T008 [US1] Add tests in `src/bin/report.test.ts`: with no flag and an empty env, the client factory receives `KEEP_YAML_LOGIN`; `manager_id` is `null` in the emitted report; the error path renders no fabricated id (depends on T005, T006, T007)

**Checkpoint**: US1 is independently shippable — the reported defect is fixed.

---

## Phase 4: User Story 2 — MCC-nested leaf inherits the real login (P1)

**Goal**: With credentials carrying `login_customer_id`, a zero-flag run uses that value.

**Independent test**: Assert `loadClient` maps `KEEP_YAML_LOGIN` to the yaml's
`login_customer_id`, and that `report`'s resolver produces `KEEP_YAML_LOGIN` in exactly
that situation.

- [ ] T009 [US2] Add a test in `src/bin/report.test.ts` asserting that when the resolver yields `KEEP_YAML_LOGIN` the value reaches `loadReadClient` unmodified (spy factory identity check, not a string comparison) (depends on T005)
- [ ] T010 [P] [US2] Add a test in `src/lib/auth.test.ts` (or extend the existing coverage there) pinning the `KEEP_YAML_LOGIN` → yaml `login_customer_id` mapping and the `undefined`-yaml → header-omitted case, so US1 and US2 cannot regress into each other (depends on T002)

**Checkpoint**: Both zero-flag paths — direct and MCC-nested — are covered.

---

## Phase 5: User Story 3 — Explicit override + normalization (P2)

**Goal**: `--manager` beats env beats credentials; ids are normalized and digit-checked.

**Independent test**: A table test over every combination of flag / env / neither,
including dashed and blank inputs, asserting the exact resolved value.

- [ ] T011 [P] [US3] Add the precedence matrix to `src/cli/args.test.ts`: flag wins over env; env wins over absent flag; neither yields `KEEP_YAML_LOGIN`; dashed `222-222-2222` normalizes to `2222222222` from either tier (depends on T002)
- [ ] T012 [P] [US3] Add blank-env cases to `src/cli/args.test.ts`: `""` and `"   "` are treated as absent and fall through to `KEEP_YAML_LOGIN`, never as an explicit "no manager" (FR-007) (depends on T002)
- [ ] T013 [US3] Add a test in `src/bin/report.test.ts` asserting a non-digits resolved manager fails via `requireDigits` with the standard argument error rather than reaching the client (depends on T005)

**Checkpoint**: The full resolution contract is pinned.

---

## Phase 6: Polish & Cross-Cutting

- [ ] T014 [P] Remove the `via 222-222-2222` default from the argument hint in `skills/adkit/reference/report.md` and document the new precedence chain including `GOOGLE_ADS_LOGIN_CUSTOMER_ID` (depends on T005)
- [ ] T015 [P] Add the FR-010 regression guard: a test asserting the literal `2222222222` no longer appears as a runtime default in `src/bin/report.ts` (source-level assertion, scoped to the entrypoint so unrelated fixture uses in other tests are not caught) (depends on T004)
- [ ] T016 Update the pre-existing `report.test.ts` assertions that encode the old default (`:46-47`, `:62`, `:71`, `:79`, `:94`, `:410-419`, `:530-541`) to the new contract, keeping the `--manager` override case intact (depends on T004, T005)
- [ ] T017 Run the full gate set in `skills/adkit/scripts/`: `npx tsc --noEmit`, `npx vitest run`, `npx eslint .` — all green, with no reduction in test count versus the T001 baseline (depends on T008, T009, T010, T011, T012, T013, T014, T015, T016)

---

## Execution Wave DAG

Tasks in the same wave have no dependency on one another and can run in parallel.

| Wave | Tasks | Notes |
|---|---|---|
| W0 | T001 | Baseline gates before any edit |
| W1 | T002, T003 | Foundational: the resolver and the widened seam are independent files |
| W2 | T004 | Removes the constant; needs the widened seam |
| W3 | T005, T011, T012, T015 | T005 is the single call-site rewrite; the `args.test.ts` matrix and the source guard depend only on W1/W2 |
| W4 | T006, T007, T009, T013, T014 | All hang off the rewritten call site and touch distinct regions/files |
| W5 | T008, T010, T016 | Tests that assert the finished US1 behavior and the migrated legacy assertions |
| W6 | T017 | Final full-gate run |

## Dependencies

**Story completion order**: US1 (P1) → US2 (P1) → US3 (P2). US2 and US3 both depend on
the Foundational phase and on T005, but not on each other — after T005 lands they can be
worked in either order or concurrently.

**Critical path**: T001 → T003 → T004 → T005 → T008 → T017.

## Implementation Strategy

**MVP = Phase 1 + Phase 2 + Phase 3 (US1)**. That alone closes the reported bug: the
placeholder is gone and a directly-reachable leaf reports successfully. US2 is a
regression fence around the MCC-nested path (behavior it protects is already delivered by
US1's resolver, but untested without it), and US3 pins the override and normalization
contract. Ship US1 first, then layer US2 and US3 before the PR — none of the three is
large enough to warrant a split PR.
