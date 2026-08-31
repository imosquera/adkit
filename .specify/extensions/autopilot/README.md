# autopilot extension

Registers two commands:

- **`/speckit-autopilot-run`** — take the highest-ranked eligible open GitHub issue
  (or a given issue number) from backlog to a reviewed **draft PR**, driving the whole
  speckit pipeline unattended — pick → worktree → specify → clarify (auto-answered)
  → plan → tasks → implement → review → draft PR — and posting progress to the issue
  at every stage.
- **`/speckit-autopilot-schedule`** — put `/speckit-autopilot-run` on a recurring
  **launchd** timer so the backlog drains itself (default **every 2h**, configurable
  via `--interval-hours N`). Opt-in and macOS-only; also `uninstall`, `status`, and
  `run-now`. `.run` detects whether a schedule exists and *suggests* setting one up
  when it doesn't — it never schedules itself.

## Which issue gets picked

Every scheduled pass re-runs the pick, so the ordering policy is what decides where
the next two hours of unattended work go. Eligible candidates (open, unparked,
unclaimed, no branch/worktree/PR, non-empty body) are sorted by:

1. **Priority label** — `p0` < `p1` < `p2` < `p3`. Spellings `p1`, `P1`,
   `priority: p1`, `priority/p1` all read the same, as do the severity words
   `critical`/`urgent` (p0), `high` (p1), `medium`/`normal` (p2), `low` (p3). The
   lowest rank on an issue wins, so a contradictory `p2, critical` pair is treated
   as p0 rather than averaged.
2. **Bugs before features**, within one priority tier — a `bug`/`defect`/
   `regression`/`incident` label, or a `fix:`/`bug:` title prefix. Across tiers
   priority still wins: an explicit `p0` feature outranks a `p2` bug, because that
   is what the human said.
3. **Age** — oldest `createdAt` last, so an unlabelled backlog drains in exactly the
   filing order it used to.

An issue with **no** priority label ranks as `p2`, deliberately mid-pack rather than
last: ranking it last would let an explicitly deprioritized `p3` chore outrank every
untriaged bug in the backlog, inverting the point of the label.

The vocabulary lives in `preflight-issues.py` (`PRIORITY_RE`, `PRIORITY_WORDS`,
`BUG_LABELS`) and is written by the git extension's `label-issue.sh`, which
`/speckit-git-issue` calls after every spec sync — that command is what asks the
human for a priority, or infers one when nobody is there to ask. An explicit
`/speckit-autopilot-run <N>` skips ranking entirely: a typed issue number is
already a choice.

## The two labels: `autopilot:claimed` and `autopilot:blocked`

Autopilot keeps its state on the issue itself, in two labels that mean opposite
things and are cleaned up by different actors.

| Label | Lifetime | Written by | Cleared by |
|---|---|---|---|
| `autopilot:claimed` | **transient** — one run | the skill body, once, at Step 1 | the skill on every exit path; `autopilot-run.sh`'s `EXIT` trap as a safety net if the session dies ungracefully |
| `autopilot:blocked` | **durable** — until the blocker is fixed | the skill body, on a hard non-recoverable stop | **a human**, deliberately |

Both are in `preflight-issues.py`'s `BLOCK` set, so a labelled issue is skipped by
the auto-pick and explicit-issue paths alike.

`autopilot:blocked` exists because removing the claim on a hard stop restores the
issue to the eligible pool in full: the next scheduled tick re-picks it,
rediscovers the identical blocker, posts a near-duplicate comment, and unclaims.
One issue went through that loop **10 times over two days** before anyone noticed
(issue #32). The blocking run now also posts a comment carrying a machine-readable
marker line:

```
AUTOPILOT-BLOCKED: fix target `~/.claude/skills/hindsight/hindsight.py` resolves outside any git repo
```

`preflight-issues.py`'s `blocked_reason()` reads that line back (newest matching
comment wins) so an explicit `/speckit-autopilot-run N` on a parked issue prints
`SKIP: #N blocked — <reason>` instead of silently repeating the cycle. Nothing
automatic ever removes `autopilot:blocked` — clearing it is the human signal that
the blocker is actually resolved.

## One run, one repository

An autopilot run is bound to exactly one repo and one checkout, in both directions:

- **Input** — `fetch-open-issues.sh` runs `gh issue list` with no `--repo`, so the
  backlog comes from the checkout's own remote. Autopilot has never sourced work
  from another repository.
