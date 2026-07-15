---
description: "Take the oldest eligible open GitHub issue (or a given issue number) from backlog to a reviewed draft PR by driving the full speckit pipeline unattended: pick → worktree → specify → clarify (auto-answered) → plan → tasks → implement → review → draft PR, posting progress to the issue at every stage."
---

# Issue Backlog Autopilot

Take one GitHub issue from the backlog all the way to a reviewed **draft PR**, running
the full speckit pipeline unattended and narrating progress back to the issue so a
human can audit every decision after the fact.

The speckit commands already exist and each does its job well; the value here is the
**orchestration** — picking the right issue, wiring the worktree to the *existing*
issue (not a duplicate), auto-answering clarify instead of blocking on it, driving
every stage in order, recovering from gate failures, and leaving a clean draft PR.
You are the coordinator, not the implementer: prefer invoking the sibling
`/speckit-*` commands over re-deriving their work by hand.

## User Input

```text
$ARGUMENTS
```

Optional. If the input contains an issue number (e.g. `#42` or `42`), extract it as
`N` and work **that** issue instead of auto-picking the oldest — but still apply the
eligibility checks in Step 1 (via `preflight-issues.py`) and refuse (explaining why)
if it's already in progress, parked, or already claimed by another autopilot run.
With no input, auto-pick per Step 1 and set `N` to whichever issue the script picks.
This is also how the wrapper (`autopilot-run.sh`) hands off: it runs its own
preflight to decide whether to launch at all, then passes the picked issue number as
`$ARGUMENTS` so this run binds to the exact same issue instead of re-picking
independently.

## Operating contract

- **One issue per run.** Pick a single issue, take it to a draft PR, stop. Don't
  batch the backlog in one invocation — each issue is its own worktree, branch, and
  PR, and a human should be able to review them independently.
- **Full autonomy, full audit trail.** Answer clarify questions yourself and fix
  gate/test failures without asking — but write down *what* you decided and *why* as
  issue comments, so nothing is a black box. The right to act autonomously is paid
  for with a legible record.
