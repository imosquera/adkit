#!/usr/bin/env bash
# spec-minimal preset: enforce-minimal-tree.sh
# The SINGLE enforcement mechanism for spec-minimal. Run as the last step of
# the wrapped /speckit-plan.
#
# Unlike a read-only verifier, this script is SELF-HEALING: it never leaves a
# forbidden artifact on disk. For each forbidden path it finds, it inlines the
# content into plan.md inside an idempotent sentinel block, then removes the
# path.
#
# ALLOWED top-level entries:  spec.md, plan.md, tasks.md, quickstart.md, research.md
# FORBIDDEN (any form):       data-model.md, contracts (file or dir)
#
# Anything else at the top level is UNKNOWN: warned about on stderr and left
# alone. Dotfiles are ignored entirely. Other stacked presets legitimately write
# files here (checklists/, …), so unknown entries must never fail the run.
#
# ---------------------------------------------------------------------------
# SAFETY INVARIANTS (this script deletes files — read before editing)
#
# 1. WRITE-BEFORE-REMOVE. All content is gathered first, the complete new
#    plan.md is built in memory, and it is written ATOMICALLY (temp file in the
#    same directory + fsync + os.replace, always encoding="utf-8"). Only after
#    that write is confirmed does anything get removed. If the write fails,
#    nothing is removed and the script exits 1. plan.md is never truncated in
#    place, so a failed write can never destroy existing plan content.
#    The original plan.md permission bits are carried over to the replacement;
#    a read-only plan.md is therefore still healed (the directory, not the
#    file, is what must be writable).
#
# 2. SENTINELS CAN NEVER APPEAR IN A BLOCK BODY. Gathered content is sanitized
#    before it is wrapped: any literal "<!-- BEGIN: spec-minimal inlined" or
#    "<!-- END: spec-minimal inlined" is rewritten to
#    "<!-- (escaped by spec-minimal) BEGIN: …" / "… END: …", which is not
#    itself a sentinel. This IS deliberate and it IS lossy — but only in the
#    escaping sense: the text stays fully readable, only the exact comment
#    prefix changes. Without it, inlined content that merely quotes a sentinel
#    (this preset's own README.md does) would make block parsing ambiguous and
#    silently eat the rest of plan.md. The escape is idempotent, so repeated
#    runs converge.
#
# 3. UNBALANCED SENTINELS ARE A HARD ERROR. A BEGIN with no matching END (or an
#    END with no BEGIN, or a mismatched pair) means plan.md cannot be parsed
#    unambiguously. The script reports which sentinel is unbalanced and on what
#    line, writes nothing, removes nothing, and exits 1.
#
# 4. SYMLINKS ARE NEVER FOLLOWED. A forbidden path that is a symlink (including
#    a dangling one) is detected via lexists, is NOT read or inlined, and only
#    the link itself is removed — the target is left untouched. This is
#    reported truthfully rather than as "empty".
#
# 5. A FORBIDDEN ARTIFACT IS NEVER LEFT ON DISK JUST BECAUSE plan.md IS ABSENT.
#    plan.md is itself in the allowed set, so if it is missing the enforcer
#    CREATES it (with a minimal header) and rehomes the content into it. There
#    is no "refuse and leave the artifact there" outcome.
# ---------------------------------------------------------------------------
#
# Exit codes:
#   0  the tree matches the allowed set — no forbidden artifact remains on
#      disk. Healing (including creating plan.md) and warnings may have
#      happened; both are reported.
#   1  one of two distinct situations, always stated explicitly on stderr:
#        (a) HEALING IMPOSSIBLE — nothing was written to plan.md and nothing
#            was removed. Causes: the feature dir cannot be listed, plan.md
#            exists but cannot be read as UTF-8, plan.md has unbalanced
#            sentinels, a forbidden artifact cannot be read, or plan.md cannot
#            be written.
#        (b) PARTIALLY HEALED — the content IS safely inlined in plan.md, but
#            at least one forbidden artifact could not be removed from disk and
#            is still there.
#   2  bad usage
#
# Usage: enforce-minimal-tree.sh <feature-dir>

set -euo pipefail

FEATURE_DIR="${1:-}"
if [[ -z "$FEATURE_DIR" ]]; then
    echo "error: feature directory argument required" >&2
    exit 2
