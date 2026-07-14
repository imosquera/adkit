#!/usr/bin/env python3
"""Maintain one dashboard branch-status card per git branch as a feature moves
through the SpecKit cycle (specify -> plan -> tasks -> implement -> review).

The card is a pure YAML file (branches/<slug>.yaml) the agent-os dashboard renders
as a live "Active branches" card. This script is the single deterministic writer:
it rewrites the WHOLE file on every phase transition (never patches in place),
always bumps `updated`, and enforces the status rules so the model never has to
hand-author fiddly YAML.

Each phase carries: status + summary (one line, always shown) + description (a
paragraph shown in the expanded panel) + items (the work list — user stories in
`specify`, tasks in `tasks`/`implement`). `review` also carries substeps (the
review-extension passes) nested directly under phases.review.substeps. Items and
descriptions are preserved across rewrites, so setting specify's user stories once
keeps them through later phases.

Usage (verbs):
  progress_report.py enter <phase> [--summary S] [--description D] [--items-json J]
      phase active; priors done; laters pending
  progress_report.py done  <phase> [--summary S] [--description D] [--items-json J]
      phase done (+ all priors done)
  progress_report.py block <phase> --reason R
      phase blocked; reason -> summary + note
  progress_report.py set   <phase> [--summary S] [--description D] [--items-json J]
      update a phase's summary/description/items WITHOUT touching any statuses
      (use mid-phase as items flip to done, e.g. implement progress)
  progress_report.py substep k=v [k=v ...] [--note N]
      review substeps (review -> active)
  progress_report.py done-all
      all five phases done (card shows "done")

Phases : specify plan tasks implement review
Substeps (review): code comments tests errors types simplify pr
Status : done | active | pending | blocked   (nothing else)

--items-json takes a JSON array; each element is an object with keys:
  title (required), id (optional), description (optional),
  status (optional, default pending). It REPLACES the target phase's item list,
  so re-send the full list with updated statuses as work lands. Example:
  --items-json '[{"id":"US1","title":"As a user, I can ...","status":"active"}]'

Common options (all verbs):
  --branch B      default: current git branch (`git rev-parse --abbrev-ref HEAD`)
  --title  T      human label   (default: preserved, else derived from branch)
  --spec   S      feature slug   (default: preserved, else derived from branch)
  --issue  U      GitHub issue or PR URL (e.g. https://github.com/owner/repo/issues/42)
  --dashboard D   dashboard repo (default: $AGENT_OS_DASHBOARD or ~/Code/agent-os)
  --note   N      trailing one-line note

Graceful skip: if <dashboard>/branches does not exist, print a note and exit 0 —
progress reporting must never break the pipeline it observes.
"""
import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime

LOG_PATH = os.path.expanduser("~/Library/Logs/speckit-autopilot.log")


def log(msg: str) -> None:
    """Append a timestamped line to the autopilot log, silently skipping on any error."""
    try:
        os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
        ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with open(LOG_PATH, "a") as f:
            f.write(f"{ts} {msg}\n")
    except Exception:
        pass

PHASES = ["specify", "plan", "tasks", "implement", "review"]
SUBSTEPS = ["code", "comments", "tests", "errors", "types", "simplify", "pr"]
STATUSES = {"done", "active", "pending", "blocked"}
ITEM_KEYS = ("id", "title", "description", "status")


# ---------------------------------------------------------------- helpers ----
def sh(*args):
    try:
        return subprocess.run(args, capture_output=True, text=True).stdout.strip()
    except Exception:
        return ""


def current_branch():
    return sh("git", "rev-parse", "--abbrev-ref", "HEAD") or "HEAD"


def slugify(branch):
    s = branch.replace("/", "-")
    s = re.sub(r"[^A-Za-z0-9._-]+", "-", s)
    return re.sub(r"-{2,}", "-", s).strip("-") or "branch"


def humanize(branch):
    tail = branch.split("/")[-1]
    return re.sub(r"[-_]+", " ", tail).strip().title() or branch


def resolve_dashboard(explicit):
    d = explicit or os.environ.get("AGENT_OS_DASHBOARD") or "~/Code/agent-os"
    return os.path.expanduser(d)


def now_stamp():
    return datetime.now().strftime("%Y-%m-%d %H:%M")


def blank_state(branch):
    return {
        "branch": branch,
        "title": "",
        "spec": "",
        "issue": "",
        "session": "",
        "note": "",
        "phases": {
            "specify":   {"status": "pending", "summary": "", "description": "", "items": []},
            "plan":      {"status": "pending", "summary": "", "description": "", "items": []},
            "tasks":     {"status": "pending", "summary": "", "items": []},
            "implement": {"status": "pending", "summary": "", "items": []},
            "review":    {
                "status": "pending", "summary": "",
                "substeps": {s: "pending" for s in SUBSTEPS},
            },
        },
    }


