# autopilot extension

Registers two commands:

- **`/speckit-autopilot-run`** — take the oldest eligible open GitHub issue (or a
  given issue number) from backlog to a reviewed **draft PR**, driving the whole
  speckit pipeline unattended — pick → worktree → specify → clarify (auto-answered)
  → plan → tasks → implement → review → draft PR — and posting progress to the issue
  at every stage.
- **`/speckit-autopilot-schedule`** — put `/speckit-autopilot-run` on a recurring
  **launchd** timer so the backlog drains itself (default **every 2h**, configurable
  via `--interval-hours N`). Opt-in and macOS-only; also `uninstall`, `status`, and
  `run-now`. `.run` detects whether a schedule exists and *suggests* setting one up
  when it doesn't — it never schedules itself.

See `commands/speckit.autopilot.run.md` for the full workflow and the decisions behind
it (one issue per run, full autonomy with an issue-comment audit trail, stop only
on hard blockers), and `commands/speckit.autopilot.schedule.md` for the scheduler.

## Scheduling (recurring unattended runs)

```bash
/speckit-autopilot-schedule                       # schedule every 2h (default)
/speckit-autopilot-schedule install --interval-hours 4
/speckit-autopilot-schedule status                # is it on? interval + log tail
/speckit-autopilot-schedule run-now               # fire one pass immediately
/speckit-autopilot-schedule uninstall             # stop it
```

Each repo gets its own launchd agent
(`~/Library/LaunchAgents/com.speckit.autopilot.<repo>.plist`) that runs
`scripts/bash/autopilot-run.sh <repo>` on the interval, which invokes
`claude -p "/speckit-autopilot-run" --dangerously-skip-permissions` inside the repo.
The permission bypass is what makes an *unattended* pass possible; runs are
single-flight (a long pass won't stack a second one), and output lands in
`~/Library/Logs/speckit-autopilot/<repo>.log`. Nothing recurring is installed until
you run `install` — it's strictly opt-in.

## Install

```bash
specify extension add --dev /path/to/speckit-squads/extensions/autopilot
# or, for the whole repo:  /path/to/speckit-squads/install.sh <project>
```

## Optional: name each session after its issue (SessionStart hook)

`hooks/session-title.sh` titles a Claude Code session after the speckit feature /
GitHub issue it belongs to, so parallel backlog runs are easy to tell apart. It's
a **Claude Code** hook (settings.json), not a speckit pipeline hook, so `specify`
does not wire it up — add it to the consumer project's `.claude/settings.json`
yourself:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "$CLAUDE_PROJECT_DIR/.specify/extensions/autopilot/hooks/session-title.sh"
          }
        ]
      }
    ]
  }
}
```

(Adjust the path if your install location differs; with `--dev` installs the
extension resolves back to this repo's source tree, so you can also point at
`/path/to/speckit-squads/extensions/autopilot/hooks/session-title.sh` directly.)

### What it does

- Fires on session **startup** and **resume** (Claude ignores a hook-set title
  after `/clear` and during compaction, so it stays silent then).
- Reads `.specify/feature.json`: `source_issue` → `#N: <issue title>` (via `gh`),
  else `branch_name`; falls back to the live git branch. On the main checkout with
  no feature, it emits nothing and Claude keeps its auto-generated title.
- Never blocks a session from starting — every failure degrades quietly.

### Known limitation

The session that *runs* `/speckit-autopilot-run` starts before the issue is picked, so
it can't rename itself — there's no supported way to rename a **running** Claude
session (only `startup`/`resume` via this hook, or a manual `/rename`). The command
sets a best-effort terminal-tab title for the running session; the durable
Claude-session title applies whenever you open or resume a session **inside the
issue's worktree**.
