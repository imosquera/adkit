#!/usr/bin/env python3
"""Evaluate the open-issue backlog and emit a single descriptive log line.

Three modes, selected by argv:
  preflight-issues.py <issues.json>              — auto-pick the highest-ranked eligible issue
  preflight-issues.py <issues.json> <N>          — validate ONE specific issue number
  preflight-issues.py --worktree-check <N>       — branch/worktree/PR existence only

`--cross-repo` may be added to either of the first two modes.

The first two modes share the same eligibility rules (block labels, empty
body, in-progress) so the auto-pick path and the explicit-issue path can
never drift apart — that drift (the explicit path skipping the
`autopilot:claimed` check) was one of the root causes of two autopilot runs
colliding on the same issue (repo issue #19).

`--worktree-check` is deliberately narrower: it skips the label/body checks
entirely and only asks "does a branch, worktree, or PR already exist for
#N?" It exists for the skill's post-claim re-check (Step 2) — by that point
the run has already added `autopilot:claimed` to its OWN issue, so re-running
the full label-aware check would see that self-applied label and immediately
(and incorrectly) treat every run as colliding with itself.

`autopilot:blocked` is the *durable* counterpart to the transient
`autopilot:claimed` lock. A run that hits a hard, non-recoverable blocker
removes its claim (transient) and adds `autopilot:blocked` (durable), so the
issue leaves the eligible pool for good instead of being re-picked on the very
next tick. Without it the cleanup path wrote no durable state at all and one
issue was re-picked in 10 consecutive sessions (repo issue #32). The reason
travels in an issue comment tagged with BLOCK_SENTINEL, which
`blocked_reason()` reads back so an explicit re-run is *told why* rather than
silently skipped.

`--cross-repo` closes the blind spot that `in_progress()` cannot see: a PR that
delivered the issue **in a different repository**. `has_open_pr()` searches only
the current repo, so when the fix for an issue ships elsewhere — a skills repo, a
sibling service — nothing here notices. On 2026-08-20 that cost three full
autopilot sessions on one issue: run 1 shipped the work as a PR in another repo,
and runs 2, 3 and 4 each got `PICK: ... (explicit)`, claimed the issue, and only
then discovered by hand that it was already done (repo issue #34). One of them
started 35 seconds after the delivering run finished.

The scan reads the issue's own thread — body plus comments, the same fetch
`blocked_reason()` already pays for — pulls every `github.com/<owner>/<repo>/pull/<n>`
URL out of it, and resolves each with `gh pr view --repo`. A **merged** PR wins over
a merely open one; a **closed, unmerged** PR is ignored, since abandoned work must
not park an issue forever. Draft status is reported but does not change the verdict:
an open draft still means someone is on it, matching the "existence alone means skip"
rule below.

It is opt-in because it costs one `gh issue view` plus one `gh pr view` per linked
PR, and on the auto-pick path it runs **only against the issue about to be picked**
— the one place the answer changes the outcome — never against every candidate.

This script only ever *reads*. A confirmed cross-repo delivery still needs the
durable `autopilot:blocked` park, and that write belongs to the caller — via the
shared `park-issue.sh`, the single writer of the label and sentinel.

To make that possible for *every* caller, a cross-repo finding is also emitted as
machine-readable `DELIVERED: <n> <url> (<state>)` lines after the verdict line.
Two callers need them and neither can recover the finding from the verdict prose:

  * `autopilot-run.sh` exits on `SKIP:` **before** launching the skill, so when a
    delivered issue leaves nothing else eligible the skill — the only component
    that used to park — never runs at all. The finding would be rediscovered, with
    the same GitHub lookups, on every scheduled tick forever.
  * A delivered issue does not stop the scan (see `auto_pick`), so a run can report
    `PICK:` for a *later* issue while still having found a delivered earlier one.
    That one needs parking too, on the success path.

The verdict is always the FIRST line, so the existing "read the first word to
decide" contract is unchanged; callers that do not care about parking can keep
reading `head -1` and ignore the rest.

Existence of a branch/worktree/PR is unconditionally treated as in-progress
here — there is no "looks dead, might be safe to reuse" downgrade. A fresh,
seconds-old worktree from a sibling run and a genuinely abandoned one from a
crashed run look identical at this level, and this project's autopilot never
auto-resumes existing work either way (issue #19 fix #3): a human can always
inspect and clean up a stale branch/worktree by hand.

Auto-pick orders the eligible pool by (priority, bug-before-feature, age) — see
the "ordering" block below — instead of taking the oldest. The chosen issue's
rank is echoed in the PICK line so a scheduled log says *why* it won.

Output format (callers read the first word to decide):
  PICK: #42 "Fix the thing" [p0, bug] — 7 open (2 parked, 1 in-progress)
  SKIP: backlog clear — 3 open, all parked/in-progress
  SKIP: no open issues
  SKIP: 5 open but all in-progress (branches: 003-foo, 005-bar)
  PICK: #42 "Fix the thing" (explicit)
  SKIP: #42 parked:autopilot:claimed
  SKIP: #42 blocked — fix target is outside any git repo
  SKIP: #42 in-progress:082-fix-thing
  SKIP: #42 delivered — https://github.com/o/r/pull/3 (merged)
  SKIP: #42 not open or not found

Plus, after the verdict line, zero or more machine-readable park requests:
  DELIVERED: 42 https://github.com/o/r/pull/3 (merged)
  LIVE: 082-fix-thing
  CLEAR
"""
import json
import re
import subprocess
import sys

