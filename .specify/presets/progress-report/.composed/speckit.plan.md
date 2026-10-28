---
description: Wraps /speckit-plan to update the agent-os dashboard card
scripts:
  sh: scripts/bash/setup-plan.sh --json
  ps: scripts/powershell/setup-plan.ps1 -Json
  py: scripts/python/setup_plan.py --json
---


## Dashboard — enter `plan`

```bash
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
REPORT="$PROJECT_DIR/.specify/presets/progress-report/scripts/ts/progress_report.ts"
command -v bun >/dev/null || { echo "progress-report: bun not found on PATH — install bun (https://bun.sh); the dashboard writer is TypeScript run by bun" >&2; exit 1; }
bun "$REPORT" enter plan
```


## Wrapper Layer

This preset wraps `/speckit-plan` and every inner layer (e.g. `library-research`,
which adds libraries). The plan is where new files, layers and dependencies get
committed to, so it is the cheap place to cut them: nothing is written yet and
`tasks.md` does not exist.

If `ponytail:ponytail` is explicitly listed among this session's available
skills, invoke it before the core flow. Never guess a skill name or install one;
if it is not listed, skip it silently. The ladder below is the binding rule
either way.

### Core Flow


## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

## Behavior

Execute the canonical stock `/speckit-plan` flow with **one mandatory gate**: a
Parse boundary design section in the generated `plan.md`.

### Core Flow

Run the core plan flow first so that `plan.md` exists before the gate is applied.


## Wrapper Layer

This preset wraps the stock `/speckit-plan` command (and any inner wrapper the
core flow expands to, e.g. from another chained `speckit.plan` preset).

The spec decided **which** actions exist and what they say
(`## Actions & Buttons`). This layer decides **how they are built** so they look
and behave the same as every other button in the product.

### Button System (MANDATORY)

Read `## Actions & Buttons` in `spec.md` first.

This layer covers **web / browser screens only**. Native iOS screens belong to
`button-design-ios`'s `## iOS Button System`; never design them here.

- If it says `None.` (e.g. `None — no user-facing web UI.`), add nothing and
  say so in your report.
- If the spec has no such section (it was written without this preset's
  `speckit.specify` layer), ask Jev whether it touches UI:

  ```bash
  PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
  bun "$PROJECT_DIR/.specify/presets/button-design/scripts/ts/jev.ts" applies-ui --spec "$SPECIFY_FEATURE_DIRECTORY/spec.md"
  ```

  Exit 0 with `decision: "applies"` → write `## Button System` below from the
  spec's web screens (if the UI is only native iOS, add nothing). Exit 0 with `"skip"`, exit 3, or any other exit → add nothing
  and say so. Either way the check passes; quote the `record` line in your
  report.
- Otherwise `plan.md` MUST carry a `## Button System` section with these five
  markers, each populated:

```markdown
## Button System

**Component:** reuse `Button` from `src/ui/Button.tsx` (variants primary,
secondary, tertiary, destructive). No new button style.
**Color roles:** primary = brand color; secondary = outlined neutral;
destructive = danger red; disabled = muted fill and text, not just lowered
opacity. The same color means the same role on every screen.
**States:** default, hover, focus-visible, active, disabled, loading. Every
state keeps label text ≥ 4.5:1 against its fill and the button ≥ 3:1 against
its container.
**Touch targets:** 44×44 minimum hit area, icon-only buttons included; ≥ 8px
between adjacent targets.
**Placement:** the primary sits where the task ends: bottom of the form,
trailing edge of a button pair, in the platform's dialog order. Actions sit
next to what they act on, never floating in a corner. A sticky mobile CTA never
covers content.
```

Rules behind the markers:

- **Reuse before you add.** Name the existing button component and the variant
  each spec row maps to. A new variant or one-off style needs a stated reason in
  `plan.md`. "This page is different" is not a reason.
- **Consistency across screens.** Shape, radius, font size, weight,
  capitalization, and padding match the existing system. A primary in a modal
  looks like a primary on the dashboard.
- **Links stay links.** Spec rows of kind `link` render as text links (underline
  or link style, no container), never button-shaped.
- **Destructive safeguards are designed here.** For every spec row with a
  safeguard, the plan names the confirm dialog, type-to-confirm field, or undo
  affordance and where it lives.

