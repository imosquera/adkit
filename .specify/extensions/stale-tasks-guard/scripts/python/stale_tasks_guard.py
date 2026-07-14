#!/usr/bin/env python3
"""stale_tasks_guard.py — deterministic helper for the stale-tasks-guard extension.

Compares spec.md/tasks.md staleness for the active feature directory, resolved
with the same priority core Spec Kit uses (.specify/scripts/bash/common.sh
get_feature_paths()): the SPECIFY_FEATURE_DIRECTORY env var first (an explicit
override for the run), falling back to .specify/feature.json's
"feature_directory" key. A clean (committed, non-dirty) file's git commit time
is used instead of its filesystem mtime, since `git checkout`/clone resets
mtimes for every file to checkout time regardless of true edit history —
which would otherwise silently defeat the comparison in a fresh worktree.
A file with uncommitted local changes uses its filesystem mtime, which
reflects the real edit time.

Exit codes:
  0   Not stale, or the guard does not apply (missing spec.md/tasks.md,
      unresolvable feature directory). Implementation may proceed.
  1   Stale tasks detected: spec.md is newer than tasks.md.

Anything printed to stderr on a 0 exit is advisory (e.g. "guard skipped —
feature directory unresolvable") and must not be read as staleness.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys


def _git(args: list[str], cwd: str) -> str | None:
    try:
        result = subprocess.run(
            ["git", *args], cwd=cwd, capture_output=True, text=True, timeout=5
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    return result.stdout.strip()


def effective_mtime(path: str) -> float:
    """Return a staleness-comparable timestamp for `path`.

    Uncommitted changes: filesystem mtime (accurate). Clean/committed file:
    the file's last commit time (immune to checkout resetting mtime). Not a
    git repo, or file untracked: filesystem mtime.
    """
    dirty = _git(["status", "--porcelain", "--", path], ".")
    if not dirty:
        commit_epoch = _git(["log", "-1", "--format=%ct", "--", path], ".")
        if commit_epoch:
            return float(commit_epoch)
    return os.path.getmtime(path)


def resolve_feature_dir() -> str | None:
    env_dir = os.environ.get("SPECIFY_FEATURE_DIRECTORY")
    if env_dir:
        return env_dir if os.path.isabs(env_dir) else os.path.join(os.getcwd(), env_dir)

    try:
        with open(".specify/feature.json", encoding="utf-8") as f:
            return json.load(f)["feature_directory"]
    except (OSError, json.JSONDecodeError, KeyError) as exc:
        print(
            f"stale-tasks-guard: could not resolve feature_directory ({exc}); "
            "skipping guard",
            file=sys.stderr,
        )
        return None


def main() -> int:
    feature_dir = resolve_feature_dir()
    if feature_dir is None:
        return 0

    spec_path = os.path.join(feature_dir, "spec.md")
    tasks_path = os.path.join(feature_dir, "tasks.md")
    if not os.path.isfile(spec_path) or not os.path.isfile(tasks_path):
        return 0

    spec_time = effective_mtime(spec_path)
    tasks_time = effective_mtime(tasks_path)

    if spec_time > tasks_time:
        delta_minutes = int((spec_time - tasks_time) / 60)
        print("STALE TASKS DETECTED")
        print(f"   spec.md was modified {delta_minutes}m after tasks.md was last generated.")
        print("   Run /speckit-tasks to reconcile, then re-run /speckit-implement.")
        print("   To bypass: /speckit-implement --force")
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