BLOCK = {
    "blocked", "wontfix", "duplicate",
    "needs-discussion", "needs discussion",
    "on-hold", "on hold", "question", "epic",
    "autopilot:claimed",
    "autopilot:blocked",
}

# Durable "do not retry" label, and the marker autopilot writes into the issue
# comment that explains why. Kept here so the writer (the skill) and the reader
# (this script) can never disagree about the string.
BLOCKED_LABEL = "autopilot:blocked"
BLOCK_SENTINEL = "AUTOPILOT-BLOCKED:"

# Cross-repo delivery detection. Only fully-qualified PR URLs count: the
# `owner/repo#N` shorthand is ambiguous (it renders identically for issues) and
# resolving it would spend a `gh` call per false positive.
PR_URL_RE = re.compile(
    r"https://github\.com/([A-Za-z0-9._-]+)/([A-Za-z0-9._-]+)/pull/(\d+)")

# A PR in these states means someone already delivered the issue. CLOSED is
# absent on purpose — a closed, unmerged PR is abandoned work, and treating it
# as delivery would park the issue permanently on a dead end.
DELIVERED_STATES = ("MERGED", "OPEN")

# Bound on how many linked PRs one issue thread is worth resolving. A chatty
# thread can accumulate many links; the delivering PR is effectively never the
# 11th one mentioned.
MAX_PR_LOOKUPS = 10

# ---------------------------------------------------------------- ordering ---
# The backlog arrives oldest-first (`fetch-open-issues.sh` sorts by createdAt),
# but "oldest" is not the same as "most important": a P0 outage filed this
# morning sat behind a year-old chore, every tick, until a human intervened.
# Eligible candidates are therefore ordered by (priority, kind, age) instead of
# age alone. Age remains the final tiebreak, so the previous behaviour is what
# you get on a backlog with no priority or type labels at all.
#
# Priority is read from labels in any of the common spellings — `p0`, `P1`,
# `priority: p2`, `priority/p3`, `priority-p1` — plus the severity words teams
# use instead (`critical` → p0, `high` → p1, `medium` → p2, `low` → p3). The
# LOWEST rank found on an issue wins, so a mislabelled `p2, critical` pair is
# treated as p0 rather than silently averaged.
PRIORITY_WORDS = {"critical": 0, "urgent": 0, "high": 1, "medium": 2, "normal": 2, "low": 3}
PRIORITY_RE = re.compile(r"^(?:priority[:/ -]*)?p(\d)$")

# An issue with NO priority label sorts in the middle, level with p2 — not last.
# Ranking it last would let an explicitly deprioritized `p3` chore outrank every
# untriaged bug in the backlog, which inverts the point of the label.
DEFAULT_PRIORITY = 2

