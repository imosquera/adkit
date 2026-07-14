#!/usr/bin/env python3
"""Parse, Don't Validate — deterministic anti-pattern scanner.

Enforces the "parse, don't validate" discipline: push untrusted data through a
parser at the boundary that returns a *more precise type*, instead of scattering
re-validation (`isValid...`, defensive `if`s) across the call stack. A validator
says "this is fine, continue" and throws the proof away the instant it returns;
a parser returns either a precise type or a typed error and the type carries the
proof forward. This script gives the preset teeth: an implementer can't claim
"no validators left" while an `is_valid_user` / `isValidUser` still sits in the
diff.

Everything is analysed as a real AST — no regex heuristics:
  * Python (`.py/.pyi`) via the stdlib `ast` module.
  * TypeScript (`.ts/.tsx/.mts/.cts`) by shelling out to Node and the project's
    TypeScript Compiler API (`scripts/node/pdv_ts_scan.cjs`). This requires
    `node` on PATH and `typescript` installed in the project. There is NO regex
    fallback: if either is missing, or a source file cannot be parsed, the scan
    fails loudly rather than silently under-reporting.

Stdlib-only Python 3.8+ (the Node helper carries the TypeScript dependency).

Subcommands
-----------
  checklist
      Print the discipline items an implementation audit must cover.

  scan [--base <ref>] [paths ...]
      Scan TypeScript/Python sources for parse-don't-validate anti-patterns.
      With explicit paths, scans exactly those. With no paths, scans the git
      change set: the working tree PLUS work already committed on the current
      branch (diffed against `--base`, or an auto-detected base ref —
      origin/HEAD, then origin/main/master, then main/master). Including
      committed work means the gate still fires after a post-implement hook has
      staged and committed the changes. Exits non-zero when un-waived findings
      exist (1) or when the scan itself could not run (3).

Waivers
-------
Any finding can be suppressed with a trailing or preceding line comment
(`//` for TypeScript, `#` for Python):

      const raw = input as User; // parse-dont-validate: allow PDV004 (boundary)
      user = cast(User, raw)      # parse-dont-validate: allow PDV004 (boundary)

The rule id is required; the parenthetical reason is for humans. Waive at the
*parser boundary* — that is the one place a narrowing cast is legitimate. A
waiver that leaks outside a parser module is the bug this scheme exists to
prevent.
"""

from __future__ import annotations

import ast
import json
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional

# --- discipline items (language-general) ------------------------------------

CHECKLIST = [
    ("PDV001", "No dynamic-typing escape hatch",
     "TypeScript `any`/`as any` and Python `Any` erase the boundary. Untrusted "
     "input is `unknown` (TS) or a parsed model (Py), never `any`/`Any`."),
    ("PDV002", "Deserialization stays at a parser boundary",
     "`JSON.parse` / `json.loads` / `pickle.loads` are deserializers, not "
     "validators. Keep them inside a parser module that hands back a precise "
     "domain type; don't scatter raw deserialization through domain code."),
    ("PDV003", "No boolean validators at the boundary",
     "A `boolean`/`bool`-returning `isValid*`/`validate*` throws information "
     "away the instant it returns. Return a parsed, more-precise type (or a "
     "Result) instead."),
    ("PDV004", "Narrowing casts only inside parser modules",
     "TypeScript `x as Brand` and Python `cast(Brand, x)` are the one "
     "sanctioned lie — confine them to the parser at the boundary. A cast "
     "elsewhere forges trust the type system never granted."),
]

WAIVER_RE = re.compile(r"parse-dont-validate:\s*allow\s+(PDV\d{3})", re.IGNORECASE)

# A parser boundary module — the sanctioned home for narrowing casts and raw
# deserialization. Covers TS parser/schema idioms and Python model/schema ones.
PARSER_FILE_RE = re.compile(
    r"(parse|parser|schema|schemas|codec|decoder|brand|model|models)",
    re.IGNORECASE,
)

VALIDATOR_NAME_RE = re.compile(r"^(is_[A-Za-z]\w*|validate\w*|check_valid\w*)$")

TS_EXTENSIONS = {".ts", ".tsx", ".mts", ".cts"}
PY_EXTENSIONS = {".py", ".pyi"}
EXTENSIONS = TS_EXTENSIONS | PY_EXTENSIONS

NODE_HELPER = Path(__file__).resolve().parent.parent / "node" / "pdv_ts_scan.cjs"


class ScanError(Exception):
    """The scan could not be performed (missing tool, unparseable source)."""


@dataclass
class Finding:
    rule: str
    path: str
    line: int
    text: str


