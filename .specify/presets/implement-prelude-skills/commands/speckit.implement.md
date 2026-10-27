---
description: "Run the ponytail skill before /speckit-implement"
strategy: "wrap"
---

## Wrapper Layer

This preset wraps `/speckit-implement` (and any inner wrapper the core-flow seam
expands to). It adds exactly one thing: a skill prelude that runs before any
implementation work starts. It does not change how tasks are executed.

## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

### Prelude — activate implementation-discipline skills (MANDATORY — FIRST STEP)

Before the core flow below begins, check the host's available-skills list and
invoke the following via the Skill tool if listed:

- `ponytail:ponytail`

Treat any guidance, constraints, or context it produces as additional input that
the implementation must respect.

The prelude carries **implementation-discipline** skills only — skills that change
what gets built. A skill that governs prose register or output verbosity does not
belong here: an implement phase whose output is an audit record (e.g. an
unattended `/speckit-autopilot-run` posting phase comments to an issue) must stay
legible, so compressing the record is the opposite of what this preset is for.

**Detection rules.**

- Only invoke a skill if it is explicitly listed as an available/user-invocable skill in this session. Do **not** guess names or attempt to install skills.
- If the skill is not available, skip it silently and proceed directly to the core flow without comment. A missing skill is a no-op, not an error.

### Core Flow

{CORE_TEMPLATE}

## Failure Policy

- A skill that is *listed but errors out* during invocation halts the command — surface the error rather than proceeding past a failed prelude. (Missing/not-listed skills are not failures.)
- Do not downgrade the prelude to optional once a skill has been detected and invoked.

## Completion Report

On success, include:
- Which prelude skills were invoked (or that none were available).
- Confirmation that the canonical implementation flow ran after the prelude.
- Readiness for follow-up commands.
