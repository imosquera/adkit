---
description: 'Composable wrapper for /speckit-specify that requires an `## Actions
  & Buttons` table for every feature touching web UI: one primary per screen, buttons
  vs links, specific 1–3 word labels, and a safeguard on every destructive action
  — checked deterministically after the spec is written.'
---


## Wrapper Layer

This preset wraps the stock `/speckit-specify` command. Keep the stock workflow
for branch/worktree setup, feature directory creation, template loading,
checklist generation, hooks, and reporting.

This layer makes the feature's **actions** a requirement. Which control is the
next step, what it says, and what it costs to click it wrongly are product
decisions. Left to implementation they get made by whoever writes the markup,
one screen at a time, and the result is three competing primaries and a
`Submit` on the delete dialog.

### Platform Scope

This layer covers **web / browser screens only** (the TypeScript side). If the
project also installs `button-design-ios`, native app screens belong to its
`## iOS Actions & Buttons` section; never list them here. When the feature's
UI is only on the iOS side, write `None — no user-facing web UI.` under
`## Actions & Buttons`.

### Button Rules (MANDATORY)

Apply these to every user-facing action the feature adds or changes:

1. **Buttons do something; links go somewhere.** Submitting, starting a
   process, opening a modal → `button`. Navigating to a page or section →
   `link`. Never style or specify one as the other.
2. **One primary per screen.** Exactly one action is the next best step and
   gets visual priority. Everything else is `secondary` (outlined/neutral) or
   `tertiary` (text-weight). A modal is its own screen.
3. **Labels are 1–3 words, verb first, and say what happens next.**
   `Download Report`, not `Submit`/`OK`/`Yes`/`Confirm`/`Click here`. If a label
   would make sense on any screen of the product, it is too generic.
4. **Match the moment.** On the step that completes the task, the label names
   the completion (`Download Report`), not the flow (`Next`).
5. **Destructive actions name their consequence and carry a safeguard.**
   `Delete Account`, `Cancel My Subscription`, `Remove File Permanently` —
   never a bare `Delete`. Each one gets a confirm dialog, a type-to-confirm
   step for the unrecoverable ones, or an undo.
6. **Speak the user's language.** No internal feature names or jargon in a
   label; use the verb a user would say out loud.

### Required Section (MANDATORY)

`spec.md` MUST carry an `## Actions & Buttons` section, placed after
`## User Scenarios & Testing`. The `git` extension renders it into the tracking
issue, and `/speckit-plan` is held to it.

```markdown
## Actions & Buttons

| Screen | Label | Kind | Role | Safeguard |
|---|---|---|---|---|
| Export dialog | Download Report | button | primary | — |
| Export dialog | Cancel | button | secondary | — |
| Settings | Save Changes | button | primary | — |
| Settings | Delete Account | button | secondary | type-to-confirm |
| Delete dialog | Delete Account | button | primary | confirm dialog |
| Delete dialog | Keep Account | button | secondary | — |
| Settings | Privacy policy | link | — | — |
```

- **Kind** is `button` or `link`. **Role** is `primary`, `secondary`, or
  `tertiary` for a button, and `—` for a link.
- **Safeguard** is `—` for a non-destructive action. For a destructive one it
  names the mechanism: `confirm dialog`, `type-to-confirm`, or `undo`.
- The label is the exact copy the user will read.
- If the feature has **no user-facing web UI**, write
  `None — no user-facing web UI.` under the heading. Do not omit the heading: an absent section and a
  deliberate "none" must read differently.

If the `spec-ui-preview` preset is also installed, its preview must show the
same hierarchy: one filled primary per screen, secondaries outlined or neutral,
links as underlined text with no container, and destructive actions in the
danger color.

### Core Flow


## Wrapper Layer

This preset wraps the stock `/speckit-specify` command. Keep the stock workflow
for branch/worktree setup, feature directory creation, template loading,
checklist generation, hooks, and reporting.