fi
if [[ ! -d "$FEATURE_DIR" ]]; then
    echo "error: not a directory: $FEATURE_DIR" >&2
    exit 2
fi

python3 - "$FEATURE_DIR" <<'PY'
import os
import re
import shutil
import sys
import tempfile
from pathlib import Path

feature_dir = Path(sys.argv[1])

ALLOWED = ("spec.md", "plan.md", "tasks.md", "quickstart.md", "research.md")
# Deterministic processing order — keeps plan.md stable across runs.
FORBIDDEN = ("data-model.md", "contracts")

PLAN = feature_dir / "plan.md"

SENTINEL_RE = re.compile(r"<!-- (BEGIN|END): spec-minimal inlined (.*?) -->")

# The caller's locale must never be able to crash the reporting (a print that
# raises UnicodeEncodeError after a removal is how you get a wrong error
# message about what happened). Report text is ASCII on purpose; this is the
# belt to that suspenders.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(errors="backslashreplace")
    except (AttributeError, OSError):
        pass

# Progress flags — they decide what we may TRUTHFULLY claim in an error message.
PLAN_WRITTEN = False
REMOVAL_STARTED = False


def err(msg):
    print(msg, file=sys.stderr)


def begin_sentinel(name):
    return f"<!-- BEGIN: spec-minimal inlined {name} -->"


def end_sentinel(name):
    return f"<!-- END: spec-minimal inlined {name} -->"


def die_untouched(lines):
    for line in lines:
        err(line)
    err("")
    err("HEALING IMPOSSIBLE: nothing was written to plan.md and nothing was")
    err("removed. Fix the problem above and re-run this script.")
    sys.exit(1)


# ---------------------------------------------------------------- sanitizing


def sanitize(text):
    """Neutralize literal sentinels so a block body can never contain one.

    Deliberate and lossy-by-design in the escaping sense ONLY: the text stays
    readable, just with an annotated comment prefix. See invariant 2 above.
    """
    return (
        text.replace(
            "<!-- BEGIN: spec-minimal inlined",
            "<!-- (escaped by spec-minimal) BEGIN: spec-minimal inlined",
        ).replace(
            "<!-- END: spec-minimal inlined",
            "<!-- (escaped by spec-minimal) END: spec-minimal inlined",
        )
    )


# ---------------------------------------------------------------- gathering


def read_text_or_none(path):
    """Return the file's text, or None if it can't be decoded as UTF-8."""
    try:
        return path.read_bytes().decode("utf-8")
    except UnicodeDecodeError:
        return None


def gather_file(path, skipped):
    text = read_text_or_none(path)
    if text is None:
        skipped.append(str(path.name))
        return ""
    return text


def gather_dir(root, skipped):
    """Concatenate every file under root, each under a '### <relpath>' heading."""
    chunks = []
    files = sorted(
        p for p in root.rglob("*") if p.is_file() and not p.is_symlink()
    )
    for path in files:
        rel = path.relative_to(root).as_posix()
        text = read_text_or_none(path)
        if text is None:
            skipped.append(f"{root.name}/{rel}")
            continue
        body = text.strip("\n")
        chunks.append(f"### {rel}\n\n{body}\n" if body else f"### {rel}\n")
    return "\n".join(chunks)


def gather(path, skipped):
    """Read a NON-symlink forbidden path. Symlinks are handled by the caller."""
    if path.is_dir():
        return gather_dir(path, skipped)
    return gather_file(path, skipped)


def make_block(name, content):
    body = sanitize(content).strip("\n")
    return (
        begin_sentinel(name) + "\n"
        f"## Inlined from {name}\n"
        "\n"
        + body + "\n"
        + end_sentinel(name) + "\n"
    )


# ---------------------------------------------------------------- parsing


def line_of(text, offset):
    return text.count("\n", 0, offset) + 1


