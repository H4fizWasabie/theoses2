#!/usr/bin/env bash
#
# Manually roll the theoses2 VPS deployment back to a previous release.
# Companion to update.sh's automatic rollback: update.sh only reverts within
# its own run, when the health check right after a swap fails. This script
# covers the case update.sh can't: a release that passed its health check at
# swap time but caused trouble later (a behavioral regression, not a crash).
#
# Run with no arguments to roll back to the release just before `current`.
# Pass a tag to roll back to that specific release instead.
#
# Flow: resolve target release -> swap the `current` symlink -> restart the
# managed services -> health-check -> swap back to whatever was current
# beforehand and restart again on failure. Every outcome is reported to the
# owner over Telegram.
#
# This is a deliberate, one-shot operator action - it is not wired into the
# theoses-updater timer and never runs unattended.
#
# Requires: curl, systemctl, sort -V.
#
# Usage:
#   ./rollback.sh              # roll back to the release before current
#   ./rollback.sh v1.0.35      # roll back to a specific release tag

set -euo pipefail

RELEASES_ROOT="/opt/theoses2-releases"
ENV_FILE="/home/theoses/.theoses/agent/theoses.env"
SERVICES=(theoses2-dashboard theoses2-telegram)
HEALTH_CHECK_ATTEMPTS=10
HEALTH_CHECK_INTERVAL=3

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
notify() {
    "${script_dir}/notify-telegram.sh" "$1"
}

log() {
    echo "[theoses-rollback] $*"
}

# Same rationale as update.sh: pull only the Telegram vars, don't source the
# whole env file (it sets HOME=/home/theoses, which breaks this script's own
# ability to find root's config when run as root).
if [[ -f "$ENV_FILE" ]]; then
    THEOSES_TELEGRAM_BOT_TOKEN="$(grep -m1 '^THEOSES_TELEGRAM_BOT_TOKEN=' "$ENV_FILE" | cut -d= -f2-)"
    THEOSES_TELEGRAM_CHAT_ID="$(grep -m1 '^THEOSES_TELEGRAM_CHAT_ID=' "$ENV_FILE" | cut -d= -f2-)"
    export THEOSES_TELEGRAM_BOT_TOKEN THEOSES_TELEGRAM_CHAT_ID
fi

if [[ ! -L "${RELEASES_ROOT}/current" ]]; then
    log "no current release symlink at ${RELEASES_ROOT}/current - nothing to roll back from"
    exit 1
fi

current_tag="$(basename "$(readlink -f "${RELEASES_ROOT}/current")")"

mapfile -t all_releases < <(find "$RELEASES_ROOT" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort -V)

target_tag="${1:-}"
if [[ -z "$target_tag" ]]; then
    # Default: the release immediately before current in version order.
    for ((i = 0; i < ${#all_releases[@]}; i++)); do
        if [[ "${all_releases[$i]}" == "$current_tag" ]]; then
            if (( i == 0 )); then
                log "no release older than current (${current_tag}) is on disk - nothing to roll back to"
                exit 1
            fi
            target_tag="${all_releases[$((i - 1))]}"
            break
        fi
    done
    if [[ -z "$target_tag" ]]; then
        log "could not find current release ${current_tag} among installed releases, pass a target tag explicitly"
        exit 1
    fi
fi

if [[ "$target_tag" == "$current_tag" ]]; then
    log "target ${target_tag} is already current, nothing to do"
    exit 0
fi

if [[ ! -d "${RELEASES_ROOT}/${target_tag}" ]]; then
    log "release ${target_tag} is not installed under ${RELEASES_ROOT} (it may have been pruned)"
    exit 1
fi

log "rolling back ${current_tag} -> ${target_tag}"

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

ln -sfn "${RELEASES_ROOT}/${target_tag}" "${RELEASES_ROOT}/current.new"
mv -T "${RELEASES_ROOT}/current.new" "${RELEASES_ROOT}/current"

if restart_and_check; then
    log "rollback to ${target_tag} succeeded"
    notify "theoses rolled back: ${current_tag} -> ${target_tag}. Services healthy."
else
    log "rollback to ${target_tag} failed health check, reverting to ${current_tag}"
    ln -sfn "${RELEASES_ROOT}/${current_tag}" "${RELEASES_ROOT}/current.new"
    mv -T "${RELEASES_ROOT}/current.new" "${RELEASES_ROOT}/current"
    if restart_and_check; then
        notify "theoses rollback to ${target_tag} FAILED health check. Restored ${current_tag} successfully."
    else
        notify "theoses rollback to ${target_tag} FAILED health check, and RESTORING ${current_tag} ALSO FAILED. Services may be down - manual intervention needed."
    fi
    exit 1
fi
