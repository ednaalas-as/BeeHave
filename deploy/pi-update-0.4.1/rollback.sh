#!/bin/sh
# Restores agent 0.4.0 and the previous setup service from install.sh's backups.
# Monitoring is not touched. Saved Wi-Fi networks stay as they are now (a forgotten network
# is not brought back, and priorities keep their new values).
set -eu
[ "$(id -u)" = 0 ] || { echo "Run with sudo: sudo sh rollback.sh"; exit 1; }
BAK=bak-0.4.0-20261023
cp -p /opt/beehave-agent/agent.py.$BAK /opt/beehave-agent/agent.py
cp -p /opt/beehave-setup/service.py.$BAK /opt/beehave-setup/service.py
systemctl restart beehave-setup
systemctl restart beehave-agent
for unit in beehave-setup beehave-agent beehave-continuous; do printf '  %s: ' "$unit"; systemctl is-active "$unit" || true; done
echo "Rolled back to agent 0.4.0 and the previous setup service."
