#!/usr/bin/env python3
"""Evaluate the open-issue backlog and emit a single descriptive log line.

Output format (autopilot-run.sh reads the first word to decide):
  PICK: #42 "Fix the thing" — 7 open (2 parked, 1 in-progress)
  SKIP: backlog clear — 3 open, all parked/in-progress
  SKIP: no open issues
  SKIP: 5 open but all in-progress (branches: 003-foo, 005-bar)
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


def in_progress(n):
    """Return branch/worktree name if issue #N is already being worked."""
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


def main():
    if len(sys.argv) < 2:
        print("SKIP: no issues file given")
        return

    try:
        issues = json.load(open(sys.argv[1]))
    except Exception as e:
        print(f"SKIP: could not parse issues ({e})")
        return

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

        # already have a pick — still count remaining skips
        blocking2 = labels & BLOCK
        if blocking2:
            parked.append(f"#{n}")
        elif not (i.get("body") or "").strip():
            empty_body.append(f"#{n}")
        else:
            wip2 = in_progress(n)
            if wip2:
                in_prog.append(f"#{n}({wip2})")

    # Build context string
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


if __name__ == "__main__":
    main()
