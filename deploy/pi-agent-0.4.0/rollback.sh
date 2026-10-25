#!/bin/sh
# Restores agent 0.3.1 and its settings from install.sh's backups. Monitoring is not touched.
# The outbox (including any audio transfer progress) is kept; the API keeps what it received.
set -eu
[ "$(id -u)" = 0 ] || { echo "Run with sudo: sudo sh rollback.sh"; exit 1; }
BAK=bak-0.3.1-20261022
cp -p /opt/beehave-agent/agent.py.$BAK /opt/beehave-agent/agent.py
cp -p /opt/beehave-agent/sync.py.$BAK /opt/beehave-agent/sync.py
cp -p /etc/beehave-agent/agent.env.$BAK /etc/beehave-agent/agent.env
systemctl restart beehave-agent
for unit in beehave-agent beehave-continuous; do printf '  %s: ' "$unit"; systemctl is-active "$unit" || true; done
echo "Rolled back to agent 0.3.1. audio_sync.py is left in place but unused."