def parse_blocks(plan_text):
    """Return [(name, start, stop)] for every well-formed sentinel block.

    Any imbalance is a hard error (invariant 3) — plan.md is not parseable
    unambiguously, so we refuse to touch anything.
    """
    blocks = []
    open_block = None
    for m in SENTINEL_RE.finditer(plan_text):
        kind, name = m.group(1), m.group(2)
        if kind == "BEGIN":
            if open_block is not None:
                die_untouched([
                    f"FAIL: unbalanced spec-minimal sentinels in {PLAN}",
                    f"  - {begin_sentinel(open_block[0])}",
                    f"    on line {line_of(plan_text, open_block[1])} is never closed;",
                    f"    a second BEGIN (for '{name}') appears first on line"
                    f" {line_of(plan_text, m.start())}.",
                ])
            open_block = (name, m.start())
        else:
            if open_block is None:
                die_untouched([
                    f"FAIL: unbalanced spec-minimal sentinels in {PLAN}",
                    f"  - {end_sentinel(name)}",
                    f"    on line {line_of(plan_text, m.start())} has no matching BEGIN.",
                ])
            if open_block[0] != name:
                die_untouched([
                    f"FAIL: unbalanced spec-minimal sentinels in {PLAN}",
                    f"  - {end_sentinel(name)}",
                    f"    on line {line_of(plan_text, m.start())} does not match the open",
                    f"    {begin_sentinel(open_block[0])}",
                    f"    on line {line_of(plan_text, open_block[1])}.",
                ])
            stop = m.end()
            # Swallow the newline that terminates the END sentinel line, since
            # a replacement block already carries its own.
            if plan_text[stop:stop + 1] == "\n":
                stop += 1
            blocks.append((name, open_block[1], stop))
            open_block = None
    if open_block is not None:
        die_untouched([
            f"FAIL: unbalanced spec-minimal sentinels in {PLAN}",
            f"  - {begin_sentinel(open_block[0])}",
            f"    on line {line_of(plan_text, open_block[1])} is never closed.",
            "    Close it (or delete the orphan line) so the block structure is",
            "    unambiguous, then re-run.",
        ])
    return blocks


def rebuild(plan_text, blocks, new_blocks):
    """Replace each named block in place; drop later duplicates of that name.

    Names with no existing block are appended, separated by one blank line.
    """
    out = []
    pos = 0
    placed = set()
    for name, start, stop in blocks:
        if name not in new_blocks:
            continue
        out.append(plan_text[pos:start])
        if name not in placed:
            out.append(new_blocks[name])
            placed.add(name)
            pos = stop
        else:
            # Stale duplicate: drop it, along with the blank line after it.
            pos = stop
            while plan_text[pos:pos + 1] == "\n":
                pos += 1
    out.append(plan_text[pos:])
    text = "".join(out)

    for name in new_blocks:
        if name in placed:
            continue
        if text and not text.endswith("\n"):
            text += "\n"
        if text:
            text += "\n"
        text += new_blocks[name]
    return text


# ---------------------------------------------------------------- writing


def write_plan_atomically(text):
    """Write plan.md via temp-file + fsync + os.replace. Never truncates."""
    global PLAN_WRITTEN
    directory = str(feature_dir)
    fd, tmp = tempfile.mkstemp(prefix=".plan.md.", suffix=".tmp", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as fh:
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())
        try:
            mode = os.stat(str(PLAN)).st_mode & 0o7777
        except OSError:
            mode = 0o644  # plan.md did not exist; mkstemp's 0600 is too tight
        try:
            os.chmod(tmp, mode)
        except OSError:
            pass
        os.replace(tmp, str(PLAN))
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    try:
        dfd = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    except OSError:
        pass
    PLAN_WRITTEN = True


# ---------------------------------------------------------------- main


