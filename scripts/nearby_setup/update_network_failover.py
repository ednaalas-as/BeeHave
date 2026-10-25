#!/usr/bin/env python3
"""Install (or roll back) the Wi-Fi failover update of the nearby setup service.

  sudo python3 update_network_failover.py            install
  sudo python3 update_network_failover.py --rollback restore the previous files

Changes only /opt/beehave-setup (service.py, portal files, new wifi_profiles.py),
renames the setup hotspot's network name to HOTSPOT_SSID (its WPA2 password is
unchanged) and updates that one line of the private setup label, then restarts
only beehave-setup.service. Saved client Wi-Fi profiles, setup identity, pairing,
the BeeHave agent, monitoring, and every data file are left untouched. Every file
is verified by hash before anything is replaced.
"""
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

TARGET = Path('/opt/beehave-setup')
LABEL = Path('/var/lib/beehave-setup/setup-label.txt')
HOTSPOT = 'beehave-setup-hotspot'
HOTSPOT_SSID = 'BeeHave-01-Setup'
SUFFIX = '.before-network-failover'
# Installed versions this update may replace: the original Phase 1 service and the
# known-networks update (update_management.py) in case that was installed first.
REPLACEABLE = {
    'service.py': {'4ddb7353f44cfbb4b72a0cca19565b2ea4714ccdc8ae17a92bd3d28e64bf91df',
                   'e5d369eb603de332d011b6dd3ffdd20570078f12e1be72fb438cbc4009ec0a7c'},
    'portal.html': {'4eebf9397138898f7220c59241a5642eef1998f88b5f42ccbc3e27d7feb5dd4d'},
    'portal.js': {'af26a331ab4d6c20d5b90af98f60a088a7343fb95f775883e75810146027a770'},
}
NEW = {
    'service.py': '89c0eba808808811d7ce8331638ea1c1f6536effc6cded874c591179043acafc',
    'portal.html': '68a616e4810235a026f1011646c5c36cc667e2cf2af754aca0a2870331893ed9',
    'portal.js': '5c4a118c49a8731861d24d050d86b8ab6a59f66997ad795c43c66cf98223463a',
    'wifi_profiles.py': '12e5385f738d9f1bb1853e1f4e7dc37fce0c1e6cea7b013ff32a7dd4f194e16c',
}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def restart():
    subprocess.run(['systemctl', 'restart', 'beehave-setup.service'], check=True)
    time.sleep(3)
    subprocess.run(['systemctl', 'is-active', '--quiet', 'beehave-setup.service'], check=True)


def write(path, data, mode):
    temporary = path.with_name(path.name + '.network-failover-update')
    with temporary.open('xb') as output:
        output.write(data)
    temporary.chmod(mode)
    os.replace(temporary, path)


def nm(*args):
    return subprocess.run(['nmcli', *args], capture_output=True, text=True, timeout=30, check=True).stdout.strip()


def hotspot_ssid():
    return nm('-g', '802-11-wireless.ssid', 'connection', 'show', HOTSPOT)


def rename_hotspot(ssid):
    """Network name only; mode, WPA2 security, password, and address stay as installed.
    An active hotspot keeps its old name until it is next started."""
    nm('connection', 'modify', HOTSPOT, '802-11-wireless.ssid', ssid)
    if LABEL.is_file():
        lines = LABEL.read_text().splitlines(keepends=True)
        LABEL.write_text(''.join(f'Wi-Fi: {ssid}\n' if line.startswith('Wi-Fi: ') else line for line in lines))


def rollback():
    backups = [TARGET / (name + SUFFIX) for name in REPLACEABLE]
    if not all(b.is_file() for b in backups):
        sys.exit('No complete backup from this update was found. Nothing was changed.')
    for backup in backups:
        shutil.copy2(backup, backup.with_name(backup.name[:-len(SUFFIX)]))
    (TARGET / 'wifi_profiles.py').unlink(missing_ok=True)
    previous = TARGET / ('hotspot-ssid' + SUFFIX)
    if previous.is_file():
        rename_hotspot(previous.read_text().strip())
        previous.unlink()
    restart()
    # The originals are back in place; the copies would only block a later re-install.
    for backup in backups:
        backup.unlink()
    print('Restored the previous setup service. Wi-Fi profiles changed with the helper keep their new priorities.')


def install():
    source = Path(__file__).resolve().parent
    for name, expected in NEW.items():
        if not (source / name).is_file() or digest(source / name) != expected:
            sys.exit(f'Bundled {name} does not match this update. Nothing was changed.')
    if all((TARGET / n).is_file() and digest(TARGET / n) == h for n, h in NEW.items()):
        print('This update is already installed. Nothing was changed.')
        return
    for name, allowed in REPLACEABLE.items():
        path = TARGET / name
        if path.is_symlink() or not path.is_file() or digest(path) not in allowed:
            sys.exit(f'The installed {name} differs from the verified version. Stop for review; nothing was changed.')
        if path.with_name(name + SUFFIX).exists():
            sys.exit('A backup from an earlier attempt exists. Review it (or --rollback) first; nothing was changed.')
    if (TARGET / 'wifi_profiles.py').exists():
        sys.exit('An unexpected wifi_profiles.py is already installed. Nothing was changed.')
    compile((source / 'service.py').read_text(), 'service.py', 'exec')
    old_ssid = hotspot_ssid()
    if not old_ssid:
        sys.exit('The BeeHave setup hotspot profile was not found. Nothing was changed.')
    for name in REPLACEABLE:
        shutil.copy2(TARGET / name, TARGET / (name + SUFFIX))
    (TARGET / ('hotspot-ssid' + SUFFIX)).write_text(old_ssid + '\n')  # not secret
    for name in REPLACEABLE:
        write(TARGET / name, (source / name).read_bytes(), (TARGET / name).stat().st_mode & 0o777)
    write(TARGET / 'wifi_profiles.py', (source / 'wifi_profiles.py').read_bytes(), 0o755)
    try:
        rename_hotspot(HOTSPOT_SSID)
        restart()
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError):
        rollback()
        sys.exit('The updated setup service did not start; the previous version was restored.')
    print('Updated only beehave-setup.service. Saved Wi-Fi profiles, setup identity, pairing, '
          'the agent, monitoring, and data were not changed.')
    print(f'Setup hotspot renamed from {old_ssid} to {HOTSPOT_SSID}; its password is unchanged. '
          'Update the network name on the printed label (the label file was updated).')
    print('Wi-Fi helper: sudo python3 /opt/beehave-setup/wifi_profiles.py list')


def main():
    if os.geteuid() != 0:
        sys.exit('Run this setup-service update with sudo.')
    rollback() if sys.argv[1:] == ['--rollback'] else install()


if __name__ == '__main__':
    main()
