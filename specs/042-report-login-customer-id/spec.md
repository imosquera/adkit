# Feature Specification: `report` resolves the login-customer-id instead of hardcoding a placeholder

**Feature Branch**: `042-report-login-customer-id`

**Created**: 2026-07-26

**Status**: Draft

**Input**: User description: "report: resolve manager/login-customer-id from config + Secret Manager, drop hardcoded placeholder (2222222222). `ads.sh report <leaf> --days 7` fails with 'No customer found for the provided customer id' because report injects a bogus manager (`DEFAULT_MANAGER = \"2222222222\"`) as the login-customer-id, while `audit`/`preflight` inherit the real login from the credentials. Source: GitHub issue #42."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Report a directly-reachable leaf account with no manager flag (Priority: P1)

An operator runs `ads.sh report 8911925499 --days 7` against an account their credentials can reach directly. Today the command fails with `No customer found for the provided customer id` because a placeholder manager id is injected as the login header. The operator should get their report without passing any manager flag, exactly as `audit` and `preflight` already behave for the same account.

**Why this priority**: This is the reported defect. Every `report` run without a hand-passed `--manager` is broken today, which makes the subcommand unusable for its primary case.

**Independent Test**: Run `report <leaf-id> --days 7` with no manager flag against a directly-reachable account and confirm the report is produced and no placeholder id is sent as the login header.

**Acceptance Scenarios**:

1. **Given** credentials whose file carries no `login_customer_id` and a directly-accessible leaf account, **When** the operator runs `report <leaf> --days 7` with no manager flag, **Then** the read client is built with no login-customer-id header and the report is produced.
2. **Given** the same run, **When** the report output and any error text are rendered, **Then** the string `2222222222` never appears as a value the tool itself supplied.
3. **Given** no manager could be resolved from any source, **When** the report is written, **Then** the report's manager field records the absence explicitly rather than a fabricated id.

---

### User Story 2 - Inherit the real MCC login from credentials for an MCC-nested leaf (Priority: P1)

An operator whose leaf account is reachable only through a manager account runs `report <leaf> --days 7` with no flag. The login-customer-id seeded into `google-ads.yaml` from Secret Manager (via `render-yaml` / `bootstrap-secrets`) is used automatically, the same source `audit` and `preflight` draw on.

**Why this priority**: Without this, fixing User Story 1 would simply break the MCC-nested case in the other direction. Both paths must work with zero flags for the fix to be complete.

**Independent Test**: With credentials carrying a `login_customer_id`, run `report <leaf>` with no flag and confirm the read client is built with that yaml value.

**Acceptance Scenarios**:

1. **Given** credentials carrying `login_customer_id: <mcc>`, **When** the operator runs `report <leaf>` with no manager flag and no environment override, **Then** the read client is built with `<mcc>` as the login-customer-id.
2. **Given** the same credentials, **When** the report is written, **Then** the report's manager field reflects the resolved `<mcc>`, not a placeholder.

---

### User Story 3 - Override the resolved login explicitly (Priority: P2)

An operator who needs to route a run through a specific manager account passes it on the command line, or sets it once in the environment for a whole session, and that choice overrides whatever the credentials carry.

**Why this priority**: The explicit override already exists (`--manager`) and must keep working; the environment tier makes the value configurable without editing credentials. Both are secondary to the zero-flag paths being correct.

**Independent Test**: Resolve the login with each combination of flag, environment variable, and credentials value present, and confirm the documented precedence order holds.

**Acceptance Scenarios**:

1. **Given** credentials carrying `login_customer_id: <a>`, **When** the operator passes `--manager <b>`, **Then** `<b>` is used as the login-customer-id.
2. **Given** credentials carrying `login_customer_id: <a>` and the environment variable set to `<c>`, **When** the operator passes no flag, **Then** `<c>` is used.
3. **Given** a manager id supplied in dashed human form (`222-222-2222`), **When** it is resolved from any tier, **Then** it is normalized to 10 digits with no dashes before use.
4. **Given** a manager id that is not digits-only after normalization, **When** the command runs, **Then** it fails with a clear argument error rather than sending a malformed header.

---

### Edge Cases

- Environment variable present but empty or whitespace-only → treated as absent, falling through to the credentials tier rather than clearing the login.
- `--manager` supplied with no following value or with a following token that is itself a flag → must not consume an unrelated token; behavior mirrors the existing `--manager`/`--days` parsing convention in the same file.
- Credentials file missing or unreadable → the failure surfaces as a credentials error, not as a silent fall-through to "no login".
- A resolved login that is valid digits but wrong for the leaf → the API rejection message must name the manager actually used, so the operator can see which tier supplied it.
- Report output consumers that today read a always-present manager field → the field must remain present in the output shape, with an explicit empty value when no manager was resolved.