### Core Flow


## Wrapper Layer

This preset wraps the stock `/speckit-plan` command (and any inner wrapper the
core flow expands to, e.g. from another chained `speckit.plan` preset).

`## Scope discipline` in `spec.md` is a contract, not a note. This layer is the
half of the minimum-diff mandate that enforces it at plan time — the cheap
moment. The expensive moment is reviewing the seven-file PR the unenforced plan
would have produced.

### Scope Rule (MANDATORY)

Before designing anything, **read `## Scope discipline` in `spec.md`** and treat
its `MUST NOT touch:` list as binding on the plan, on `tasks.md`, and on every
artifact this phase writes.

- No plan step, task, file-change list, or code sketch may modify a listed path.
- Also honour the mandate the spec was written under: prefer extending an
  existing file over adding one, reuse the existing shape rather than inventing
  a parallel one, and plan no refactor, rename, or formatting churn the
  requirements do not need. Each new file the plan introduces needs a reason
  stated in `plan.md`.
- If the design genuinely requires a listed path, **do not quietly widen the
  plan.** Stop, amend `## Scope discipline` in `spec.md` to remove that entry
  with the reason, and say so on the tracking issue. A spec change is a visible
  event; a widened plan is not.
- Restating an exclusion is encouraged, not penalized: a `## Scope` or
  `## Non-Goals` section in `plan.md`, and any line that says a path must not be
  touched, are both exempt from the check below.

If `spec.md` has no `## Scope discipline` section, the spec was written without
this preset's `speckit.specify` layer. Say so in your report and continue —
this layer never invents a scope contract the spec did not sign.

### Core Flow


## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

## Behavior

Execute the canonical stock `/speckit-plan` flow, then add one mandatory
research pass: identify TypeScript/web build-it-yourself surface area in the
finished plan and check, via live web search, whether an existing npm library
already solves it well enough that hand-rolling it would be wasted effort.
Findings go in this layer's own section of the shared `research.md`.

### Core Flow

Run the core plan flow first so that `plan.md` exists before research begins.


## Wrapper Layer

This preset wraps the stock `/speckit-plan` command (and any inner wrapper that
the core flow expands to, e.g. from another chained `speckit.plan` preset). It
enforces a strictly minimal artifact tree.

Enforcement has two halves — the prompt rule below prevents, and the post-flight
enforcer guarantees. `presets/spec-minimal/README.md` is the canonical
description of the mechanism; do not restate it elsewhere.

### Documentation Rule (MANDATORY — NO EXCEPTIONS)

The feature directory MUST contain ONLY these entries at the top level:

- `spec.md`
- `plan.md`
- `tasks.md`
- `quickstart.md` (optional but allowed)
- `research.md` (optional but allowed — e.g. written by the `library-research`
  preset; nothing pre-creates it)
- `checklists/` (allowed — core Spec Kit's `/speckit-specify` mandates
  `checklists/requirements.md`)

`data-model.md` and `contracts/` **MUST NOT be created** — not as files, not as
directories, not in any form. There is no escape hatch. Any content that the
stock flow would have written into one of those paths MUST instead be inlined
as a section of `plan.md`.

When you reach any step of the core flow that would create `data-model.md` or
`contracts/`, do not create the path. Fold its content into `plan.md` and
continue.

In the **Project Structure → Documentation (this feature)** subsection of
`plan.md`, list exactly the allowed files and nothing else.

### Core Flow


## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

## Pre-Execution Checks

**Check for extension hooks (before planning)**:
- Check if `.specify/extensions.yml` exists in the project root.
- If it exists, read it and look for entries under the `hooks.before_plan` key
- If the YAML cannot be parsed or is invalid, do not skip silently: tell the user that `.specify/extensions.yml` could not be read (include the parser error) and that no hooks were checked, including any mandatory (`optional: false`) hooks registered there, then continue normally
- Filter out hooks where `enabled` is explicitly `false`. Treat hooks without an `enabled` field as enabled by default.
- For each remaining hook, do **not** attempt to interpret or evaluate hook `condition` expressions:
  - If the hook has no `condition` field, or it is null/empty, treat the hook as executable
  - If the hook defines a non-empty `condition`, skip the hook and leave condition evaluation to the HookExecutor implementation
