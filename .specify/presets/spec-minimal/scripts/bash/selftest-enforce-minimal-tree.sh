#!/usr/bin/env bash
# spec-minimal preset: selftest-enforce-minimal-tree.sh
# Self-contained test for enforce-minimal-tree.sh. No test framework required.
#
# Every case asserts the real postcondition: exit code AND on-disk state AND
# plan.md content — never the exit code alone. This script deletes files for a
# living, so "it exited 0" is not evidence of anything.
#
# Usage: ./presets/spec-minimal/scripts/bash/selftest-enforce-minimal-tree.sh

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENFORCE="$HERE/enforce-minimal-tree.sh"

if [[ ! -x "$ENFORCE" ]]; then
    echo "error: not executable: $ENFORCE" >&2
    exit 2
fi

WORK="$(mktemp -d)"
# Cases deliberately create unreadable/unwritable dirs; loosen before deleting.
cleanup() { chmod -R u+rwx "$WORK" 2>/dev/null; rm -rf "$WORK"; }
trap cleanup EXIT

FAILURES=0
CASE=""

start() { CASE="$1"; }
pass() { echo "PASS: $CASE"; }
fail() { echo "FAIL: $CASE — $1"; FAILURES=$((FAILURES + 1)); }

# Sentinels, spelled once. Built by concatenation so that this test file itself
# never contains a literal sentinel that could confuse a future grep.
b_sent() { printf '<!-- BEGIN: spec-minimal inlined %s -->' "$1"; }
e_sent() { printf '<!-- END: spec-minimal inlined %s -->' "$1"; }

# count <pattern> <file>  (fixed-string, byte-oriented)
count() { LC_ALL=C grep -c -F -- "$1" "$2" 2>/dev/null || true; }
has() { LC_ALL=C grep -q -F -- "$1" "$2" 2>/dev/null; }

# Make a fresh feature dir with the baseline allowed files.
mkfeature() {
    local dir="$WORK/$1"
    chmod -R u+rwx "$dir" 2>/dev/null
    rm -rf "$dir"
    mkdir -p "$dir"
    printf '# Spec\n\nsome spec\n' > "$dir/spec.md"
    printf '# Plan\n\nsome plan\n' > "$dir/plan.md"
    printf '# Tasks\n\n- T001\n' > "$dir/tasks.md"
    echo "$dir"
}

# run <dir> -> sets RC, OUT, ERR
run() {
    OUT="$("$ENFORCE" "$1" 2>"$WORK/.stderr")"
    RC=$?
    ERR="$(cat "$WORK/.stderr")"
}

# run_env <VAR=VAL> <dir> -> sets RC, OUT, ERR
run_env() {
    OUT="$(env "$1" "$ENFORCE" "$2" 2>"$WORK/.stderr")"
    RC=$?
    ERR="$(cat "$WORK/.stderr")"
}

# ---------------------------------------------------------------- case 1
start "clean tree => exit 0, nothing changed, stderr empty"
d="$(mkfeature clean)"
before="$(cd "$d" && ls -A | sort)"
plan_before="$(cat "$d/plan.md")"
run "$d"
if [[ $RC -ne 0 ]]; then
    fail "expected exit 0, got $RC ($ERR)"
elif [[ "$(cd "$d" && ls -A | sort)" != "$before" ]]; then
    fail "tree changed"
elif [[ "$(cat "$d/plan.md")" != "$plan_before" ]]; then
    fail "plan.md changed"
elif [[ -n "$ERR" ]]; then
    fail "expected empty stderr, got: $ERR"
elif [[ "$OUT" != ok:* ]]; then
    fail "expected an 'ok:' line, got: $OUT"
else
    pass
fi

# ---------------------------------------------------------------- case 2
start "data-model.md with content => inlined + removed"
d="$(mkfeature data-model)"
printf '# Data Model\n\nWe picked sqlite because it is boring.\n' > "$d/data-model.md"
run "$d"
if [[ $RC -ne 0 ]]; then
    fail "expected exit 0, got $RC ($ERR)"
elif [[ -e "$d/data-model.md" ]]; then
    fail "data-model.md still on disk"
elif ! has "$(b_sent data-model.md)" "$d/plan.md"; then
    fail "BEGIN sentinel missing from plan.md"
elif ! has "$(e_sent data-model.md)" "$d/plan.md"; then
    fail "END sentinel missing from plan.md"
elif ! has '## Inlined from data-model.md' "$d/plan.md"; then
    fail "heading missing from plan.md"
