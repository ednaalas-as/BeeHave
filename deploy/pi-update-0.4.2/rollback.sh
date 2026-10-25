#!/bin/sh
# Restores the agent and setup service that install.sh replaced (0.4.0 or 0.4.1).
# Monitoring is not touched. The copy of the setup label already in BeeHave stays there.
set -eu
[ "$(id -u)" = 0 ] || { echo "Run with sudo: sudo sh rollback.sh"; exit 1; }
BAK=bak-before-0.4.2
cp -p /opt/beehave-agent/agent.py.$BAK /opt/beehave-agent/agent.py
for f in service.py portal.html portal.js; do cp -p /opt/beehave-setup/$f.$BAK /opt/beehave-setup/$f; done
systemctl restart beehave-setup
systemctl restart beehave-agent
for unit in beehave-setup beehave-agent beehave-continuous; do printf '  %s: ' "$unit"; systemctl is-active "$unit" || true; done
echo "Rolled back to the previous agent and setup service."
