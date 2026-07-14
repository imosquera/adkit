#!/usr/bin/env python3
"""Decode Claude Code's `--output-format stream-json` into compact, human-readable
log lines, flushing each so `tail -f` shows a live pass.

Read from STDIN (the pipe from `claude`), never from a heredoc — invoke as
`claude … --output-format stream-json --verbose | python3 stream-decode.py`.

The stream is one JSON object per line. We surface the parts a human watching a log
cares about — assistant text, tool calls, tool results (truncated), and the final
result — and pass through anything unrecognized (incl. stderr noise) verbatim so
nothing is silently lost.
"""
import json
import sys
from datetime import datetime

MAX = 220  # truncate long blobs so the log stays scannable
INDENT = " " * 20  # continuation/detail lines align under the message column


def clip(s, limit=MAX):
    s = " ".join(str(s).split())  # collapse whitespace/newlines to one line
    return s if len(s) <= limit else s[:limit] + " …"


def emit(icon, label, text, cont=False):
    """One pretty line: `HH:MM:SS  <icon> LABEL  text`. `cont=True` indents a
    detail line under the previous message instead of re-stamping it."""
    if cont:
        print(f"{INDENT}{icon} {text}", flush=True)
    else:
        ts = datetime.now().strftime("%H:%M:%S")
        print(f"{ts}  {icon} {label:<7} {text}", flush=True)


def handle(obj):
    typ = obj.get("type")

    if typ == "system":
        if obj.get("subtype") == "init":
            model = obj.get("model", "?")
            n = len(obj.get("tools", []) or [])
            emit("⚙", "init", f"model={model} · {n} tools")
        return

    if typ in ("assistant", "user"):
        msg = obj.get("message", {}) or {}
        content = msg.get("content")
        if isinstance(content, str):
            if content.strip():
                emit("💬", "claude", clip(content))
            return
        for b in content or []:
            bt = b.get("type")
            if bt == "text":
                if b.get("text", "").strip():
                    emit("💬", "claude", clip(b["text"]))
            elif bt == "tool_use":
                name = b.get("name", "?")
                emit("🔧", "tool", f"{name}  {clip(json.dumps(b.get('input', {})), 140)}")
            elif bt == "tool_result":
                r = b.get("content")
                if isinstance(r, list):
                    r = "".join(x.get("text", "") for x in r if isinstance(x, dict))
                if str(r).strip():
                    emit("↳", "", clip(r, 160), cont=True)
        return

    if typ == "result":
        dur = obj.get("duration_ms")
        cost = obj.get("total_cost_usd")
        sub = obj.get("subtype", "")
        meta = []
        if dur is not None:
            meta.append(f"{dur/1000:.1f}s")
        if cost is not None:
            meta.append(f"${cost:.4f}")
        suffix = f" ({' · '.join(meta)})" if meta else ""
        emit("✅", "done", f"{sub}{suffix}".strip())
        if obj.get("result"):
            emit("→", "", clip(obj["result"]), cont=True)
        return


def main():
    for line in sys.stdin:
        line = line.rstrip("\n")
        if not line.strip():
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            print(line, flush=True)  # non-JSON (e.g. stderr) — pass through
            continue
        try:
            handle(obj)
        except Exception as e:  # never let a decode bug drop the pass's output
            print(f"[stream-decode: {e}] {clip(line)}", flush=True)


if __name__ == "__main__":
    main()
