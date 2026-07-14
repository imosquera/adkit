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

Optional. If the input contains an issue number (e.g. `#42` or `42`), work **that**
issue instead of auto-picking the oldest — but still apply the eligibility checks in
Step 1 and refuse (explaining why) if it's already in progress or parked. With no
input, auto-pick per Step 1.

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

## Step 1 — Pick the oldest eligible issue

"Oldest" = earliest `createdAt`. "Eligible" = open, not already in progress, not
parked. Compute it deterministically, then show your pick before proceeding.

**Fetch to a file — never pipe `gh` into a stdin-heredoc script.** The tempting
one-liner `gh issue list --json … | python3 - <<'PY' … json.load(sys.stdin) … PY`
**always fails** with `JSONDecodeError: Expecting value: line 1 column 1 (char 0)`.
`python3 -` reads its *program* from stdin, and the heredoc `<<'PY'` binds stdin to
the heredoc text — that redirect wins over the pipe, so `gh`'s JSON never reaches
Python and `json.load(sys.stdin)` reads an empty stream. You cannot route both the
script *and* the data through one stdin. Land the data in a file first, then let the
heredoc script read the **file** (stdin stays free for the program):

```bash
# Sort inside gh (--jq) so the file is already oldest-first. Include `body` — the
# empty-body eligibility check below needs it. Fail loud on a bad fetch rather than
# leaving an empty file for the parser to choke on.
gh issue list --state open --limit 200 \
  --json number,title,labels,createdAt,assignees,body \
  --jq 'sort_by(.createdAt)' > /tmp/autopilot_issues.json \
  || { echo "gh issue list failed — run 'gh auth status' and confirm a GitHub remote"; exit 1; }
[ -s /tmp/autopilot_issues.json ] || { echo "gh returned no data — treat as a failure, not an empty backlog"; exit 1; }
```

Then rank eligibility by **reading the file** (note `json.load(open(...))`, not
`sys.stdin`, so the heredoc-script stays valid):

```bash
python3 - <<'PY'
import json
issues = json.load(open("/tmp/autopilot_issues.json"))   # file, NOT sys.stdin
block = {"blocked","wontfix","duplicate","needs-discussion","needs discussion",
         "on-hold","on hold","question","epic"}
for i in issues:                                          # already oldest-first
    labels = {l["name"].lower() for l in i["labels"]}
    reason = ("parked:" + ",".join(sorted(labels & block))) if (labels & block) \
             else ("empty-body" if not (i.get("body") or "").strip() else "")
    print(f'#{i["number"]:<4} {i["createdAt"][:10]}  '
          f'{("SKIP " + reason) if reason else "ELIGIBLE"}  :: {i["title"][:60]}')
PY
```

Label/empty-body skips are handled above; still apply the **in-progress** check
(branch / worktree / open PR) below before committing to a pick. When an explicit
issue number was given, validate *it* against the same rules instead of scanning.

Exclude an issue when any of these hold:

- **Blocked/parked labels** — any of `blocked`, `wontfix`, `duplicate`,
  `needs-discussion`, `on-hold`, `question`, `epic` (match case-insensitively; treat
  close variants like `needs discussion` the same).
- **Already in progress** — a local or remote branch, an existing worktree, or an
  open PR already references this issue number. Check:
  ```bash
  git branch -a --list "*${N}-*"        # a branch numbered to the issue
  git worktree list | grep -E "/${N}-"  # an existing worktree
  gh pr list --state open --search "${N} in:title,body" --json number,headRefName
  ```
  If any hit, the issue is being worked — skip it.
- **Not automatable** — the body is empty, or it's a pure question/discussion with no
  implementable ask. Skip and move to the next.

`gh issue list` already excludes PRs, so you won't accidentally grab one.

**Report the pick** to the user in one line (number, title, why it was chosen over
older ones that were skipped) before you start building. If nothing is eligible, say
the backlog is clear and stop — that's success, not failure.

## Step 2 — Bind a worktree to the EXISTING issue (avoid the duplicate-issue trap)

This is the sharpest edge. `/speckit-git-feature` is built to **create a new** stub
issue and number the branch to it. Here the issue already exists, so you must bypass
that and bind to issue `#N` instead — otherwise you get a duplicate issue and
mismatched numbering.

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