elif ! has 'boring' "$d/plan.md"; then
    fail "data-model content missing from plan.md"
elif ! has 'some plan' "$d/plan.md"; then
    fail "original plan.md content lost"
else
    pass
fi

# ---------------------------------------------------------------- case 3
start "contracts/ dir with two nested files => both inlined with ### headings"
d="$(mkfeature contracts)"
mkdir -p "$d/contracts/api"
printf 'openapi: 3.0.0\n' > "$d/contracts/api/openapi.yml"
printf '{"kind": "event"}\n' > "$d/contracts/events.json"
run "$d"
if [[ $RC -ne 0 ]]; then
    fail "expected exit 0, got $RC ($ERR)"
elif [[ -e "$d/contracts" ]]; then
    fail "contracts/ still on disk"
elif ! has '### api/openapi.yml' "$d/plan.md"; then
    fail "'### api/openapi.yml' heading missing"
elif ! has '### events.json' "$d/plan.md"; then
    fail "'### events.json' heading missing"
elif ! has 'openapi: 3.0.0' "$d/plan.md"; then
    fail "openapi.yml content missing"
elif ! has '"kind": "event"' "$d/plan.md"; then
    fail "events.json content missing"
else
    pass
fi

# ---------------------------------------------------------------- case 4
start "idempotence: re-running over the same artifact is byte-identical"
d="$(mkfeature idempotent)"
printf '# Data Model\n\nround one\n' > "$d/data-model.md"
run "$d"
first="$(cat "$d/plan.md")"
# Recreate the same artifact and heal again — the block must be replaced,
# not duplicated, and plan.md must come out byte-identical.
printf '# Data Model\n\nround one\n' > "$d/data-model.md"
run "$d"
second="$(cat "$d/plan.md")"
n="$(count "$(b_sent data-model.md)" "$d/plan.md")"
if [[ $RC -ne 0 ]]; then
    fail "expected exit 0, got $RC ($ERR)"
elif [[ "$first" != "$second" ]]; then
    fail "plan.md differs between runs"
elif [[ "$n" -ne 1 ]]; then
    fail "expected exactly 1 sentinel block, found $n"
else
    pass
fi

# ---------------------------------------------------------------- case 5
start "unknown entry => exit 0, warning on stderr, entry kept"
d="$(mkfeature unknown)"
mkdir -p "$d/checklists"
printf '%s\n' '- [ ] item' > "$d/checklists/ux.md"
run "$d"
if [[ $RC -ne 0 ]]; then
    fail "expected exit 0, got $RC ($ERR)"
elif [[ ! -d "$d/checklists" ]]; then
    fail "checklists/ was removed"
elif [[ "$ERR" != *"warning:"*"checklists"* ]]; then
    fail "expected a warning about checklists on stderr, got: $ERR"
else
    pass
fi

# ---------------------------------------------------------------- case 6
start "forbidden artifact + missing plan.md => plan.md created, artifact rehomed, exit 0"
d="$(mkfeature noplan)"
rm -f "$d/plan.md"
printf '# Data Model\n\nirreplaceable\n' > "$d/data-model.md"
run "$d"
if [[ $RC -ne 0 ]]; then
    fail "expected exit 0, got $RC ($ERR)"
elif [[ ! -f "$d/plan.md" ]]; then
    fail "plan.md was not created"
elif [[ -e "$d/data-model.md" ]]; then
    fail "data-model.md still on disk (acceptance: never left behind)"
elif ! has 'irreplaceable' "$d/plan.md"; then
    fail "data-model content was not rehomed into the new plan.md"
elif ! has '# Implementation Plan' "$d/plan.md"; then
    fail "created plan.md is missing its header"
elif [[ "$OUT" != *created:*plan.md* ]]; then
    fail "expected a 'created:' line for plan.md, got: $OUT"
else
    pass
fi

# ---------------------------------------------------------------- case 7
start "missing arg => exit 2"
OUT="$("$ENFORCE" 2>"$WORK/.stderr")"; RC=$?
ERR="$(cat "$WORK/.stderr")"
if [[ $RC -ne 2 ]]; then
    fail "expected exit 2, got $RC"
elif [[ "$ERR" != error:* ]]; then
    fail "expected an 'error:' line on stderr, got: $ERR"
else
    pass
fi

