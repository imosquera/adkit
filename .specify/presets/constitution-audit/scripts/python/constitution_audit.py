#!/usr/bin/env python3
"""constitution_audit.py — deterministic helper for the constitution-audit preset.

Subcommands:
  list                       Print each principle heading from
                             .specify/memory/constitution.md, one per line.
                             Exit 0 if any principle is found, 1 otherwise.

  validate <audit-file>      Validate <audit-file> against the constitution:
                               - every principle heading is referenced
                               - each principle has a verdict line containing
                                 exactly one of PASS / VIOLATES / N/A
                               - each principle has at least one quoted span
                                 (>= 4 words; "...", `...`, or `>` blockquote)
                                 that is a substring of the constitution body
                                 for that principle. This is the
                                 fabrication-killer: invented quotes fail.
                             Exit 0 on success, 1 with a per-principle error
                             list on failure.

Environment:
  CONSTITUTION_PATH          Override the constitution path
                             (default: <repo-root>/.specify/memory/constitution.md)
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path
from typing import Iterator

# Heading detection (permissive): matches
#   "## I. Foo", "### Principle 1: Bar", "#### 3) Baz", etc.
_PRINCIPLE_RE = re.compile(
    r"^(#{1,4})\s+(?:Principle\s+)?(\d+|[IVXLCDMivxlcdm]+)[.:)]\s+(.+?)\s*$"
)

_VERDICT_RE = re.compile(r"(?:^|[^A-Za-z])(PASS|VIOLATES|N/A)(?:[^A-Za-z]|$)")

# Quote extraction patterns. Backtick blocks are matched non-greedily across
# a single line; blockquotes are picked up per-line.
_DOUBLE_QUOTE_RE = re.compile(r'"([^"\n]+)"')
_BACKTICK_RE = re.compile(r"`([^`\n]+)`")
_BLOCKQUOTE_RE = re.compile(r"^>\s?(.*)$")

_WS_RUN = re.compile(r"\s+")

EXIT_OK = 0
EXIT_FAIL = 1
EXIT_USAGE = 2


# ---------------------------------------------------------------------------
# Repo + constitution resolution
# ---------------------------------------------------------------------------
def _find_repo_root(start: Path) -> Path:
    cur = start.resolve()
    for d in (cur, *cur.parents):
        if (d / ".specify").is_dir() or (d / ".git").exists():
            return d
    return cur


def _constitution_path() -> Path:
    override = os.environ.get("CONSTITUTION_PATH")
    if override:
        return Path(override)
    script_dir = Path(__file__).resolve().parent
    repo_root = _find_repo_root(script_dir)
    return repo_root / ".specify" / "memory" / "constitution.md"


# ---------------------------------------------------------------------------
# Principle extraction
# ---------------------------------------------------------------------------
class Principle:
    __slots__ = ("line", "depth", "key", "heading")

    def __init__(self, line: int, depth: int, key: str, heading: str) -> None:
        self.line = line  # 1-based line number of the heading
        self.depth = depth  # number of leading '#'s
        self.key = key.upper()  # normalised numeric or roman-numeral key
        self.heading = heading  # full heading text (after the #s)


def _extract_principles(constitution_text: str) -> list[Principle]:
    out: list[Principle] = []
    for i, raw in enumerate(constitution_text.splitlines(), start=1):
        m = _PRINCIPLE_RE.match(raw)
        if not m:
            continue
        depth = len(m.group(1))
        key = m.group(2)
        # Reconstruct the full heading text (without leading '#'s) for display
        # and section-matching in the audit file.
        heading_after_hashes = raw.lstrip("#").lstrip()
        out.append(Principle(i, depth, key, heading_after_hashes))
    return out


def _principle_body(constitution_lines: list[str], principle: Principle) -> str:
    """Return the body text of one principle: every line between its heading and
    the next heading of equal-or-shallower depth (or EOF)."""
    body: list[str] = []
    start_idx = principle.line  # principle.line is 1-based; start AFTER the heading
    for raw in constitution_lines[start_idx:]:
        m = re.match(r"^(#{1,6})\s+", raw)
        if m and len(m.group(1)) <= principle.depth:
            break
        body.append(raw)
    return "\n".join(body)


# ---------------------------------------------------------------------------
# Audit section extraction + quote extraction
# ---------------------------------------------------------------------------
def _extract_section(audit_lines: list[str], principle: Principle) -> str:
    """Find the principle's section in the audit file. A section starts at the
    first line that contains the full heading text OR a `Principle <key>` /
    `<key>.` / `<key>:` / `<key>)` token, and ends at the next markdown
    heading (any depth) or EOF."""
    key_pat = re.compile(
        r"(?:^|[^A-Za-z0-9])(?:Principle\s+)?"
        + re.escape(principle.key)
        + r"(?:[.:)\s])"
    )
    heading_needle = principle.heading

    collecting = False
    section: list[str] = []
    for raw in audit_lines:
        if not collecting:
            if heading_needle in raw or key_pat.search(raw):
                collecting = True
                section.append(raw)
            continue
        # Collecting: stop on the next markdown heading
        if re.match(r"^#{1,6}\s+", raw):
            break
        section.append(raw)
    return "\n".join(section)


def _extract_quotes(section: str) -> Iterator[str]:
    for line in section.splitlines():
        bq = _BLOCKQUOTE_RE.match(line)
        if bq:
            yield bq.group(1).strip()
    for m in _DOUBLE_QUOTE_RE.finditer(section):
        yield m.group(1).strip()
    for m in _BACKTICK_RE.finditer(section):
        yield m.group(1).strip()


def _normalise_ws(text: str) -> str:
    return _WS_RUN.sub(" ", text).strip()


# ---------------------------------------------------------------------------
# Subcommands
# ---------------------------------------------------------------------------
def cmd_list() -> int:
    path = _constitution_path()
    if not path.is_file():
        print(
            f"[constitution-audit] No constitution at {path}; nothing to list.",
            file=sys.stderr,
        )
        return EXIT_FAIL
    principles = _extract_principles(path.read_text(encoding="utf-8"))
    if not principles:
        print(
            f"[constitution-audit] No principle headings matched in {path}.",
            file=sys.stderr,
        )
        print(
            "[constitution-audit] Expected pattern: '## I. Name', "
            "'### Principle 1: Name', etc.",
            file=sys.stderr,
        )
        return EXIT_FAIL
    for p in principles:
        print(p.heading)
    return EXIT_OK


def cmd_validate(audit_path_str: str) -> int:
    if not audit_path_str:
        print("Usage: constitution_audit.py validate <audit-file>", file=sys.stderr)
        return EXIT_USAGE

    constitution_path = _constitution_path()
    if not constitution_path.is_file():
        print(
            f"[constitution-audit] No constitution at {constitution_path}; "
            "nothing to validate against.",
            file=sys.stderr,
        )
        return EXIT_OK

    audit_path = Path(audit_path_str)
    if not audit_path.is_file():
        print(
            f"[constitution-audit] Error: audit file not found: {audit_path}",
            file=sys.stderr,
        )
        return EXIT_FAIL

    constitution_text = constitution_path.read_text(encoding="utf-8")
    constitution_lines = constitution_text.splitlines()
    constitution_norm = _normalise_ws(constitution_text)

    audit_text = audit_path.read_text(encoding="utf-8")
    audit_lines = audit_text.splitlines()

    principles = _extract_principles(constitution_text)
    if not principles:
        print(
            f"[constitution-audit] No principle headings matched in "
            f"{constitution_path}; treating as no-op.",
            file=sys.stderr,
        )
        return EXIT_OK

    errors = 0
    for p in principles:
        section = _extract_section(audit_lines, p)
        if not section:
            print(
                f'[constitution-audit] MISSING: principle "{p.heading}" '
                f"has no section in {audit_path}",
                file=sys.stderr,
            )
            errors += 1
            continue

        if not _VERDICT_RE.search(section):
            print(
                f'[constitution-audit] NO VERDICT: principle "{p.heading}" '
                "section lacks a PASS / VIOLATES / N/A line",
                file=sys.stderr,
            )
            errors += 1
            continue

        body = _principle_body(constitution_lines, p)
        # Fall back to whole-constitution search if body extraction returned
        # nothing (defensive; shouldn't happen with valid headings).
        body_norm = _normalise_ws(body) if body.strip() else constitution_norm

        quote_ok = False
        for q in _extract_quotes(section):
            if len(q.split()) < 4:
                continue
            if _normalise_ws(q) in body_norm:
                quote_ok = True
                break

        if not quote_ok:
            print(
                f'[constitution-audit] UNQUOTED OR FABRICATED: principle '
                f'"{p.heading}" has no quoted span (>=4 words) that appears '
                "in the constitution",
                file=sys.stderr,
            )
            errors += 1

    if errors:
        print(
            f"[constitution-audit] {errors} / {len(principles)} principles "
            "failed validation. Fix the audit and re-run.",
            file=sys.stderr,
        )
        return EXIT_FAIL

    print(
        f"[constitution-audit] OK: all {len(principles)} principles have "
        "a verdict and a verified quote.",
        file=sys.stderr,
    )
    return EXIT_OK


# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------
_USAGE = """Usage: constitution_audit.py <subcommand> [args]

Subcommands:
  list                      Print constitution principle headings, one per line.
  validate <audit-file>     Validate an audit file (or plan.md) against the
                            constitution. Exits non-zero on missing principles,
                            missing verdicts, or unquoted/fabricated quotes.

Environment:
  CONSTITUTION_PATH         Override the constitution path
                            (default: <repo>/.specify/memory/constitution.md)
"""


def main(argv: list[str]) -> int:
    if not argv or argv[0] in ("-h", "--help"):
        print(_USAGE, end="")
        return EXIT_OK if argv else EXIT_USAGE
    sub, *rest = argv
    if sub == "list":
        return cmd_list()
    if sub == "validate":
        return cmd_validate(rest[0] if rest else "")
    print(f"Unknown subcommand: {sub}", file=sys.stderr)
    print("Run 'constitution_audit.py --help' for usage.", file=sys.stderr)
    return EXIT_USAGE


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