## Clarifications

### Session 2026-07-26

Auto-answered by autopilot from the issue text + repo code (`src/lib/auth.ts`, `src/bin/audit.ts`, `src/bin/report.ts`, `reference/conventions.md`). No user-facing ambiguity; these are design decisions grounded in existing conventions.

- Q: When nothing resolves, should `report` clear the login header (pass `null`, as `audit` does) or inherit the yaml value (`KEEP_YAML_LOGIN`)? → A: Inherit the yaml value. The issue names `KEEP_YAML_LOGIN` explicitly as the required default, and it is strictly more correct than `null`: for a direct leaf the yaml normally carries no `login_customer_id`, so inheriting yields the same omitted header `audit` gets, while for an MCC-nested leaf it additionally picks up the real login. `audit`'s `null` is a deliberate narrower choice for its own use case and is not changed here.
- Q: What is the precedence order? → A: `--manager` flag → `GOOGLE_ADS_LOGIN_CUSTOMER_ID` environment value → credentials `login_customer_id` (inherited, not read directly) → no login header. This matches the ordered-candidate idiom already used by `audit` (`resolveAuditCustomer`) and `create`.
- Q: What name for the environment tier? → A: `GOOGLE_ADS_LOGIN_CUSTOMER_ID`, matching the SDK's own field name and the existing `GOOGLE_ADS_CUSTOMER_ID` convention in the repo.
- Q: Does this feature read Google Secret Manager directly? → A: No. Secret Manager reaches the credentials file through the existing `render-yaml` / `bootstrap-secrets` path; `report` inherits the resolved value from the credentials like `audit` does. Adding a second, direct Secret Manager read would duplicate an existing seam.
- Q: What does the report's manager field carry when nothing resolves? → A: An explicit empty value (null), not a placeholder and not an omitted key, so existing consumers keep a stable output shape while the absence stays legible.
- Q: Should the sibling `DEFAULT_CUSTOMER = "1111111111"` placeholder also be removed? → A: Out of scope. The issue is scoped to the manager/login placeholder, and the customer default has its own resolution path; removing it is a separate behavioral change worth its own issue.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: `report` MUST NOT use any hardcoded literal customer/manager id as a runtime default for the login-customer-id.
- **FR-002**: `report` MUST resolve the login-customer-id through the precedence chain: explicit `--manager` flag, then the `GOOGLE_ADS_LOGIN_CUSTOMER_ID` environment value, then the credentials' own `login_customer_id`, then no login header.
- **FR-003**: When no tier supplies a value, `report` MUST let the read client inherit the credentials' login (the yaml-inherit behavior), which omits the header entirely for a directly-accessible leaf.
- **FR-004**: `report` MUST build its read client through the same client seam `audit` uses, so that the manager/no-manager decision is expressed once and not re-derived per subcommand.
- **FR-005**: Every customer and manager id `report` handles MUST be normalized to 10 digits with dashes stripped before use, per `reference/conventions.md`.
- **FR-006**: `report` MUST reject a manager id that is not digits-only after normalization with a clear argument error, consistent with how `audit` validates `--login-customer-id`.
- **FR-007**: An environment value that is empty or whitespace-only MUST be treated as absent rather than as an explicit "no manager" instruction.
- **FR-008**: Error text and report output MUST name the manager actually used, and MUST record an explicit empty value when none was resolved.
- **FR-009**: The user-facing documentation for `report` MUST stop advertising the placeholder manager id as a default.
- **FR-010**: A test MUST assert that the placeholder literal no longer appears as a runtime default in the report entrypoint, so the regression cannot silently return.

### Functional Programming Constraints

- Login-customer-id resolution MUST be a pure function of its inputs (parsed arguments, an injected environment map), returning a new value with no side effects and no reads of ambient global state inside the function body.
- Argument parsing MUST remain a pure function of its input tokens, returning a new parsed value without mutating shared state.
- The resolution result MUST be parsed once at the command boundary into the precise value the client seam accepts, so downstream code never re-checks or re-normalizes it.

### Platform Constraints

- Change is confined to the `adkit` CLI (Node/TypeScript). No new runtime dependencies.
- The existing invocation surface (`ads.sh report ...`, positional and flag customer forms) MUST keep working.
- No change to `audit` or `preflight` behavior.

## Notes

- Generated/updated by /speckit-specify from GitHub issue #42.
