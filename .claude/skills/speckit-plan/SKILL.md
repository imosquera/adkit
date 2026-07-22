---
name: speckit-plan
description: Execute /speckit-plan, but require the Constitution Check section of
argument-hint: "Optional guidance for the planning phase"
  plan.md to pass deterministic substring-quote validation against the constitution
compatibility: Requires spec-kit project structure with .specify/ directory
metadata:
  author: github-spec-kit
  source: preset:constitution-audit
user-invocable: true
disable-model-invocation: false
---

# Speckit Plan Skill

## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

## Behavior

Execute the canonical stock `/speckit-plan` flow with **one mandatory gate** on the Constitution Check section of the generated `plan.md`.

### Core Flow

Run the core plan flow first so that `plan.md` exists before the Constitution
Check gate is applied. This `
## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

## Behavior

Execute the canonical stock `/speckit-plan` flow with **one mandatory gate**: a
Parse boundary design section in the generated `plan.md`.

### Core Flow

Run the core plan flow first so that `plan.md` exists before the gate is
applied. This `
## Dashboard — enter `plan`

```bash
REPORT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}/.specify/presets/progress-report/scripts/python/progress_report.py"
python3 "$REPORT" enter plan
```


## Wrapper Layer

This preset wraps the stock `/speckit-plan` command (and any inner wrapper, such
as the constitution-audit Constitution Check gate, that the core flow expands
to). It enforces a strictly minimal artifact tree.

Enforcement has exactly two parts: a mandatory prompt rule that forbids the agent
from ever creating the forbidden paths, and a read-only post-flight verifier that
fails the run if any forbidden artifact is found on disk. **Nothing is
pre-created** — the feature directory must never contain the forbidden paths at
any point, not even as empty sentinel files or read-only directories.

### Documentation Rule (MANDATORY — NO EXCEPTIONS)

The feature directory MUST contain ONLY these files at the top level:

- `spec.md`
- `plan.md`
- `tasks.md`
- `requirements.md`
- `quickstart.md` (optional but allowed)

`research.md`, `data-model.md`, and `contracts/` **MUST NOT be created** — not as
files, not as directories, not in any form. There is no escape hatch. Any content
that the stock flow would have written into one of those paths MUST instead be
inlined as a section of `plan.md` or `requirements.md`.

When you reach any step of the core flow that would create `research.md`,
`data-model.md`, or `contracts/`, do not create the path. Fold its content into
`plan.md` or `requirements.md` and continue.

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
- If the YAML cannot be parsed or is invalid, skip hook checking silently and continue normally
- Filter out hooks where `enabled` is explicitly `false`. Treat hooks without an `enabled` field as enabled by default.
- For each remaining hook, do **not** attempt to interpret or evaluate hook `condition` expressions:
  - If the hook has no `condition` field, or it is null/empty, treat the hook as executable
  - If the hook defines a non-empty `condition`, skip the hook and leave condition evaluation to the HookExecutor implementation
- When constructing slash commands from hook command names, replace dots (`.`) with hyphens (`-`). For example, `speckit.git.commit` → `/speckit-git-commit`.
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

1. **Setup**: Run `.specify/scripts/bash/setup-plan.sh --json` from repo root and parse JSON for FEATURE_SPEC, IMPL_PLAN, SPECS_DIR, BRANCH. For single quotes in args like "I'm Groot", use escape syntax: e.g 'I'\''m Groot' (or double-quote if possible: "I'm Groot").

2. **Load context**: Read FEATURE_SPEC and `.specify/memory/constitution.md`. Load IMPL_PLAN template (already copied).

3. **Execute plan workflow**: Follow the structure in IMPL_PLAN template to:
   - Fill Technical Context (mark unknowns as "NEEDS CLARIFICATION")
   - Fill Constitution Check section from constitution
   - Evaluate gates (ERROR if violations unjustified)
   - Phase 0: Generate research.md (resolve all NEEDS CLARIFICATION)
   - Phase 1: Generate data-model.md, contracts/, quickstart.md
   - Phase 1: Update agent context by running the agent script
   - Re-evaluate Constitution Check post-design