# ------------------------------------------------------------- read/parse ----
def parse_card(text, branch):
    """Tolerant, indent-aware reader for our own block-style YAML output. Recovers
    statuses/summaries/descriptions/items/substeps + meta so a rewrite preserves
    earlier phases. Any parse failure degrades to a blank state."""
    # Try yaml first (PyYAML); fall back to manual line reader.
    try:
        import yaml  # type: ignore
        raw = yaml.safe_load(text)
        return _from_yaml_dict(raw, branch)
    except Exception:
        pass
    return _manual_parse(text, branch)


def _from_yaml_dict(raw, branch):
    if not isinstance(raw, dict):
        return blank_state(branch)
    st = blank_state(branch)
    st["branch"] = str(raw.get("branch", branch) or branch)
    st["title"] = str(raw.get("title", "") or "")
    st["spec"] = str(raw.get("spec", "") or "")
    st["issue"] = str(raw.get("issue", "") or "")
    st["session"] = str(raw.get("session", "") or "")
    st["note"] = str(raw.get("note", "") or "")
    phases_raw = raw.get("phases") or {}
    if isinstance(phases_raw, dict):
        for p in PHASES:
            pr = phases_raw.get(p)
            if not isinstance(pr, dict):
                continue
            ph = st["phases"][p]
            ph["status"] = _valid(str(pr.get("status", "pending")))
            ph["summary"] = str(pr.get("summary", "") or "")
            if "description" in pr:
                ph["description"] = str(pr.get("description", "") or "")
            items_raw = pr.get("items")
            if isinstance(items_raw, list):
                ph["items"] = [_norm_item(x) for x in items_raw if isinstance(x, dict)]
            if p == "review":
                ss_raw = pr.get("substeps")
                if isinstance(ss_raw, dict):
                    for s in SUBSTEPS:
                        ph["substeps"][s] = _valid(str(ss_raw.get(s, "pending")))
    return st


def _manual_parse(text, branch):
    """Line-by-line fallback for environments without PyYAML."""
    st = blank_state(branch)
    cur_phase = None
    mode = None       # None | "items" | "substeps"
    cur_item = None

    def close_item():
        nonlocal cur_item
        if cur_item is not None and cur_phase:
            if cur_item.get("title") or cur_item.get("id"):
                st["phases"][cur_phase]["items"].append(cur_item)
        cur_item = None

    for raw in text.splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        indent = len(raw) - len(raw.lstrip())
        line = raw.strip()

        # top-level scalar keys
        mt = re.match(r"^(branch|title|spec|issue|session|updated|note):\s*(.*)$", line)
        if indent == 0 and mt:
            close_item()
            k, v = mt.group(1), _unquote(mt.group(2))
            if k in ("branch", "title", "spec", "issue", "session", "note"):
                st[k] = v or st.get(k, "")
            cur_phase, mode = None, None
            continue
        if indent == 0 and line.startswith("phases:"):
            close_item()
            cur_phase, mode = None, None
            continue

        # phase header at indent 2
        mp = re.match(r"^([a-z]+):\s*$", line)
        if indent == 2 and mp and mp.group(1) in PHASES:
            close_item()
            cur_phase, mode = mp.group(1), None
            continue

        if not cur_phase:
            continue

        # phase attribute at indent 4
        if indent == 4:
            close_item()
            if line.startswith("items:"):
                mode = "items"
                continue
            if line.startswith("substeps:"):
                mode = "substeps"
                continue
            mode = None
            ms = re.match(r"^status:\s*(\w+)", line)
            if ms:
                st["phases"][cur_phase]["status"] = _valid(ms.group(1))
                continue
            msum = re.match(r"^summary:\s*(.*)$", line)
            if msum:
                st["phases"][cur_phase]["summary"] = _unquote(msum.group(1))
                continue
            mdesc = re.match(r"^description:\s*(.*)$", line)
            if mdesc:
                st["phases"][cur_phase]["description"] = _unquote(mdesc.group(1))
                continue
            continue

        # substep rows (indent 6 under review)
        if mode == "substeps" and cur_phase == "review":
            mss = re.match(r"^([a-z]+):\s*(\w+)", line)
            if mss and mss.group(1) in SUBSTEPS:
                st["phases"]["review"]["substeps"][mss.group(1)] = _valid(mss.group(2))
            continue

        # item rows
        if mode == "items":
            mnew = re.match(r"^-\s+(\w+):\s*(.*)$", line)
            if mnew:
                close_item()
                cur_item = {}
                _set_item(cur_item, mnew.group(1), mnew.group(2))
                continue
            mkv = re.match(r"^(\w+):\s*(.*)$", line)
            if mkv and cur_item is not None:
                _set_item(cur_item, mkv.group(1), mkv.group(2))
            continue

    close_item()
    return st


