#!/usr/bin/env python3
"""Manage the Pi's saved Wi-Fi profiles through NetworkManager (run with sudo).

  list                              saved Wi-Fi profiles, without passwords
  priority PROFILE N                autoconnect on, autoconnect-priority N (0-100)
  autoconnect PROFILE on|off        enable or disable automatic use
  add SSID [--priority N] [--hidden] [--open]
                                    save a network for later; the password is asked
                                    for without echo and never put on a command line

PROFILE is a connection name exactly as listed (quote names with spaces) or its UUID.
Nothing is ever deleted, the active connection is never switched, and the BeeHave
setup hotspot (or any other access-point profile) is never modified.
"""
import argparse
import getpass
import os
from pathlib import Path
import subprocess
import sys
import uuid

PROFILES = Path('/etc/NetworkManager/system-connections')


def nm(*args):
    return subprocess.run(['nmcli', *args], capture_output=True, text=True, timeout=30, check=True).stdout


def fields(row):
    """Split one `nmcli -t` row; names may contain escaped ':' and '\\'."""
    parts, current, escaped = [], '', False
    for char in row:
        if escaped:
            current += char
            escaped = False
        elif char == '\\':
            escaped = True
        elif char == ':':
            parts.append(current)
            current = ''
        else:
            current += char
    parts.append(current)
    return parts


def wifi_profiles():
    profiles = []
    for row in nm('-t', '-f', 'NAME,UUID,TYPE,AUTOCONNECT,AUTOCONNECT-PRIORITY,ACTIVE', 'connection', 'show').splitlines():
        parts = fields(row)
        if len(parts) != 6 or parts[2] != '802-11-wireless':
            continue
        mode, ssid = (nm('-g', '802-11-wireless.mode,802-11-wireless.ssid', 'connection', 'show', 'uuid', parts[1]).rstrip('\n').split('\n', 1) + [''])[:2]
        profiles.append({'name': parts[0], 'uuid': parts[1], 'autoconnect': parts[3], 'priority': parts[4],
                         'active': parts[5], 'mode': mode, 'ssid': ssid})
    return profiles


def find(target):
    matches = [p for p in wifi_profiles() if target in (p['uuid'], p['name'])]
    if not matches:
        sys.exit(f'No saved Wi-Fi profile named {target!r}. Run "list" to see exact names.')
    if len(matches) > 1:
        sys.exit(f'Several profiles are named {target!r}; use one of their UUIDs from "list".')
    profile = matches[0]
    if profile['mode'] == 'ap':
        sys.exit('That is an access-point (setup hotspot) profile; it is managed by BeeHave setup and was not changed.')
    return profile


def show():
    rows = sorted(wifi_profiles(), key=lambda p: (p['autoconnect'] != 'yes', -int(p['priority'] or 0), p['name']))
    print(f"{'PRIORITY':>8}  {'AUTO':4}  {'ACTIVE':6}  NAME  [SSID]  UUID")
    for p in rows:
        ssid = '' if p['ssid'] == p['name'] else f"  [{p['ssid']}]"
        note = '  (setup hotspot, managed by BeeHave)' if p['mode'] == 'ap' else ''
        print(f"{p['priority']:>8}  {p['autoconnect']:4}  {p['active']:6}  {p['name']!r}{ssid}  {p['uuid']}{note}")


def priority_value(text):
    value = int(text)
    if not 0 <= value <= 100:
        raise argparse.ArgumentTypeError('priority must be 0-100')
    return value


def add(ssid, priority, hidden, open_network):
    if not 1 <= len(ssid.encode()) <= 32:
        sys.exit('The network name (SSID) must be 1-32 bytes.')
    security = ''
    if not open_network:
        password = getpass.getpass(f'Wi-Fi password for {ssid}: ')
        if not 8 <= len(password.encode()) <= 63 or '\n' in password or '\r' in password:
            sys.exit('WPA/WPA2 passwords are 8-63 characters. Nothing was saved.')
        escaped = password.replace('\\', '\\\\').replace(' ', '\\s').replace('\t', '\\t')
        security = f'[wifi-security]\nkey-mgmt=wpa-psk\npsk={escaped}\n'
    profile_id = str(uuid.uuid4())
    name = 'beehave-wifi-' + profile_id
    ssid_bytes = ';'.join(str(byte) for byte in ssid.encode()) + ';'
    keyfile = (f'[connection]\nid={name}\nuuid={profile_id}\ntype=wifi\ninterface-name=wlan0\n'
               f'autoconnect=true\nautoconnect-priority={priority}\n'
               f'[wifi]\nmode=infrastructure\nssid={ssid_bytes}\n' + ('hidden=true\n' if hidden else '') +
               security + '[ipv4]\nmethod=auto\n[ipv6]\nmethod=auto\n')
    path = PROFILES / (name + '.nmconnection')
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as handle:
        handle.write(keyfile)
    # Load only: the current connection is not interrupted. NetworkManager uses
    # the new profile automatically whenever it is the best saved network in range.
    nm('connection', 'load', str(path))
    print(f'Saved {ssid!r} as {name} with priority {priority}. The current connection was not changed.')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('list')
    p = sub.add_parser('priority')
    p.add_argument('profile')
    p.add_argument('value', type=priority_value)
    a = sub.add_parser('autoconnect')
    a.add_argument('profile')
    a.add_argument('state', choices=('on', 'off'))
    n = sub.add_parser('add')
    n.add_argument('ssid')
    n.add_argument('--priority', type=priority_value, default=50)
    n.add_argument('--hidden', action='store_true')
    n.add_argument('--open', action='store_true', help='network without a password')
    args = parser.parse_args()
    if args.command != 'list' and os.geteuid() != 0:
        sys.exit('Changing saved Wi-Fi profiles needs sudo.')
    try:
        if args.command == 'list':
            show()
        elif args.command == 'priority':
            profile = find(args.profile)
            nm('connection', 'modify', 'uuid', profile['uuid'], 'connection.autoconnect', 'yes',
               'connection.autoconnect-priority', str(args.value))
            print(f"{profile['name']!r}: autoconnect yes, priority {args.value}.")
        elif args.command == 'autoconnect':
            profile = find(args.profile)
            nm('connection', 'modify', 'uuid', profile['uuid'], 'connection.autoconnect', 'yes' if args.state == 'on' else 'no')
            print(f"{profile['name']!r}: autoconnect {args.state}.")
        else:
            add(args.ssid, args.priority, args.hidden, args.open)
    except subprocess.CalledProcessError as failure:
        sys.exit(f'NetworkManager refused the change: {(failure.stderr or "").strip()[:300]}')


if __name__ == '__main__':
    main()