- For each executable hook, output the following based on its `optional` flag:
  - **Optional hook** (`optional: true`):
    ```
    ## Extension Hooks

    **Optional Pre-Hook**: {extension}
    Command: `/{command}`
    Description: {description}

    Prompt: {prompt}
    To execute: `/{command}`
    ```
  - **Mandatory hook** (`optional: false`):
    ```
    ## Extension Hooks

    **Automatic Pre-Hook**: {extension}
    Executing: `/{command}`
    EXECUTE_COMMAND: {command}

    Wait for the result of the hook command before proceeding to the Outline.
    ```
    After emitting the block above you MUST actually invoke the hook and wait for it to finish before continuing. Run it the same way you would run the command yourself in this agent/session (the invocation may differ from the literal `{command}` id shown above, e.g. a skills-mode agent runs it as `/skill:speckit-...` or `$speckit-...`). Emitting the block alone does not run the hook.
- If no hooks are registered or `.specify/extensions.yml` does not exist, skip silently

## Outline

1. **Setup**: Run `{SCRIPT}` from repo root and parse JSON for FEATURE_SPEC, IMPL_PLAN, FEATURE_DIR, BRANCH. For single quotes in args like "I'm Groot", use escape syntax: e.g 'I'\''m Groot' (or double-quote if possible: "I'm Groot").

2. **Load context**: Read FEATURE_SPEC and `/memory/constitution.md`. Load IMPL_PLAN template (already copied).

3. **Execute plan workflow**: Follow the structure in IMPL_PLAN template to:
   - Fill Technical Context (mark unknowns as "NEEDS CLARIFICATION")
   - Fill Constitution Check section from constitution
   - Evaluate gates (ERROR if violations unjustified)
   - Phase 0: Generate research.md (resolve all NEEDS CLARIFICATION)
   - Phase 1: Generate data-model.md, contracts/, quickstart.md
   - Re-evaluate Constitution Check post-design

## Mandatory Post-Execution Hooks

**You MUST complete this section before reporting completion to the user.**

Check if `.specify/extensions.yml` exists in the project root.
- If it does not exist, or no hooks are registered under `hooks.after_plan`, skip to the Completion Report.
- If it exists, read it and look for entries under the `hooks.after_plan` key.
- If the YAML cannot be parsed or is invalid, do not skip silently: tell the user that `.specify/extensions.yml` could not be read (include the parser error) and that no hooks were checked, including any mandatory (`optional: false`) hooks registered there, then continue to the Completion Report.
- Filter out hooks where `enabled` is explicitly `false`. Treat hooks without an `enabled` field as enabled by default.
- For each remaining hook, do **not** attempt to interpret or evaluate hook `condition` expressions:
  - If the hook has no `condition` field, or it is null/empty, treat the hook as executable
  - If the hook defines a non-empty `condition`, skip the hook and leave condition evaluation to the HookExecutor implementation
- For each executable hook, output the following based on its `optional` flag:
  - **Mandatory hook** (`optional: false`) — **You MUST emit `EXECUTE_COMMAND:` for each mandatory hook**:
    ```
    ## Extension Hooks

    **Automatic Hook**: {extension}
    Executing: `/{command}`
    EXECUTE_COMMAND: {command}
    ```
    After emitting the block above you MUST actually invoke the hook and wait for it to finish before continuing. Run it the same way you would run the command yourself in this agent/session (the invocation may differ from the literal `{command}` id shown above, e.g. a skills-mode agent runs it as `/skill:speckit-...` or `$speckit-...`). Emitting the block alone does not run the hook.
  - **Optional hook** (`optional: true`):
    ```
    ## Extension Hooks

    **Optional Hook**: {extension}
    Command: `/{command}`
    Description: {description}

    Prompt: {prompt}
    To execute: `/{command}`
    ```

## Completion Report

Command ends after Phase 1 design. Report branch, IMPL_PLAN path, and generated artifacts.

## Phases

### Phase 0: Outline & Research

1. **Extract unknowns from Technical Context** above:
   - For each NEEDS CLARIFICATION → research task
   - For each dependency → best practices task
   - For each integration → patterns task

2. **Generate and dispatch research agents**:

   ```text
   For each unknown in Technical Context:
     Task: "Research {unknown} for {feature context}"
   For each technology choice:
     Task: "Find best practices for {tech} in {domain}"
   ```

