#!/usr/bin/env bash
#
# One-time VPS setup for the theoses2 self-update pipeline. Installs the
# updater under /opt/theoses-updater, creates the releases root, and enables
# the periodic timer. Run as root on the deployment host.
#
# This does NOT repoint theoses2-dashboard.service / theoses2-telegram.service
# at the managed releases directory yet - there is nothing in
# /opt/theoses2-releases/current until the updater has completed its first
# run. After the first successful run of `systemctl start theoses-updater`,
# install theoses2-dashboard.service / theoses2-telegram.service from this
# directory to cut the live services over, then `systemctl daemon-reload &&
# systemctl restart theoses2-dashboard theoses2-telegram`.
#
# Usage (from a checkout of this repo):
#   sudo ./scripts/theoses-updater/install.sh

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p /opt/theoses-updater
cp "${script_dir}/update.sh" "${script_dir}/rollback.sh" "${script_dir}/notify-telegram.sh" /opt/theoses-updater/
chmod +x /opt/theoses-updater/update.sh /opt/theoses-updater/rollback.sh /opt/theoses-updater/notify-telegram.sh

mkdir -p /opt/theoses2-releases

# `theoses` on PATH, following the current release, so the agent can test a change in a fresh process
# (`theoses -p --no-session ...`) instead of restarting the service it runs in (issue #530).
cat > /usr/local/bin/theoses <<'EOF'
#!/usr/bin/env bash
exec node /opt/theoses2-releases/current/packages/coding-agent/dist/cli.js "$@"
EOF
chmod +x /usr/local/bin/theoses

cp "${script_dir}/theoses-updater.service" "${script_dir}/theoses-updater.timer" /etc/systemd/system/

systemctl daemon-reload
systemctl enable --now theoses-updater.timer

echo "Installed. Run 'systemctl start theoses-updater.service' to trigger the first check immediately, then 'journalctl -u theoses-updater -f' to watch it."
