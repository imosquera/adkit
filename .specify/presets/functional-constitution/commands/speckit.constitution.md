---
description: "Create or update the project constitution and always enforce a mandatory Functional Programming Paradigms section"
---

## User Input

```text
$ARGUMENTS
```

You MUST consider the user input before proceeding.

## Intent

Run the normal `/speckit-constitution` workflow, then enforce a canonical functional-programming section in `.specify/memory/constitution.md`.

## Enforcement Rules

After generating or updating the constitution, you MUST ensure this section exists exactly once.

- If a section with the same heading already exists, replace that entire section body with the canonical text below.
- If the section does not exist, insert it immediately after the first numbered principle section header (for example after `### I. ...`) while preserving all other constitution content.
- Do not weaken, paraphrase, or omit any of the constraints.

## Canonical Section (MUST be present verbatim)

### I. Functional Programming Paradigms (MANDATORY)

All implementation MUST follow functional programming discipline throughout the codebase.
No exceptions are permitted without an explicit governance amendment.

- **Pure functions**: Every function MUST be free of observable side effects and MUST NOT
  mutate state outside its own scope.
- **Higher-order functions**: `map`, `filter`, `reduce`, and function composition MUST replace
  imperative loops (`for`/`while`). Recursion or functional iterators MUST be used instead.
- **Referential transparency**: Any function call MUST be replaceable with its return value
  without altering program behavior. Functions that violate this are not permitted.
- **No shared mutable state**: All required data MUST be passed as arguments. Global or
  shared mutable variables are prohibited.
- **Declarative style**: Code MUST describe *what* is computed, not *how* iteration proceeds.

## Output

Write the finalized constitution to `.specify/memory/constitution.md`.
