#!/usr/bin/env bash
#
# Self-update the theoses2 VPS deployment from the latest published GitHub
# Release. Runs as a standalone systemd oneshot (theoses-updater.service),
# independent of the theoses2-dashboard / theoses2-telegram services it
# manages, so a bad release can never leave nothing able to recover them.
#
# Flow: check latest release -> download+verify the services bundle ->
# extract into a new versioned directory -> atomically swap the `current`
# symlink -> restart the managed services -> health-check -> roll back the
# symlink and restart again on failure. Every outcome is reported to the
# owner over Telegram.
#
# Requires: gh (authenticated, `repo` scope; the release repo is private),
# curl, tar, sha256sum, systemctl, sort -V.

set -euo pipefail

REPO="H4fizWasabie/theoses2"
ASSET_NAME="theoses-services-linux-x64.tar.gz"
RELEASES_ROOT="/opt/theoses2-releases"
ENV_FILE="/home/theoses/.theoses/agent/theoses.env"
SERVICES=(theoses2-dashboard theoses2-telegram)
KEEP_RELEASES=3
HEALTH_CHECK_ATTEMPTS=10
HEALTH_CHECK_INTERVAL=3

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
notify() {
    "${script_dir}/notify-telegram.sh" "$1"
}

log() {
    echo "[theoses-updater] $*"
}

# Pull only the two Telegram vars out of the services' env file - sourcing it
# wholesale would clobber this script's own HOME/PATH with values meant for
# the theoses-owned dashboard/telegram services (e.g. theoses.env sets
# HOME=/home/theoses, which breaks gh's ability to find /root/.config/gh
# when this runs as root).
if [[ -f "$ENV_FILE" ]]; then
    THEOSES_TELEGRAM_BOT_TOKEN="$(grep -m1 '^THEOSES_TELEGRAM_BOT_TOKEN=' "$ENV_FILE" | cut -d= -f2-)"
    THEOSES_TELEGRAM_CHAT_ID="$(grep -m1 '^THEOSES_TELEGRAM_CHAT_ID=' "$ENV_FILE" | cut -d= -f2-)"
    export THEOSES_TELEGRAM_BOT_TOKEN THEOSES_TELEGRAM_CHAT_ID
fi

mkdir -p "$RELEASES_ROOT"

current_tag=""
if [[ -L "${RELEASES_ROOT}/current" ]]; then
    current_tag="$(basename "$(readlink -f "${RELEASES_ROOT}/current")")"
fi

latest_tag="$(gh release view --repo "$REPO" --json tagName -q .tagName)"

if [[ -z "$latest_tag" ]]; then
    log "could not determine latest release tag"
    exit 1
fi

if [[ "$latest_tag" == "$current_tag" ]]; then
    log "already on ${current_tag}, nothing to do"
    exit 0
fi

if [[ -n "$current_tag" ]]; then
    newest="$(printf '%s\n%s\n' "$current_tag" "$latest_tag" | sort -V | tail -1)"
    if [[ "$newest" != "$latest_tag" ]]; then
        log "latest release ${latest_tag} is not newer than installed ${current_tag}, skipping"
        exit 0
    fi
fi

log "updating ${current_tag:-<none>} -> ${latest_tag}"

workdir="$(mktemp -d)"
cleanup() {
    rm -rf "$workdir"
}
trap cleanup EXIT

gh release download "$latest_tag" --repo "$REPO" --dir "$workdir" \
    --pattern "$ASSET_NAME" --pattern "SHA256SUMS"

(
    cd "$workdir"
    grep " ${ASSET_NAME}\$" SHA256SUMS | sha256sum -c -
)

target_dir="${RELEASES_ROOT}/${latest_tag}"
rm -rf "${target_dir}.tmp"
mkdir -p "${target_dir}.tmp"
tar -xzf "${workdir}/${ASSET_NAME}" -C "${target_dir}.tmp" --strip-components=1

for entry_path in packages/dashboard/dist/index.js packages/telegram/dist/index.js; do
    if [[ ! -f "${target_dir}.tmp/${entry_path}" ]]; then
        log "downloaded bundle is missing ${entry_path}, aborting"
        rm -rf "${target_dir}.tmp"
        notify "theoses update ${current_tag:-<none>} -> ${latest_tag} FAILED: downloaded bundle missing ${entry_path}. Left running on ${current_tag:-<none>}."
        exit 1
    fi
done

rm -rf "$target_dir"
mv "${target_dir}.tmp" "$target_dir"

restart_and_check() {
    systemctl restart "${SERVICES[@]}"

    local attempt
    for ((attempt = 1; attempt <= HEALTH_CHECK_ATTEMPTS; attempt++)); do
        sleep "$HEALTH_CHECK_INTERVAL"
        local all_active=true
        for svc in "${SERVICES[@]}"; do
            if ! systemctl is-active --quiet "$svc"; then
                all_active=false
                break
            fi
        done
        if [[ "$all_active" == true ]]; then
            return 0
        fi
    done
    return 1
}

ln -sfn "$target_dir" "${RELEASES_ROOT}/current.new"
mv -T "${RELEASES_ROOT}/current.new" "${RELEASES_ROOT}/current"

if restart_and_check; then
    log "update to ${latest_tag} succeeded"
    notify "theoses updated: ${current_tag:-<none>} -> ${latest_tag}. Services healthy."
else
    log "update to ${latest_tag} failed health check, rolling back"
    if [[ -n "$current_tag" ]]; then
        ln -sfn "${RELEASES_ROOT}/${current_tag}" "${RELEASES_ROOT}/current.new"
        mv -T "${RELEASES_ROOT}/current.new" "${RELEASES_ROOT}/current"
        if restart_and_check; then
            notify "theoses update to ${latest_tag} FAILED health check. Rolled back to ${current_tag} successfully."
        else
            notify "theoses update to ${latest_tag} FAILED health check, and ROLLBACK to ${current_tag} ALSO FAILED. Services may be down - manual intervention needed."
        fi
    else
        notify "theoses first install (${latest_tag}) FAILED health check. No previous version to roll back to - manual intervention needed."
    fi
    exit 1
fi

# Prune old release directories, keeping the current one and the
# KEEP_RELEASES most recent by tag.
mapfile -t all_releases < <(find "$RELEASES_ROOT" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort -V)
prune_count=$(( ${#all_releases[@]} - KEEP_RELEASES ))
if (( prune_count > 0 )); then
    for ((i = 0; i < prune_count; i++)); do
        old="${all_releases[$i]}"
        if [[ "$old" != "$latest_tag" ]]; then
            log "pruning old release ${old}"
            rm -rf "${RELEASES_ROOT:?}/${old}"
        fi
    done
fi
