---
description: "Execute /speckit-implement normally, then always run graphify update as the final step"
---

## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

## Behavior

1. Execute the canonical stock `/speckit-implement` flow unchanged (including all prerequisite checks, task execution behavior, and normal hook handling).
2. After implementation succeeds, run one final graph refresh step:
   - Resolve worktree root to graph (prefer `.specify/feature.json.worktree_path`; otherwise use current repository root).
   - Execute `graphify update <resolved-worktree-path>`.
3. This graph refresh is mandatory and must run as the last implementation step.

## Failure Policy

- If `graphify` CLI is unavailable, unauthenticated, or the update command fails, return an error and mark the overall command as incomplete.
- Do not silently skip or downgrade this step to optional behavior.

## Completion Report

On success, include:
- Path used for graph refresh
- Confirmation that `graphify update` was executed as the final step
- Readiness for follow-up commands