## Mandatory Post-Execution Hooks

**You MUST complete this section before reporting completion to the user.**

Check if `.specify/extensions.yml` exists in the project root.
- If it does not exist, or no hooks are registered under `hooks.after_plan`, skip to the Completion Report.
- If it exists, read it and look for entries under the `hooks.after_plan` key.
- If the YAML cannot be parsed or is invalid, skip hook checking silently and continue to the Completion Report.
- Filter out hooks where `enabled` is explicitly `false`. Treat hooks without an `enabled` field as enabled by default.
- For each remaining hook, do **not** attempt to interpret or evaluate hook `condition` expressions:
  - If the hook has no `condition` field, or it is null/empty, treat the hook as executable
  - If the hook defines a non-empty `condition`, skip the hook and leave condition evaluation to the HookExecutor implementation
- When constructing slash commands from hook command names, replace dots (`.`) with hyphens (`-`). For example, `speckit.git.commit` → `/speckit-git-commit`.
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

Command ends after Phase 2 planning. Report branch, IMPL_PLAN path, and generated artifacts.

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


### Post-Flight Verification (MANDATORY — LAST STEP)

After the entire core flow above has completed, and before reporting success, run
the read-only verifier as the final step:

```bash
.specify/presets/spec-minimal/scripts/bash/verify-minimal-tree.sh "$SPECIFY_FEATURE_DIRECTORY"
```

This script creates nothing and deletes nothing. It exits non-zero if any
forbidden artifact (`research.md`, `data-model.md`, `contracts/`) or any other
unexpected entry ended up on disk. If it exits non-zero, surface the error
verbatim to the user and stop — do not retry, do not silently delete, do not
report success. Only report success once this verifier exits zero.


## Dashboard — `plan` done

```bash
REPORT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}/.specify/presets/progress-report/scripts/python/progress_report.py"
python3 "$REPORT" done plan --summary "<architecture / data model / key decisions in one line>"
```