- **Stop only on a hard blocker** (see [Stop conditions](#stop-conditions)). A
  wrong-but-recoverable guess is acceptable; a wrong *irreversible* action is not.

## Preflight (fail fast, before touching anything)

Confirm the environment can complete the whole run — a pipeline that dies at the PR
step after writing code is worse than one that never starts.

1. **Speckit repo?** `.specify/` exists at the repo root. If not, this isn't a
   speckit project — stop and say so.
2. **`gh` authed?** `gh auth status` succeeds. The pick, the issue comments, and the
   PR all need it.
3. **Clean base.** You're on the repo's default branch (or a clean tree) so the new
   worktree forks from a sane point. Note (don't auto-discard) uncommitted junk.
4. **Resolve the repo** with `gh repo view --json nameWithOwner` — every `gh` call
   below is scoped to it explicitly, never relying on ambient state.
5. **Scheduled? Suggest it up front** (advisory, non-blocking). Check whether a
   recurring autopilot timer is installed for this repo, and if not, surface the tip
   **right now — before doing any work** — so the user can opt in for future passes.
   On macOS:
   ```bash
   SCHED="$CLAUDE_PROJECT_DIR/.specify/extensions/autopilot/scripts/bash/autopilot-schedule.sh"
   [ -x "$SCHED" ] && "$SCHED" status --project "$CLAUDE_PROJECT_DIR" | head -1
   ```
   If the first line is `NOT SCHEDULED`, say once, then continue with this run:

   > Tip: this repo isn't on an autopilot schedule. Run `/speckit-autopilot-schedule`
   > to have me work the backlog automatically every 2h (configurable, e.g.
   > `/speckit-autopilot-schedule install --interval-hours 4`). Opt-in and easy to
   > stop with `/speckit-autopilot-schedule uninstall`. I'll proceed with this run now.

   If it's already `SCHEDULED`, say nothing. Never schedule it yourself — scheduling
   is always a deliberate user action. (If the script is absent or this isn't macOS,
   skip silently.) The suggestion is a one-time nudge at the start; don't repeat it
   later in the run.

## Step 1 — Pick the oldest eligible issue (or validate the given one)

"Oldest" = earliest `createdAt`. "Eligible" = open, not already in progress, not
parked, not already claimed by another autopilot run. Compute it deterministically,
then show your pick before proceeding.

**Fetch to a file, via the shared script — never pipe `gh` into a stdin-heredoc
script.** The tempting one-liner
`gh issue list --json … | python3 - <<'PY' … json.load(sys.stdin) … PY` **always
fails** with `JSONDecodeError: Expecting value: line 1 column 1 (char 0)`.
`python3 -` reads its *program* from stdin, and the heredoc `<<'PY'` binds stdin to
the heredoc text — that redirect wins over the pipe, so `gh`'s JSON never reaches
Python and `json.load(sys.stdin)` reads an empty stream. You cannot route both the
script *and* the data through one stdin. `fetch-open-issues.sh` sidesteps this by
landing the data in a file first (sorted oldest-first, `body` included for the
empty-body check below), so every reader — this skill or `preflight-issues.py`
directly — takes a **file path**, never stdin:

```bash
FETCH_SCRIPT="$CLAUDE_PROJECT_DIR/.specify/extensions/autopilot/scripts/bash/fetch-open-issues.sh"
bash "$FETCH_SCRIPT" /tmp/autopilot_issues.json
```

**Run the shared eligibility script for BOTH paths — never restate the rules
inline.** `preflight-issues.py` is the single source of truth for what counts as
eligible (block labels — including `autopilot:claimed` — empty body, and an
existing branch/worktree/PR). An inline reimplementation of this list has drifted
from the script before (the explicit-issue path once omitted `autopilot:claimed`,
which is exactly how two runs collided on the same issue — see issue #19). Always
`exec` the script instead:

```bash
PREFLIGHT_SCRIPT="$CLAUDE_PROJECT_DIR/.specify/extensions/autopilot/scripts/bash/preflight-issues.py"

# With an explicit issue number in $ARGUMENTS, validate THAT issue only:
python3 "$PREFLIGHT_SCRIPT" /tmp/autopilot_issues.json "$N"
# => "PICK: #42 \"Fix the thing\" (explicit)"  or  "SKIP: #42 <reason>"

# With no input, auto-pick the oldest eligible issue:
python3 "$PREFLIGHT_SCRIPT" /tmp/autopilot_issues.json
# => "PICK: #42 \"Fix the thing\" (7 open, 2 parked, 1 in-progress)"  or  "SKIP: ..."
```

A `SKIP:` result on the explicit-issue path means **stop immediately** — do not
create a spec, branch, worktree, or commit. Report the exact SKIP reason to the
user (e.g. "already claimed by another autopilot run" or "already in progress on
branch 082-…") before ending the session. A `SKIP:` result on the auto-pick path
means the whole backlog is unworkable right now — say so and stop; that's success,
not failure, unless the script reported a hard failure (couldn't parse issues),
which is a Stop condition.

`gh issue list` already excludes PRs, so you won't accidentally grab one.

**Report the pick** to the user in one line (number, title, why it was chosen over
older ones that were skipped) before you start building.

### Claim it immediately — before any other action

The moment you have a `PICK:` result, claim the issue **before** doing anything
else (before Step 2's worktree work, before writing any file). This is the one and
only place that applies the `autopilot:claimed` label — the wrapper script
(`autopilot-run.sh`) no longer claims on your behalf; it only decides whether to
launch you and which issue to hand you. That split matters: if the wrapper claimed
*and* the skill claimed, a session could see its own wrapper-applied claim during
its eligibility check and mistake it for a competing run (the "self-starve" bug).
Because claiming now happens exactly once, per run, inside the skill, that
confusion can't happen — you always know the claim on your picked issue is yours.

```bash
gh label create "autopilot:claimed" --color "0075ca" \
  --description "Autopilot is actively working this issue" 2>/dev/null || true
gh issue edit "$N" --add-label "autopilot:claimed" \
  || { echo "claim failed on #$N — stopping rather than risk a collision"; exit 1; }
```

Labeling isn't a perfect distributed lock (no compare-and-swap), so treat it as one
layer of a defense-in-depth: the local single-flight lock in `autopilot-run.sh`
serializes same-machine ticks, this label serializes cross-machine/manual runs, and
Step 2's fresh liveness re-check catches the residual race window. Remember to
**remove this label on every exit path** — success (end of Step 9) or any Stop
condition (see [Stop conditions](#stop-conditions)):

```bash
gh issue edit "$N" --remove-label "autopilot:claimed" 2>/dev/null || true
```

## Step 2 — Bind a worktree to the EXISTING issue (avoid the duplicate-issue trap)

This is the sharpest edge. `/speckit-git-feature` is built to **create a new** stub
issue and number the branch to it. Here the issue already exists, so you must bypass
that and bind to issue `#N` instead — otherwise you get a duplicate issue and
mismatched numbering.

0. **Re-check for a competing branch/worktree/PR right before creating anything.**
   Step 1's check happened moments ago; re-run it once more to shrink the race
   window as close to zero as the claim label allows. Use `--worktree-check`, NOT
   a full re-run of Step 1's eligibility script against the issue list — by now
   you've already added `autopilot:claimed` to `#N` yourself, so re-running the
   label-aware check would see your own claim and incorrectly report a collision
   with yourself on every single run. `--worktree-check` only looks at
   branches/worktrees/PRs, never labels, so it can't trip on your own claim:
   ```bash
   python3 "$PREFLIGHT_SCRIPT" --worktree-check "$N"
   ```
   If this reports `LIVE:` (a branch, worktree, or PR for `#N` now exists — e.g. a
   sibling run created one in the interim), **do not resume it — stop and report it
   as a collision**, same as a Step 1 SKIP, and remove your own claim first (see the
   cleanup snippet above). There is no automatic resume path in this skill: an
   existing branch or worktree for `#N` is always treated as another run's
   in-progress work, never as something to pick back up, because a live sibling and
   a crashed leftover look identical at a glance (this ambiguity — an empty
   just-created worktree mistaken for an abandoned one — is exactly how two runs
   collided on issue #150; see issue #19). If a human wants to actually resume a
   dead worktree, that's a deliberate manual action outside this skill, not
   something to infer here. Only `CLEAR` means proceed.
1. Derive a slug from the issue title (kebab-case, trimmed) and the branch name
   `NNN-slug`, zero-padded to the repo's convention (e.g. `082-signup-thankyou`).
2. Create the branch + worktree **without** creating an issue by forcing the branch
   name — the `GIT_BRANCH_NAME` override makes `/speckit-git-feature` skip issue
   creation entirely (per its own contract):
   ```bash
   GIT_BRANCH_NAME="NNN-slug" <run /speckit-git-feature>
   ```
   (Or use `/speckit-git-worktree` if a suitable branch already exists.)
3. **Link the existing issue** by writing `source_issue` into the new worktree's
   `.specify/feature.json` (so `/speckit-git-pr`, `/speckit-git-commit`, and
   `/speckit-git-clean` all pick up issue `#N` automatically):
   ```bash
   # in the new worktree
   python3 - "$N" <<'PY'
   import json, sys, pathlib
   p = pathlib.Path(".specify/feature.json"); d = json.loads(p.read_text())
   d["source_issue"] = int(sys.argv[1]); p.write_text(json.dumps(d, indent=2))
   print("linked source_issue", sys.argv[1])
   PY
   ```
4. **`cd` into the worktree** and run everything below from there. Speckit resolves
   paths from the worktree root; running from the main checkout drifts the cwd and
   breaks the `.specify/` scripts.
5. **Label the session.** Set a best-effort terminal-tab title for the running
   session so it's identifiable at a glance:
   ```bash
   printf '\033]0;autopilot #%s: %s\007' "$N" "<short issue title>"
   ```
   This sets the *terminal tab* only — Claude's own session title can't be renamed
   mid-run. Durable naming comes from the `session-title.sh` SessionStart hook
   (see the extension README): any session you open or **resume inside this
   worktree** is auto-titled `#N: <issue title>`.
6. **Post the first progress comment** on the issue: "🤖 Autopilot picked this up —
   worktree `NNN-slug` created. Starting spec."

## Step 3 — Specify

Run `/speckit-specify` with the **issue body as the input** so the spec is grounded in
what was actually asked. Let it write `spec.md` and sync the issue. If the body is
thin, enrich the spec from the title + any linked context, but don't invent scope the
issue didn't imply.

**After `/speckit-specify` completes, always run these `after_specify` hooks — treat
them as mandatory, never skip them regardless of how they are flagged in the
project's `extensions.yml`:**

```bash
specify hook run speckit.agent-context.update  2>/dev/null || true
specify hook run speckit.graphify.update       2>/dev/null || true
```

These keep the agent-context and knowledge graph current after every spec write.
They are required for the progress-report dashboard to reflect accurate state. The
`|| true` prevents a missing hook from blocking the pipeline, but if `specify hook run`
is unavailable entirely, warn and continue rather than stopping.


## Step 4 — Clarify (you answer the questions)

Run `/speckit-clarify`. It will surface `[NEEDS CLARIFICATION]` questions. **You answer
them** — that's the whole point of autopilot — using, in order of preference:

1. **The issue + repo context** — the answer is often already implied by the issue,
   the existing code, the constitution, or prior decisions. Read before guessing.
2. **Best-practice research** — for genuinely open questions (auth model, retry
   semantics, rate limits, accessibility, legal like CAN-SPAM/GDPR), do a quick web
   search and pick the well-supported default. Cite the basis briefly.
3. **The conservative, reversible default** — when still unsure, choose the option
   that's easiest to change later and hardest to get catastrophically wrong.

**Record every answer as an issue comment** before applying it — a compact
"Clarifications (auto-answered)" list of `Q → A — because …`. This is the audit trail
that makes unattended clarify trustworthy. Then apply the answers to the spec exactly
as `/speckit-clarify` would (Clarifications session block + the affected FRs / edge
cases).

If a question is **irreducibly ambiguous AND a wrong guess is irreversible** (e.g.
"delete which production dataset?"), that's a hard blocker — see Stop conditions.

## Step 5 — Plan

Run `/speckit-plan`. It gates on the Constitution Check. To avoid the known
validate-loop, author the Constitution Check right the first time:

- **One quote per physical line** — the validator's quote regex can't match across a
  line-wrap, so a wrapped quote silently fails.
- **Never write a principle's key token in prose before its heading** — the section
  extractor grabs the first occurrence of the token, so "Principle IX" above the
  `### IX` heading hijacks the section → "NO VERDICT".
- **Bare verdict tokens** — `PASS` / `VIOLATES` / `N/A` with no trailing punctuation
  (`**VIOLATES.**` fails; `**VIOLATES**` passes).

Also honor whatever presets are enabled: check `.specify/presets/.registry`; if
`parse-dont-validate` is enabled, add the `## Parse Boundaries` section and run its
scanner rather than skipping it.

## Step 6 — Tasks

Run `/speckit-tasks` to generate the dependency-ordered `tasks.md`. No special
handling — just confirm it produced tasks covering the plan's MVP.

## Step 7 — Implement

Run `/speckit-implement`. Then, because you're unattended:

- **Drive gates to green.** Typecheck, tests, lint, the constitution audit, and any
  preset scanner must pass. When one fails, fix the code and re-run — that's expected
  autopilot work, not a blocker. For a new sub-package, remember it needs its own
  `vitest.config.ts` / `eslint.config.js` and a local `npm install` before its tools
  resolve.
- **Post a progress comment** summarizing what shipped: files added/changed, test
  counts, and any task deliberately deferred (with why).

## Step 8 — Review

Run `/speckit-review-run` on the working diff (it fans out the specialized
reviewers — code, tests, errors, comments, types, simplify — in parallel). Triage the
findings: **apply** the clear correctness and test-coverage fixes; **record a
decision** ("keep — because …") for anything you deliberately leave, the same way a
human reviewer would. Re-run the gates after applying fixes.

## Step 9 — Open the draft PR

Run `/speckit-git-pr` to push the branch and open the PR. Open it **as a draft** — a
human explicitly wants a not-yet-mergeable PR to review, not an auto-merge. Because
`source_issue` is set, the body includes `Closes #N`, so merging later auto-closes the
issue.

**Final issue comment**: link the draft PR and give a 3–5 line summary — what was
built, the assumptions you made (link the earlier clarify comment), gate status
(tests/lint/audit green), and anything left for the human (a task deferred, a creds
step, a judgment call worth a second look).

**Remove the claim** now that a draft PR exists to show for it — the open PR itself
is a stronger in-progress signal than the label from here on:
```bash
gh issue edit "$N" --remove-label "autopilot:claimed" 2>/dev/null || true
```

Then report the same summary to the user, leading with the PR URL.

## Stop conditions (hard blockers only)

Stop, leave the worktree intact, post what you found to the issue, and hand back to
the user only when continuing would be reckless or is impossible:

- **Missing capability** — `gh` / `gcloud` / build creds absent or unauthenticated and
  the step needs them (login is interactive; you can't do it).
- **Not a speckit repo** — no `.specify/`.
- **Irreversible ambiguity** — a clarify or design decision that is both genuinely
  undetermined and destructive if guessed wrong (data deletion, spend, sending real
  messages, production migration). Ask; don't guess.
- **Repeated gate failure with no progress** — you've tried a fix two or three times
  and the same gate still fails for a reason you don't understand. Surface the exact
  error rather than thrash or paper over it.

**Whenever you stop after having claimed an issue** (i.e. any stop from Step 1's
claim onward), remove the claim before ending the session — a stuck claim on a
dead run would block the issue forever:
```bash
gh issue edit "$N" --remove-label "autopilot:claimed" 2>/dev/null || true
```

A skipped or deferred *task* is not a blocker — note it and keep going. The bar for
stopping is "a human would be angry I proceeded," not "this got hard."

## Why it's built this way

- **Draft PR, not merge** — the human keeps the final gate; autopilot does the toil,
  not the irreversible call.
- **Issue comments at every stage** — unattended autonomy is only safe if it's
  auditable; the issue thread becomes the flight recorder.
- **Bind to the existing issue** — the single most common way this goes wrong is a
  duplicate issue + mismatched branch number from `/speckit-git-feature`'s
  create-path; forcing `GIT_BRANCH_NAME` and writing `source_issue` prevents it.
- **Answer clarify, don't skip it** — clarify catches the ambiguities that sink an
  implementation; auto-answering (with a logged rationale) keeps that value while
  removing the human wait.
- **Claiming lives in exactly one place** — the skill body, not the wrapper. Two
  autopilot runs collided on issue #150 partly because `autopilot-run.sh` claimed
  the label before launching `claude -p`, so that session's own preflight could see
  its own wrapper-applied claim and misread it as a competing run. Now the wrapper
  only picks and hands off an issue number; the skill claims once, per run, so a run
  always recognizes its own claim as its own.
- **One eligibility script, not two copies** — the explicit-issue path used to
  restate the block-label list inline and had already drifted from
  `preflight-issues.py` (missing `autopilot:claimed`) by the time #150 collided.
  Both paths now `exec` the same script so they can't drift again.
- **Never auto-resume a branch/worktree** — an empty, seconds-old worktree from a
  sibling run and a crashed leftover from days ago look identical at first glance.
  Proving "dead" (no open PR, no fresh pickup comment, no recent activity, no live
  `claude` process) is cheap; treating a live sibling as abandoned is not — it's
  exactly what happened on issue #150. When any signal is ambiguous, skip.
