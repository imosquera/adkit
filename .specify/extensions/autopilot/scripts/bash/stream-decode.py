#!/usr/bin/env python3
"""Decode Claude Code's `--output-format stream-json` into compact, human-readable
log lines, flushing each so `tail -f` shows a live pass.

Read from STDIN (the pipe from `claude`), never from a heredoc — invoke as
`claude … --output-format stream-json --verbose | python3 stream-decode.py`.

The stream is one JSON object per line. We surface the parts a human watching a log
cares about — assistant text, tool calls, tool results (truncated), subagent
start/finish, and the final result — and pass through anything unrecognized (incl.
stderr noise) verbatim so nothing is silently lost.

Two properties the log depends on, both of which read straight off the stream:

  * Honest timestamps. Every `assistant`/`user` event carries its own `timestamp`;
    we stamp the line with THAT, not with the wall clock at decode time. Events
    arrive in buffered bursts, so `datetime.now()` collapsed a batch of turns
    minutes apart onto one second and printed them in an order that implied a
    history that never happened (the oldest statement printed last). Only events
    that genuinely lack a timestamp (`result`, some `system` frames) fall back to
    now(), and those are stamped `~HH:MM:SS` so a reader can tell.

  * Attribution. Once a pass fans out to subagents, interleaved lines are
    meaningless without knowing who spoke. `parent_tool_use_id` names the Task
    tool call that owns each line (null = the main session, which gets no tag);
    `system/task_started` gives us `subagent_type`/`description` for that same id,
    so lines read `[review-tests]` rather than `[sub:a1b2c3]`.
"""
import json
import re
import sys
from datetime import datetime

MAX = 220  # truncate long blobs so the log stays scannable
INDENT = " " * 20  # continuation/detail lines align under the message column

# tool_use_id -> attribution, learned from task_started / subagent-tagged events.
_subtypes = {}  # tool_use_id -> subagent_type   (authoritative)
_descs = {}     # tool_use_id -> slugged description (fallback)
_task_ids = {}  # task_id -> tool_use_id (task_notification may carry only task_id)
_aliased = set()  # ids whose desc-derived tag we already reconciled with its type


def clip(s, limit=MAX):
    s = " ".join(str(s).split())  # collapse whitespace/newlines to one line
    return s if len(s) <= limit else s[:limit] + " …"


def slug(s, limit=18):
    s = re.sub(r"[^a-z0-9]+", "-", str(s).lower()).strip("-")
    return s[:limit].rstrip("-")


def remember(tool_use_id, subagent_type=None, description=None):
    """Record what we know about a subagent's owning tool call. Called from
    task_started and from any child event that names its own subagent_type."""
    if not tool_use_id:
        return
    if subagent_type:
        new = slug(subagent_type)
        old = _descs.get(tool_use_id)
        # task_started only carries a description, so the first lines for a
        # subagent may be tagged with its slugged description and later ones with
        # its type. Say so once, rather than leaving two tags for one agent.
        if old and old != new and tool_use_id not in _aliased:
            _aliased.add(tool_use_id)
            emit("≡", "", f"= [{old}]", cont=True, tag=new)
        _subtypes[tool_use_id] = new
    if description and tool_use_id not in _descs:
        d = slug(description)
        if d:
            _descs[tool_use_id] = d


def label_for(tool_use_id):
    """Short, stable tag for a subagent. None for the main session."""
    if not tool_use_id:
        return None
    return (
        _subtypes.get(tool_use_id)
        or _descs.get(tool_use_id)
        or "sub:" + str(tool_use_id)[-6:]
    )


def stamp(raw):
    """`HH:MM:SS` from the event's own timestamp; `~HH:MM:SS` (decode time) when
    the event has none, so an inferred time is never mistaken for a real one."""
    if raw is not None:
        try:
            if isinstance(raw, (int, float)):
                # epoch seconds or milliseconds
                secs = raw / 1000.0 if raw > 1e11 else float(raw)
                return datetime.fromtimestamp(secs).strftime("%H:%M:%S")
            dt = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
            if dt.tzinfo is not None:
                dt = dt.astimezone()  # render in the log's local timezone
            return dt.strftime("%H:%M:%S")
        except (ValueError, OSError, OverflowError):
            pass
    return "~" + datetime.now().strftime("%H:%M:%S")


def emit(icon, label, text, cont=False, when=None, tag=None):
    """One pretty line: `HH:MM:SS  <icon> LABEL  [tag] text`. `cont=True` indents a
    detail line under the previous message instead of re-stamping it. The tag is
    repeated on continuation lines because subagent output interleaves — the line
    above may belong to someone else."""
    prefix = f"[{tag}] " if tag else ""
    if cont:
        print(f"{INDENT}{icon} {prefix}{text}", flush=True)
    else:
        print(f"{stamp(when)}  {icon} {label:<7} {prefix}{text}", flush=True)


def handle(obj):
    typ = obj.get("type")
    when = obj.get("timestamp")

    if typ == "system":
        sub = obj.get("subtype")
        if sub == "init":
            model = obj.get("model", "?")
            n = len(obj.get("tools", []) or [])
            emit("⚙", "init", f"model={model} · {n} tools", when=when)
        elif sub == "task_started":
            tuid = obj.get("tool_use_id")
            tid = obj.get("task_id")
            if tid and tuid:
                _task_ids[tid] = tuid
            remember(tuid, obj.get("subagent_type"), obj.get("description"))
            desc = clip(obj.get("description") or "(no description)")
            emit("▶", "task", f"started · {desc}", when=when, tag=label_for(tuid))
        elif sub == "task_notification":
            tuid = obj.get("tool_use_id") or _task_ids.get(obj.get("task_id"))
            status = obj.get("status") or "update"
            summary = clip(obj.get("summary") or "")
            body = f"{status} · {summary}" if summary else str(status)
            emit("⏹", "task", body, when=when, tag=label_for(tuid))
        return

    if typ in ("assistant", "user"):
        parent = obj.get("parent_tool_use_id")
        # A subagent's own events name their type; task_started may not have fired
        # yet (or may have been missed), so learn attribution from here too.
        remember(parent, obj.get("subagent_type"), obj.get("task_description"))
        tag = label_for(parent)
        msg = obj.get("message", {}) or {}
        content = msg.get("content")
        if isinstance(content, str):
            if content.strip():
                emit("💬", "claude", clip(content), when=when, tag=tag)
            return
        for b in content or []:
            bt = b.get("type")
            if bt == "text":
                if b.get("text", "").strip():
                    emit("💬", "claude", clip(b["text"]), when=when, tag=tag)
            elif bt == "tool_use":
                name = b.get("name", "?")
                emit(
                    "🔧",
                    "tool",
                    f"{name}  {clip(json.dumps(b.get('input', {})), 140)}",
                    when=when,
                    tag=tag,
                )
            elif bt == "tool_result":
                r = b.get("content")
                if isinstance(r, list):
                    r = "".join(x.get("text", "") for x in r if isinstance(x, dict))
                if str(r).strip():
                    emit("↳", "", clip(r, 160), cont=True, tag=tag)
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
        tag = label_for(obj.get("parent_tool_use_id"))
        emit("✅", "done", f"{sub}{suffix}".strip(), when=when, tag=tag)
        if obj.get("result"):
            emit("→", "", clip(obj["result"]), cont=True, tag=tag)
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
