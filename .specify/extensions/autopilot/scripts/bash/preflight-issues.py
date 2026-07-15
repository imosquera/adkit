#!/usr/bin/env python3
"""Evaluate the open-issue backlog and emit a single descriptive log line.

Three modes, selected by argv:
  preflight-issues.py <issues.json>              — auto-pick the oldest eligible issue
  preflight-issues.py <issues.json> <N>          — validate ONE specific issue number
  preflight-issues.py --worktree-check <N>       — branch/worktree/PR existence only

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

Existence of a branch/worktree/PR is unconditionally treated as in-progress
here — there is no "looks dead, might be safe to reuse" downgrade. A fresh,
seconds-old worktree from a sibling run and a genuinely abandoned one from a
crashed run look identical at this level, and this project's autopilot never
auto-resumes existing work either way (issue #19 fix #3): a human can always
inspect and clean up a stale branch/worktree by hand.

Output format (callers read the first word to decide):
  PICK: #42 "Fix the thing" — 7 open (2 parked, 1 in-progress)
  SKIP: backlog clear — 3 open, all parked/in-progress
  SKIP: no open issues
  SKIP: 5 open but all in-progress (branches: 003-foo, 005-bar)
  PICK: #42 "Fix the thing" (explicit)
  SKIP: #42 parked:autopilot:claimed
  SKIP: #42 in-progress:082-fix-thing
  SKIP: #42 not open or not found
  LIVE: 082-fix-thing
  CLEAR
"""
import json
import subprocess
import sys

BLOCK = {
    "blocked", "wontfix", "duplicate",
    "needs-discussion", "needs discussion",
    "on-hold", "on hold", "question", "epic",
    "autopilot:claimed",
}


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


def eligibility_reason(i):
    """Return "" if eligible, else a SKIP reason string."""
    n = i["number"]
    labels = {l["name"].lower() for l in i.get("labels", [])}
    blocking = labels & BLOCK
    if blocking:
        return "parked:" + ",".join(sorted(blocking))
    if not (i.get("body") or "").strip():
        return "empty-body"
    wip = in_progress(n)
    if wip:
        return f"in-progress:{wip}"
    return ""


def validate_one(issues, target):
    match = next((i for i in issues if i.get("number") == target), None)
    if match is None:
        print(f"SKIP: #{target} not open or not found")
        return
    reason = eligibility_reason(match)
    if reason:
        print(f"SKIP: #{target} {reason}")
        return
    title = match.get("title", "").strip()[:70]
    print(f'PICK: #{target} "{title}" (explicit)')


def auto_pick(issues):
    total = len(issues)
    if total == 0:
        print("SKIP: no open issues")
        return

    parked = []
    in_prog = []
    empty_body = []
    pick = None

    for i in issues:
        n = i["number"]
        title = i.get("title", "").strip()[:70]
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

        if pick is None:
            pick = (n, title)
            # keep scanning to count the rest accurately
            continue

    parts = []
    if parked:
        parts.append(f"{len(parked)} parked")
    if empty_body:
        parts.append(f"{len(empty_body)} empty-body")
    if in_prog:
        parts.append(f"{len(in_prog)} in-progress ({', '.join(in_prog[:3])}{'…' if len(in_prog) > 3 else ''})")
    ctx = f"{total} open" + (f" — {', '.join(parts)}" if parts else "")

    if pick:
        n, title = pick
        print(f'PICK: #{n} "{title}" ({ctx})')
    else:
        print(f"SKIP: nothing eligible — {ctx}")


def main():
    if len(sys.argv) < 2:
        print("SKIP: no issues file given")
        return

    if sys.argv[1] == "--worktree-check":
        if len(sys.argv) < 3:
            print("SKIP: --worktree-check requires an issue number")
            return
        try:
            n = int(sys.argv[2].lstrip("#"))
        except ValueError:
            print(f"SKIP: bad issue number {sys.argv[2]!r}")
            return
        wip = in_progress(n)
        print(f"LIVE: {wip}" if wip else "CLEAR")
        return

    try:
        issues = json.load(open(sys.argv[1]))
    except Exception as e:
        print(f"SKIP: could not parse issues ({e})")
        return

    if len(sys.argv) >= 3 and sys.argv[2].strip():
        try:
            target = int(sys.argv[2].lstrip("#"))
        except ValueError:
            print(f"SKIP: bad issue number {sys.argv[2]!r}")
            return
        validate_one(issues, target)
        return

    auto_pick(issues)


if __name__ == "__main__":
    main()