- **Schedule** — `autopilot-schedule.sh` resolves the repo root via
  `git rev-parse --show-toplevel`, labels the launchd job
  `com.speckit.autopilot.<repo-slug>`, and bakes that root into the plist as the
  runner's argument. One plist per checkout; `--project DIR` lets several repos
  each hold their own timer without colliding.
- **Output** — enforced by `check-target-repo.sh` (below). This is the half that
  used to be missing.

### The output guard (`check-target-repo.sh`)

Nothing checked where the *fix* had to land. lead-drop#182 asked for a change to a
file that resolved into a different repository; autopilot did the work and opened
the PR over there, while the issue it "finished" stayed open behind it. A run bound
to one repo delivered to another — and that open issue is what three later runs then
picked up again (issue #34).

The pre-existing "fix target outside any git repo" stop condition did not catch it:
that target was inside a perfectly good repo, just not ours.

Step 1.5 now hands every path the issue names to the guard:

```
$ check-target-repo.sh hindsight.py README.md
FOREIGN: hindsight.py → /Users/iam/Code/dotskills
INSIDE: README.md → /Users/iam/Code/lead-drop
BLOCKED: 1 of 2 target(s) not in /Users/iam/Code/lead-drop
```

- Resolves `~` and symlinks — the #34 target presented through a symlink.
- A path that does not exist yet (an issue asking for a **new** file) resolves to
  its deepest existing ancestor: the directory the file would be created in.
- Repo identity is the git **common dir**, never the worktree toplevel. Autopilot
  always runs inside a worktree, where `--show-toplevel` is the worktree path while
  `--git-common-dir` is the main repo's `.git`; comparing toplevels would report
  every in-repo file as foreign.
- `OUTSIDE` (no git repo at all) stays distinguishable from `FOREIGN` (a different
  repo), because they are different stop conditions with different advice.

A non-zero exit is a *Durable* stop: park with `park-issue.sh`, naming the repo the
fix belongs in, and release the claim. A human moves the issue; autopilot does not
guess.

## Cross-repo delivery detection (`--cross-repo`)

The guard above stops autopilot from *creating* a cross-repo delivery. This check is
the cleanup net for ones that already exist — work delivered elsewhere before the
guard existed, or a PR a human links by hand.

Every other eligibility check looks only at *this* repo: `has_open_pr()` searches
the current repo, and the branch/worktree scan is local by definition. So an issue
whose fix already shipped as a PR in a **different** repository reads as perfectly
fresh, and gets picked again. That is what cost three sessions on lead-drop#182.

Note this never *sources* work from another repo — it reads issues from this repo
only, and a finding can only ever cause a **skip**.

`preflight-issues.py <issues.json> [N] --cross-repo` closes that gap. It reads the
issue's own thread (body + comments — the same fetch `blocked_reason()` already
pays for), pulls out every `github.com/<owner>/<repo>/pull/<n>` URL, and resolves
each with `gh pr view --repo`:

```
SKIP: #182 delivered — https://github.com/imosquera/dotskills/pull/3 (merged)
```

- **Merged beats open**, so the message names the PR that actually shipped rather
  than whichever was linked first.
- **Closed-unmerged never counts** — abandoned work must not park an issue forever.
- **Draft is reported, not decisive**: an open draft still means someone is on it,
  matching the "existence alone means skip" rule the local checks already follow.
- **Unresolvable links are ignored** (private repo, deleted PR), so a token that
  can't read the other repo degrades to today's behaviour instead of parking the
  issue on no evidence.