def _set_item(item, key, val):
    if key not in ITEM_KEYS:
        return
    if key == "status":
        item["status"] = _valid(val.strip())
    else:
        item[key] = _unquote(val)


def _valid(s):
    return s if s in STATUSES else "pending"


def _unquote(v):
    v = v.strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
        v = v[1:-1]
    return v.replace('\\"', '"')


# ---------------------------------------------------------------- render ----
def _q(s):
    s = " ".join(str(s).split())
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _norm_item(raw):
    it = {}
    if raw.get("id"):
        it["id"] = str(raw["id"]).strip()
    it["title"] = str(raw.get("title", "")).strip()
    if raw.get("description"):
        it["description"] = str(raw["description"]).strip()
    it["status"] = _valid(str(raw.get("status", "pending")).strip())
    return it


def render_items(items):
    lines = ["    items:"]
    for it in items:
        first = True

        def emit(k, v, quote, _first=None):
            nonlocal first
            prefix = "      - " if first else "        "
            lines.append(f"{prefix}{k}: {_q(v) if quote else v}")
            first = False

        if it.get("id"):
            emit("id", it["id"], False)
        emit("title", it.get("title", ""), True)
        if it.get("description"):
            emit("description", it["description"], True)
        emit("status", it.get("status", "pending"), False)
    return lines


def render(st):
    out = []
    out.append(f"branch: {st['branch']}")
    out.append(f"title: {st['title'] or humanize(st['branch'])}")
    if st.get("spec"):
        out.append(f"spec: {st['spec']}")
    if st.get("issue"):
        out.append(f"issue: {st['issue']}")
    if st.get("session"):
        out.append(f"session: {_q(st['session'])}")
    out.append(f"updated: {now_stamp()}")
    note = st.get("note", "")
    out.append(f"note: {_q(note) if note else '\"\"'}")
    out.append("")
    out.append("phases:")
    for p in PHASES:
        ph = st["phases"][p]
        out.append(f"  {p}:")
        out.append(f"    status: {ph['status']}")
        summary = ph.get("summary", "")
        out.append(f"    summary: {_q(summary) if summary else '\"\"'}")
        if "description" in ph:
            desc = ph.get("description", "")
            out.append(f"    description: {_q(desc) if desc else '\"\"'}")
        if ph.get("items"):
            out.extend(render_items(ph["items"]))
        if p == "review":
            out.append("    substeps:")
            substeps = ph.get("substeps", {})
            for s in SUBSTEPS:
                out.append(f"      {s}: {substeps.get(s, 'pending')}")
    return "\n".join(out) + "\n"


def atomic_write(path, text):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        f.write(text)
    os.replace(tmp, path)


# ----------------------------------------------------------------- verbs ----
def _apply_detail(st, phase, args):
    if args.summary:
        st["phases"][phase]["summary"] = args.summary
    if args.description:
        st["phases"][phase]["description"] = args.description
    if args.items_json is not None:
        try:
            data = json.loads(args.items_json)
            if isinstance(data, list):
                st["phases"][phase]["items"] = [
                    _norm_item(x) for x in data if isinstance(x, dict)
                ]
        except json.JSONDecodeError as e:
            sys.exit(f"error: --items-json is not valid JSON: {e}")


