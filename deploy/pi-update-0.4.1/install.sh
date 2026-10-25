#!/bin/sh
# BeeHave update 0.4.1 = the installed agent 0.4.0 and setup service, plus only:
#   - Wi-Fi Disconnect, Forget, and Priority (0-100) for saved networks, requested from the
#     BeeHave web/mobile app. Leaving the active network first moves to another saved network
#     that reaches BeeHave; if there is none, the Pi stays on it and nothing is deleted.
# Monitoring (beehave-continuous), its runs folder, WAVs and the sync outbox are not modified.
#
# Run on the Pi from this folder:
#   sudo sh install.sh
# To undo: sudo sh rollback.sh
set -eu
cd "$(dirname "$0")"
[ "$(id -u)" = 0 ] || { echo "Run with sudo: sudo sh install.sh"; exit 1; }
BAK=bak-0.4.0-20261023

echo "Checking the installed files are the ones this update was built from..."
printf '%s\n' \
  "f8281f2296bc482cfce48bce02a20b697ef3ebfe8c39112e04ea7ac33fa37769  /opt/beehave-agent/agent.py" \
  "81571ba0c8da824b3009833e12b84469a495e79fa4fa92bf38de34bbe6736ae1  /opt/beehave-setup/service.py" \
  | sha256sum -c - || { echo "The installed agent or setup service is not the expected version; nothing was changed."; exit 1; }
sha256sum -c SHA256SUMS
[ ! -e /opt/beehave-agent/agent.py.$BAK ] && [ ! -e /opt/beehave-setup/service.py.$BAK ] \
  || { echo "A backup from this update already exists; nothing was changed."; exit 1; }

echo "Backing up the current files..."
cp -p /opt/beehave-agent/agent.py /opt/beehave-agent/agent.py.$BAK
cp -p /opt/beehave-setup/service.py /opt/beehave-setup/service.py.$BAK

echo "Installing..."
install -o root -g root -m 644 agent.py /opt/beehave-agent/agent.py
install -o root -g root -m 644 service.py /opt/beehave-setup/service.py
# The setup service restart does not change the current Wi-Fi connection.
systemctl restart beehave-setup
systemctl restart beehave-agent
sleep 8
if ! systemctl is-active --quiet beehave-setup || ! systemctl is-active --quiet beehave-agent; then
  echo "The new version did not start; restoring the previous one."
  sh rollback.sh
  exit 1
fi

echo "Status:"
for unit in beehave-setup beehave-agent beehave-continuous; do printf '  %s: ' "$unit"; systemctl is-active "$unit" || true; done
journalctl -u beehave-agent -n 5 --no-pager -o cat
echo "Done. Agent 0.4.1 installed."
