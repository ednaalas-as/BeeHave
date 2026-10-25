#!/usr/bin/env python3
"""One-time administrator installation; never run automatically by the app."""
import argparse
import ipaddress
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import sys
from urllib.parse import urlparse
import uuid


def run(*args):
    subprocess.run(args, check=True)


def main():
    parser = argparse.ArgumentParser(description='Install only the isolated BeeHave nearby setup service.')
    parser.add_argument('--web-origin', action='append', required=True, help='Exact trusted BeeHave web origin, e.g. https://beehave.example; repeat for development origins')
    parser.add_argument('--hotspot-name', help='Setup hotspot network name, e.g. BeeHave-01-Setup (default: BeeHave-Setup-<random>)')
    args = parser.parse_args()
    if args.hotspot_name is not None and (not 1 <= len(args.hotspot_name) <= 32 or not all(c.isalnum() or c in '-_' for c in args.hotspot_name)):
        sys.exit('Use a hotspot name of 1-32 letters, digits, - or _.')
    if os.geteuid() != 0:
        sys.exit('Administrator privileges are needed for this one-time installation.')
    for origin in args.web_origin:
        parsed = urlparse(origin)
        if parsed.scheme not in ('https', 'http') or not parsed.hostname or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment:
            sys.exit('Use exact http(s) origins without paths, credentials, or wildcards.')
    for tool in ('nmcli', 'systemctl', 'ip', 'dnsmasq'):
        if not shutil.which(tool):
            sys.exit(f'Missing {tool}; no installation was performed.')
    source = Path(__file__).resolve().parent
    for name in ('service.py', 'portal.html', 'portal.js', 'beehave-setup.service', 'beehave-setup.service.xml'):
        if not (source / name).is_file():
            sys.exit(f'Missing bundled setup file: {name}')
    profile = Path('/etc/NetworkManager/system-connections/beehave-setup.nmconnection')
    destination = Path('/opt/beehave-setup')
    state = Path('/var/lib/beehave-setup')
    unit = Path('/etc/systemd/system/beehave-setup.service')
    advertisement = Path('/etc/avahi/services/beehave-setup.service')
    # Refuse accidental replacement, including prior setup state. Updates need review.
    if any(p.exists() for p in (profile, destination, state, unit, advertisement)):
        sys.exit('Setup paths already exist. Nothing was overwritten; review the existing installation first.')
    routes = json.loads(subprocess.check_output(['ip', '-j', 'route'], text=True))
    for route in routes:
        network = route.get('dst', 'default')
        if network != 'default' and ipaddress.ip_network(network, strict=False).overlaps(ipaddress.ip_network('192.168.77.0/24')):
            sys.exit('The setup hotspot subnet conflicts with an existing route. Review before installation.')
    destination.mkdir(mode=0o755)
    state.mkdir(mode=0o700)
    for name in ('service.py', 'portal.html', 'portal.js'):
        shutil.copyfile(source / name, destination / name)
    # Isolated runtime; no changes to the monitoring virtual environment.
    run(sys.executable, '-m', 'venv', str(destination / 'venv'))
    python = str(destination / 'venv/bin/python')
    run(python, '-m', 'pip', 'install', 'cryptography==46.0.5')
    run(python, str(destination / 'service.py'), '--initialize')
    (state / 'origins.json').write_text(json.dumps(args.web_origin))
    os.chmod(state / 'origins.json', 0o600)
    identity = json.loads((state / 'identity.json').read_text())
    hotspot_password = secrets.token_hex(12)
    hotspot_name = args.hotspot_name or 'BeeHave-Setup-' + secrets.token_hex(3)
    keyfile = f'''# Managed only by BeeHave nearby setup
[connection]
id=beehave-setup-hotspot
uuid={uuid.uuid4()}
type=wifi
interface-name=wlan0
autoconnect=false
[wifi]
mode=ap
ssid={hotspot_name}
[wifi-security]
key-mgmt=wpa-psk
psk={hotspot_password}
[ipv4]
method=shared
address1=192.168.77.1/24
[ipv6]
method=disabled
'''
    fd = os.open(profile, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as f:
        f.write(keyfile)
    # Load, but do not activate: the current Wi-Fi connection stays up.
    run('nmcli', 'connection', 'load', str(profile))
    label = state / 'setup-label.txt'
    label.write_text(f'BeeHave nearby setup — keep this label private\nWi-Fi: {hotspot_name}\nWi-Fi password: {hotspot_password}\nSetup: http://{socket.gethostname().lower()}.local:8765\nSetup code: {identity["code"]}\n')
    os.chmod(label, 0o600)
    shutil.copyfile(source / 'beehave-setup.service', unit)
    shutil.copyfile(source / 'beehave-setup.service.xml', advertisement)
    run('systemctl', 'daemon-reload')
    run('systemctl', 'enable', '--now', 'beehave-setup.service')
    print('Nearby setup installed. The current Wi-Fi and monitoring service were not restarted.')
    print('Print /var/lib/beehave-setup/setup-label.txt privately for the device owner. Do not paste its contents into chat or logs.')


if __name__ == '__main__':
    main()