This layer adds a **minimum-diff mandate**. A short spec and a small change are
different things, and the second is the expensive one: a spec that faithfully
restates an issue's seven-file wish list produces a seven-file diff even when
three of those files had no reason to be touched, because nothing in the
pipeline ever asked whether the change actually needed them.

### Minimum-Diff Mandate (MANDATORY)

Before writing the spec, **re-derive every file path and precondition the issue
asserts against current `main`**. Stale references are the norm, not the
exception, and a correction is cheaper than a wrong spec.

Then specify the smallest change that satisfies the requirements:

- **Prefer extending a file that already exists over adding one.** A new module,
  a new route file, a new registration seam, or a new config entry each needs a
  reason stated in the spec — "it is tidier" is not one.
- **Every file the issue names is a hypothesis, not a requirement.** Drop the
  ones the change does not actually need — an index for a query the database
  already serves; a security rule nothing evaluates; a Terraform apply behind it
  — and record why in `## Corrections to the issue as filed`.
- **Reuse the existing shape**: the payload builder, the ownership check, the
  error discriminant, the test helper. A second way to do something the codebase
  already does is a DRY violation, not a design choice.
- **No drive-by refactors**, no renames, no formatting churn, no "while I was in
  here". If a cleanup is genuinely warranted, it is a separate issue.
- **Success looks like a diff a reviewer can read in one sitting.**

**This is a mandate for the smallest change, not a mandate for small changes.**
A migration, a rename, a framework upgrade, or a schema change legitimately
touches many files, and holding one of those to a small diff would be the
failure, not the discipline. When the change is inherently wide, say so:
add a `**Scope justification:**` line to `## Scope discipline` naming what makes
the breadth intrinsic. What is never acceptable is breadth nobody accounted for.

If implementation later shows an excluded file is genuinely required, that is a
**spec change recorded on the issue** — never a quiet edit.

### Required Sections (MANDATORY)

`spec.md` MUST carry these two sections. They are checked deterministically
after the core flow, and they exist so that later phases can be held to them:
the `git` extension renders whatever sections the spec contains into the
tracking issue, so both survive into the issue body, and `## Scope discipline`
has a known heading that `/speckit-plan` and the review passes can parse.