# ---------------------------------------------------------------- case 8
start "empty forbidden artifact => removed, no empty section appended"
d="$(mkfeature empty)"
: > "$d/data-model.md"
run "$d"
if [[ $RC -ne 0 ]]; then
    fail "expected exit 0, got $RC ($ERR)"
elif [[ -e "$d/data-model.md" ]]; then
    fail "data-model.md still on disk"
elif has 'spec-minimal inlined data-model.md' "$d/plan.md"; then
    fail "an empty sentinel block was appended"
elif [[ "$OUT" != *removed:*data-model.md* ]]; then
    fail "expected a 'removed:' line for data-model.md, got: $OUT"
else
    pass
fi

# ---------------------------------------------------------------- case 9
start "paths with spaces are handled"
d="$(mkfeature 'feature with spaces')"
mkdir -p "$d/contracts/sub dir"
printf 'spaced contract\n' > "$d/contracts/sub dir/a file.yml"
run "$d"
if [[ $RC -ne 0 ]]; then
    fail "expected exit 0, got $RC ($ERR)"
elif [[ -e "$d/contracts" ]]; then
    fail "contracts/ still on disk"
elif ! has '### sub dir/a file.yml' "$d/plan.md"; then
    fail "'### sub dir/a file.yml' heading missing"
elif ! has 'spaced contract' "$d/plan.md"; then
    fail "content missing"
else
    pass
fi

# ---------------------------------------------------------------- case 10 (C2a)
start "C2a: inlined content quoting a foreign BEGIN sentinel must not truncate plan.md"
d="$(mkfeature sentinel-truncate)"
mk_c2a() {
    {
        printf '# Data Model\n\nQuoting a sentinel, as this preset README does:\n\n'
        b_sent contracts; printf '\n\nDMTAIL\n'
    } > "$d/data-model.md"
    mkdir -p "$d/contracts"
    printf 'openapi: 3.0.0\n' > "$d/contracts/api.yml"
}
mk_c2a; run "$d"
mk_c2a; run "$d"
if [[ $RC -ne 0 ]]; then
    fail "expected exit 0, got $RC ($ERR)"
elif [[ -e "$d/data-model.md" || -e "$d/contracts" ]]; then
    fail "forbidden artifact left on disk"
elif ! has 'DMTAIL' "$d/plan.md"; then
    fail "data-model block was truncated — DMTAIL lost"
elif ! has 'openapi' "$d/plan.md"; then
    fail "contracts content lost"
elif ! has 'some plan' "$d/plan.md"; then
    fail "original plan.md content lost"
elif [[ "$(count "$(b_sent data-model.md)" "$d/plan.md")" -ne 1 ]]; then
    fail "expected exactly 1 data-model.md BEGIN, found $(count "$(b_sent data-model.md)" "$d/plan.md")"
elif [[ "$(count "$(e_sent data-model.md)" "$d/plan.md")" -ne 1 ]]; then
    fail "expected exactly 1 data-model.md END"
elif [[ "$(count "$(b_sent contracts)" "$d/plan.md")" -ne 1 ]]; then
    fail "expected exactly 1 contracts BEGIN, found $(count "$(b_sent contracts)" "$d/plan.md")"
elif [[ "$(count "$(e_sent contracts)" "$d/plan.md")" -ne 1 ]]; then
    fail "expected exactly 1 contracts END"
else
    pass
fi

# ---------------------------------------------------------------- case 11 (C2b)
start "C2b: inlined content quoting its own END sentinel must not grow plan.md"
d="$(mkfeature sentinel-growth)"
mk_c2b() {
    {
        printf '# Data Model\n\nbefore\n\n'
        e_sent data-model.md; printf '\n\nafter\n'
    } > "$d/data-model.md"
}
mk_c2b; run "$d"; r1="$(cat "$d/plan.md")"
mk_c2b; run "$d"; r2="$(cat "$d/plan.md")"
mk_c2b; run "$d"; r3="$(cat "$d/plan.md")"
if [[ $RC -ne 0 ]]; then
    fail "expected exit 0, got $RC ($ERR)"
elif [[ "$r1" != "$r2" || "$r2" != "$r3" ]]; then
    fail "plan.md is not idempotent across runs (grew or shrank)"
elif [[ "$(count "$(b_sent data-model.md)" "$d/plan.md")" -ne 1 ]]; then
    fail "expected exactly 1 BEGIN, found $(count "$(b_sent data-model.md)" "$d/plan.md")"
elif [[ "$(count "$(e_sent data-model.md)" "$d/plan.md")" -ne 1 ]]; then
    fail "expected exactly 1 END, found $(count "$(e_sent data-model.md)" "$d/plan.md")"
