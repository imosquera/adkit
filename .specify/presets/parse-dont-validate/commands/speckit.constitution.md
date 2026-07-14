---
description: "Create or update the project constitution and always enforce a mandatory Parse, Don't Validate section governing how untrusted data becomes trusted domain types."
---

## User Input

```text
$ARGUMENTS
```

You MUST consider the user input before proceeding.

## Intent

Run the normal `/speckit-constitution` workflow, then enforce a canonical
Parse, Don't Validate section in `.specify/memory/constitution.md`.

## Enforcement Rules

After generating or updating the constitution, you MUST ensure this section
exists exactly once.

- If a section with the same heading already exists, replace that entire section
  body with the canonical text below.
- If the section does not exist, insert it immediately after the first numbered
  principle section header (for example after `### I. ...`) while preserving all
  other constitution content.
- Do not weaken, paraphrase, or omit any of the constraints.

## Canonical Section (MUST be present verbatim)

### I. Parse, Don't Validate (MANDATORY)

Untrusted data MUST be parsed into precise domain types at the boundary, never
merely validated and passed along as loose primitives. A validator answers
"is this ok?" and discards the answer the instant it returns; a parser returns a
more precise type that carries the proof forward. The type system MUST carry the
proof, not the programmer's memory. This principle is language-general and
applies to every TypeScript and Python surface in the codebase.

- **Keep the boundary untyped-safe**: All data entering the system from outside
  (network, disk, env, user input, `JSON.parse` / `json.loads`) MUST stay
  untyped-safe until parsed — `unknown` in TypeScript, or handed straight to a
  parser in Python. The `any` type (TypeScript) and the `Any` type (Python) are
  prohibited in domain code.
- **Branded / nominal domain types**: Values the program has earned the right to
  trust MUST be encoded as distinct types (e.g. `Email`, `UserId`), not bare
  `string`/`number`/`int`. Primitives that can be confused MUST be branded
  (TypeScript `unique symbol` / schema `.brand()`; Python `NewType`, pydantic /
  attrs model, or frozen dataclass) so they are not interchangeable.
- **Parsers, not validators**: Boundary functions MUST return a parsed domain
  type — a discriminated `Result` (`{ kind: "ok" | "err" }`) in TypeScript, or
  the parsed model / a single typed parse error in Python. Boolean `isValid*` /
  `is_valid_*` / `validate*` functions and scattered `throw`/`raise`-based
  validation at boundaries are prohibited.
- **The cast is confined to the parser**: Type assertions that mint a branded
  type (`x as Brand` in TypeScript, `cast(Brand, x)` in Python) are permitted
  ONLY inside the parser module that owns that brand. Forging a brand anywhere
  else is prohibited.
- **No shotgun parsing**: A given piece of data MUST be parsed once, at its
  boundary. Re-checking already-parsed values with scattered defensive `if`
  statements is prohibited.

## Output

Write the finalized constitution to `.specify/memory/constitution.md`.
