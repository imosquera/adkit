# Implementation Plan: `report` resolves the login-customer-id instead of hardcoding a placeholder

**Branch**: `042-report-login-customer-id` | **Date**: 2026-07-26 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/042-report-login-customer-id/spec.md`

## Summary

`report` currently hardcodes `DEFAULT_MANAGER = "2222222222"` and passes it as the
login-customer-id on every run, which breaks any account the operator can reach without
that (fictional) MCC. The fix replaces the constant with a pure resolver that walks an
ordered candidate chain — `--manager` flag, `GOOGLE_ADS_LOGIN_CUSTOMER_ID` environment
value, then the credentials' own `login_customer_id` — and widens `report`'s injected
client-factory seam so the "inherit the yaml login" sentinel can actually flow through
it. The resolver returns the exact value `loadReadClient` accepts, so no downstream code
re-derives or re-checks the decision.

## Technical Context

**Language/Version**: TypeScript 5.x on Node (ESM, `.js` import specifiers), package root `skills/adkit/scripts/`

**Primary Dependencies**: `google-ads-api` SDK (via `src/lib/auth.ts`); no new dependencies

**Storage**: Credentials YAML at `~/.config/google-ads/google-ads.yaml` (or `GOOGLE_ADS_CREDENTIALS`), seeded from Google Secret Manager by `render-yaml` / `bootstrap-secrets`

**Testing**: vitest 2.1 (`vitest run`), tests colocated as `src/**/*.test.ts`

**Target Platform**: macOS/Linux CLI invoked through `ads.sh`

**Project Type**: CLI tool (single TypeScript package)

**Performance Goals**: N/A — the change is on a once-per-invocation startup path

**Constraints**: No behavior change to `audit` or `preflight`; the existing `ads.sh report ...` invocation surface must keep working

**Scale/Scope**: One entrypoint (`src/bin/report.ts`), one shared arg helper (`src/cli/args.ts`), their tests, and one reference doc

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

**No constitution defined.** `.specify/memory/constitution.md` exists but is still the
unfilled scaffold shipped with the template — every principle heading is a literal
placeholder (`### [PRINCIPLE_1_NAME]`, `[PRINCIPLE_1_DESCRIPTION]`), and
`constitution_audit.py list` confirms this:

```
[constitution-audit] No principle headings matched in .specify/memory/constitution.md.
[constitution-audit] Expected pattern: '## I. Name', '### Principle 1: Name', etc.
```

With no principles to quote, the quoted-Constitution-Check gate has nothing to check and
the stock flow continues unchanged. This is a **pre-existing repo condition, not a
finding of this feature** — worth raising separately, since `create-new-feature.sh`
advertises a "Constitution v2.3.0 Principle VII" that has no counterpart on disk.

