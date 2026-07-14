#!/usr/bin/env bash
# spec-minimal preset: strip-spec-sections.sh
# Remove the Assumptions, Key Entities, and Success Criteria sections from a
# spec.md, in place. Idempotent — safe to run repeatedly.
#
# Section boundary rule: a section starts at its heading line and ends at the
# next heading of the same-or-shallower level, or EOF.
#
# Usage: strip-spec-sections.sh <spec.md>

set -e

SPEC="${1:-}"
if [[ -z "$SPEC" ]]; then
    echo "error: spec.md path required" >&2
    exit 2
fi
if [[ ! -f "$SPEC" ]]; then
    echo "error: not a file: $SPEC" >&2
    exit 2
fi

python3 - "$SPEC" <<'PY'
import re, sys, pathlib

path = pathlib.Path(sys.argv[1])
text = path.read_text()
lines = text.splitlines(keepends=True)

# (heading_level, heading_text_regex)
TARGETS = [
    (2, re.compile(r'^##\s+Assumptions\s*$')),
    (3, re.compile(r'^###\s+Key Entities\s*$')),
    (2, re.compile(r'^##\s+Success Criteria\s*$')),
]

def heading_level(line):
    m = re.match(r'^(#{1,6})\s+\S', line)
    return len(m.group(1)) if m else None

out = []
i = 0
while i < len(lines):
    line = lines[i]
    matched = False
    for level, pat in TARGETS:
        if pat.match(line):
            # skip from here until next heading of <= level
            j = i + 1
            while j < len(lines):
                lvl = heading_level(lines[j])
                if lvl is not None and lvl <= level:
                    break
                j += 1
            i = j
            matched = True
            break
    if not matched:
        out.append(line)
        i += 1

path.write_text(''.join(out))
PY

echo "ok: stripped Assumptions / Key Entities / Success Criteria from $SPEC"
