#!/usr/bin/env bash
#
# Send a plaintext message to the theoses owner Telegram chat.
# Reads THEOSES_TELEGRAM_BOT_TOKEN / THEOSES_TELEGRAM_CHAT_ID from the
# environment (already exported by the caller from theoses.env).
#
# Usage:
#   ./notify-telegram.sh "message text"
#
# Never fails the caller's script: a notification failure should not block
# or roll back an otherwise successful (or already-rolled-back) update.

set -uo pipefail

message="${1:-}"

if [[ -z "${THEOSES_TELEGRAM_BOT_TOKEN:-}" || -z "${THEOSES_TELEGRAM_CHAT_ID:-}" ]]; then
    echo "notify-telegram: missing bot token or chat id, skipping notification" >&2
    exit 0
fi

if [[ -z "$message" ]]; then
    exit 0
fi

curl -fsS --max-time 10 \
    "https://api.telegram.org/bot${THEOSES_TELEGRAM_BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${THEOSES_TELEGRAM_CHAT_ID}" \
    --data-urlencode "text=${message}" \
    >/dev/null \
    || echo "notify-telegram: failed to send message" >&2

exit 0
