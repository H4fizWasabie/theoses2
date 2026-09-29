#!/usr/bin/env bash
# Usage: scripts/theoses-updater/test-install-source.sh [path/to/update.sh]
# Needs an authenticated gh. Extracts the source-install block from update.sh and runs it under the
# updater's shell options against a real release (success) and a nonexistent tag (must not abort).
set -euo pipefail
script="${1:-$(dirname "$0")/update.sh}"
REPO="H4fizWasabie/theoses2"
work="$(mktemp -d)"
trap 'chmod -R u+w "$work" 2>/dev/null; rm -rf "$work"' EXIT
log() { echo "  [log] $*"; }
block="$(sed -n '/^SOURCE_ASSET=/,/^fi$/p' "$script")"

run_case() { # tag
	local latest_tag="$1" workdir="$work/dl-$1" target_dir="$work/rel-$1"
	mkdir -p "$workdir" "${target_dir}.tmp"
	if [[ "$latest_tag" != "v9.9.9" ]]; then
		gh release download "$latest_tag" --repo "$REPO" --dir "$workdir" --pattern SHA256SUMS
	else
		: > "$workdir/SHA256SUMS"
	fi
	eval "$block"
	echo "  continued after block"
}

echo "success path (v1.0.102):"
run_case v1.0.102
[[ -f "$work/rel-v1.0.102.tmp/source/package.json" ]] || { echo "FAIL: source/package.json missing"; exit 1; }
# Mode bits, not -w: the updater (and so this test) runs as root, for whom -w is always true.
[[ "$(stat -c %A "$work/rel-v1.0.102.tmp/source/package.json")" != *w* ]] || { echo "FAIL: source is writable"; exit 1; }
echo "ok   source extracted, stripped one level, read-only"

echo "failure path (nonexistent release):"
run_case v9.9.9
[[ ! -e "$work/rel-v9.9.9.tmp/source" ]] || { echo "FAIL: partial source left behind"; exit 1; }
echo "ok   no source dir left, update would continue"