3. **Consolidate findings** in `research.md` using format:
   - Decision: [what was chosen]
   - Rationale: [why chosen]
   - Alternatives considered: [what else evaluated]

**Output**: research.md with all NEEDS CLARIFICATION resolved

### Phase 1: Design & Contracts

**Prerequisites:** `research.md` complete

1. **Extract entities from feature spec** → `data-model.md`:
   - Entity name, fields, relationships
   - Validation rules from requirements
   - State transitions if applicable

2. **Define interface contracts** (if project has external interfaces) → `/contracts/`:
   - Identify what interfaces the project exposes to users or other systems
   - Document the contract format appropriate for the project type
   - Examples: public APIs for libraries, command schemas for CLI tools, endpoints for web services, grammars for parsers, UI contracts for applications
   - Skip if project is purely internal (build scripts, one-off tools, etc.)

3. **Create quickstart validation guide** → `quickstart.md`:
   - Document runnable validation scenarios that prove the feature works end-to-end
   - Include prerequisites, setup commands, test/run commands, and expected outcomes
   - Use links or references to contracts and data model details instead of duplicating them
   - Do not include full implementation code, model/service/controller bodies, migrations, or complete test suites
   - Keep this artifact as a validation/run guide; implementation details belong in `tasks.md` and the implementation phase