def apply_verb(st, args):
    if args.title:
        st["title"] = args.title
    if args.spec:
        st["spec"] = args.spec
    if args.issue:
        st["issue"] = args.issue
    if args.session:
        st["session"] = args.session
    if not st["title"]:
        st["title"] = humanize(st["branch"])
    if not st.get("spec"):
        st["spec"] = slugify(st["branch"].split("/")[-1])

    verb = args.verb
    if verb in ("enter", "done", "block", "set"):
        phase = args.target
        if phase not in PHASES:
            sys.exit(f"error: unknown phase '{phase}' (want: {', '.join(PHASES)})")
        idx = PHASES.index(phase)
        if verb == "enter":
            for i, p in enumerate(PHASES):
                st["phases"][p]["status"] = (
                    "done" if i < idx else "active" if i == idx else "pending"
                )
            _apply_detail(st, phase, args)
        elif verb == "done":
            for i in range(idx):
                st["phases"][PHASES[i]]["status"] = "done"
            st["phases"][phase]["status"] = "done"
            _apply_detail(st, phase, args)
        elif verb == "set":
            _apply_detail(st, phase, args)
        elif verb == "block":
            reason = args.reason or "blocked"
            st["phases"][phase]["status"] = "blocked"
            st["phases"][phase]["summary"] = reason
            st["note"] = reason
    elif verb == "substep":
        for pair in args.pairs:
            if "=" not in pair:
                sys.exit(f"error: substep needs k=v, got '{pair}'")
            k, v = pair.split("=", 1)
            if k not in SUBSTEPS:
                sys.exit(f"error: unknown substep '{k}' (want: {', '.join(SUBSTEPS)})")
            st["phases"]["review"]["substeps"][k] = _valid(v)
        if st["phases"]["review"]["status"] not in ("done", "blocked"):
            st["phases"]["review"]["status"] = "active"
            for i in range(PHASES.index("review")):
                st["phases"][PHASES[i]]["status"] = "done"
    elif verb == "done-all":
        for p in PHASES:
            st["phases"][p]["status"] = "done"
        for s in SUBSTEPS:
            st["phases"]["review"]["substeps"][s] = "done"

    if args.note:
        st["note"] = args.note
    return st


# ------------------------------------------------------------------ main ----
def build_parser():
    p = argparse.ArgumentParser(description="Update a dashboard branch-status card.")
    p.add_argument("verb", choices=["enter", "done", "block", "set", "substep", "done-all"])
    p.add_argument("rest", nargs="*", help="phase (enter/done/block/set) or k=v pairs (substep)")
    p.add_argument("--summary")
    p.add_argument("--description")
    p.add_argument("--items-json", dest="items_json")
    p.add_argument("--reason")
    p.add_argument("--note")
    p.add_argument("--branch")
    p.add_argument("--title")
    p.add_argument("--spec")
    p.add_argument("--issue")
    p.add_argument("--session")
    p.add_argument("--dashboard")
    return p


def main():
    args = build_parser().parse_args()
    phase_verbs = ("enter", "done", "block", "set")
    args.target = args.rest[0] if args.rest and args.verb in phase_verbs else None
    args.pairs = args.rest if args.verb == "substep" else []
    if args.verb in phase_verbs and not args.target:
        sys.exit(f"error: '{args.verb}' needs a phase name")

    args.branch = args.branch or current_branch()
    log(f"[{args.branch}] {args.verb} {' '.join(args.rest)}")

    dashboard = resolve_dashboard(args.dashboard)
    branches = os.path.join(dashboard, "branches")
    if not os.path.isdir(branches):
        msg = f"no dashboard at {branches} — skipping"
        print(f"progress_report: {msg} (not an error)")
        log(f"[{args.branch}] SKIP {msg}")
        return

    slug = slugify(args.branch)
    # Support reading an existing .md card from a prior format; always write .yaml.
    yaml_path = os.path.join(branches, slug + ".yaml")
    md_path = os.path.join(branches, slug + ".md")

    src_path = yaml_path if os.path.exists(yaml_path) else (
        md_path if os.path.exists(md_path) else None
    )
    if src_path:
        try:
            with open(src_path) as f:
                st = parse_card(f.read(), args.branch)
        except Exception as e:
            msg = f"could not parse {src_path} ({e}); starting fresh"
            print(f"progress_report: {msg}")
            log(f"[{args.branch}] ERROR {msg}")
            st = blank_state(args.branch)
        st["branch"] = args.branch
        # Migrate: remove old .md file after first successful read
        if src_path == md_path and src_path != yaml_path:
            try:
                os.remove(md_path)
            except OSError:
                pass
    else:
        st = blank_state(args.branch)

    st = apply_verb(st, args)
    atomic_write(yaml_path, render(st))

    # Build a compact status summary for the log: phase statuses + active substeps.
    phase_statuses = " | ".join(
        f"{p}:{st['phases'][p]['status']}" for p in PHASES
    )
    review_ss = st["phases"]["review"].get("substeps", {})
    active_ss = [s for s in SUBSTEPS if review_ss.get(s) == "active"]
    ss_part = f" substeps:{','.join(active_ss)}" if active_ss else ""
    log(f"[{args.branch}] OK {args.verb} {' '.join(args.rest)} — {phase_statuses}{ss_part}")

    print(f"progress_report: {args.verb} -> {yaml_path}")


if __name__ == "__main__":
    main()
