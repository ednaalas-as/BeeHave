#!/bin/sh
# BeeHave agent 0.4.0 = the installed agent 0.3.1 (update 20261022b) plus:
#   - device status follows the run being written (correct after a reboot clock jump);
#   - automatic BRTC upload of closed WAV recordings (audio_sync.py), resumable, verified by the API;
#   - observation sync retries at most every 60 s (was up to 300 s) and resumes as soon as the API answers.
# Monitoring (beehave-continuous), its runs folder, WAVs and the sync outbox are not modified.
#
# Run on the Pi from this folder:
#   sudo sh install.sh                 install the code (audio upload stays as configured: off by default)
#   sudo sh install.sh --enable-audio  also turn on automatic audio upload for every recording in the outbox
# To undo: sudo sh rollback.sh
set -eu
cd "$(dirname "$0")"
[ "$(id -u)" = 0 ] || { echo "Run with sudo: sudo sh install.sh"; exit 1; }
ENV=/etc/beehave-agent/agent.env
BAK=bak-0.3.1-20261022

echo "Checking the installed agent is the 0.3.1 this update was built from..."
echo "403ff129362f8e94a90969c23783e664e26fc40015a374c25af6e64a011fcf15  /opt/beehave-agent/agent.py" | sha256sum -c - \
  || { echo "The installed agent is not 0.3.1; nothing was changed."; exit 1; }
sha256sum -c SHA256SUMS
[ ! -e /opt/beehave-agent/agent.py.$BAK ] || { echo "A backup from this update already exists; nothing was changed."; exit 1; }
if [ "${1:-}" = "--enable-audio" ]; then
  grep -q '^BEEHAVE_SYNC_ENABLED=1' $ENV || { echo "Observation sync is not enabled in $ENV; audio needs it. Nothing was changed."; exit 1; }
  if grep -q '^BEEHAVE_AUDIO_RECORDING_ID=' $ENV; then
    echo "Note: BEEHAVE_AUDIO_RECORDING_ID is set, so only that one recording will upload."
  fi
fi

echo "Backing up the current files..."
cp -p /opt/beehave-agent/agent.py /opt/beehave-agent/agent.py.$BAK
cp -p /opt/beehave-agent/sync.py /opt/beehave-agent/sync.py.$BAK
cp -p $ENV $ENV.$BAK
echo "  previous sync.py: $(sha256sum /opt/beehave-agent/sync.py | cut -d' ' -f1)"

echo "Installing..."
install -o root -g root -m 644 agent.py /opt/beehave-agent/agent.py
install -o root -g root -m 644 sync.py /opt/beehave-agent/sync.py
install -o root -g root -m 644 audio_sync.py /opt/beehave-agent/audio_sync.py
if [ "${1:-}" = "--enable-audio" ] && ! grep -q '^BEEHAVE_AUDIO_ENABLED=1' $ENV; then
  sed -i '/^BEEHAVE_AUDIO_ENABLED=/d' $ENV
  printf '%s\n' '# Automatic BRTC upload of closed recordings (agent 0.4.0). Originals stay on the Pi.' 'BEEHAVE_AUDIO_ENABLED=1' >> $ENV
fi
systemctl restart beehave-agent
sleep 8
if ! systemctl is-active --quiet beehave-agent; then
  echo "The new agent did not start; restoring the previous one."
  sh rollback.sh
  exit 1
fi

echo "Status:"
for unit in beehave-agent beehave-continuous; do printf '  %s: ' "$unit"; systemctl is-active "$unit" || true; done
journalctl -u beehave-agent -n 5 --no-pager -o cat
echo "Done. Watch uploads with: journalctl -u beehave-agent -f | grep -i audio"