If the plan is blocked (e.g. a gate you can't clear or an open design decision):
`python3 "$REPORT" block plan --reason "<reason>"`.
` seam is also the chaining point that lets other
presets wrap this command: when composed, the placeholder expands to the next
inner wrapper and ultimately the stock flow.


## Dashboard — enter `plan`

```bash
REPORT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}/.specify/presets/progress-report/scripts/python/progress_report.py"
python3 "$REPORT" enter plan
```


## Wrapper Layer

This preset wraps the stock `/speckit-plan` command (and any inner wrapper, such
as the constitution-audit Constitution Check gate, that the core flow expands
to). It enforces a strictly minimal artifact tree.

Enforcement has exactly two parts: a mandatory prompt rule that forbids the agent
from ever creating the forbidden paths, and a read-only post-flight verifier that
fails the run if any forbidden artifact is found on disk. **Nothing is
pre-created** — the feature directory must never contain the forbidden paths at
any point, not even as empty sentinel files or read-only directories.

### Documentation Rule (MANDATORY — NO EXCEPTIONS)

The feature directory MUST contain ONLY these files at the top level:

- `spec.md`
- `plan.md`
- `tasks.md`
- `requirements.md`
- `quickstart.md` (optional but allowed)

`research.md`, `data-model.md`, and `contracts/` **MUST NOT be created** — not as
files, not as directories, not in any form. There is no escape hatch. Any content
that the stock flow would have written into one of those paths MUST instead be
inlined as a section of `plan.md` or `requirements.md`.

When you reach any step of the core flow that would create `research.md`,
`data-model.md`, or `contracts/`, do not create the path. Fold its content into
`plan.md` or `requirements.md` and continue.

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
- If the YAML cannot be parsed or is invalid, skip hook checking silently and continue normally
- Filter out hooks where `enabled` is explicitly `false`. Treat hooks without an `enabled` field as enabled by default.
- For each remaining hook, do **not** attempt to interpret or evaluate hook `condition` expressions:
  - If the hook has no `condition` field, or it is null/empty, treat the hook as executable
  - If the hook defines a non-empty `condition`, skip the hook and leave condition evaluation to the HookExecutor implementation
- When constructing slash commands from hook command names, replace dots (`.`) with hyphens (`-`). For example, `speckit.git.commit` → `/speckit-git-commit`.
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

1. **Setup**: Run `.specify/scripts/bash/setup-plan.sh --json` from repo root and parse JSON for FEATURE_SPEC, IMPL_PLAN, SPECS_DIR, BRANCH. For single quotes in args like "I'm Groot", use escape syntax: e.g 'I'\''m Groot' (or double-quote if possible: "I'm Groot").

2. **Load context**: Read FEATURE_SPEC and `.specify/memory/constitution.md`. Load IMPL_PLAN template (already copied).

3. **Execute plan workflow**: Follow the structure in IMPL_PLAN template to:
   - Fill Technical Context (mark unknowns as "NEEDS CLARIFICATION")
   - Fill Constitution Check section from constitution
   - Evaluate gates (ERROR if violations unjustified)
   - Phase 0: Generate research.md (resolve all NEEDS CLARIFICATION)
   - Phase 1: Generate data-model.md, contracts/, quickstart.md
   - Phase 1: Update agent context by running the agent script
   - Re-evaluate Constitution Check post-design

## Mandatory Post-Execution Hooks

**You MUST complete this section before reporting completion to the user.**

Check if `.specify/extensions.yml` exists in the project root.
- If it does not exist, or no hooks are registered under `hooks.after_plan`, skip to the Completion Report.
- If it exists, read it and look for entries under the `hooks.after_plan` key.
- If the YAML cannot be parsed or is invalid, skip hook checking silently and continue to the Completion Report.
- Filter out hooks where `enabled` is explicitly `false`. Treat hooks without an `enabled` field as enabled by default.
- For each remaining hook, do **not** attempt to interpret or evaluate hook `condition` expressions:
  - If the hook has no `condition` field, or it is null/empty, treat the hook as executable
  - If the hook defines a non-empty `condition`, skip the hook and leave condition evaluation to the HookExecutor implementation
- When constructing slash commands from hook command names, replace dots (`.`) with hyphens (`-`). For example, `speckit.git.commit` → `/speckit-git-commit`.
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

Command ends after Phase 2 planning. Report branch, IMPL_PLAN path, and generated artifacts.

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


### Post-Flight Verification (MANDATORY — LAST STEP)

After the entire core flow above has completed, and before reporting success, run
the read-only verifier as the final step:

```bash
.specify/presets/spec-minimal/scripts/bash/verify-minimal-tree.sh "$SPECIFY_FEATURE_DIRECTORY"
```

This script creates nothing and deletes nothing. It exits non-zero if any
forbidden artifact (`research.md`, `data-model.md`, `contracts/`) or any other
unexpected entry ended up on disk. If it exits non-zero, surface the error
verbatim to the user and stop — do not retry, do not silently delete, do not
report success. Only report success once this verifier exits zero.


## Dashboard — `plan` done

```bash
REPORT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}/.specify/presets/progress-report/scripts/python/progress_report.py"
python3 "$REPORT" done plan --summary "<architecture / data model / key decisions in one line>"
```

If the plan is blocked (e.g. a gate you can't clear or an open design decision):
`python3 "$REPORT" block plan --reason "<reason>"`.


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
` seam is also the chaining point that
lets other presets (e.g. spec-minimal) wrap this command: when composed, the
placeholder expands to the next inner wrapper and ultimately the stock flow.


## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

## Behavior

Execute the canonical stock `/speckit-plan` flow with **one mandatory gate**: a
Parse boundary design section in the generated `plan.md`.

### Core Flow

