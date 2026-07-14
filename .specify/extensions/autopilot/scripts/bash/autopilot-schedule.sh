#!/usr/bin/env bash
#
# Manage a launchd agent that runs /speckit-autopilot-run on a fixed interval,
# so the backlog drains itself without a human kicking off each pass.
#
# NOT scheduled by default — the user opts in by running `install`. One agent per
# git repo (labelled by repo), so several projects can each be scheduled
# independently. macOS only (launchd).
#
# Subcommands:
#   install [--interval-hours N] [--project DIR]   schedule (default N=2, DIR=cwd)
#   uninstall [--project DIR]                       unschedule + remove the plist
#   status  [--project DIR]                         is it loaded? interval, log tail
#   run-now [--project DIR]                          fire one pass immediately
#   label   [--project DIR]                          print this repo's launchd label
#
# The interval is configurable: re-run `install --interval-hours N` to change it
# (the agent is reloaded so the new cadence takes effect right away).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
RUNNER="$SCRIPT_DIR/autopilot-run.sh"
DEFAULT_INTERVAL_HOURS=2

die() { echo "error: $*" >&2; exit 1; }

require_macos() {
  [ "$(uname)" = "Darwin" ] || die "launchd scheduling is macOS-only (got $(uname))."
}

project_root() {
  ( cd "${1:-$PWD}" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null ) \
    || die "not inside a git repo: ${1:-$PWD}"
}

# A readable-but-unique slug so two repos with the same basename don't collide.
slug_for() {
  local root="$1" base hash
  base="$(basename "$root")"
  # printf (not a pipe from basename) so tr never sees a trailing newline to
  # convert into a stray '-'; only genuinely unsafe chars become '-'.
  base="$(printf '%s' "$base" | tr -c 'A-Za-z0-9._-' '-')"
  hash="$(printf '%s' "$root" | shasum | cut -c1-6)"
  printf '%s-%s' "$base" "$hash"
}
label_for() { printf 'com.speckit.autopilot.%s' "$(slug_for "$1")"; }
plist_for() { printf '%s/Library/LaunchAgents/%s.plist' "$HOME" "$(label_for "$1")"; }
log_for()   { printf '%s/Library/Logs/speckit-autopilot/%s.log' "$HOME" "$(slug_for "$1")"; }

# Parse a trailing "--project DIR" (and, for install, "--interval-hours N").
parse_common() {
  PROJECT="$PWD"; INTERVAL_HOURS="$DEFAULT_INTERVAL_HOURS"
  while [ $# -gt 0 ]; do
    case "$1" in
      --project)        PROJECT="${2:?--project needs a path}"; shift 2;;
      --interval-hours) INTERVAL_HOURS="${2:?--interval-hours needs a number}"; shift 2;;
      *) die "unknown arg: $1";;
    esac
  done
}

cmd_install() {
  require_macos; parse_common "$@"
  [[ "$INTERVAL_HOURS" =~ ^[0-9]+$ ]] && [ "$INTERVAL_HOURS" -ge 1 ] \
    || die "--interval-hours must be a positive integer (hours)"
  [ -x "$RUNNER" ] || die "runner not executable: $RUNNER"

  local root label plist log seconds uid path_env
  root="$(project_root "$PROJECT")"
  label="$(label_for "$root")"; plist="$(plist_for "$root")"; log="$(log_for "$root")"
  seconds=$(( INTERVAL_HOURS * 3600 ))
  uid="$(id -u)"
  # launchd starts with a minimal PATH; spell out where claude/gh/git live.
  path_env="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

  mkdir -p "$(dirname "$plist")" "$(dirname "$log")"
  cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$RUNNER</string>
    <string>$root</string>
  </array>
  <key>StartInterval</key><integer>$seconds</integer>
  <key>RunAtLoad</key><false/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$path_env</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
  <key>StandardOutPath</key><string>$log</string>
  <key>StandardErrorPath</key><string>$log</string>
</dict>
</plist>
PLIST

  # Reload so a changed interval takes effect. Prefer modern bootstrap/bootout;
  # fall back to load/unload on older macOS.
  launchctl bootout "gui/$uid/$label" 2>/dev/null || launchctl unload "$plist" 2>/dev/null || true
  launchctl bootstrap "gui/$uid" "$plist" 2>/dev/null || launchctl load "$plist" \
    || die "launchctl failed to load $plist"

  echo "scheduled  $label"
  echo "  every    ${INTERVAL_HOURS}h (StartInterval=${seconds}s)"
  echo "  repo     $root"
  echo "  plist    $plist"
  echo "  log      $log"
  echo "  note     RunAtLoad is off — first pass fires in ~${INTERVAL_HOURS}h; use 'run-now' to trigger one immediately."
}

cmd_uninstall() {
  require_macos; parse_common "$@"
  local root label plist uid
  root="$(project_root "$PROJECT")"; label="$(label_for "$root")"; plist="$(plist_for "$root")"
  uid="$(id -u)"
  launchctl bootout "gui/$uid/$label" 2>/dev/null || launchctl unload "$plist" 2>/dev/null || true
  rm -f "$plist"
  echo "unscheduled $label (plist removed)"
}

cmd_status() {
  require_macos; parse_common "$@"
  local root label plist log uid
  root="$(project_root "$PROJECT")"; label="$(label_for "$root")"
  plist="$(plist_for "$root")"; log="$(log_for "$root")"; uid="$(id -u)"

  if launchctl print "gui/$uid/$label" >/dev/null 2>&1 || launchctl list | grep -q "$label"; then
    echo "SCHEDULED  $label"
  else
    echo "NOT SCHEDULED  $label"
    echo "  schedule it with: install --interval-hours N --project $root"
  fi
  [ -f "$plist" ] && echo "  plist  $plist  (interval $(grep -A1 StartInterval "$plist" | grep -o '[0-9]\+' | head -1)s)"
  if [ -f "$log" ]; then
    echo "  log    $log"
    echo "  --- last log lines ---"
    tail -n 5 "$log" 2>/dev/null | sed 's/^/  /'
  fi
}

cmd_run_now() {
  require_macos; parse_common "$@"
  local root label uid
  root="$(project_root "$PROJECT")"; label="$(label_for "$root")"; uid="$(id -u)"
  launchctl kickstart -k "gui/$uid/$label" 2>/dev/null \
    || die "not scheduled yet — run 'install' first"
  echo "kicked off one pass for $label (watch $(log_for "$root"))"
}

cmd_label() { parse_common "$@"; label_for "$(project_root "$PROJECT")"; }

sub="${1:-}"; shift || true
case "$sub" in
  install)   cmd_install   "$@";;
  uninstall) cmd_uninstall "$@";;
  status)    cmd_status    "$@";;
  run-now)   cmd_run_now   "$@";;
  label)     cmd_label     "$@";;
  ""|help|-h|--help)
    sed -n '3,20p' "$0" | sed 's/^# \{0,1\}//';;
  *) die "unknown subcommand: $sub (try: install | uninstall | status | run-now | label)";;
esac
