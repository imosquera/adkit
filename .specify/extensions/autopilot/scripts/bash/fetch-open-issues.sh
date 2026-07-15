#!/usr/bin/env bash
#
# Fetch the open-issue backlog to a FILE, oldest-first, for preflight-issues.py
# to read. This is deliberately a standalone script rather than an inline
# `gh issue list | python3 - <<'PY' ...` one-liner in the skill body: piping
# `gh`'s JSON into a script whose stdin is also bound to a heredoc silently
# loses the data (`python3 -` reads its *program* from stdin, and the heredoc
# redirect wins over the pipe), which always fails with
# `JSONDecodeError: Expecting value: line 1 column 1 (char 0)`. Landing the
# data in a file first sidesteps that trap entirely — the reader script takes
# a file path, not stdin.
#
# Usage: fetch-open-issues.sh <output-file>

set -uo pipefail

OUT="${1:?usage: fetch-open-issues.sh <output-file>}"

gh issue list --state open --limit 200 \
  --json number,title,labels,createdAt,assignees,body \
  --jq 'sort_by(.createdAt)' > "$OUT" \
  || { echo "gh issue list failed — run 'gh auth status' and confirm a GitHub remote" >&2; exit 1; }

[ -s "$OUT" ] || { echo "gh returned no data — treat as a failure, not an empty backlog" >&2; exit 1; }