**Output**: data-model.md, /contracts/*, quickstart.md

## Key rules

- Use absolute paths for filesystem operations; use project-relative paths for references in documentation
- ERROR on gate failures or unresolved clarifications

## Done When

- [ ] Plan workflow executed and design artifacts generated
- [ ] Extension hooks dispatched or skipped according to the rules in Mandatory Post-Execution Hooks above
- [ ] Completion reported to user with branch, plan path, and generated artifacts


### Post-Flight Enforcement (MANDATORY — LAST STEP)

After the entire core flow above has completed, and before reporting success, run
the enforcer as the final step:

```bash
bun .specify/presets/spec-minimal/scripts/ts/enforce-minimal-tree.ts "$SPECIFY_FEATURE_DIRECTORY"
```

The enforcer is self-healing: if a forbidden artifact is on disk it folds the
content into `plan.md` under an `## Inlined from <name>` heading (inside an
idempotent sentinel block) and then deletes the artifact. It always writes
`plan.md` before removing anything, so content cannot be lost. If `plan.md` is
missing it creates it. Unknown top-level entries only produce a `warning:` on
stderr — they never fail the run, so stacking with other presets is safe.

Handle the exit code as follows:

- **`0`** — the tree is clean. If the enforcer reported that it folded and
  removed any artifacts (or created `plan.md`), tell the user exactly what was
  inlined, created, and removed, then report success.
- **`1`** — read the stderr, which always says which of two cases it is:
  - `HEALING IMPOSSIBLE` — nothing was written to `plan.md` and nothing was
    removed. Surface the error verbatim, fix the underlying problem (an
    unbalanced sentinel in `plan.md`, an unreadable path, an unwritable
    directory), and re-run the enforcer.
  - `PARTIALLY HEALED` — the content IS already safely inlined in `plan.md`,
    but a forbidden artifact could not be removed. Surface the error verbatim,
    remove the named artifact (nothing is lost by doing so), and re-run.

  In both cases, do not report success.
- **`2`** — bad usage: the invocation above is wrong. Fix the call and re-run.

Only report success once the enforcer exits `0`.


### Platform scope and the shared `research.md`

This layer is the **TypeScript/web** half of a pair. Its sibling,
`library-research-ios`, wraps the same command in a mixed project (e.g. a
SwiftUI app with a TypeScript backend) and writes to the same files, so the
two split them by platform and section:

- **Platform.** Consider only surface area the plan builds in
  TypeScript/JavaScript: web app, Node / Cloud Functions backend, build and
  maintenance scripts. Swift / iOS app-side work is never a research target
  here, even when it appears in the same `plan.md`.
- **Your section.** In `$SPECIFY_FEATURE_DIRECTORY/research.md` you own exactly
  one section, from the line `## Library research — TypeScript/web` up to (not
  including) the next level-2 `## ` heading or end of file. Create or rewrite
  only that section. Never edit, move, or delete anything outside it — in
  particular `## Library research — iOS`, which belongs to the sibling layer.
- **Creating vs. updating.** If `research.md` is absent, create it with just
  your section. If it exists but has no `## Library research — TypeScript/web`
  heading (including an older `research.md` written before these headings
  existed, or one another tool wrote), leave all existing content intact and
  append your section at the end. If the heading exists, replace that section
  in place. Never overwrite the whole file.

Inside your section, each researched unknown is a level-3 (`### `) heading, so
the section boundary above stays unambiguous.

### Research Pass (MANDATORY — runs after the core flow)

0. **Applicability gate.** Ask Jev whether the plan hand-rolls anything a
   library could provide:

   ```bash
   PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
   bun "$PROJECT_DIR/.specify/presets/library-research/scripts/ts/jev.ts" applies-library --plan "$SPECIFY_FEATURE_DIRECTORY/plan.md"
   ```

   The question is platform-agnostic, so read its answer as an upper bound:
   exit 0 with `decision: "skip"` → take the no-surface-area path in step 1
   (the `N/A` line in **your section only**, `plan.md` untouched) without
   scanning. Exit 0 with `"applies"`, exit 3, or any other exit → continue
   with step 1 as usual; `"applies"` may still be about the iOS side, in which
   case step 1's scan finds nothing web-side and takes the same `N/A` path.
   Quote the printed `record` line in the Completion Report.

1. **Scan `plan.md` for TypeScript/web technical unknowns.** Look for
   components the plan builds in TypeScript/JavaScript from scratch that
   commonly have mature npm solutions — auth, session/token handling,
   parsing/validation, queues, retries/backoff, rate limiting, caching,
   diffing, scheduling, PDF/image processing, i18n, payments, and similar.
   Ignore plain internal business logic (domain rules specific to this
   feature) and anything on the Swift / iOS side — neither is a research
   target here.

   If the plan has no such web-side surface area, write your section as:

   ```markdown
   ## Library research — TypeScript/web

   N/A — no TypeScript/web build-it-yourself surface area identified in this plan.
   ```

   following the create/append/replace rules above (never overwrite the
   file), skip straight to Completion Report, and do not modify `plan.md`.

2. **Research each unknown using real web search** (`WebSearch` / `WebFetch`
   tools) — do not rely on memorized/training-data knowledge of the library
   ecosystem, since versions, maintenance status, and best-fit choice change
   over time. For each unknown, find 1-3 candidate libraries and check:
   - still maintained (recent releases/commits, not archived)
   - license compatible with the project (avoid GPL/AGPL for permissively
     licensed projects unless the plan already accepts that)
   - fits the project's existing runtime and dependencies (check `plan.md`
     and the `package.json` / lockfile of the package that will use it —
     e.g. the web app's or the functions package's, not the iOS app's —
     before recommending)
   - genuinely reduces scope versus hand-rolling — a library that only
     covers a sliver of the unknown, or adds more integration complexity
     than it removes, is not a win

3. **Write your section of `research.md`** with one subsection per unknown
   researched:

   ```markdown
   ## Library research — TypeScript/web

   ### <Unknown, e.g. "Rate limiting">

   **Candidates considered:** <library> (<one-line why>), <library> (<one-line why>)
   **Recommendation:** use `<library>` | build custom
   **Why:** <2-3 sentences — maintenance status, fit, scope saved or why nothing fit>
   ```

   `research.md` is a valid artifact under this repo's presets — it is
   explicitly allowed by `spec-minimal` (v1.1.0+) when that preset is also
   installed. A shared file rather than a second one keeps it that way.

4. **Revise `plan.md` in place** for every unknown where the recommendation
   is "use `<library>`": replace the custom-build description with a note
   that the feature will use the library instead, naming it and linking to
   `research.md` for the rationale (e.g. `See research.md (TypeScript/web) —
   using <library> instead of a custom implementation.`). Touch only the
   TypeScript/web parts of the plan; never edit iOS/Swift sections or notes
   the sibling layer wrote. Do not touch sections for unknowns where the
   recommendation was "build custom" or where no unknown was found.

### Failure Policy

- Do not fabricate library names, versions, or maintenance status. Every claim
  in `research.md` must come from an actual search/fetch result performed
  during this run, not from memory.
- If web search tools are unavailable in this session, write that fact as the
  body of **your section** instead of guessing (never overwrite the file), and
  leave `plan.md` untouched.

## Completion Report

On success, include:
- Whether research ran, and if so, how many unknowns were identified and
  researched.
- The Jev `record` line from the applicability gate.
- Any unknown where the recommendation was "use `<library>`", naming the
  library and the plan section it now replaces.
- The normal stock `/speckit-plan` completion summary.


### Post-Flight Check (MANDATORY — LAST STEP)

After the entire core flow above has completed, and before reporting success:

```bash
bun .specify/presets/diff-minimal/scripts/ts/check-plan-scope.ts "$SPECIFY_FEATURE_DIRECTORY"
```

The check is read-only. It parses the spec's `MUST NOT touch:` list and scans
`plan.md`, `tasks.md`, and any `quickstart.md` / `research.md`, skipping lines
that negate ("must not touch `X`") and sections about scope, non-goals, or
corrections.

Handle the exit code:

- **`0`** — the plan respects every out-of-scope path (or the spec forbids
  none). Report success.
- **`1`** — read the stderr: each violation is printed as `file:line` with the
  entry that forbids it. **Remove the work from the plan** and re-run. Only if
  the path is genuinely required do you amend `## Scope discipline` in `spec.md`
  and record the change on the tracking issue — then re-run. Do not report
  success while the check fails.
- **`2`** — bad usage, or no `spec.md` in the feature directory. Fix the call
  and re-run.


### Post-Flight Check (MANDATORY — LAST STEP)

After the entire core flow above has completed, and before reporting success:

```bash
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
bun "$PROJECT_DIR/.specify/presets/button-design/scripts/ts/check-buttons.ts" plan "$SPECIFY_FEATURE_DIRECTORY"
```

The check is read-only. Handle the exit code:

- **`0`**: the plan carries a populated `## Button System`, or the spec
  declares no actions. Report success.
- **`1`**: stderr names the missing section, the empty marker, or a touch
  target under 44×44. Fix `plan.md` and re-run. Do not report success while it
  fails.
- **`2`**: bad usage, or no `plan.md` in the feature directory. Fix the call
  and re-run.


### Mandatory "Parse Boundaries" section

After the core flow has produced `plan.md`, add a **`## Parse Boundaries`**
section to it. This section makes the *parse, don't validate* discipline a
design decision rather than a write-time afterthought.

Apply this gate when the feature is implemented in TypeScript or Python. If the
feature has no TypeScript/Python surface, write `## Parse Boundaries` with a
single line "N/A — no TypeScript or Python in this feature" and continue.

For a TypeScript or Python feature, the section MUST enumerate:

1. **Trust boundaries** — every point where untrusted data enters the feature
   (HTTP handlers, DB rows, env, file/CLI input, `JSON.parse` / `json.loads`,
   third-party SDK responses). Each entry names the raw input and states that it
   is kept untyped-safe on the way in (`unknown` in TypeScript, never `any`;
   fed straight to a parser in Python, never left as `Any`).
2. **Domain types** — the precise / branded types the feature earns the right to
   trust (e.g. `Email`, `UserId`), including how identity is made nominal
   (TypeScript: non-exported `unique symbol` brand or a schema library's
   `.brand()`; Python: `NewType`, a pydantic/attrs model, or a frozen
   dataclass). Every domain primitive that could be confused with another
   (`UserId` vs `OrderId`) is called out as branded.
3. **Parsers** — for each boundary, the parser that maps the raw blob to a
   domain type. TypeScript parsers return a discriminated `Result`
   (`{ kind: "ok" | "err" }`); Python parsers return the parsed model or raise a
   single typed parse error — neither returns a bare boolean and neither relies
   on `throw`/scattered re-checks. Name the module that owns each parser; brand
   casts live only there.
4. **Library choice** — whether the feature uses a schema library (TS: Zod /
   valibot / io-ts; Python: pydantic / attrs / msgspec) or hand-rolled parsers,
   and why. Prefer an existing project dependency over new hand-rolled casts.

Do not write the blanket sentence "inputs are validated" — that is the exact
anti-pattern this section exists to replace. Name the parser, its input, and its
output type.

## Failure Policy

- A TypeScript/Python feature whose `plan.md` lacks a substantive
  `## Parse Boundaries` section (boundaries + domain types + parsers) is
  incomplete. Fill it in before finishing the command.
- Downstream `/speckit-implement` (under this preset) will scan the written code
  against this design; a plan that hand-waves the boundaries will surface as
  scan findings later.

## Completion Report

On success, include:
- Confirmation that `plan.md` has a `## Parse Boundaries` section (or that it is
  N/A for a non-TypeScript/Python feature).
- A one-line summary of the boundaries, domain types, and parsers identified.
- The normal stock `/speckit-plan` completion summary.


### Ladder Pass (MANDATORY — runs after the core flow)

Re-read the finished `plan.md` (and `research.md` if present). Enumerate every
item it proposes to **add**:

- **file** — a new source, config, migration, or test file
- **abstraction** — a new interface, class, module, service, or layer
- **dependency** — a package or external service not in the project today
- **config** — a new setting, flag, env var, or option

For each, read the code it would touch first, then climb. Stop at the first rung
that holds:

1. **Does it need to exist?** Speculative need → cut it. (YAGNI)
2. **Already in this codebase?** Reuse the helper, type, or pattern.
3. **Stdlib does it?**
4. **Native platform feature covers it?** (CSS over JS, a DB constraint over app code.)
5. **Already-installed dependency solves it?**
6. **Can it be one line?**
7. **Only then:** the minimum new code, or a new dependency.

No interface with one implementation, no factory for one product, no config for
a value that never changes, no scaffolding for later.

**Never cut:** validation at trust boundaries, error handling that prevents data
loss, security measures, accessibility basics, or anything `spec.md` explicitly
requires. Those rows record rung 7 with the reason.

**Apply the result, do not just note it.** An item that stops at rung 1 is
removed from `plan.md`. An item that stops at rungs 2–6 is rewritten in
`plan.md` to use the existing code, stdlib, platform feature, installed
dependency, or one-liner instead. A library `library-research` recommended is a
dependency like any other: if rungs 2–6 hold, revise `plan.md` and note the
reversal in `research.md`.

Then add this section to `plan.md`:

```markdown
## Ladder

| Item | Kind | Rung | Reason |
|------|------|------|--------|
| `src/cache.ts` | file | 1 | cut: no measured latency problem |
| RetryPolicy interface | abstraction | 2 | reuse `withBackoff()` in `src/http.ts` |
| `p-queue` | dependency | 7 | concurrency cap across workers |

**Dependency justification:** `p-queue` — no queue in the codebase (2), stdlib
has none (3), no platform primitive (4), no installed dep covers it (5), a
correct cap is not one line (6).
```

- `Kind` is one of `file`, `abstraction`, `dependency`, `config`.
- `Rung` is the single integer 1–7 the item stopped at. An installed dependency
  is rung 5; a **new** dependency is rung 7.
- Any `dependency` row at rung 7 requires a populated
  `**Dependency justification:**` line naming why rungs 2–6 fail.
- A plan that adds nothing writes the section with exactly
  `None — extends existing code only.` in place of the table.

### Post-Flight Check (MANDATORY — LAST STEP)

```bash
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
bun "$PROJECT_DIR/.specify/presets/ponytail-plan/scripts/ts/check-ladder.ts" "$SPECIFY_FEATURE_DIRECTORY/plan.md"
```

The check is read-only. Handle the exit code:

- **`0`**: the section is present and well-formed. Report success.
- **`1`**: stderr lists each problem as `file:line`. Fix `plan.md` and re-run.
  Do not report success while it fails.
- **`2`**: bad usage or no `plan.md`. Fix the call and re-run.

The check is mechanical: it cannot tell whether a rung was honestly climbed.
That part is on you.


## Dashboard — `plan` done

```bash
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
REPORT="$PROJECT_DIR/.specify/presets/progress-report/scripts/ts/progress_report.ts"
command -v bun >/dev/null || { echo "progress-report: bun not found on PATH — install bun (https://bun.sh); the dashboard writer is TypeScript run by bun" >&2; exit 1; }
bun "$REPORT" done plan --summary "<architecture / data model / key decisions in one line>"
```

If the plan is blocked (e.g. a gate you can't clear or an open design decision):
`bun "$REPORT" block plan --reason "<reason>"`.