def main():
    # ------------------------------------------------------------ scan
    try:
        entries = sorted(p.name for p in feature_dir.iterdir())
    except OSError as exc:
        die_untouched([f"FAIL: cannot list {feature_dir} ({exc})"])

    for name in entries:
        if name.startswith("."):
            continue  # dotfiles (.DS_Store, editor droppings) are not our business
        if name in ALLOWED or name in FORBIDDEN:
            continue
        err(f"warning: unknown top-level entry (left in place): {name}")

    # lexists, not exists: a DANGLING symlink named research.md is still a
    # forbidden artifact sitting in the tree.
    present = [n for n in FORBIDDEN if os.path.lexists(str(feature_dir / n))]

    if not present:
        print(f"ok: {feature_dir} matches spec-minimal allowed set")
        return

    # plan.md is itself an allowed file, so a missing one is not a reason to
    # leave a forbidden artifact on disk (invariant 5) — create it and rehome.
    plan_created = False
    if not PLAN.is_file():
        if os.path.lexists(str(PLAN)):
            die_untouched([
                f"FAIL: {PLAN} exists but is not a regular file",
                "  - refusing to overwrite it",
            ])
        plan_created = True
        plan_text = (
            "# Implementation Plan\n"
            "\n"
            "_Created by the spec-minimal enforcer to rehome content inlined from"
            " forbidden artifacts._\n"
        )
    else:
        try:
            plan_text = PLAN.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as exc:
            die_untouched([f"FAIL: cannot read {PLAN} as UTF-8 ({exc})"])

    blocks = parse_blocks(plan_text)

    # ------------------------------------------------------------ gather
    new_blocks = {}
    empties = []
    symlinks = []

    for name in present:
        path = feature_dir / name
        if path.is_symlink():
            try:
                target = os.readlink(str(path))
            except OSError:
                target = "<unreadable>"
            symlinks.append((name, target))
            continue
        skipped = []
        try:
            content = gather(path, skipped)
        except OSError as exc:
            die_untouched([f"FAIL: cannot read forbidden artifact '{name}' ({exc})"])
        for s in skipped:
            err(f"warning: undecodable file, bytes skipped: {s}")
        if content.strip():
            new_blocks[name] = make_block(name, content)
        else:
            empties.append(name)

    # ------------------------------------------------------------ write
    # Only write (and only create plan.md) when there is content to rehome.
    if new_blocks:
        try:
            write_plan_atomically(rebuild(plan_text, blocks, new_blocks))
        except OSError as exc:
            die_untouched([f"FAIL: cannot write {PLAN} ({exc})"])
    else:
        plan_created = False

    # ------------------------------------------------------------ remove
    global REMOVAL_STARTED
    REMOVAL_STARTED = True
    removed, failures = [], []
    for name in present:
        path = feature_dir / name
        try:
            if path.is_symlink():
                path.unlink()
            elif path.is_dir():
                shutil.rmtree(str(path))
            else:
                path.unlink()
            removed.append(name)
        except OSError as exc:
            failures.append(f"{name}: could not remove ({exc})")

    # ------------------------------------------------------------ report
    if plan_created:
        print("created: plan.md (it was missing; inlined content was rehomed there)")
    for name in FORBIDDEN:
        if name in new_blocks:
            print(f"inlined: {name} -> plan.md (block '{begin_sentinel(name)}')")
    for name in empties:
        print(f"empty:   {name} had no content -- nothing inlined")
    for name, target in symlinks:
        print(
            f"symlink: {name} is a symlink -> {target}; only the link was"
            " handled, the target was neither read nor modified"
        )
    for name in removed:
        print(f"removed: {name}")

    if failures:
        err(f"FAIL: spec-minimal healing incomplete in {feature_dir}")
        for f in failures:
            err(f"  - {f}")
        err("")
        if new_blocks:
            err("PARTIALLY HEALED: the content IS safely inlined in plan.md, but the")
            err("artifact(s) above are still on disk. Remove them by hand (nothing")
            err("will be lost -- plan.md already has the content) and re-run.")
        else:
            err("PARTIALLY HEALED: nothing needed inlining, but the artifact(s) above")
            err("are still on disk. Remove them by hand and re-run.")
        sys.exit(1)

    print(f"ok: {feature_dir} healed to the spec-minimal allowed set")


try:
    main()
except SystemExit:
    raise
except BaseException as exc:  # invariant: never surface a raw traceback
    err(f"FAIL: spec-minimal enforcer hit an unexpected error in {feature_dir}")
    err(f"  - {type(exc).__name__}: {exc}")
    err("")
    if PLAN_WRITTEN or REMOVAL_STARTED:
        err("The run did not complete. plan.md was already updated" if PLAN_WRITTEN
            else "The run did not complete. plan.md was NOT updated")
        err("and artifact removal had already started." if REMOVAL_STARTED
            else "and no artifact was removed.")
        err("Check the tree by hand before re-running.")
    else:
        err("HEALING IMPOSSIBLE: nothing was written to plan.md and nothing was removed.")
    sys.exit(1)
PY
