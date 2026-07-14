---
description: "Create a feature branch + worktree and a linked GitHub issue numbered to match the spec"
---

# Create Feature Branch

Create and switch to a new git feature branch for the given specification, materialise its dedicated worktree, and open a tracking GitHub issue whose number drives the spec/branch numbering. This command handles **branch + worktree + tracking-issue creation** — the spec directory and files are created by the core `__SPECKIT_COMMAND_SPECIFY__` workflow.

## GitHub Issue Integration (Required)

`gh` **MUST** be installed and authenticated for this command to run. If `gh` is missing or `gh auth status` fails, the script errors out and creates nothing — there is no silent fallback.

When numbering is sequential, the script:

1. Creates a stub GitHub issue *before* numbering the branch.
2. Uses the issue number as `FEATURE_NUM` so the spec dir, branch, and issue all share the same identifier (e.g. `specs/008-user-auth/`, branch `008-user-auth`, issue `#8`).
3. After the branch + worktree are materialised, prefixes the issue title with `NNN: ` and writes `source_issue` into the new worktree's `.specify/feature.json` so `/speckit-git-pr`, `/speckit-git-commit`, `/speckit-archive-feature`, and `/speckit-git-clean` automatically pick up the linked issue.

If the issue's number ends up below the next free spec number (e.g. issue #5 created while `specs/008-*` already exists), the branch is still numbered using the next free spec number and the issue title is updated to match — so the alignment stays visible.

The issue body is intentionally a stub; `/speckit-specify` (when wrapped by the `spec-minimal` preset) updates the issue body with the rendered spec content because `source_issue` is already set.

Issue creation is bypassed (and numbering falls back to the normal sequential / timestamp logic) only when the caller has explicitly opted out of issue-driven numbering:
- `--timestamp`, `--number`, or `GIT_BRANCH_NAME` is in effect
- `--dry-run` is set

In every other case `gh` is mandatory: a missing binary, an unauthenticated session, or a failing `gh issue create` is a hard error.

## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

## Environment Variable Override

If the user explicitly provided `GIT_BRANCH_NAME` (e.g., via environment variable, argument, or in their request), pass it through to the script by setting the `GIT_BRANCH_NAME` environment variable before invoking the script. When `GIT_BRANCH_NAME` is set:
- The script uses the exact value as the branch name, bypassing all prefix/suffix generation
- `--short-name`, `--number`, and `--timestamp` flags are ignored
- `FEATURE_NUM` is extracted from the name if it starts with a numeric prefix, otherwise set to the full branch name

## Execution

Generate a concise short name (2-4 words) for the branch — this is the **only** non-deterministic step you perform:
- Analyze the feature description and extract the most meaningful keywords
- Use action-noun format when possible (e.g., "add-user-auth", "fix-payment-bug")
- Preserve technical terms and acronyms (OAuth2, API, JWT, etc.)

Then run the script exactly once, passing the short name and the feature description:

- **Bash**: `.specify/extensions/git/scripts/bash/create-new-feature.sh --json --short-name "<short-name>" "<feature description>"`
- **PowerShell**: `.specify/extensions/git/scripts/powershell/create-new-feature.ps1 -Json -ShortName "<short-name>" "<feature description>"`

Everything deterministic is handled by the script:
- Detecting whether the working directory is a git repo (warns and skips branch creation if not)
- Reading `branch_numbering` from `.specify/extensions/git/git-config.yml` (falling back to `.specify/init-options.json`, then to `sequential`) — pass `--timestamp` **only** if the user explicitly asked for timestamp numbering for this single invocation
- Creating the tracking GitHub issue and reconciling its number against the next free spec/branch slot
- Materialising the worktree and writing / merging `.specify/feature.json`

**IMPORTANT**:
- Do NOT pass `--number` — the script determines the correct next number automatically
- Always include the JSON flag (`--json` for Bash, `-Json` for PowerShell) so the output can be parsed reliably
- You must only ever run this script once per feature
- The JSON output will contain `BRANCH_NAME` and `FEATURE_NUM` (and `SOURCE_ISSUE` / `ISSUE_URL` when an issue was created)

## Output

The script outputs JSON with:
- `BRANCH_NAME`: The branch name (e.g., `003-user-auth` or `20260319-143022-user-auth`)
- `FEATURE_NUM`: The numeric or timestamp prefix used
- `WORKTREE_PATH`: The absolute path of the materialised feature worktree
- `SOURCE_ISSUE` (when an issue was created): The numeric GitHub issue id (also written to the worktree's `.specify/feature.json`)
- `ISSUE_URL` (when an issue was created): The full URL of the tracking issue