def _read_lines(path: Path) -> List[str]:
    try:
        return path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []


def _waivers_for_line(lines: List[str], idx: int) -> set:
    """Rule ids waived on this line or the line immediately above it."""
    waived = set()
    for probe in (idx, idx - 1):
        if 0 <= probe < len(lines):
            for m in WAIVER_RE.finditer(lines[probe]):
                waived.add(m.group(1).upper())
    return waived


def _finalize(path: str, lines: List[str], raw: List[tuple]) -> List[Finding]:
    """Apply waivers and attach source text to (rule, line) pairs."""
    out: List[Finding] = []
    seen = set()
    for rule, line in raw:
        key = (rule, line)
        if key in seen:
            continue
        seen.add(key)
        if rule in _waivers_for_line(lines, line - 1):
            continue
        text = lines[line - 1].strip() if 0 <= line - 1 < len(lines) else ""
        out.append(Finding(rule, path, line, text))
    return out


# --- Python: AST-based analysis --------------------------------------------

class _PyVisitor(ast.NodeVisitor):
    """Collect (rule, lineno) findings from a Python AST."""

    def __init__(self, is_parser: bool):
        self.is_parser = is_parser
        self.hits: List[tuple] = []

    def _flag_any(self, annotation: Optional[ast.AST]) -> None:
        if annotation is None:
            return
        for node in ast.walk(annotation):
            if isinstance(node, ast.Name) and node.id == "Any":
                self.hits.append(("PDV001", node.lineno))
            elif isinstance(node, ast.Attribute) and node.attr == "Any":
                self.hits.append(("PDV001", node.lineno))

    def visit_AnnAssign(self, node: ast.AnnAssign) -> None:
        self._flag_any(node.annotation)
        self.generic_visit(node)

    def visit_arg(self, node: ast.arg) -> None:
        self._flag_any(node.annotation)
        self.generic_visit(node)

    def _visit_func(self, node) -> None:
        self._flag_any(node.returns)
        if (isinstance(node.returns, ast.Name) and node.returns.id == "bool"
                and VALIDATOR_NAME_RE.match(node.name)):
            self.hits.append(("PDV003", node.lineno))
        self.generic_visit(node)

    visit_FunctionDef = _visit_func
    visit_AsyncFunctionDef = _visit_func

    def visit_Call(self, node: ast.Call) -> None:
        func = node.func
        if not self.is_parser and isinstance(func, ast.Attribute) \
                and isinstance(func.value, ast.Name):
            mod, fn = func.value.id, func.attr
            if ((mod in {"json", "pickle", "marshal"} and fn in {"load", "loads"})
                    or (mod == "yaml" and fn in {"load", "safe_load"})):
                self.hits.append(("PDV002", node.lineno))
        if not self.is_parser:
            is_cast = ((isinstance(func, ast.Name) and func.id == "cast")
                       or (isinstance(func, ast.Attribute) and func.attr == "cast"))
            if is_cast:
                self.hits.append(("PDV004", node.lineno))
        self.generic_visit(node)


def _scan_python(paths: List[Path]) -> List[Finding]:
    findings: List[Finding] = []
    for path in paths:
        lines = _read_lines(path)
        source = "\n".join(lines)
        try:
            tree = ast.parse(source, filename=str(path))
        except SyntaxError as e:
            raise ScanError(f"{path}:{e.lineno}: cannot parse Python source: {e.msg}")
        is_parser = bool(PARSER_FILE_RE.search(path.name))
        visitor = _PyVisitor(is_parser)
        visitor.visit(tree)
        findings.extend(_finalize(str(path), lines, visitor.hits))
    return findings


# --- TypeScript: Node + TS Compiler API -------------------------------------

def _scan_typescript(paths: List[Path]) -> List[Finding]:
    node = shutil.which("node")
    if node is None:
        raise ScanError(
            "cannot scan TypeScript — `node` was not found on PATH. Install "
            "Node.js (and `typescript` in the project) to parse TS files.")
    if not NODE_HELPER.is_file():
        raise ScanError(f"TypeScript scanner helper missing: {NODE_HELPER}")

    job = {"files": [
        {"path": str(p), "isParser": bool(PARSER_FILE_RE.search(p.name))}
        for p in paths
    ]}
    try:
        proc = subprocess.run(
            [node, str(NODE_HELPER)],
            input=json.dumps(job), capture_output=True, text=True, check=False)
    except OSError as e:
        raise ScanError(f"failed to launch Node scanner: {e}")
    if proc.returncode != 0:
        raise ScanError(proc.stderr.strip() or "TypeScript scanner failed")
    try:
        payload = json.loads(proc.stdout or "{}")
    except json.JSONDecodeError as e:
        raise ScanError(f"malformed TypeScript scanner output: {e}")

    by_file: Dict[str, List[tuple]] = {}
    for fd in payload.get("findings", []):
        by_file.setdefault(fd["path"], []).append((fd["rule"], fd["line"]))

    findings: List[Finding] = []
    for path in paths:
        raw = by_file.get(str(path), [])
        if not raw:
            continue
        findings.extend(_finalize(str(path), _read_lines(path), raw))
    return findings


