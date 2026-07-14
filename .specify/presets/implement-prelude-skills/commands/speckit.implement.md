---
description: "Before /speckit-implement begins, invoke the ponytail:ponytail and caveman skills (when available locally), then run the canonical implementation flow."
---

## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

## Behavior

1. **Prelude — activate review/lens skills.** Before any implementation work starts, check the host's available-skills list and invoke each of the following via the Skill tool if listed:
   - `ponytail:ponytail`
   - `caveman`

   Invoke them sequentially (ponytail first, then caveman). Treat any guidance, constraints, or context produced by these skills as additional input that the implementation must respect.

2. **Detection rules.**
   - Only invoke a skill if it is explicitly listed as an available/user-invocable skill in this session. Do **not** guess names or attempt to install skills.
   - If a skill is not available, skip it silently and continue. Missing skills are a no-op, not an error.
   - If neither skill is available, proceed directly to step 3 without comment.

3. **Run the canonical `/speckit-implement` flow unchanged**, honoring any prelude output from step 1 (prerequisite checks, task execution, normal hook handling, etc.).

## Failure Policy

- A skill that is *listed but errors out* during invocation halts the command — surface the error rather than proceeding past a failed prelude. (Missing/not-listed skills are not failures.)
- Do not downgrade the prelude to optional once a skill has been detected and invoked.

## Completion Report

On success, include:
- Which prelude skills were invoked (or that none were available).
- Confirmation that the canonical implementation flow ran after the prelude.
- Readiness for follow-up commands.
