---
description: "Run ponytail and caveman skills before /speckit-implement"
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

### Prelude — activate review/lens skills (MANDATORY — FIRST STEP)

Before the core flow below begins, check the host's available-skills list and
invoke each of the following via the Skill tool if listed:

- `ponytail:ponytail`
- `caveman`

Invoke them sequentially (ponytail first, then caveman). Treat any guidance,
constraints, or context produced by these skills as additional input that the
implementation must respect.

**Detection rules.**

- Only invoke a skill if it is explicitly listed as an available/user-invocable skill in this session. Do **not** guess names or attempt to install skills.
- If a skill is not available, skip it silently and continue. Missing skills are a no-op, not an error.
- If neither skill is available, proceed directly to the core flow without comment.

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