Run the core plan flow first so that `plan.md` exists before the gate is
applied. This `
## Dashboard — enter `plan`

```bash
REPORT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}/.specify/presets/progress-report/scripts/python/progress_report.py"
python3 "$REPORT" enter plan
```


## Wrapper Layer

This preset wraps the stock `/speckit-plan` command (and any inner wrapper, such
as the constitution-audit Constitution Check gate, that the core flow expands
to). It enforces a strictly minimal artifact tree.

Enforcement has exactly two parts: a mandatory prompt rule that forbids the agent
from ever creating the forbidden paths, and a read-only post-flight verifier that
fails the run if any forbidden artifact is found on disk. **Nothing is
pre-created** — the feature directory must never contain the forbidden paths at
any point, not even as empty sentinel files or read-only directories.

### Documentation Rule (MANDATORY — NO EXCEPTIONS)

The feature directory MUST contain ONLY these files at the top level:

- `spec.md`
- `plan.md`
- `tasks.md`
- `requirements.md`
- `quickstart.md` (optional but allowed)

`research.md`, `data-model.md`, and `contracts/` **MUST NOT be created** — not as
files, not as directories, not in any form. There is no escape hatch. Any content
that the stock flow would have written into one of those paths MUST instead be
inlined as a section of `plan.md` or `requirements.md`.

When you reach any step of the core flow that would create `research.md`,
`data-model.md`, or `contracts/`, do not create the path. Fold its content into
`plan.md` or `requirements.md` and continue.

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
- If the YAML cannot be parsed or is invalid, skip hook checking silently and continue normally
- Filter out hooks where `enabled` is explicitly `false`. Treat hooks without an `enabled` field as enabled by default.
- For each remaining hook, do **not** attempt to interpret or evaluate hook `condition` expressions:
  - If the hook has no `condition` field, or it is null/empty, treat the hook as executable
  - If the hook defines a non-empty `condition`, skip the hook and leave condition evaluation to the HookExecutor implementation
- When constructing slash commands from hook command names, replace dots (`.`) with hyphens (`-`). For example, `speckit.git.commit` → `/speckit-git-commit`.
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

1. **Setup**: Run `.specify/scripts/bash/setup-plan.sh --json` from repo root and parse JSON for FEATURE_SPEC, IMPL_PLAN, SPECS_DIR, BRANCH. For single quotes in args like "I'm Groot", use escape syntax: e.g 'I'\''m Groot' (or double-quote if possible: "I'm Groot").

2. **Load context**: Read FEATURE_SPEC and `.specify/memory/constitution.md`. Load IMPL_PLAN template (already copied).

3. **Execute plan workflow**: Follow the structure in IMPL_PLAN template to:
   - Fill Technical Context (mark unknowns as "NEEDS CLARIFICATION")
   - Fill Constitution Check section from constitution
   - Evaluate gates (ERROR if violations unjustified)
   - Phase 0: Generate research.md (resolve all NEEDS CLARIFICATION)
   - Phase 1: Generate data-model.md, contracts/, quickstart.md
   - Phase 1: Update agent context by running the agent script
   - Re-evaluate Constitution Check post-design

## Mandatory Post-Execution Hooks

**You MUST complete this section before reporting completion to the user.**

Check if `.specify/extensions.yml` exists in the project root.
- If it does not exist, or no hooks are registered under `hooks.after_plan`, skip to the Completion Report.
- If it exists, read it and look for entries under the `hooks.after_plan` key.
- If the YAML cannot be parsed or is invalid, skip hook checking silently and continue to the Completion Report.
- Filter out hooks where `enabled` is explicitly `false`. Treat hooks without an `enabled` field as enabled by default.
- For each remaining hook, do **not** attempt to interpret or evaluate hook `condition` expressions:
  - If the hook has no `condition` field, or it is null/empty, treat the hook as executable
  - If the hook defines a non-empty `condition`, skip the hook and leave condition evaluation to the HookExecutor implementation
- When constructing slash commands from hook command names, replace dots (`.`) with hyphens (`-`). For example, `speckit.git.commit` → `/speckit-git-commit`.
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

Command ends after Phase 2 planning. Report branch, IMPL_PLAN path, and generated artifacts.

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


### Post-Flight Verification (MANDATORY — LAST STEP)

After the entire core flow above has completed, and before reporting success, run
the read-only verifier as the final step:

```bash
.specify/presets/spec-minimal/scripts/bash/verify-minimal-tree.sh "$SPECIFY_FEATURE_DIRECTORY"
```

This script creates nothing and deletes nothing. It exits non-zero if any
forbidden artifact (`research.md`, `data-model.md`, `contracts/`) or any other
unexpected entry ended up on disk. If it exits non-zero, surface the error
verbatim to the user and stop — do not retry, do not silently delete, do not
report success. Only report success once this verifier exits zero.


## Dashboard — `plan` done

```bash
REPORT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}/.specify/presets/progress-report/scripts/python/progress_report.py"
python3 "$REPORT" done plan --summary "<architecture / data model / key decisions in one line>"
```

If the plan is blocked (e.g. a gate you can't clear or an open design decision):
`python3 "$REPORT" block plan --reason "<reason>"`.
` seam is also the chaining point that lets other
presets wrap this command: when composed, the placeholder expands to the next
inner wrapper and ultimately the stock flow.


