---
description: "Run /speckit-implement, then always run graphify update"
strategy: "wrap"
---

## Wrapper Layer

This preset wraps `/speckit-implement` (and any inner wrapper the core-flow seam
expands to). It adds exactly one thing: a mandatory graph refresh as the final
implementation step. It does not change how tasks are executed.

## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

### Core Flow

{CORE_TEMPLATE}

### Graph Refresh (MANDATORY — LAST STEP)

After the entire core flow above has completed successfully, and before reporting
success, run one final graph refresh:

- Resolve the worktree root to graph with `git rev-parse --show-toplevel` (falling
  back to the current repository root).
- Execute `graphify update <resolved-worktree-path>`.

This graph refresh is mandatory and must run as the last implementation step.

## Failure Policy

- If `graphify` CLI is unavailable, unauthenticated, or the update command fails, return an error and mark the overall command as incomplete.
- Do not silently skip or downgrade this step to optional behavior.

## Completion Report

On success, include:
- Path used for graph refresh
- Confirmation that `graphify update` was executed as the final step
- Readiness for follow-up commands