# Within one priority tier, defects come before new work: a broken system is
# worth more than an addition to it. Across tiers priority still wins, so an
# explicit p0 feature outranks a p2 bug — the labels a human set are the
# strongest signal available.
BUG_LABELS = {"bug", "defect", "regression", "fix", "broken", "incident", "outage"}
BUG_TITLE_RE = re.compile(r"^\s*(?:\[[^\]]*\]\s*)?(?:bug|fix|hotfix)\b[:( ]", re.I)


def priority_ranks(labels):
    """Every priority rank an issue's labels spell out, in no order."""
    ranks = []
    for name in labels:
        m = PRIORITY_RE.match(name.strip())
        if m:
            ranks.append(int(m.group(1)))
        elif name in PRIORITY_WORDS:
            ranks.append(PRIORITY_WORDS[name])
    return ranks


def priority_rank(labels):
    """Lowest priority rank among an issue's labels; DEFAULT_PRIORITY if none."""
    ranks = priority_ranks(labels)
    return min(ranks) if ranks else DEFAULT_PRIORITY


def labelled_priority(labels):
    """True when a human actually set a priority, vs DEFAULT_PRIORITY standing in."""
    return bool(priority_ranks(labels))


def is_bug(issue, labels):
    """True when the issue is a defect rather than new work.

    Labels are authoritative; the title prefix (`fix: …`, `bug(x): …`) is a
    fallback for repos that file bugs without ever applying a label — this one
    included, where conventional-commit-style titles carry the type.
    """
    if labels & BUG_LABELS or any("bug" in l for l in labels):
        return True
    return bool(BUG_TITLE_RE.match(issue.get("title") or ""))


def rank_key(issue, seq):
    """Sort key for eligible candidates: priority, then bugs, then oldest.

    `seq` is the issue's index in the (oldest-first) fetch, which keeps the
    sort stable and makes age the final tiebreak without re-parsing dates.
    """
    labels = {l["name"].lower() for l in issue.get("labels", [])}
    return (priority_rank(labels), 0 if is_bug(issue, labels) else 1, seq)


def rank_reason(issue):
    """Short why-this-one tag for the PICK line, e.g. `p0, bug` or `p2 default`.

    Says explicitly when the priority was assumed rather than labelled, so a log
    line never implies a triage decision nobody made.
    """
    labels = {l["name"].lower() for l in issue.get("labels", [])}
    p = priority_rank(labels)
    bits = [f"p{p}" if labelled_priority(labels) else f"p{p} default"]
    if is_bug(issue, labels):
        bits.append("bug")
    return ", ".join(bits)


def sh(*args):
    try:
        return subprocess.run(args, capture_output=True, text=True).stdout.strip()
    except Exception:
        return ""


def has_open_pr(n):
    out = sh("gh", "pr", "list", "--state", "open",
             "--search", f"{n} in:title,body",
             "--json", "number,headRefName")
    try:
        return bool(json.loads(out)) if out else False
    except Exception:
        return False


def find_worktree_or_branch(n):
    num = str(n)
    branches = sh("git", "branch", "-a", "--list", f"*{num}-*")
    if branches:
        name = branches.splitlines()[0].strip().lstrip("* ").split("/")[-1]
        return name
    worktrees = sh("git", "worktree", "list")
    for line in worktrees.splitlines():
        if f"/{num}-" in line or f"/{num.zfill(3)}-" in line:
            return line.split()[0].split("/")[-1]
    return ""


def in_progress(n):
    """Return a description if issue #N already has a branch, worktree, or
    open PR — any one signal is enough, unconditionally (see module
    docstring: existence alone means skip, never "prove it's dead first")."""
    name = find_worktree_or_branch(n)
    if name:
        return name
    if has_open_pr(n):
        return f"PR referencing #{n}"
    return ""


_THREAD_CACHE = {}