```markdown
## Corrections to the issue as filed

- `path/from/the/issue` — dropped: the query is a single equality filter the
  database already indexes, so no composite index is needed.
- The issue says the read happens in the client; it runs in a Cloud Function on
  the Admin SDK.

## Scope discipline

**MUST NOT touch:**

- `firestore.rules` — the read runs on the Admin SDK, which never consults rules
- `infra/**` — a rules change would pull a Terraform apply in behind it
- `src/legacy/**` — unrelated layer

**Scope justification:** <only when the change is inherently wide — what makes
the breadth intrinsic>
```

Rules for both sections:

- Each `MUST NOT touch:` entry is a bullet whose path or glob is in **backticks**.
  `**` spans directory separators, a single `*` does not, and a trailing `/`
  means the directory and everything under it.
- Give a short reason per entry. The reason is what stops a later phase from
  overturning the exclusion by guessing.
- If the issue was right in every particular, write `None.` under
  `## Corrections to the issue as filed` rather than inventing a correction.
- If nothing needs holding out, write `None.` under `## Scope discipline` — an
  empty heading is worse than no heading, because later phases would be held to
  nothing while appearing to be held to something.

### Core Flow


## Wrapper Layer

This preset wraps the stock `/speckit-specify` command. Keep the stock workflow for branch/worktree setup, feature directory creation, template loading, checklist generation, hooks, and reporting.

This layer adds one post-processing step: a deterministic section stripper that removes `## Assumptions`, `### Key Entities`, and `## Success Criteria` from the rendered `spec.md`. It runs after the core flow below, not during it — the exact instruction is in **Output Rules (MANDATORY — LAST STEP)** after the core-flow seam. Keep all other mandatory sections intact, including User Scenarios, Edge Cases, Functional Requirements, Functional Programming Constraints, and Platform Constraints.

### Core Flow


## Wrapper Layer

This preset wraps the stock `/speckit-specify` command. Keep the stock workflow for branch/worktree setup, feature directory creation, template loading, checklist generation, hooks, and reporting.

This layer adds one post-processing step: for UI-touching features it inserts a `## UI Preview (Requirement)` section into the rendered `spec.md`. It runs after the core flow below, not during it — the exact instruction is in **UI Preview Layer (MANDATORY — LAST STEP)** after the core-flow seam.

It also composes with any other wrapper around `speckit.specify` — notably `spec-minimal`. When two wrappers are stacked, the engine orders them by install priority ascending, then alphabetically by preset id; whichever comes first ends up as the outer layer. Ordering does not matter here: the two layers are independent. `spec-minimal`'s section stripper only removes `## Assumptions`, `### Key Entities`, and `## Success Criteria`, and never touches the `## UI Preview (Requirement)` section this preset writes.

### Core Flow


## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

## Pre-Execution Checks

**Check for extension hooks (before specification)**:
- Check if `.specify/extensions.yml` exists in the project root.
- If it exists, read it and look for entries under the `hooks.before_specify` key
- If the YAML cannot be parsed or is invalid, skip hook checking silently and continue normally
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

The text the user typed after `__SPECKIT_COMMAND_SPECIFY__` in the triggering message **is** the feature description. Assume you always have it available in this conversation even if `{ARGS}` appears literally below. Do not ask the user to repeat it unless they provided an empty command.

Given that feature description, do this:

1. **Generate a concise short name** (2-4 words) for the feature:
   - Analyze the feature description and extract the most meaningful keywords
   - Create a 2-4 word short name that captures the essence of the feature
   - Use action-noun format when possible (e.g., "add-user-auth", "fix-payment-bug")
   - Preserve technical terms and acronyms (OAuth2, API, JWT, etc.)
   - Keep it concise but descriptive enough to understand the feature at a glance
   - Examples:
     - "I want to add user authentication" → "user-auth"
     - "Implement OAuth2 integration for the API" → "oauth2-api-integration"
     - "Create a dashboard for analytics" → "analytics-dashboard"
     - "Fix payment processing timeout bug" → "fix-payment-timeout"

2. **Branch creation** (optional, via hook):

   If a `before_specify` hook ran successfully in the Pre-Execution Checks above, it will have created/switched to a git branch and output JSON containing `BRANCH_NAME` and `FEATURE_NUM`. Note these values for reference, but the branch name does **not** dictate the spec directory name.

   If the user explicitly provided `GIT_BRANCH_NAME`, pass it through to the hook so the branch script uses the exact value as the branch name (bypassing all prefix/suffix generation).

3. **Create the spec feature directory**:

   Specs live under the default `specs/` directory unless the user explicitly provides `SPECIFY_FEATURE_DIRECTORY`.

   **Resolution order for `SPECIFY_FEATURE_DIRECTORY`**:
   1. If the user explicitly provided `SPECIFY_FEATURE_DIRECTORY` (e.g., via environment variable, argument, or configuration), use it as-is
   2. Otherwise, auto-generate it under `specs/`:
      - Check `.specify/init-options.json` for `feature_numbering` (preferred) or `branch_numbering` (deprecated, migration only — will be removed in a future release)
      - If `"timestamp"`: prefix is `YYYYMMDD-HHMMSS` (current timestamp)
      - If `"sequential"` or absent: prefix is `NNN` (next available 3-digit number after scanning existing directories in `specs/`)
      - Construct the directory name: `<prefix>-<short-name>` (e.g., `003-user-auth` or `20260319-143022-user-auth`)
      - Set `SPECIFY_FEATURE_DIRECTORY` to `specs/<directory-name>`
      - If `branch_numbering` was used (and `feature_numbering` was absent), emit a one-line warning: "⚠️ `branch_numbering` in init-options.json is deprecated. Rename to `feature_numbering`."

   **Create the directory and spec file**:
   - `mkdir -p SPECIFY_FEATURE_DIRECTORY`
   - Resolve the active `spec-template` through the Spec Kit preset/template resolution stack (equivalent to `specify preset resolve spec-template`)
   - Copy the resolved `spec-template` file to `SPECIFY_FEATURE_DIRECTORY/spec.md` as the starting point
   - Set `SPEC_FILE` to `SPECIFY_FEATURE_DIRECTORY/spec.md`
   - Persist the resolved path to `.specify/feature.json`:
     ```json
     {
       "feature_directory": "<resolved feature dir>"
     }
     ```
     Write the actual resolved directory path value (for example, `specs/003-user-auth`), not the literal string `SPECIFY_FEATURE_DIRECTORY`.
     This allows downstream commands (`__SPECKIT_COMMAND_PLAN__`, `__SPECKIT_COMMAND_TASKS__`, etc.) to locate the feature directory without relying on git branch name conventions.

   **IMPORTANT**:
   - You must only create one feature per `__SPECKIT_COMMAND_SPECIFY__` invocation
   - The spec directory name and the git branch name are independent — they may be the same but that is the user's choice
   - The spec directory and file are always created by this command, never by the hook

4. Load the resolved active `spec-template` file to understand required sections.

5. **IF EXISTS**: Load `/memory/constitution.md` for project principles and governance constraints.

6. Follow this execution flow:
    1. Parse user description from arguments
       If empty: ERROR "No feature description provided"
    2. Extract key concepts from description
       Identify: actors, actions, data, constraints
    3. For unclear aspects:
       - Make informed guesses based on context and industry standards
       - Only mark with [NEEDS CLARIFICATION: specific question] if:
         - The choice significantly impacts feature scope or user experience
         - Multiple reasonable interpretations exist with different implications
         - No reasonable default exists
       - **LIMIT: Maximum 3 [NEEDS CLARIFICATION] markers total**
       - Prioritize clarifications by impact: scope > security/privacy > user experience > technical details
    4. Fill User Scenarios & Testing section
       If no clear user flow: ERROR "Cannot determine user scenarios"
    5. Generate Functional Requirements
       Each requirement must be testable
       Use reasonable defaults for unspecified details (document assumptions in Assumptions section)
    6. Define Success Criteria
       Create measurable, technology-agnostic outcomes
       Include both quantitative metrics (time, performance, volume) and qualitative measures (user satisfaction, task completion)
       Each criterion must be verifiable without implementation details
    7. Identify Key Entities (if data involved)
    8. Return: SUCCESS (spec ready for planning)

7. Write the specification to SPEC_FILE using the template structure, replacing placeholders with concrete details derived from the feature description (arguments) while preserving section order and headings.

8. **Specification Quality Validation**: After writing the initial spec, validate it against quality criteria:

   a. **Create Spec Quality Checklist**: Generate a checklist file at `SPECIFY_FEATURE_DIRECTORY/checklists/requirements.md` using the checklist template structure with these validation items:

      ```markdown
      # Specification Quality Checklist: [FEATURE NAME]

      **Purpose**: Validate specification completeness and quality before proceeding to planning
      **Created**: [DATE]
      **Feature**: [Link to spec.md]

      ## Content Quality

      - [ ] No implementation details (languages, frameworks, APIs)
      - [ ] Focused on user value and business needs
      - [ ] Written for non-technical stakeholders
      - [ ] All mandatory sections completed

      ## Requirement Completeness

      - [ ] No [NEEDS CLARIFICATION] markers remain
      - [ ] Requirements are testable and unambiguous
      - [ ] Success criteria are measurable
      - [ ] Success criteria are technology-agnostic (no implementation details)
      - [ ] All acceptance scenarios are defined
      - [ ] Edge cases are identified
      - [ ] Scope is clearly bounded
      - [ ] Dependencies and assumptions identified

      ## Feature Readiness

      - [ ] All functional requirements have clear acceptance criteria
      - [ ] User scenarios cover primary flows
      - [ ] Feature meets measurable outcomes defined in Success Criteria
      - [ ] No implementation details leak into specification

      ## Notes

      - Items marked incomplete require spec updates before `__SPECKIT_COMMAND_CLARIFY__` or `__SPECKIT_COMMAND_PLAN__`
      ```

   b. **Run Validation Check**: Review the spec against each checklist item:
      - For each item, determine if it passes or fails
      - Document specific issues found (quote relevant spec sections)

   c. **Handle Validation Results**:

      - **If all items pass**: Mark checklist complete and proceed to the Mandatory Post-Execution Hooks section

      - **If items fail (excluding [NEEDS CLARIFICATION])**:
        1. List the failing items and specific issues
        2. Update the spec to address each issue
        3. Re-run validation until all items pass (max 3 iterations)
        4. If still failing after 3 iterations, document remaining issues in checklist notes and warn user

      - **If [NEEDS CLARIFICATION] markers remain**:
        1. Extract all [NEEDS CLARIFICATION: ...] markers from the spec
        2. **LIMIT CHECK**: If more than 3 markers exist, keep only the 3 most critical (by scope/security/UX impact) and make informed guesses for the rest
        3. For each clarification needed (max 3), present options to user in this format:

           ```markdown
           ## Question [N]: [Topic]

           **Context**: [Quote relevant spec section]

           **What we need to know**: [Specific question from NEEDS CLARIFICATION marker]

           **Suggested Answers**:

           | Option | Answer | Implications |
           |--------|--------|--------------|
           | A      | [First suggested answer] | [What this means for the feature] |
           | B      | [Second suggested answer] | [What this means for the feature] |
           | C      | [Third suggested answer] | [What this means for the feature] |
           | Custom | Provide your own answer | [Explain how to provide custom input] |

           **Your choice**: _[Wait for user response]_
           ```

        4. **CRITICAL - Table Formatting**: Ensure markdown tables are properly formatted:
           - Use consistent spacing with pipes aligned
           - Each cell should have spaces around content: `| Content |` not `|Content|`
           - Header separator must have at least 3 dashes: `|--------|`
           - Test that the table renders correctly in markdown preview
        5. Number questions sequentially (Q1, Q2, Q3 - max 3 total)
        6. Present all questions together before waiting for responses
        7. Wait for user to respond with their choices for all questions (e.g., "Q1: A, Q2: Custom - [details], Q3: B")
        8. Update the spec by replacing each [NEEDS CLARIFICATION] marker with the user's selected or provided answer
        9. Re-run validation after all clarifications are resolved

   d. **Update Checklist**: After each validation iteration, update the checklist file with current pass/fail status

## Mandatory Post-Execution Hooks

**You MUST complete this section before reporting completion to the user.**

Check if `.specify/extensions.yml` exists in the project root.
- If it does not exist, or no hooks are registered under `hooks.after_specify`, skip to the Completion Report.
- If it exists, read it and look for entries under the `hooks.after_specify` key.
- If the YAML cannot be parsed or is invalid, skip hook checking silently and continue to the Completion Report.
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

Report completion to the user with:
- `SPECIFY_FEATURE_DIRECTORY` — the feature directory path
- `SPEC_FILE` — the spec file path
- Checklist results summary
- Readiness for the next phase (`__SPECKIT_COMMAND_CLARIFY__` or `__SPECKIT_COMMAND_PLAN__`)

**NOTE:** Branch creation is handled by the `before_specify` hook (git extension). Spec directory and file creation are always handled by this core command.

## Quick Guidelines

- Focus on **WHAT** users need and **WHY**.
- Avoid HOW to implement (no tech stack, APIs, code structure).
- Written for business stakeholders, not developers.
- DO NOT create any checklists that are embedded in the spec. That will be a separate command.

### Section Requirements

- **Mandatory sections**: Must be completed for every feature
- **Optional sections**: Include only when relevant to the feature
- When a section doesn't apply, remove it entirely (don't leave as "N/A")

### For AI Generation

When creating this spec from a user prompt:

1. **Make informed guesses**: Use context, industry standards, and common patterns to fill gaps
2. **Document assumptions**: Record reasonable defaults in the Assumptions section
3. **Limit clarifications**: Maximum 3 [NEEDS CLARIFICATION] markers - use only for critical decisions that:
   - Significantly impact feature scope or user experience
   - Have multiple reasonable interpretations with different implications
   - Lack any reasonable default
4. **Prioritize clarifications**: scope > security/privacy > user experience > technical details
5. **Think like a tester**: Every vague requirement should fail the "testable and unambiguous" checklist item
6. **Common areas needing clarification** (only if no reasonable default exists):
   - Feature scope and boundaries (include/exclude specific use cases)
   - User types and permissions (if multiple conflicting interpretations possible)
   - Security/compliance requirements (when legally/financially significant)

**Examples of reasonable defaults** (don't ask about these):

- Data retention: Industry-standard practices for the domain
- Performance targets: Standard web/mobile app expectations unless specified
- Error handling: User-friendly messages with appropriate fallbacks
- Authentication method: Standard session-based or OAuth2 for web apps
- Integration patterns: Use project-appropriate patterns (REST/GraphQL for web services, function calls for libraries, CLI args for tools, etc.)

### Success Criteria Guidelines

Success criteria must be:

1. **Measurable**: Include specific metrics (time, percentage, count, rate)
2. **Technology-agnostic**: No mention of frameworks, languages, databases, or tools
3. **User-focused**: Describe outcomes from user/business perspective, not system internals
4. **Verifiable**: Can be tested/validated without knowing implementation details

**Good examples**:

- "Users can complete checkout in under 3 minutes"
- "System supports 10,000 concurrent users"
- "95% of searches return results in under 1 second"
- "Task completion rate improves by 40%"

**Bad examples** (implementation-focused):

- "API response time is under 200ms" (too technical, use "Users see results instantly")
- "Database can handle 1000 TPS" (implementation detail, use user-facing metric)
- "React components render efficiently" (framework-specific)
- "Redis cache hit rate above 80%" (technology-specific)

## Done When

- [ ] Specification written to `SPEC_FILE` and validated against quality checklist
- [ ] Extension hooks dispatched or skipped according to the rules in Mandatory Post-Execution Hooks above
- [ ] Completion reported to user with feature directory, spec file path, and checklist results


### UI Preview Layer (MANDATORY — LAST STEP)

After the entire core flow above has completed and `spec.md` has been written, and
before reporting success, apply this layer to `spec.md` as the final step.

This MUST run **before any post-execution hook renders `spec.md` into a GitHub
issue** (or any other downstream consumer reads the file) — otherwise the issue
body will be missing the preview, which defeats the point of this preset. If the
core flow's post-execution hooks have not yet fired when you reach this point,
insert the preview first and then fire them. If a hook already published an issue
body without the preview, re-run that hook afterward.

If the feature touches user-facing UI, insert a new top-level `## UI Preview (Requirement)` section immediately after `## User Scenarios & Testing` and before `## Functional Requirements`.

The preview must be a self-contained HTML fragment with inline `style="..."` attributes only. Do not use `<style>`, `<script>`, `<link>`, remote assets, or external fonts.

Use this sentinel block so updates can replace the preview idempotently:

```markdown
## UI Preview (Requirement)

This preview is part of the requirement, not a suggestion. Any implementation
that materially diverges from the visual intent below must be re-spec'd. The
markup is GitHub-markdown-safe (inline styles only) and renders inline in
GitHub, VS Code, and Obsidian previews.

<details open>
  <summary><strong>Inline HTML preview</strong> (click to collapse)</summary>

<!-- BEGIN: spec-ui-preview preset -->
<div style="...">
  ...generated fragment...
</div>
<!-- END: spec-ui-preview preset -->

</details>
```

When a Functional Requirement is directly expressed by a visible element in the preview, append `(see UI Preview)` instead of repeating the visual details in prose.

If the feature does not touch user-facing UI, add nothing — do not emit an empty preview section.


### Output Rules (MANDATORY — LAST STEP)

After the entire core flow above has completed and `spec.md` has been written, and
before reporting success, run the deterministic section stripper as the final step:

```bash
.specify/presets/spec-minimal/scripts/bash/strip-spec-sections.sh "$SPECIFY_FEATURE_DIRECTORY/spec.md"
```

This MUST run **before any post-execution hook renders `spec.md` into a GitHub
issue** (or any other downstream consumer reads the file). If the core flow's
post-execution hooks have not yet fired when you reach this point, run the
stripper first and then fire them. If a hook already published an issue body from
the unstripped file, re-run that hook after stripping so the issue reflects the
stripped spec.

The stripper removes `## Assumptions`, `### Key Entities`, and `## Success
Criteria` idempotently — it is safe to run repeatedly. It leaves every other
section untouched.


### Post-Flight Check (MANDATORY — LAST STEP)

After the entire core flow above has completed and `spec.md` has been written,
and before reporting success, verify the two sections:

```bash
bun .specify/presets/diff-minimal/scripts/ts/check-scope-sections.ts "$SPECIFY_FEATURE_DIRECTORY/spec.md"
```

This MUST run **before any post-execution hook renders `spec.md` into a GitHub
issue**, so the issue body carries both sections. If a hook has already
published a body from a spec that failed this check, fix the spec and re-run
that hook.

The check is read-only — it never edits the spec. Handle the exit code:

- **`0`** — both sections are present and populated. Report success.
- **`1`** — read the stderr: it names the missing or empty section and shows the
  expected shape. **Write the missing content into `spec.md` yourself** — do not
  ask the user to, and do not report success — then re-run the check.
- **`2`** — bad usage: the invocation above is wrong. Fix the call and re-run.


### Applicability Gate (after `spec.md` is written)

Before writing `## Actions & Buttons`, ask Jev whether the spec touches UI:

```bash
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
bun "$PROJECT_DIR/.specify/presets/button-design/scripts/ts/jev.ts" applies-ui --spec "$SPECIFY_FEATURE_DIRECTORY/spec.md"
```

- **exit 0, `decision: "skip"`**: write only `None — no user-facing web UI.`
  under `## Actions & Buttons`, then run the post-flight check.
- **exit 0, `decision: "applies"`**: apply the rules above and write the table.
  The gate asks about UI in general: if all of it is native iOS UI, still
  write `None — no user-facing web UI.`
- **exit 3** (or any other exit): decide from the spec yourself, as without Jev.

Quote the printed `record` line in your final report.

### Post-Flight Check (MANDATORY — LAST STEP)

After the entire core flow above has completed and `spec.md` has been written,
and before reporting success:

```bash
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
bun "$PROJECT_DIR/.specify/presets/button-design/scripts/ts/check-buttons.ts" spec "$SPECIFY_FEATURE_DIRECTORY/spec.md"
```

This MUST run **before any post-execution hook renders `spec.md` into a GitHub
issue**, so the issue body carries a section that passed. If a hook already
published a body from a failing spec, fix the spec and re-run that hook.

The check is read-only. Handle the exit code:

- **`0`**: the table follows the rules, or the section says `None.`. Notes on
  stdout (e.g. a screen with buttons but no primary) are advisory. Report
  success.
- **`1`**: stderr names each violating row and rule. **Fix `spec.md`
  yourself.** Rewrite the label, demote the extra primary, or add the
  safeguard. Then re-run. Do not report success while it fails.
- **`2`**: bad usage. Fix the call and re-run.