## Dashboard — enter `plan`

```bash
REPORT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}/.specify/presets/progress-report/scripts/python/progress_report.py"
python3 "$REPORT" enter plan
```


## Wrapper Layer

This preset wraps the stock `/speckit-plan` command (and any inner wrapper, such
as the constitution-audit Constitution Check gate, that the core flow expands
to). It enforces a strictly minimal artifact tree.

Enforcement has exactly two parts: a mandatory prompt rule that forbids the agent
from ever creating the forbidden paths, and a read-only post-flight verifier that
fails the run if any forbidden artifact is found on disk. **Nothing is
pre-created** — the feature directory must never contain the forbidden paths at
any point, not even as empty sentinel files or read-only directories.

### Documentation Rule (MANDATORY — NO EXCEPTIONS)

The feature directory MUST contain ONLY these files at the top level:

- `spec.md`
- `plan.md`
- `tasks.md`
- `requirements.md`
- `quickstart.md` (optional but allowed)

`research.md`, `data-model.md`, and `contracts/` **MUST NOT be created** — not as
files, not as directories, not in any form. There is no escape hatch. Any content
that the stock flow would have written into one of those paths MUST instead be
inlined as a section of `plan.md` or `requirements.md`.

When you reach any step of the core flow that would create `research.md`,
`data-model.md`, or `contracts/`, do not create the path. Fold its content into
`plan.md` or `requirements.md` and continue.

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
- If the YAML cannot be parsed or is invalid, skip hook checking silently and continue normally
- Filter out hooks where `enabled` is explicitly `false`. Treat hooks without an `enabled` field as enabled by default.
- For each remaining hook, do **not** attempt to interpret or evaluate hook `condition` expressions:
  - If the hook has no `condition` field, or it is null/empty, treat the hook as executable
  - If the hook defines a non-empty `condition`, skip the hook and leave condition evaluation to the HookExecutor implementation
- When constructing slash commands from hook command names, replace dots (`.`) with hyphens (`-`). For example, `speckit.git.commit` → `/speckit-git-commit`.
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

1. **Setup**: Run `.specify/scripts/bash/setup-plan.sh --json` from repo root and parse JSON for FEATURE_SPEC, IMPL_PLAN, SPECS_DIR, BRANCH. For single quotes in args like "I'm Groot", use escape syntax: e.g 'I'\''m Groot' (or double-quote if possible: "I'm Groot").

2. **Load context**: Read FEATURE_SPEC and `.specify/memory/constitution.md`. Load IMPL_PLAN template (already copied).

3. **Execute plan workflow**: Follow the structure in IMPL_PLAN template to:
   - Fill Technical Context (mark unknowns as "NEEDS CLARIFICATION")
   - Fill Constitution Check section from constitution
   - Evaluate gates (ERROR if violations unjustified)
   - Phase 0: Generate research.md (resolve all NEEDS CLARIFICATION)
   - Phase 1: Generate data-model.md, contracts/, quickstart.md
   - Phase 1: Update agent context by running the agent script
   - Re-evaluate Constitution Check post-design

