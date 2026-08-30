# Git Branching Workflow Extension

Feature branch creation, numbering (sequential/timestamp), worktree management, cleanup, PR creation, and auto-commit for Spec Kit.

## Overview

This extension provides Git operations as an optional, self-contained module. It manages:

- **Feature branch creation** with sequential (`001-feature-name`) or timestamp (`20260319-143022-feature-name`) numbering
- **Worktree creation and cleanup** for feature isolation
- **PR creation** for completed feature branches (`--draft` for a human-review handoff:
  opens the PR as a draft and leaves the tracking issue open)
- **`commit_exclude`** — repo-tracked generated artifacts that CI rebuilds on the
  default branch are kept out of every auto-commit, and reset to the base branch
  before a PR opens
- **GitHub issue sync** — when a tracking issue is linked, its body is re-rendered from `spec.md` after every `/speckit-specify` (title untouched); skipped cleanly when there is no linked issue
- **Auto-commit** after core commands (configurable per-command with custom messages)

## Commands

| Command | Description |
|---------|-------------|
| `speckit.git.feature` | Create a feature branch with sequential or timestamp numbering; `--source-issue N` binds to an existing issue instead of opening a stub |
| `speckit.git.worktree` | Create a worktree under the `${PROJ}.worktrees` collector directory |
| `speckit.git.clean` | Clean up the current feature worktree, branch, issue, and uncommitted changes |
| `speckit.git.issue` | Update the linked GitHub issue's body from `spec.md` (a manual run may also create one when none is linked) |
| `speckit.git.commit` | Auto-commit changes (configurable per-command enable/disable and messages) |
| `speckit.git.pr` | Open a GitHub PR for the current feature branch; `--draft` opens it as a draft and skips the archive-feature pre-step |

## Hooks

| Event | Command | Priority | Optional | Description |
|-------|---------|----------|----------|-------------|
| `before_specify` | `speckit.git.feature` | — | No | Create feature branch before specification |
| `before_clarify` | `speckit.git.commit` | 10 | Yes | Commit outstanding changes before clarification |
| `before_plan` | `speckit.git.commit` | 10 | Yes | Commit outstanding changes before planning |
| `before_tasks` | `speckit.git.commit` | 10 | Yes | Commit outstanding changes before task generation |
| `before_implement` | `speckit.git.commit` | 10 | Yes | Commit outstanding changes before implementation |
| `before_checklist` | `speckit.git.commit` | 10 | Yes | Commit outstanding changes before checklist |
| `before_analyze` | `speckit.git.commit` | 10 | Yes | Commit outstanding changes before analysis |
| `before_taskstoissues` | `speckit.git.commit` | 10 | Yes | Commit outstanding changes before issue sync |
| `after_constitution` | `speckit.git.commit` | 10 | Yes | Auto-commit after constitution update |
| `after_specify` | `speckit.git.issue` | 5 | No | Update the linked GitHub issue's body from the rendered spec (no-op when no issue is linked) |
| `after_specify` | `speckit.git.commit` | 10 | Yes | Auto-commit after specification |
| `after_clarify` | `speckit.git.commit` | 10 | Yes | Auto-commit after clarification |
| `after_plan` | `speckit.git.commit` | 10 | Yes | Auto-commit after planning |
| `after_tasks` | `speckit.git.commit` | 10 | Yes | Auto-commit after task generation |
| `after_implement` | `speckit.git.commit` | 10 | Yes | Auto-commit after implementation |
| `after_checklist` | `speckit.git.commit` | 10 | Yes | Auto-commit after checklist |
| `after_analyze` | `speckit.git.commit` | 10 | Yes | Auto-commit after analysis |
| `after_taskstoissues` | `speckit.git.commit` | 10 | Yes | Auto-commit after issue sync |

`after_specify` runs two commands. The intended order is `speckit.git.issue` first — it syncs the tracking issue (and on a manual run may write `source_issue` into `.specify/feature.json`) — then `speckit.git.commit`, which picks up that change along with the new spec. The `priority` values in the manifest record that intent, but the runtime does not guarantee it: the agent-driven hook runner reads `hooks.after_specify` from `.specify/extensions.yml` and iterates the entries as registered, without sorting by priority. The order that actually holds is the manifest's **declaration order**, which is why the `after_specify` block in `extension.yml` must not be reordered.

Issue sync is non-optional in the sense that the agent always runs it, but it is not always a mutation:

- **A tracking issue is linked** (`source_issue` in `.specify/feature.json`) → the issue's **body** is rewritten from the spec. The title is left alone; `speckit.git.feature` owns it. If `gh` is missing, unauthenticated, or the edit fails, the hook errors rather than skipping.
- **No tracking issue is linked** → the hook prints a one-line notice and exits successfully without creating anything. This is the normal state when `speckit.git.feature` bypassed issue creation (`--timestamp`, `--number`, `GIT_BRANCH_NAME`, `--dry-run`) or ran in a repo without `gh`, so `/speckit-specify` keeps working for non-GitHub users.

Creating an issue is the job of `speckit.git.feature`, which owns the numbering contract. Running `/speckit-git-issue` manually *may* create one when none is linked; the automatic hook path never does.

## Configuration

Configuration is stored in `.specify/extensions/git/git-config.yml`:

```yaml
# Branch numbering strategy: "sequential" or "timestamp"
branch_numbering: sequential

# Auto-commit per command (all disabled by default)
# Example: enable auto-commit after specify
auto_commit:
  default: false
  after_specify:
    enabled: true
    message: "[Spec Kit] Add specification"
```

## Installation

```bash
# Install the bundled git extension (no network required)
specify extension add git
```

## Disabling

```bash
# Disable the git extension (spec creation continues without branching)
specify extension disable git

# Re-enable it
specify extension enable git
```

## Graceful Degradation

When Git is not installed or the directory is not a Git repository:
- Spec directories are still created under `specs/`
- Branch and worktree operations are skipped with a warning
- PR operations are skipped with a warning

## Scripts

The extension bundles cross-platform scripts:

- `scripts/bash/create-new-feature.sh` — Bash implementation
- `scripts/bash/git-common.sh` — Shared Git utilities (Bash)
- `scripts/powershell/create-new-feature.ps1` — PowerShell implementation
- `scripts/powershell/git-common.ps1` — Shared Git utilities (PowerShell)