elif ! has 'after' "$d/plan.md"; then
    fail "content after the quoted sentinel was lost"
elif ! has 'some plan' "$d/plan.md"; then
    fail "original plan.md content lost"
else
    pass
fi

# ---------------------------------------------------------------- case 12 (C3)
start "C3: orphan BEGIN in plan.md => exit 1, nothing written, nothing removed"
d="$(mkfeature orphan-begin)"
{
    printf '# Plan\n\nsome plan\n\n'
    b_sent data-model.md; printf '\n\nKEEPME\n'
} > "$d/plan.md"
printf '# Data Model\n\nnew round\n' > "$d/data-model.md"
plan_before="$(cat "$d/plan.md")"
dm_before="$(cat "$d/data-model.md")"
run "$d"
if [[ $RC -ne 1 ]]; then
    fail "expected exit 1, got $RC"
elif [[ ! -f "$d/data-model.md" ]]; then
    fail "data-model.md was removed despite the hard error"
elif [[ "$(cat "$d/data-model.md")" != "$dm_before" ]]; then
    fail "data-model.md was modified"
elif [[ "$(cat "$d/plan.md")" != "$plan_before" ]]; then
    fail "plan.md was modified despite the hard error (KEEPME at risk)"
elif [[ "$ERR" != *unbalanced* ]]; then
    fail "expected stderr to say 'unbalanced', got: $ERR"
elif [[ "$ERR" != *"never closed"* ]]; then
    fail "expected stderr to name the unclosed sentinel, got: $ERR"
elif [[ "$ERR" != *line* ]]; then
    fail "expected stderr to give a line number, got: $ERR"
else
    pass
fi

# ---------------------------------------------------------------- case 13 (C1a)
start "C1a: read-only plan.md => healed atomically, content never lost, mode preserved"
d="$(mkfeature readonly-plan)"
printf '# Data Model\n\nWe picked sqlite because it is boring.\n' > "$d/data-model.md"
chmod 444 "$d/plan.md"
run "$d"
mode="$(ls -l "$d/plan.md" | cut -c1-10)"
chmod 644 "$d/plan.md"
if [[ $RC -ne 0 ]]; then
    fail "expected exit 0, got $RC ($ERR)"
elif [[ -e "$d/data-model.md" ]]; then
    fail "data-model.md removed without its content being written"
elif ! has 'boring' "$d/plan.md"; then
    fail "data-model content was NOT written to plan.md (data loss)"
elif ! has 'some plan' "$d/plan.md"; then
    fail "original plan.md content lost"
elif [[ "$mode" != "-r--r--r--" ]]; then
    fail "plan.md permission bits not preserved, got: $mode"
else
    pass
fi

# ---------------------------------------------------------------- case 14 (C1b)
start "C1b: non-UTF-8 locale with non-latin1 content => still healed losslessly"
d="$(mkfeature nonutf8-locale)"
printf '# Data Model\n\nJAPANESEMARKER \345\244\251\346\260\227 caf\303\251\n' > "$d/data-model.md"
run_env "LC_ALL=en_US.ISO8859-1" "$d"
if [[ $RC -ne 0 ]]; then
    fail "expected exit 0, got $RC ($ERR)"
elif [[ -e "$d/data-model.md" ]]; then
    fail "data-model.md removed but plan.md write failed"
elif [[ ! -s "$d/plan.md" ]]; then
    fail "plan.md was truncated to 0 bytes"
elif ! has 'JAPANESEMARKER' "$d/plan.md"; then
    fail "data-model content missing from plan.md"
elif ! LC_ALL=C grep -q -F -- "$(printf '\345\244\251\346\260\227')" "$d/plan.md"; then
    fail "non-latin1 bytes were mangled or dropped"
elif ! has 'some plan' "$d/plan.md"; then
    fail "original plan.md content lost"
else
    pass
fi

# ---------------------------------------------------------------- case 15 (M1)
start "M1: one artifact removable, one not => exit 1, content safe, state reported exactly"
d="$(mkfeature partial-removal)"
printf '# Data Model\n\nDMBODY\n' > "$d/data-model.md"
mkdir -p "$d/contracts/locked"
printf 'LOCKEDCONTRACT\n' > "$d/contracts/locked/api.yml"
chmod 500 "$d/contracts/locked"
run "$d"
chmod 700 "$d/contracts/locked" 2>/dev/null
if [[ $RC -ne 1 ]]; then
    fail "expected exit 1, got $RC ($OUT)"