def issue_thread(n):
    """Return (body, [comment bodies…]) for issue #N, fetched at most once.

    `blocked_reason()` and `delivered_by()` both need the same thread, and on
    the explicit-issue path both can run for one issue. Caching keeps that to a
    single `gh issue view` instead of two.
    """
    if n not in _THREAD_CACHE:
        out = sh("gh", "issue", "view", str(n), "--json", "body,comments")
        try:
            data = json.loads(out) if out else {}
        except Exception:
            data = {}
        body = data.get("body") or ""
        comments = [(c.get("body") or "") for c in (data.get("comments") or [])]
        _THREAD_CACHE[n] = (body, comments)
    return _THREAD_CACHE[n]


def blocked_reason(n):
    """Read back WHY autopilot durably blocked issue #N.

    The stopping run posts a comment containing a BLOCK_SENTINEL line; the
    newest such comment wins (a later run may have refined the diagnosis).
    Returns "" when no tagged comment exists — e.g. a human applied the label
    by hand — so callers must treat the reason as best-effort, never as proof
    the label is real. Only the explicit-issue path pays for this extra `gh`
    call; auto-pick just counts the issue as parked.
    """
    _, comments = issue_thread(n)
    for body in reversed(comments):
        for line in body.splitlines():
            if BLOCK_SENTINEL in line:
                return line.split(BLOCK_SENTINEL, 1)[1].strip().strip("*_` ")[:160]
    return ""


def linked_prs(n):
    """Every distinct PR URL mentioned in issue #N's body or comments.

    Order is preserved (body first, then comments oldest→newest) and duplicates
    are dropped, so a PR linked once by autopilot and again by a human costs one
    lookup, not two.
    """
    body, comments = issue_thread(n)
    seen = []
    for text in [body, *comments]:
        for owner, repo, num in PR_URL_RE.findall(text):
            key = (owner, repo, num)
            if key not in seen:
                seen.append(key)
    return seen[:MAX_PR_LOOKUPS]


def delivered_by(n):
    """Return "<url> (<state>)" if a PR in ANY repo already delivered issue #N.

    Resolves every linked PR and prefers a MERGED one over a merely OPEN one, so
    the message names the PR that actually shipped rather than whichever was
    mentioned first. Returns "" when nothing is linked, nothing resolves (a
    private repo the token cannot read, a deleted PR), or every linked PR is
    closed-unmerged — all of which mean "no evidence of delivery", never
    "definitely not delivered".
    """
    fallback = ""
    for owner, repo, num in linked_prs(n):
        out = sh("gh", "pr", "view", num, "--repo", f"{owner}/{repo}",
                 "--json", "state,isDraft,url")
        try:
            pr = json.loads(out) if out else {}
        except Exception:
            continue
        state = (pr.get("state") or "").upper()
        if state not in DELIVERED_STATES:
            continue
        url = pr.get("url") or f"https://github.com/{owner}/{repo}/pull/{num}"
        detail = state.lower()
        if pr.get("isDraft"):
            detail += ", draft"
        if state == "MERGED":
            return f"{url} ({detail})"
        fallback = fallback or f"{url} ({detail})"
    return fallback


def eligibility_reason(i, explain=False, cross_repo=False):
    """Return "" if eligible, else a SKIP reason string.

    `explain` costs one extra `gh` call and is only worth it on the
    explicit-issue path, where a human typed the number and deserves to be
    told why their re-run is refusing (repo issue #32).

    `cross_repo` is checked last because it is the most expensive test here —
    every cheaper local signal gets a chance to skip the issue first.
    """
    n = i["number"]
    labels = {l["name"].lower() for l in i.get("labels", [])}
    blocking = labels & BLOCK
    if blocking:
        if explain and BLOCKED_LABEL in blocking:
            why = blocked_reason(n)
            return f"blocked — {why}" if why else \
                f"blocked — {BLOCKED_LABEL} label set, no recorded reason"
        return "parked:" + ",".join(sorted(blocking))
    if not (i.get("body") or "").strip():
        return "empty-body"
    wip = in_progress(n)
    if wip:
        return f"in-progress:{wip}"
    if cross_repo:
        pr = delivered_by(n)
        if pr:
            return f"delivered — {pr}"
    return ""


