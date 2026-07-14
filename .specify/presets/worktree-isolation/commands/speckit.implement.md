---
description: "Execute the implementation plan by processing and executing all tasks defined in tasks.md. Per BeadBits Constitution v2.3.0 Principle VII (Feature-Work Isolation), this command MUST run inside the feature's dedicated worktree; the agent cd's into the worktree recorded in .specify/feature.json before executing any task."
argument-hint: "Optional implementation guidance or task filter"
compatibility: "Requires spec-kit project structure with .specify/ directory"
metadata:
  author: "beadbits"
  source: ".specify/presets/worktree-isolation/commands/speckit.implement.md"
user-invocable: true
disable-model-invocation: false
---


## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

## Pre-Execution Checks

**Check for extension hooks (before implementation)**:
- Check if `.specify/extensions.yml` exists in the project root.
- If it exists, read it and look for entries under the `hooks.before_implement` key
- Filter, evaluate, and emit hook banners per the standard format.
- If no hooks are registered or `.specify/extensions.yml` does not exist, skip silently.

## Outline

### 0. cd into the feature's worktree (MANDATORY — Principle VII)

Per BeadBits Constitution v2.3.0 Principle VII (Feature-Work Isolation),
/speckit-implement MUST execute with the agent's cwd set to the feature's worktree.
This step runs BEFORE any filesystem write performed by the rest of this
outline.

1. Read `.specify/feature.json` (relative to the current cwd). If the file
   is missing or cannot be parsed as JSON, ERROR with:
   "Cannot resolve feature: .specify/feature.json is missing or malformed.
   Run /speckit-specify to (re)initialize a feature."
   Do NOT proceed.

2. Let `WT = feature.json.worktree_path`.

3. If `WT` is null or the field is absent:
   Emit a single-sentence warning:
   "This feature has no recorded worktree_path (likely created before
   Constitution v2.3.0). Proceeding in the current cwd; Principle VII
   isolation is not enforced for this invocation."
   Then proceed in the current cwd. Skip steps 4–6.

4. If `WT` is non-null but the directory does NOT exist on disk:
   The recorded path is machine-local (e.g. created in another clone or by
   another author) and is meaningless here. Emit a single-sentence warning:
   "Recorded worktree_path '<WT>' does not exist on disk (likely a path from
   another clone). Proceeding in the current cwd; Principle VII isolation is
   not enforced for this invocation."
   Then proceed in the current cwd. Skip steps 5–6.

5. If `WT` is non-null, exists on disk, and matches the current cwd
   (resolved to absolute path), proceed silently — no cd needed.

6. Otherwise (`WT` is non-null, exists, and differs from cwd):
   Prefix every subsequent shell invocation in this command with
   `cd "<WT>" && ...` so the cd is visible in the session log. All
   filesystem writes performed by the rest of this outline land inside
   the worktree. Do not silently rely on tools that ignore cwd
   (absolute-path file writers) as a substitute — the cd MUST appear
   in the session log for post-hoc isolation auditing.

### End cd-block (Principle VII enforcement complete)

### 1. Prerequisites

Run `.specify/scripts/bash/check-prerequisites.sh --json --require-tasks --include-tasks` from repo root and parse FEATURE_DIR and AVAILABLE_DOCS list. All paths must be absolute. For single quotes in args like "I'm Groot", use escape syntax: e.g 'I'\''m Groot' (or double-quote if possible: "I'm Groot").

### 2. Check checklists status

(if FEATURE_DIR/checklists/ exists):
- Scan all checklist files in the checklists/ directory
- For each checklist, count:
  - Total items: All lines matching `- [ ]` or `- [X]` or `- [x]`
  - Completed items: Lines matching `- [X]` or `- [x]`
  - Incomplete items: Lines matching `- [ ]`
- Create a status table:

  ```text
  | Checklist | Total | Completed | Incomplete | Status |
  |-----------|-------|-----------|------------|--------|
  | ux.md     | 12    | 12        | 0          | ✓ PASS |
  | test.md   | 8     | 5         | 3          | ✗ FAIL |
  | security.md | 6   | 6         | 0          | ✓ PASS |
  ```

- Calculate overall status:
  - **PASS**: All checklists have 0 incomplete items
  - **FAIL**: One or more checklists have incomplete items

- **If any checklist is incomplete**:
  - Display the table with incomplete item counts
  - **STOP** and ask: "Some checklists are incomplete. Do you want to proceed with implementation anyway? (yes/no)"
  - Wait for user response before continuing
  - If user says "no" or "wait" or "stop", halt execution
  - If user says "yes" or "proceed" or "continue", proceed to step 3

- **If all checklists are complete**:
  - Display the table showing all checklists passed
  - Automatically proceed to step 3

### 3. Load implementation context

- **REQUIRED**: Read tasks.md for the complete task list and execution plan
- **REQUIRED**: Read plan.md for tech stack, architecture, and file structure
- **IF EXISTS**: Read data-model.md for entities and relationships
- **IF EXISTS**: Read contracts/ for API specifications and test requirements
- **IF EXISTS**: Read research.md for technical decisions and constraints
- **IF EXISTS**: Read .specify/memory/constitution.md for governance constraints
- **IF EXISTS**: Read quickstart.md for integration scenarios