elif [[ -e "$d/data-model.md" ]]; then
    fail "data-model.md should have been removed (its removal succeeds)"
elif [[ ! -d "$d/contracts" ]]; then
    fail "contracts/ should still be on disk (its removal fails)"
elif ! has 'DMBODY' "$d/plan.md"; then
    fail "data-model content not inlined before removal"
elif ! has 'LOCKEDCONTRACT' "$d/plan.md"; then
    fail "contracts content not inlined — it is about to be reported as unremovable"
elif ! has 'some plan' "$d/plan.md"; then
    fail "original plan.md content lost"
elif [[ "$ERR" != *"PARTIALLY HEALED"* ]]; then
    fail "expected stderr to say PARTIALLY HEALED, got: $ERR"
elif [[ "$ERR" != *contracts* ]]; then
    fail "expected stderr to name contracts, got: $ERR"
elif [[ "$ERR" == *"HEALING IMPOSSIBLE"* ]]; then
    fail "stderr wrongly claims nothing was written"
else
    pass
fi

# ---------------------------------------------------------------- case 16 (M2)
start "M2: dangling data-model.md symlink => detected and removed, not reported clean"
d="$(mkfeature dangling-symlink)"
ln -s "$WORK/does-not-exist-ever" "$d/data-model.md"
run "$d"
if [[ $RC -ne 0 ]]; then
    fail "expected exit 0, got $RC ($ERR)"
elif [[ -L "$d/data-model.md" ]]; then
    fail "dangling data-model.md symlink left on disk"
elif [[ "$OUT" != *symlink:*data-model.md* ]]; then
    fail "expected a 'symlink:' line for data-model.md, got: $OUT"
elif [[ "$OUT" != *removed:*data-model.md* ]]; then
    fail "expected a 'removed:' line for data-model.md, got: $OUT"
elif [[ "$ERR" == *"unknown top-level entry"*data-model.md* ]]; then
    fail "data-model.md was misreported as an unknown entry: $ERR"
else
    pass
fi

# ---------------------------------------------------------------- case 17 (M3)
start "M3: contracts symlink to a dir => link removed, target intact, reported truthfully"
d="$(mkfeature contracts-symlink)"
target="$WORK/contracts-target"
rm -rf "$target"; mkdir -p "$target"
printf 'TARGETCONTRACT\n' > "$target/api.yml"
ln -s "$target" "$d/contracts"
run "$d"
if [[ $RC -ne 0 ]]; then
    fail "expected exit 0, got $RC ($ERR)"
elif [[ -L "$d/contracts" || -e "$d/contracts" ]]; then
    fail "contracts symlink left on disk"
elif [[ ! -f "$target/api.yml" ]]; then
    fail "symlink target was destroyed"
elif [[ "$(cat "$target/api.yml")" != "TARGETCONTRACT" ]]; then
    fail "symlink target content was modified"
elif [[ "$OUT" != *symlink:*contracts* ]]; then
    fail "expected a truthful 'symlink:' line, got: $OUT"
elif [[ "$OUT" == *empty:*contracts* ]]; then
    fail "contracts was falsely reported as empty, got: $OUT"
elif [[ "$ERR" == *undecodable* ]]; then
    fail "spurious 'undecodable file' warning, got: $ERR"
else
    pass
fi

# ---------------------------------------------------------------- case 18 (L1)
start "L1: unreadable feature dir => clean exit 1, no traceback, nothing removed"
d="$(mkfeature unreadable-dir)"
printf '# Data Model\n\nSTILLHERE\n' > "$d/data-model.md"
chmod 300 "$d"
run "$d"
chmod 700 "$d"
if [[ $RC -ne 1 ]]; then
    fail "expected exit 1, got $RC ($OUT)"
elif [[ "$ERR" == *Traceback* ]]; then
    fail "raw traceback leaked to stderr: $ERR"
elif [[ "$ERR" != FAIL:* ]]; then
    fail "expected a 'FAIL:' line on stderr, got: $ERR"
elif [[ "$ERR" != *"HEALING IMPOSSIBLE"* ]]; then
    fail "expected stderr to state HEALING IMPOSSIBLE, got: $ERR"
elif [[ ! -f "$d/data-model.md" ]]; then
    fail "data-model.md was removed"
elif ! has 'STILLHERE' "$d/data-model.md"; then
    fail "data-model.md content changed"
