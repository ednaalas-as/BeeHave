#!/usr/bin/env python3
"""Runs as root before the agent starts: copies the paired device key into RAM.

The key stays in /var/lib/beehave-setup (root only); the agent receives a copy in
/run/beehave-agent that only it can read and that disappears on reboot. The key
is never printed.
"""
import json
import os
from pathlib import Path
import pwd
import sys

PAIRING = Path(os.environ.get("BEEHAVE_PAIRING_FILE", "/var/lib/beehave-setup/pairing.json"))
TARGET = Path(os.environ.get("BEEHAVE_DEVICE_KEY_FILE", "/run/beehave-agent/device.key"))
# The device ID is not secret; the agent derives observation identities from it.
DEVICE_ID = Path(os.environ.get("BEEHAVE_DEVICE_ID_FILE", str(TARGET.with_name("device.id"))))
OWNER = os.environ.get("BEEHAVE_AGENT_USER", "beehave-agent")


def main():
    TARGET.unlink(missing_ok=True)
    DEVICE_ID.unlink(missing_ok=True)
    try:
        pairing = json.loads(PAIRING.read_text())
    except (OSError, ValueError):
        pairing = {}
    key = pairing.get("key") if pairing.get("completed") else None
    if not isinstance(key, str) or not key:
        print("This Pi is not paired with a BeeHave farm; the agent will wait.", flush=True)
        return 0
    descriptor = os.open(TARGET, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o400)
    with os.fdopen(descriptor, "w") as handle:
        handle.write(key)
    device = pairing.get("deviceId")
    if isinstance(device, str) and device:
        DEVICE_ID.write_text(device)
        os.chmod(DEVICE_ID, 0o444)
    if os.geteuid() == 0:
        user = pwd.getpwnam(OWNER)
        os.chown(TARGET, user.pw_uid, user.pw_gid)
    print("Device key loaded for the BeeHave agent.", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