def validate_one(issues, target, cross_repo=False):
    match = next((i for i in issues if i.get("number") == target), None)
    if match is None:
        print(f"SKIP: #{target} not open or not found")
        return
    reason = eligibility_reason(match, explain=True, cross_repo=cross_repo)
    if reason:
        print(f"SKIP: #{target} {reason}")
        if reason.startswith("delivered — "):
            print(f"DELIVERED: {target} {reason[len('delivered — '):]}")
        return
    title = match.get("title", "").strip()[:70]
    # No rank tag here: an explicitly requested issue is worked regardless of
    # where it would have sorted, and printing a rank would suggest otherwise.
    print(f'PICK: #{target} "{title}" (explicit)')


def auto_pick(issues, cross_repo=False):
    total = len(issues)
    if total == 0:
        print("SKIP: no open issues")
        return

    parked = []
    in_prog = []
    empty_body = []
    delivered = []
    candidates = []

    for seq, i in enumerate(issues):
        n = i["number"]
        labels = {l["name"].lower() for l in i.get("labels", [])}

        blocking = labels & BLOCK
        if blocking:
            parked.append(f"#{n}")
            continue

        if not (i.get("body") or "").strip():
            empty_body.append(f"#{n}")
            continue

        wip = in_progress(n)
        if wip:
            in_prog.append(f"#{n}({wip})")
            continue

        candidates.append((rank_key(i, seq), i))

    # Order the whole eligible pool before choosing, rather than taking the
    # first one the (oldest-first) scan happens to reach. This is the only
    # place the ordering policy is applied — the explicit-issue path never
    # ranks, because a human who typed a number has already chosen.
    candidates.sort(key=lambda c: c[0])

    pick = None
    for _, i in candidates:
        # Cross-repo delivery is tested only on the candidate about to be
        # picked, in rank order: it is the sole position where the answer
        # changes what this run does, and testing every candidate would spend
        # `gh` calls on issues we are not going to touch anyway. A delivered
        # one is recorded for parking and the next-ranked candidate is tried.
        if cross_repo:
            pr = delivered_by(i["number"])
            if pr:
                delivered.append((i["number"], pr))
                continue
        pick = i
        break

    parts = []
    if parked:
        parts.append(f"{len(parked)} parked")
    if empty_body:
        parts.append(f"{len(empty_body)} empty-body")
    if in_prog:
        parts.append(f"{len(in_prog)} in-progress ({', '.join(in_prog[:3])}{'…' if len(in_prog) > 3 else ''})")
    if delivered:
        parts.append(f"{len(delivered)} delivered "
                     f"({', '.join(f'#{n} {pr}' for n, pr in delivered)})")
    ctx = f"{total} open" + (f" — {', '.join(parts)}" if parts else "")

    if pick:
        title = pick.get("title", "").strip()[:70]
        print(f'PICK: #{pick["number"]} "{title}" [{rank_reason(pick)}] ({ctx})')
    else:
        print(f"SKIP: nothing eligible — {ctx}")

    # After the verdict, never before it: the first line is the caller's contract.
    for n, pr in delivered:
        print(f"DELIVERED: {n} {pr}")


def main():
    # Pull flags out first so `--cross-repo` can sit in any position without
    # ever being mistaken for the issue-number positional.
    argv = sys.argv[1:]
    cross_repo = "--cross-repo" in argv
    argv = [a for a in argv if a != "--cross-repo"]

    if not argv:
        print("SKIP: no issues file given")
        return

    if argv[0] == "--worktree-check":
        if len(argv) < 2:
            print("SKIP: --worktree-check requires an issue number")
            return
        try:
            n = int(argv[1].lstrip("#"))
        except ValueError:
            print(f"SKIP: bad issue number {argv[1]!r}")
            return
        wip = in_progress(n)
        print(f"LIVE: {wip}" if wip else "CLEAR")
        return

    try:
        issues = json.load(open(argv[0]))
    except Exception as e:
        print(f"SKIP: could not parse issues ({e})")
        return

    if len(argv) >= 2 and argv[1].strip():
        try:
            target = int(argv[1].lstrip("#"))
        except ValueError:
            print(f"SKIP: bad issue number {argv[1]!r}")
            return
        validate_one(issues, target, cross_repo=cross_repo)
        return

    auto_pick(issues, cross_repo=cross_repo)


if __name__ == "__main__":
    main()