## Mandatory Post-Execution Hooks

**You MUST complete this section before reporting completion to the user.**

Check if `.specify/extensions.yml` exists in the project root.
- If it does not exist, or no hooks are registered under `hooks.after_plan`, skip to the Completion Report.
- If it exists, read it and look for entries under the `hooks.after_plan` key.
- If the YAML cannot be parsed or is invalid, skip hook checking silently and continue to the Completion Report.
- Filter out hooks where `enabled` is explicitly `false`. Treat hooks without an `enabled` field as enabled by default.
- For each remaining hook, do **not** attempt to interpret or evaluate hook `condition` expressions:
  - If the hook has no `condition` field, or it is null/empty, treat the hook as executable
  - If the hook defines a non-empty `condition`, skip the hook and leave condition evaluation to the HookExecutor implementation
- When constructing slash commands from hook command names, replace dots (`.`) with hyphens (`-`). For example, `speckit.git.commit` → `/speckit-git-commit`.
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

Command ends after Phase 2 planning. Report branch, IMPL_PLAN path, and generated artifacts.

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


### Post-Flight Verification (MANDATORY — LAST STEP)

After the entire core flow above has completed, and before reporting success, run
the read-only verifier as the final step:

```bash
.specify/presets/spec-minimal/scripts/bash/verify-minimal-tree.sh "$SPECIFY_FEATURE_DIRECTORY"
```

This script creates nothing and deletes nothing. It exits non-zero if any
forbidden artifact (`research.md`, `data-model.md`, `contracts/`) or any other
unexpected entry ended up on disk. If it exits non-zero, surface the error
verbatim to the user and stop — do not retry, do not silently delete, do not
report success. Only report success once this verifier exits zero.


## Dashboard — `plan` done

```bash
REPORT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}/.specify/presets/progress-report/scripts/python/progress_report.py"
python3 "$REPORT" done plan --summary "<architecture / data model / key decisions in one line>"
```

If the plan is blocked (e.g. a gate you can't clear or an open design decision):
`python3 "$REPORT" block plan --reason "<reason>"`.


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


### Mandatory Quoted Constitution Check

After the core flow has produced `plan.md`, apply the Constitution Check gate.

When `.specify/memory/constitution.md` exists:

1. **List the principles** the Constitution Check must cover:

   ```sh
   python3 .specify/presets/constitution-audit/scripts/python/constitution_audit.py list
   ```

2. **Write the Constitution Check section of `plan.md`** so that, for every principle listed above:
   - The principle heading is referenced.
   - The section contains **a direct quoted span (>= 4 words) taken verbatim from that principle's body in the constitution** (double quotes, backticks, or a `>` blockquote).
   - The section contains a verdict line with exactly one of: `PASS`, `VIOLATES`, or `N/A`.
   - `VIOLATES` entries include a written justification and proposed mitigation (re-checked at `/speckit-implement` time).
   - `N/A` entries include a one-line justification.

   The blanket sentence "No violations" is forbidden — it cannot survive validation.

3. **Validate `plan.md`** deterministically:

   ```sh
   python3 .specify/presets/constitution-audit/scripts/python/constitution_audit.py validate <feature-directory>/plan.md
   ```

   If this exits non-zero, the Constitution Check is incomplete or contains fabricated quotes. Fix the flagged entries and re-run validation. **Do not finish the command until this exits zero.**

When `.specify/memory/constitution.md` does **not** exist, the Constitution Check section may state "No constitution defined" and the stock flow continues unchanged.

## Failure Policy

- A non-zero exit from `constitution_audit.py validate` is a hard stop. The command is incomplete; downstream `/speckit-implement` will refuse to start.
- The script enforces the quote-substring check; the LLM cannot work around it by paraphrasing or inventing plausible-sounding quotes.

## Completion Report

On success, include:
- Whether the Constitution Check was validated (path to `plan.md`)
- Confirmation that `constitution_audit.py validate` exited zero
- The normal stock `/speckit-plan` completion summary