else
    pass
fi

# ---------------------------------------------------------------- case 18b
start "research.md is ALLOWED => kept untouched, no warning"
d="$(mkfeature research-allowed)"
printf '# Research\n\nLIBFINDINGS\n' > "$d/research.md"
plan_before="$(cat "$d/plan.md")"
run "$d"
if [[ $RC -ne 0 ]]; then
    fail "expected exit 0, got $RC ($ERR)"
elif [[ ! -f "$d/research.md" ]]; then
    fail "research.md was removed — it is in the allowed set"
elif ! has 'LIBFINDINGS' "$d/research.md"; then
    fail "research.md content changed"
elif [[ "$(cat "$d/plan.md")" != "$plan_before" ]]; then
    fail "plan.md changed — research.md must not be inlined"
elif [[ "$ERR" == *warning:*research.md* ]]; then
    fail "research.md was warned about as unknown, got: $ERR"
else
    pass
fi

# ---------------------------------------------------------------- case 19 (L2)
start "L2: dotfiles are ignored, not warned about"
d="$(mkfeature dotfiles)"
printf 'junk' > "$d/.DS_Store"
run "$d"
if [[ $RC -ne 0 ]]; then
    fail "expected exit 0, got $RC ($ERR)"
elif [[ -n "$ERR" ]]; then
    fail "expected empty stderr, got: $ERR"
elif [[ ! -f "$d/.DS_Store" ]]; then
    fail ".DS_Store was removed"
else
    pass
fi

# ---------------------------------------------------------------- case 20 (L3)
start "L3: pre-existing duplicate blocks for one name converge to a single block"
d="$(mkfeature duplicate-blocks)"
{
    printf '# Plan\n\nsome plan\n\n'
    b_sent data-model.md; printf '\n## Inlined from data-model.md\n\nSTALEONE\n'
    e_sent data-model.md; printf '\n\n'
    b_sent data-model.md; printf '\n## Inlined from data-model.md\n\nSTALETWO\n'
    e_sent data-model.md; printf '\n\nPLANTAIL\n'
} > "$d/plan.md"
printf '# Data Model\n\nFRESHCONTENT\n' > "$d/data-model.md"
run "$d"
n_begin="$(count "$(b_sent data-model.md)" "$d/plan.md")"
n_end="$(count "$(e_sent data-model.md)" "$d/plan.md")"
if [[ $RC -ne 0 ]]; then
    fail "expected exit 0, got $RC ($ERR)"
elif [[ -e "$d/data-model.md" ]]; then
    fail "data-model.md still on disk"
elif [[ "$n_begin" -ne 1 ]]; then
    fail "expected exactly 1 BEGIN after healing, found $n_begin"
elif [[ "$n_end" -ne 1 ]]; then
    fail "expected exactly 1 END after healing, found $n_end"
elif has 'STALEONE' "$d/plan.md"; then
    fail "stale block 1 survived"
elif has 'STALETWO' "$d/plan.md"; then
    fail "stale duplicate block 2 survived"
elif ! has 'FRESHCONTENT' "$d/plan.md"; then
    fail "fresh content missing"
elif ! has 'PLANTAIL' "$d/plan.md"; then
    fail "content after the duplicate blocks was lost"
elif ! has 'some plan' "$d/plan.md"; then
    fail "original plan.md content lost"
else
    pass
fi

# ---------------------------------------------------------------- case 21
start "C1b: report text itself must be encodable in a non-UTF-8 locale"
d="$(mkfeature nonutf8-report)"
: > "$d/data-model.md"
mkdir -p "$d/checklists"
run_env "LC_ALL=en_US.ISO8859-1" "$d"
if [[ $RC -ne 0 ]]; then
    fail "expected exit 0, got $RC ($ERR)"
elif [[ -e "$d/data-model.md" ]]; then
    fail "data-model.md still on disk"
elif [[ "$OUT" != *empty:*data-model.md* ]]; then
    fail "expected the 'empty:' report line to survive the locale, got: $OUT"
elif [[ "$OUT" != *removed:*data-model.md* ]]; then
    fail "expected a 'removed:' line, got: $OUT"
elif [[ "$ERR" == *Error* ]]; then
    fail "reporting raised under a non-UTF-8 locale: $ERR"
else
    pass
fi

echo ""
if [[ $FAILURES -eq 0 ]]; then
    echo "all cases passed"
    exit 0
fi
echo "$FAILURES case(s) failed"
exit 1
