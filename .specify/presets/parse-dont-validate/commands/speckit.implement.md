---
description: "Run /speckit-implement under the Parse, Don't Validate discipline — parse untrusted input into precise domain types at the boundary — then block completion until a deterministic anti-pattern scan of the written TypeScript/Python passes."
---

## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

## Behavior

Execute the canonical stock `/speckit-implement` flow while honoring one design
discipline, then run **one mandatory scan gate** before reporting completion.

### Design discipline (applies while code is written)

Parse, don't validate. A validator says "this is fine, continue" and throws the
proof away the instant it returns; a parser takes a blob and returns either a
**more precise type** or a typed error. Encode what you checked in the type so
future code never re-checks.

Whenever this run touches code that ingests untrusted data (network, disk, env,
user input, `JSON.parse` / `json.loads`), prefer parsing over validating. The
principle is language-general; apply the idioms of whichever language you write:

1. **Boundary is untyped-safe, domain is precise.** Untrusted input enters as
   `unknown` (TypeScript) — never `any` — or as a value immediately fed to a
   parser (Python), never left as `Any`. `JSON.parse` returns `any` and
   `json.loads` returns `Any`; treat their output as raw until a parser has run.
2. **Parse at the boundary into branded / nominal domain types.** Turn `string`
   into `Email`, `number`/`int` into `UserId` (TypeScript: a non-exported
   `unique symbol` brand or a schema library's `.brand()`; Python: `NewType`, a
   pydantic/attrs model, or a frozen dataclass). Illegal states become
   unrepresentable; downstream code trusts the type instead of re-checking.
3. **Parsers return a discriminated Result, not a boolean and not a throw.**
   TypeScript: a `{ kind: "ok" | "err" }` union so failure is visible in the
   signature and exhaustiveness (`never`-narrowing) catches missing cases.
   Python: return the parsed model or raise a single typed parse error at the
   boundary — do not add boolean `isValid*` / `is_valid_*` / `validate*`
   functions that callers must remember to re-run.
4. **The cast is confined to the parser.** `x as Brand` (TS) / `cast(Brand, x)`
   (Python) is the one sanctioned lie, allowed only inside the parser module
   that owns that brand. Never forge a brand elsewhere.
5. **A schema library is welcome.** Zod / valibot / io-ts (TS) and pydantic /
   attrs / msgspec (Python) satisfy this discipline and are preferred over
   hand-rolled casts when the project already has one. The library is a tool;
   the boundary discipline is still yours.

Respect any project constitution and existing conventions. If the feature has no
TypeScript or Python surface, this discipline is a no-op and you proceed with the
stock flow.

### Stock flow

Execute the canonical stock `/speckit-implement` flow unchanged, applying the
discipline above to any TypeScript or Python you write.

### Mandatory anti-pattern scan (runs AFTER all task execution)

After the stock flow finishes, gate completion on a deterministic scan of the
TypeScript/Python changed during this run:

1. **Review the discipline items** the scan enforces:

   ```sh
   python3 .specify/presets/parse-dont-validate/scripts/python/parse_dont_validate.py checklist
   ```

2. **Scan the changed files** (no paths → the script inspects the git change
   set: working-tree changes **plus** work already committed on the current
   branch, so the gate still fires even if a post-implement hook has committed
   the implementation. Pass explicit paths/dirs to narrow, or `--base <ref>` to
   pin the branch base):

   ```sh
   python3 .specify/presets/parse-dont-validate/scripts/python/parse_dont_validate.py scan
   ```

   Both languages are analysed as real ASTs. Scanning **TypeScript** requires
   `node` on PATH and `typescript` installed in the project (the Node helper
   uses the TypeScript Compiler API). If the scanner exits `3` with a message
   that `typescript` is missing, install it (`npm i -D typescript`) and re-run —
   do not treat a missing parser as a pass.

3. **Resolve every finding.** For each reported `PDVxxx`, either:
   - **Fix it** — replace the validator / `any` / `Any` / stray cast with a
     parser that returns a precise type (this is the default and preferred
     outcome), or
   - **Waive it at the boundary** — if the finding is a legitimate narrowing
     cast or deserialization *inside the parser module*, add a
     `parse-dont-validate: allow PDVxxx (<reason>)` comment on that line (`//`
     for TypeScript, `#` for Python). Waive only at the trusted parser boundary;
     a waiver anywhere else is the bug this preset exists to catch.

   Re-run `scan` until it exits zero. **Do not report completion while it exits
   non-zero.**

If the run produced no TypeScript or Python, `scan` reports nothing to check and
exits zero — proceed normally.

## Failure Policy

- A non-zero exit from `parse_dont_validate.py scan` is a hard stop on reporting
  completion. Fix the flagged code or add a boundary waiver, then re-scan.
- Do not silence a finding by deleting the offending line's functionality, by
  widening a type to escape the regex, or by waiving outside a parser module.
  The point is a real parser at the boundary, not a green scan.
- If the feature has no TypeScript or Python, do not fabricate parsing work —
  the gate is a no-op.

## Completion Report

On success, include:
- The normal stock `/speckit-implement` completion summary.
- Whether the parse-don't-validate scan ran and that it exited zero.
- Any findings that were fixed (what became a parser) and any that were waived
  at a parser boundary (with the reason).