It is opt-in for cost — one `gh issue view` plus one `gh pr view` per linked PR —
and on the auto-pick path it runs only against the issue about to be picked, the
one position where the answer changes the outcome. Both callers (the skill's Step 1
and `autopilot-run.sh`'s launch preflight) pass it.

The script itself never writes; it emits the finding as a machine-readable
`DELIVERED: <n> <url> (<state>)` line after the verdict, and the caller parks the
issue through the shared `park-issue.sh`. Parking is what makes the finding
durable — the label is in preflight's `BLOCK` set, so the next tick skips the issue
outright instead of re-running the same GitHub lookups forever.

**Both** callers park, and neither can delegate to the other:

- `autopilot-run.sh` exits on a `SKIP:` verdict *before* launching the skill, so a
  delivered issue that leaves nothing else eligible would otherwise be rediscovered
  on every scheduled tick, with no durable state ever written.
- A delivered issue does not stop preflight's scan, so a run can report `PICK:` for
  a later issue while still having found a delivered earlier one — which needs
  parking on the success path too.

`park-issue.sh` is the single writer of the label and the `AUTOPILOT-BLOCKED:`
sentinel (the hard-blocker stop path uses it as well), so the strings preflight
greps for cannot drift between two hand-rolled copies. It no-ops on an issue that
is already parked, so a re-park adds no duplicate comment.

Parking is not closing: a linked PR is strong evidence, not proof that it resolves
the issue, and that call is a human's.

## Binding a worktree to an existing issue

Autopilot creates its worktree with `GIT_BRANCH_NAME` set, which makes
`/speckit-git-feature` skip issue creation — so on its own nothing writes the issue
linkage, and the fresh worktree may still carry an *inherited* `.specify/feature.json`
from the base branch. Passing `--source-issue N` alongside `GIT_BRANCH_NAME` closes
that gap in one call: the git extension writes the linkage itself, no second step
(issue #44). `scripts/bash/bind-feature-issue.sh <issue> [worktree]` remains the
explicit fallback — for a worktree made some other way, or an installed `git`
extension too old to know `--source-issue`. It performs the same binding through the
git extension's shared writer,
`spec_kit_write_feature_json()`, so the file is gitignored (and `git rm --cached`ed
in a project whose older layout still tracks it) on this path too. Writing the file
with a raw `printf` skips that half and leaves a tracked `feature.json` that the
next worktree inherits — the stale-state bug of issue #33, on the one code path that
runs unattended (issue #21). The git extension is required.

See `commands/speckit.autopilot.run.md` for the full workflow and the decisions behind
it (one issue per run, full autonomy with an issue-comment audit trail, stop only
on hard blockers), and `commands/speckit.autopilot.schedule.md` for the scheduler.

## Scheduling (recurring unattended runs)

```bash
/speckit-autopilot-schedule                       # schedule every 2h (default)
/speckit-autopilot-schedule install --interval-hours 4
/speckit-autopilot-schedule status                # is it on? interval + log tail
/speckit-autopilot-schedule run-now               # fire one pass immediately
/speckit-autopilot-schedule uninstall             # stop it
```

Each repo gets its own launchd agent
(`~/Library/LaunchAgents/com.speckit.autopilot.<repo>.plist`) that runs
`scripts/bash/autopilot-run.sh <repo>` on the interval, which invokes
`claude -p "/speckit-autopilot-run" --dangerously-skip-permissions` inside the repo.
The permission bypass is what makes an *unattended* pass possible; runs are
single-flight (a long pass won't stack a second one), and output lands in
`~/Library/Logs/speckit-autopilot/<repo>.log`. Nothing recurring is installed until
you run `install` — it's strictly opt-in.

## Install

```bash
specify extension add --dev /path/to/speckit-squads/extensions/autopilot
# or, for the whole repo:  /path/to/speckit-squads/install.sh <project>
```

## Optional: name each session after its issue (SessionStart hook)

`hooks/session-title.sh` titles a Claude Code session after the speckit feature /
GitHub issue it belongs to, so parallel backlog runs are easy to tell apart. It's
a **Claude Code** hook (settings.json), not a speckit pipeline hook, so `specify`
does not wire it up — add it to the consumer project's `.claude/settings.json`
yourself:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "$CLAUDE_PROJECT_DIR/.specify/extensions/autopilot/hooks/session-title.sh"
          }
        ]
      }
    ]
  }
}
```

(Adjust the path if your install location differs; with `--dev` installs the
extension resolves back to this repo's source tree, so you can also point at
`/path/to/speckit-squads/extensions/autopilot/hooks/session-title.sh` directly.)

### What it does

- Fires on session **startup** and **resume** (Claude ignores a hook-set title
  after `/clear` and during compaction, so it stays silent then).
- Reads `source_issue` from `.specify/feature.json` → `#N: <issue title>` (via `gh`),
  else the live git branch. On the main checkout with no feature, it emits
  nothing and Claude keeps its auto-generated title.
- Never blocks a session from starting — every failure degrades quietly.

### Known limitation

The session that *runs* `/speckit-autopilot-run` starts before the issue is picked, so
it can't rename itself — there's no supported way to rename a **running** Claude
session (only `startup`/`resume` via this hook, or a manual `/rename`). The command
sets a best-effort terminal-tab title for the running session; the durable
Claude-session title applies whenever you open or resume a session **inside the
issue's worktree**.