# --- driver -----------------------------------------------------------------

def _git(args: List[str]) -> List[str]:
    try:
        out = subprocess.run(["git", *args], capture_output=True, text=True,
                             check=False)
    except OSError:
        return []
    return out.stdout.splitlines() if out.returncode == 0 else []


def _detect_base() -> Optional[str]:
    """A base ref to diff the current branch against for committed feature work."""
    head = _git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
    for ref in (head + ["origin/main", "origin/master", "main", "master"]):
        if _git(["rev-parse", "--verify", "--quiet", ref]):
            return ref
    return None


def _changed_files(base: Optional[str]) -> List[Path]:
    # Working-tree state (before any auto-commit hook runs).
    names: List[str] = []
    names += _git(["diff", "--name-only", "--diff-filter=d", "HEAD"])
    names += _git(["diff", "--name-only", "--diff-filter=d"])
    names += _git(["ls-files", "--others", "--exclude-standard"])

    # Committed work on this branch — so the gate still sees the implementation
    # even after a post-implement hook has staged + committed it. Diff against
    # the merge-base with the branch's base ref.
    base = base or _detect_base()
    if base:
        mb = _git(["merge-base", base, "HEAD"])
        if mb:
            names += _git(["diff", "--name-only", "--diff-filter=d", mb[0], "HEAD"])

    seen, paths = set(), []
    for n in names:
        if n and n not in seen:
            seen.add(n)
            p = Path(n)
            if p.suffix in EXTENSIONS and p.is_file():
                paths.append(p)
    return paths


def _expand(paths: List[str]) -> List[Path]:
    out: List[Path] = []
    for raw in paths:
        p = Path(raw)
        if p.is_dir():
            for ext in EXTENSIONS:
                out.extend(p.rglob(f"*{ext}"))
        elif p.suffix in EXTENSIONS and p.is_file():
            out.append(p)
    skip = {"node_modules", "dist", "__pycache__", ".venv", "venv", "build"}
    return [p for p in out if not (skip & set(p.parts))]


def cmd_checklist() -> int:
    for rule, title, why in CHECKLIST:
        print(f"{rule}\t{title}")
        print(f"\t{why}")
    return 0


def cmd_scan(argv: List[str]) -> int:
    base: Optional[str] = None
    paths: List[str] = []
    it = iter(argv)
    for arg in it:
        if arg == "--base":
            base = next(it, None)
        elif arg.startswith("--base="):
            base = arg.split("=", 1)[1]
        else:
            paths.append(arg)

    targets = sorted(set(_expand(paths) if paths else _changed_files(base)))
    if not targets:
        print("parse-dont-validate: no TypeScript/Python files to scan.")
        return 0

    py = [p for p in targets if p.suffix in PY_EXTENSIONS]
    tsx = [p for p in targets if p.suffix in TS_EXTENSIONS]

    try:
        findings = _scan_python(py)
        if tsx:
            findings += _scan_typescript(tsx)
    except ScanError as e:
        print(f"parse-dont-validate: {e}", file=sys.stderr)
        return 3

    if not findings:
        print(f"parse-dont-validate: clean — scanned {len(targets)} file(s), "
              f"no anti-patterns.")
        return 0

    titles = {r: t for r, t, _ in CHECKLIST}
    findings.sort(key=lambda f: (f.path, f.line, f.rule))
    for f in findings:
        print(f"{f.path}:{f.line}: {f.rule} {titles.get(f.rule, '')}")
        print(f"    {f.text}")
    print()
    print(f"parse-dont-validate: {len(findings)} finding(s). Fix each, or waive "
          f"at the parser boundary with a `parse-dont-validate: allow PDVxxx` "
          f"comment.")
    return 1


def main(argv: List[str]) -> int:
    if not argv:
        print(__doc__)
        return 2
    cmd, rest = argv[0], argv[1:]
    if cmd == "checklist":
        return cmd_checklist()
    if cmd == "scan":
        return cmd_scan(rest)
    print(f"unknown command: {cmd!r} (expected 'checklist' or 'scan')",
          file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
