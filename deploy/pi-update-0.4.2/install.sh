#!/bin/sh
# BeeHave update 0.4.2 = agent/setup service 0.4.1 (or 0.4.0), plus only:
#   - The setup label (setup Wi-Fi name and password, setup code) appears in the BeeHave app
#     for the device's farm owners: Edge Device -> Advanced settings -> Setup label. The agent
#     sends it once it is online, so it can be read later while the Pi is in setup mode.
#     Nobody needs a terminal on the Pi to read /var/lib/beehave-setup/setup-label.txt.
#   - Includes 0.4.1's saved-network Disconnect/Forget/Priority when installed over 0.4.0.
#   - Setup page wording points to the app for the setup code, and a "What happens next" box
#     explains the Wi-Fi switch. The result of a setup page Wi-Fi change is reported to the app.
# Monitoring (beehave-continuous), its runs folder, WAVs and the sync outbox are not modified.
# Wi-Fi, the setup hotspot, its password and the setup code do not change.
#
# Run on the Pi from this folder:
#   sudo sh install.sh
# To undo: sudo sh rollback.sh
set -eu
cd "$(dirname "$0")"
[ "$(id -u)" = 0 ] || { echo "Run with sudo: sudo sh install.sh"; exit 1; }
BAK=bak-before-0.4.2

echo "Checking the installed files are a version this update was built from..."
agent=$(sha256sum /opt/beehave-agent/agent.py | cut -d' ' -f1)
setup=$(sha256sum /opt/beehave-setup/service.py | cut -d' ' -f1)
case "$agent $setup" in
  "e9f2383a8ca0e7b8008a99b9bd5c0945df707ce801a0fc3fb0315676d31d2fed a4c8008b45759f0f93307ad8f3f4e013f0a42ebe594db0fb1ee1524a169068d0") echo "  Installed: 0.4.1" ;;
  "f8281f2296bc482cfce48bce02a20b697ef3ebfe8c39112e04ea7ac33fa37769 81571ba0c8da824b3009833e12b84469a495e79fa4fa92bf38de34bbe6736ae1") echo "  Installed: 0.4.0" ;;
  *) echo "The installed agent or setup service is not 0.4.0 or 0.4.1; nothing was changed."; exit 1 ;;
esac
sha256sum -c SHA256SUMS
for f in /opt/beehave-agent/agent.py /opt/beehave-setup/service.py /opt/beehave-setup/portal.html /opt/beehave-setup/portal.js; do
  [ ! -e "$f.$BAK" ] || { echo "A backup from this update already exists ($f.$BAK); nothing was changed."; exit 1; }
done

echo "Backing up the current files..."
cp -p /opt/beehave-agent/agent.py /opt/beehave-agent/agent.py.$BAK
for f in service.py portal.html portal.js; do cp -p /opt/beehave-setup/$f /opt/beehave-setup/$f.$BAK; done

echo "Installing..."
install -o root -g root -m 644 agent.py /opt/beehave-agent/agent.py
for f in service.py portal.html portal.js; do install -o root -g root -m 644 $f /opt/beehave-setup/$f; done
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
echo "Done. Agent 0.4.2 installed. The setup label appears in the app after the next heartbeat (about 30 seconds)."
