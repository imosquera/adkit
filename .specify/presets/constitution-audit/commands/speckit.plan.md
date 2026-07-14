---
description: "Execute /speckit-plan, but require the Constitution Check section of plan.md to pass deterministic substring-quote validation against the constitution"
---

## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

## Behavior

Execute the canonical stock `/speckit-plan` flow with **one mandatory gate** on the Constitution Check section of the generated `plan.md`.

### Core Flow

Run the core plan flow first so that `plan.md` exists before the Constitution
Check gate is applied. This `{CORE_TEMPLATE}` seam is also the chaining point that
lets other presets (e.g. spec-minimal) wrap this command: when composed, the
placeholder expands to the next inner wrapper and ultimately the stock flow.

{CORE_TEMPLATE}

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