### 4. Project setup verification

- **REQUIRED**: Create/verify ignore files based on actual project setup:

**Detection & Creation Logic**:
- Check if the following command succeeds to determine if the repository is a git repo (create/verify .gitignore if so):

  ```sh
  git rev-parse --git-dir 2>/dev/null
  ```

- Check if Dockerfile* exists or Docker in plan.md → create/verify .dockerignore
- Check if .eslintrc* exists → create/verify .eslintignore
- Check if eslint.config.* exists → ensure the config's `ignores` entries cover required patterns
- Check if .prettierrc* exists → create/verify .prettierignore
- Check if .npmrc or package.json exists → create/verify .npmignore (if publishing)
- Check if terraform files (*.tf) exist → create/verify .terraformignore
- Check if .helmignore needed (helm charts present) → create/verify .helmignore

**If ignore file already exists**: Verify it contains essential patterns, append missing critical patterns only
**If ignore file missing**: Create with full pattern set for detected technology

**Common Patterns by Technology** (from plan.md tech stack):
- **Node.js/JavaScript/TypeScript**: `node_modules/`, `dist/`, `build/`, `*.log`, `.env*`
- **Python**: `__pycache__/`, `*.pyc`, `.venv/`, `venv/`, `dist/`, `*.egg-info/`
- **Go**: `*.exe`, `*.test`, `vendor/`, `*.out`
- **Universal**: `.DS_Store`, `Thumbs.db`, `*.tmp`, `*.swp`, `.vscode/`, `.idea/`

**Tool-Specific Patterns**:
- **Docker**: `node_modules/`, `.git/`, `Dockerfile*`, `.dockerignore`, `*.log*`, `.env*`, `coverage/`
- **Terraform**: `.terraform/`, `*.tfstate*`, `*.tfvars`, `.terraform.lock.hcl`

### 5. Parse tasks.md

Extract:
- **Task phases**: Setup, Tests, Core, Integration, Polish
- **Task dependencies**: Sequential vs parallel execution rules
- **Task details**: ID, description, file paths, parallel markers [P]
- **Execution flow**: Order and dependency requirements

### 6. Execute implementation

- **Phase-by-phase execution**: Complete each phase before moving to the next
- **Respect dependencies**: Run sequential tasks in order, parallel tasks [P] can run together
- **Follow TDD approach**: Execute test tasks before their corresponding implementation tasks
- **File-based coordination**: Tasks affecting the same files must run sequentially
- **Validation checkpoints**: Verify each phase completion before proceeding

### 7. Implementation execution rules

- **Setup first**: Initialize project structure, dependencies, configuration
- **Tests before code**: If you need to write tests for contracts, entities, and integration scenarios
- **Core development**: Implement models, services, CLI commands, endpoints
- **Integration work**: Database connections, middleware, logging, external services
- **Polish and validation**: Unit tests, performance optimization, documentation

### 8. Progress tracking and error handling

- Report progress after each completed task
- Halt execution if any non-parallel task fails
- For parallel tasks [P], continue with successful tasks, report failed ones
- Provide clear error messages with context for debugging
- Suggest next steps if implementation cannot proceed
- **IMPORTANT** For completed tasks, make sure to mark the task off as [X] in the tasks file.

### 9. Completion validation

- Verify all required tasks are completed
- Check that implemented features match the original specification
- Validate that tests pass and coverage meets requirements
- Confirm the implementation follows the technical plan
- Report final status with summary of completed work

Note: This command assumes a complete task breakdown exists in tasks.md. If tasks are incomplete or missing, suggest running `/speckit-tasks` first to regenerate the task list.

### 10. Check for extension hooks (after implementation)

After completion validation, check if `.specify/extensions.yml` exists in the project root.
- If it exists, read it and look for entries under the `hooks.after_implement` key
- Filter, evaluate, and emit hook banners per the standard format.
- If no hooks are registered or `.specify/extensions.yml` does not exist, skip silently.

## Constitution v2.3.0 Principle VII compliance note

This preset override exists specifically to close the resume-case gap left by PR #21
for `/speckit-implement`. The substantive operational behaviour it adds beyond the stock
`speckit-implement` skill is:

1. Reading `worktree_path` from `.specify/feature.json` at the cwd.
2. `cd`-ing into that path before any filesystem write performed by the implement outline.
3. Falling back to the current cwd (with a warning) when the recorded worktree directory
   does not exist on disk — because `worktree_path` is a machine-local absolute path
   committed to `.specify/feature.json`, a fresh clone would otherwise abort on a path
   it can never have.

This override SUPERSEDES the in-skill worktree-resolution block previously added in
commit fee6cf3, which auto-created worktrees from the branch name. A missing worktree
directory degrades to the current cwd rather than erroring, so implementation stays
portable across clones.

The cd-block at `### 0.` is byte-identical across all four feature-scoped command
overrides (`/speckit-clarify`, `/speckit-plan`, `/speckit-tasks`, `/speckit-implement`)
modulo the slash-command substitution; this is enforced by SC-002 in
`specs/022-worktree-isolation-resume/quickstart.md`.