The binding rules this feature is actually held to are the project conventions in
`CLAUDE.md` (functional style; parse, don't validate), enforced below by the
**Functional Programming Constraints** in the spec and the **Parse Boundaries** section
of this plan.

## Project Structure

### Documentation (this feature)

```text
specs/042-report-login-customer-id/
├── spec.md              # Feature specification
├── plan.md              # This file (/speckit-plan command output)
├── requirements.md      # Spec quality checklist
└── tasks.md             # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
skills/adkit/
├── scripts/src/
│   ├── bin/
│   │   ├── report.ts          # Entrypoint under change: drop DEFAULT_MANAGER, resolve + widen factory seam
│   │   └── report.test.ts     # Resolution precedence, factory-argument, and no-placeholder tests
│   ├── cli/
│   │   ├── args.ts            # Home of the new pure resolver (alongside normalizeId / resolveCustomer)
│   │   └── args.test.ts       # Unit tests for the resolver in isolation
│   └── lib/
│       ├── auth.ts            # KEEP_YAML_LOGIN sentinel + loadClient (read-only for this feature)
│       └── mcp-client.ts      # loadReadClient — the client seam report must reach through
└── reference/
    └── report.md              # Argument hint that still advertises the placeholder default
```

**Structure Decision**: Single existing TypeScript package; no new modules or directories.
The resolver lands in `src/cli/args.ts` beside `normalizeId` and `resolveCustomer`,
because it is the same category of thing (a pure, testable argument-resolution helper
shared across bins) and that module already owns the ordered-candidate idiom. Putting it
in `report.ts` would make it unreachable for the other bins that will eventually want the
same precedence.

## Parse Boundaries

The feature is TypeScript, so this section is binding.

### Trust boundaries

1. **CLI tokens** — `argv: string[]` reaching `parseArgs` in `report.ts`. Raw and
   untrusted; a stray token can be anything. Never widened to `any`; handled as
   `string[]` and consumed into the parsed args value in one pass.
2. **Environment** — `GOOGLE_ADS_LOGIN_CUSTOMER_ID`, read through an **injected**
   `Record<string, string | undefined>` (defaulting to `process.env`), never read from
   ambient global state inside the resolver body. Values arrive as `string | undefined`
   and are treated as untrusted text until parsed.
3. **Credentials YAML** — `login_customer_id` from `google-ads.yaml`. This boundary is
   **already owned by `src/lib/auth.ts`** (`readCredentials` → `loadClient`), and this
   feature deliberately does not re-read or re-parse it. `report` expresses "use whatever
   that boundary resolved" by passing the `KEEP_YAML_LOGIN` sentinel, so the yaml is
   parsed exactly once, in the module that owns it.

### Domain types

- **`LoginCustomerId`** — the parsed result of the resolution chain. Its type is exactly
  `string | null | typeof KEEP_YAML_LOGIN`, the parameter type `loadClient` already
  accepts (`src/lib/auth.ts:158`). This is the key design decision: the parse output type
  **is** the client seam's input type, so there is no gap where a caller could re-check or
  re-normalize. The three states are semantically distinct and cannot be collapsed into
  `string | null` — `KEEP_YAML_LOGIN` means "inherit the yaml login", `null` means
  "explicitly send no login header", and a `string` means "override with this MCC".
- **Nominal identity**: `KEEP_YAML_LOGIN` is already a `unique symbol`
  (`Symbol("keep-yaml-login")`, `auth.ts:101`), which makes the sentinel arm nominally
  distinct at zero cost — no string value can be mistaken for it. The `string` arm is a
  10-digit customer id; `customer` and `manager` ids are structurally identical strings
  and are distinguished positionally rather than by a brand, consistent with the rest of
  the codebase. No new brand is introduced: adding one for this arm alone would be
  inconsistent with `normalizeId` / `resolveCustomer` / `requireDigits`, which all
  operate on plain strings today. Called out explicitly so the choice is deliberate
  rather than an oversight.

### Parsers

| Boundary | Parser | Input → Output | Owner module |
|---|---|---|---|
| CLI tokens | `parseArgs` (existing) | `string[]` → parsed args, with `manager: string \| null` (`null` = flag absent, replacing today's placeholder default) | `src/bin/report.ts` |
| Flag + env + yaml chain | **`resolveLoginCustomerId`** (new) | `(managerFlag: string \| null \| undefined, env: Record<string, string \| undefined>)` → `string \| null \| typeof KEEP_YAML_LOGIN` | `src/cli/args.ts` |
| Credentials YAML | `readCredentials` / `loadClient` (existing, untouched) | yaml text → `login_customer_id` applied to the SDK customer | `src/lib/auth.ts` |

`resolveLoginCustomerId` is a **pure total function**: first non-blank candidate wins,
each candidate `normalizeId`'d (dashes stripped) on the way through, falling through to
`KEEP_YAML_LOGIN` when every tier is absent. Blank/whitespace-only env values are
absent, not "clear the header" (FR-007). It performs no I/O and takes `env` as a
parameter so precedence is testable without mutating `process.env` — the pattern
`resolveAuditCustomer` already establishes (`audit.ts:911-918`).

Digit enforcement stays a **separate, single call** to the existing
`requireDigits(label, value)` (`src/audit/scoring.ts:299`), applied once at the
`report.ts` boundary immediately after resolution, exactly as `audit.ts:963` does. It
throws a typed argument error rather than returning a boolean. Downstream code holds a
value that is already normalized and digit-checked and never re-validates it.

**Result-shape note**: the repo has no `{ kind: "ok" | "err" }` `Result` convention —
`args.ts` resolvers return values directly and `requireDigits` throws a typed error at
the boundary. This feature follows the established local convention rather than
introducing a one-off `Result` type that no other caller in the package understands. The
"parse once, at the edge" property is preserved either way.

### Library choice

**Hand-rolled, reusing existing helpers — deliberately not zod.** The package *does*
depend on zod, and uses it where it earns its keep: `src/lib/brand.ts` parses
model-authored JSON of unbounded shape (`parseDifferentiationProfile`), and
`src/lib/schema.ts` parses structured payloads. Neither situation applies here. The
value parsed at this boundary is a three-arm union over one already-normalized string,
and one of its arms is a `unique symbol` sentinel that zod cannot express naturally
(`z.custom` with a type predicate would be strictly more code than the union itself).
Introducing a schema here would add a second normalization vocabulary alongside
`normalizeId` + `requireDigits`, which already express exactly this rule and are what
`audit` uses — and matching `audit`'s boundary is the stated goal of FR-004. The rule of
thumb this follows: zod for untrusted structured payloads, plain parsers for scalar CLI
arguments.

## Implementation Approach

1. **`src/cli/args.ts`** — add the pure `resolveLoginCustomerId` resolver described
   above, exported alongside `normalizeId` / `resolveCustomer`.
2. **`src/bin/report.ts`** —
   - delete `DEFAULT_MANAGER`;
   - default `manager` to `null` in `parseArgs` (flag absent) instead of the placeholder;
   - widen the injected factory type from `(manager: string) => AdsClient` to
     `(login: string | null | typeof KEEP_YAML_LOGIN) => AdsClient` so `loadReadClient`
     fits the seam without narrowing (this is what structurally blocks the fix today);
   - resolve once, `requireDigits` once, then `clientFactory(resolved)`;
   - render `manager_id` as the resolved string or `null`, and make the error text name
     the manager actually used (or say none was used).
3. **`skills/adkit/reference/report.md`** — drop the `via 222-222-2222` default from the
   argument hint.
4. **Tests** — precedence matrix in `args.test.ts`; factory-argument and output-shape
   assertions in `report.test.ts`; a guard asserting the placeholder literal is no longer
   a runtime default in `report.ts`. The existing `report.test.ts` assertions that encode
   the old default (`:46-47`, `:62`, `:71`, `:79`, `:94`, `:410-419`, `:530-541`) are
   updated to the new contract.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

No violations to track — no constitution principles are defined in this repo (see
Constitution Check). The design adds one pure function and widens one existing type; it
introduces no new module, dependency, or abstraction layer.
