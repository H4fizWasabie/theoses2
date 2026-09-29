#!/usr/bin/env bash
# Usage: scripts/theoses-updater/test-is-busy.sh [path/to/update.sh]. Extracts is_busy and runs it under the updater's shell options.
set -euo pipefail
script="${1:-$(dirname "$0")/update.sh}"
AGENT_DIR="$(mktemp -d)"
IDLE_BUSY_WINDOW_SECONDS=20
trap 'rm -rf "$AGENT_DIR"' EXIT
eval "$(sed -n '/^is_busy() {/,/^}/p' "$script")"

check() { # name expected_status
	local status=0
	is_busy || status=$?
	if [[ "$status" != "$2" ]]; then echo "FAIL $1: status $status, expected $2"; exit 1; fi
	echo "ok   $1"
}

check "no markers, no sessions" 1

mkdir -p "$AGENT_DIR/busy"
touch "$AGENT_DIR/busy/$$-live-session"
check "live marker" 0

rm "$AGENT_DIR/busy/$$-live-session"
touch "$AGENT_DIR/busy/999999-dead-session"
check "stale marker is ignored" 1
[[ ! -e "$AGENT_DIR/busy/999999-dead-session" ]] && echo "ok   stale marker removed"

mkdir -p "$AGENT_DIR/sessions/x"
touch "$AGENT_DIR/sessions/x/a.jsonl"
check "fresh session file falls back to busy" 0
touch -d '5 minutes ago' "$AGENT_DIR/sessions/x/a.jsonl"
check "old session file is idle" 1
