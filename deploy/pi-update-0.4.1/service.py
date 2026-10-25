#!/usr/bin/env python3
"""Isolated nearby setup. Never reads monitoring files or sends monitoring data."""
import argparse
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import secrets
import socket
import struct
import subprocess
import threading
import time
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.request import urlopen

from cryptography.hazmat.primitives import serialization, hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

STATE = Path('/var/lib/beehave-setup')
LOCK = threading.RLock()
CHALLENGES = {}
ALLOWED_ORIGINS = set()
HOTSPOT = 'beehave-setup-hotspot'
# Read-only network status and scans for the BeeHave agent (systemd RuntimeDirectory).
AGENT_SOCKET = Path('/run/beehave-setup/agent.sock')
AGENT_USER = 'beehave-agent'


def save(name, value):
    # Only our fixed state files are writable; no monitoring path is accepted.
    if name not in ('identity.json', 'pairing.json', 'wifi-status.json', 'credential-key.json'):
        raise ValueError('Invalid setup state file')
    path = STATE / name
    temp = path.with_suffix('.tmp')
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as f:
        json.dump(value, f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(temp, path)


def load(name):
    path = STATE / name
    return json.loads(path.read_text()) if path.exists() else {}


def identity():
    info = load('identity.json')
    if not info:
        private = Ed25519PrivateKey.generate()
        info = {'privateKey': private.private_bytes(serialization.Encoding.Raw, serialization.PrivateFormat.Raw, serialization.NoEncryption()).hex(), 'code': secrets.token_hex(16)}
        save('identity.json', info)
    private = Ed25519PrivateKey.from_private_bytes(bytes.fromhex(info['privateKey']))
    public = private.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo).hex()
    return info, private, public


def nm(*args, timeout=20):
    # No shell, no credentials in logs or process arguments.
    return subprocess.run(['nmcli', *args], capture_output=True, text=True, timeout=timeout, check=True).stdout.strip()


DEFAULT_PRIORITY = 50
AGENT_ENV = Path('/etc/beehave-agent/agent.env')
SCAN = {'networks': [], 'at': 0}

FAILURES = {
    'wrong_password': 'Incorrect Wi-Fi password, or the network rejected it. Check the password and try again.',
    'not_found': 'Network not found. Check the network name and that the Pi is in range.',
    'no_ip': 'The Pi joined the Wi-Fi but did not get an IP address from the router.',
    'timeout': 'The connection attempt timed out. Move the Pi closer to the router and try again.',
    'failed': 'The Pi could not connect to this Wi-Fi network.',
    'no_internet': 'The Pi joined the Wi-Fi, but it has no internet access.',
    'cloud_unreachable': 'The Pi joined the Wi-Fi and has internet, but could not reach BeeHave.',
    'portal': 'The Wi-Fi needs a sign-in page (captive portal), which the Pi cannot complete.',
    'interrupted': 'The Wi-Fi change was interrupted before it finished.',
}
CONNECTED = {
    'online': 'Connected to {ssid}. BeeHave Cloud is reachable.',
    'cloud_unreachable': 'Connected to {ssid} with internet, but BeeHave Cloud is unreachable. The network is saved and the Pi keeps retrying.',
    'no_internet': 'Connected to {ssid}, but internet is unavailable. The network is saved.',
    'portal': 'Connected to {ssid}, but it needs a sign-in page (captive portal), which the Pi cannot complete.',
    'connected': 'Connected to {ssid}.',
}


def split_fields(row):
    """Split one `nmcli -t` row, honouring escaped ':' and '\\'."""
    parts, current, escaped = [], '', False
    for char in row:
        if escaped:
            current, escaped = current + char, False
        elif char == '\\':
            escaped = True
        elif char == ':':
            parts.append(current)
            current = ''
        else:
            current += char
    return parts + [current]


def security_label(flags):
    flags = flags.replace('--', '').split()
    if not flags:
        return 'open'
    if '802.1X' in flags:
        return 'enterprise'
    wpa3, wpa2 = 'WPA3' in flags, 'WPA2' in flags or 'WPA1' in flags
    return 'wpa2/wpa3' if wpa3 and wpa2 else 'wpa3' if wpa3 else 'wpa2' if wpa2 else 'wep' if 'WEP' in flags else 'secured'


def fresh_scan(rescan=True):
    """Nearby networks as sanitized SSID/signal/security only (no BSSIDs). Raises if
    the radio refuses to scan (e.g. while it is busy as the setup hotspot)."""
    rows = nm('-t', '-f', 'SSID,SIGNAL,SECURITY', 'device', 'wifi', 'list', 'ifname', 'wlan0', '--rescan', 'yes' if rescan else 'no', timeout=30)
    best = {}
    for row in rows.splitlines():
        parts = split_fields(row) + ['', '']
        ssid, signal, flags = parts[0], parts[1], parts[2]
        if not ssid or len(ssid.encode()) > 32:
            continue  # hidden networks are entered by name instead
        level = int(signal) if signal.isdigit() else 0
        if ssid not in best or level > best[ssid]['signal']:
            best[ssid] = {'ssid': ssid, 'signal': min(level, 100), 'security': security_label(flags)}
    networks = sorted(best.values(), key=lambda n: -n['signal'])[:40]
    if networks:
        SCAN.update(networks=networks, at=int(time.time()))
    return networks


def scan_networks():
    """For the setup page/app: a fresh scan, or the last one taken whenever the Pi
    looked for saved networks if the radio cannot scan right now."""
    try:
        networks = fresh_scan()
    except subprocess.SubprocessError:
        networks = []
    if networks:
        return {'networks': networks, 'scannedAt': SCAN['at'], 'cached': False}
    return {'networks': SCAN['networks'], 'scannedAt': SCAN['at'], 'cached': True}


def classify_failure(error):
    text = (getattr(error, 'stderr', '') or '').lower()
    if isinstance(error, subprocess.TimeoutExpired) or 'timeout expired' in text:
        return 'timeout'
    if 'secrets were required' in text or 'no-secrets' in text or ('supplicant' in text and ('authenticat' in text or 'disconnect' in text)):
        return 'wrong_password'
    if 'could not be found' in text or 'no network with ssid' in text or 'ssid-not-found' in text:
        return 'not_found'
    if 'ip configuration' in text or 'dhcp' in text:
        return 'no_ip'
    return 'failed'


def api_origin():
    try:
        for line in AGENT_ENV.read_text().splitlines():
            if line.startswith('BEEHAVE_API_URL='):
                return line.split('=', 1)[1].strip().strip('"').rstrip('/')
    except OSError:
        pass
    return None


def cloud_reachable():
    """Unauthenticated health probe only; no device key or account credential is sent."""
    origin = api_origin()
    if not origin or not origin.startswith(('http://', 'https://')):
        return None
    try:
        with urlopen(origin + '/api/health', timeout=8) as response:
            return response.status < 500
    except HTTPError as failure:
        return failure.code < 500
    except (URLError, OSError, ValueError):
        return False


def connected_stage():
    """Progressive validation after association + IP: internet, then BeeHave Cloud."""
    try:
        internet = nm('networking', 'connectivity', 'check', timeout=20)
    except subprocess.SubprocessError:
        internet = 'unknown'
    if internet in ('none', 'limited'):
        return 'no_internet'
    if internet == 'portal':
        return 'portal'
    cloud = cloud_reachable()
    if cloud:
        return 'online'
    if cloud is None:
        return 'connected'
    return 'cloud_unreachable' if internet == 'full' else 'no_internet'


def wifi_status(state, stage, ssid, **extra):
    text = (FAILURES.get(stage, FAILURES['failed']) if state == 'failed' else CONNECTED.get(stage, '')).format(ssid=ssid)
    save('wifi-status.json', {'state': state, 'stage': stage, 'ssid': ssid, 'message': text, 'at': int(time.time()), **extra})


def known_security(ssid):
    return next((n['security'] for n in SCAN['networks'] if n['ssid'] == ssid), '')


def write_profile(profile, profile_id, ssid, password, hidden):
    """Write a NEW, exclusively owned NetworkManager keyfile (0600, never auto-joined until it
    has worked). The password goes only into this root-only file, never into arguments or logs."""
    profile_name = 'beehave-wifi-' + profile_id
    if password:
        escaped_password = password.replace('\\', '\\\\').replace(' ', '\\s').replace('\t', '\\t')
        key_mgmt = 'sae' if known_security(ssid) == 'wpa3' else 'wpa-psk'
        security = f'[wifi-security]\nkey-mgmt={key_mgmt}\npsk={escaped_password}\n'
    else:
        security = ''  # explicitly requested open network
    ssid_bytes = ';'.join(str(byte) for byte in ssid.encode()) + ';'
    keyfile = (
        f'[connection]\nid={profile_name}\nuuid={profile_id}\ntype=wifi\ninterface-name=wlan0\nautoconnect=false\n'
        f'[wifi]\nmode=infrastructure\nssid={ssid_bytes}\n' + ('hidden=true\n' if hidden else '') +
        security + '[ipv4]\nmethod=auto\n[ipv6]\nmethod=auto\n'
    )
    fd = os.open(profile, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as f:
        f.write(keyfile)
        f.flush()
        os.fsync(f.fileno())  # survives power loss once loaded


def connect_wifi(ssid, password, priority=DEFAULT_PRIORITY, hidden=False):
    time.sleep(2)  # Let the encrypted response reach the phone before changing networks.
    profile_id = str(uuid.uuid4())
    # Only create a NEW, exclusively owned NetworkManager profile. Never rewrite
    # a saved profile, even when the SSID already exists.
    profile = Path('/etc/NetworkManager/system-connections') / ('beehave-wifi-' + profile_id + '.nmconnection')
    previous = None
    created = False
    try:
        previous = nm('-g', 'GENERAL.CON-UUID', 'device', 'show', 'wlan0')
        created = True  # from here on, failure cleanup removes whatever this attempt wrote
        write_profile(profile, profile_id, ssid, password, hidden)
        nm('connection', 'load', str(profile))
        nm('--wait', '35', 'connection', 'up', 'uuid', profile_id, timeout=40)
        if not nm('-g', 'IP4.ADDRESS', 'device', 'show', 'wlan0'):
            raise subprocess.CalledProcessError(1, 'nmcli', stderr='ip configuration unavailable')
        # Associated with an address: the credentials are valid, so the network is saved
        # for automatic use even if internet or BeeHave Cloud is down right now.
        nm('connection', 'modify', 'uuid', profile_id, 'connection.autoconnect', 'yes', 'connection.autoconnect-priority', str(priority))
        wifi_status('connected', connected_stage(), ssid)
    except (subprocess.SubprocessError, OSError) as error:
        wifi_status('failed', classify_failure(error), ssid)
        try:
            if previous and previous != '--' and previous != profile_id:
                nm('connection', 'up', 'uuid', previous, timeout=40)
            else:
                nm('connection', 'up', HOTSPOT, timeout=40)
        except subprocess.SubprocessError:
            pass  # the watch loop restores a saved network or the setup hotspot
        if created:
            # Remove only the profile this attempt created; it never connected.
            try:
                nm('connection', 'delete', 'uuid', profile_id)
            except subprocess.SubprocessError:
                profile.unlink(missing_ok=True)


def command(data):
    info, private, public = identity()
    action = data.get('action')
    if action == 'status':
        return {'wifi': load('wifi-status.json'), 'paired': load('pairing.json').get('completed', False)}
    if action == 'scan':
        return scan_networks()
    if action == 'wifi':
        ssid, password = data.get('ssid', ''), data.get('password', '')
        open_network, hidden = data.get('open') is True, data.get('hidden') is True
        if not isinstance(ssid, str) or not 1 <= len(ssid.encode()) <= 32 or '\n' in ssid or not isinstance(password, str) or '\n' in password or '\r' in password:
            raise ValueError('Enter the Wi-Fi network name (1–32 characters).')
        if open_network and password:
            raise ValueError('Leave the password empty for an open network.')
        if not open_network and not 8 <= len(password.encode()) <= 63:
            raise ValueError('Enter the 8–63 character Wi-Fi password, or choose an open network. Enterprise networks are not supported.')
        priority = data.get('priority', DEFAULT_PRIORITY)
        if priority in (None, ''):
            priority = DEFAULT_PRIORITY
        if isinstance(priority, bool) or not isinstance(priority, int) or not 0 <= priority <= 100:
            raise ValueError('Connection priority must be a whole number from 0 to 100.')
        if load('wifi-status.json').get('state') == 'connecting':
            raise ValueError('A Wi-Fi connection attempt is already in progress.')
        save('wifi-status.json', {'state': 'connecting', 'ssid': ssid, 'message': f'Connecting to {ssid}…', 'at': int(time.time())})
        threading.Thread(target=connect_wifi, args=(ssid, password, priority, hidden), daemon=True).start()
        return {'message': f'Connecting to {ssid}. This setup connection will drop while the Pi switches networks. '
                           'If it cannot connect, the BeeHave setup hotspot returns within about a minute: rejoin it and check the status.'}
    pair = load('pairing.json')
    if action == 'release':
        # Only reached through the encrypted, setup-code authenticated channel.
        # A hash check makes retries safe: never rotate a newly prepared key twice.
        if pair and hashlib.sha256(pair['key'].encode()).hexdigest() == data.get('keyHash'):
            save('pairing.json', {'key': secrets.token_hex(32)})
        return {'released': True}
    if action == 'invite':
        # Reuse the key even across expired attempts: a lost completion response
        # must never rotate a key that the API has already registered.
        if not pair:
            pair = {'key': secrets.token_hex(32)}
        pair.update(nonce=secrets.token_hex(32), expires=int(time.time() * 1000) + 600000)
        save('pairing.json', pair)
        key_hash = hashlib.sha256(pair['key'].encode()).hexdigest()
        message = f"beehave-pair-v1\n{pair['nonce']}\n{key_hash}\n{pair['expires']}"
        return {'ticket': {'publicKey': public, 'nonce': pair['nonce'], 'keyHash': key_hash, 'expires': pair['expires'], 'signature': private.sign(message.encode()).hex()}}
    if action == 'confirm':
        if not pair or pair.get('expires', 0) <= time.time() * 1000:
            raise ValueError('Pairing invitation expired. Start again.')
        for name in ('session', 'deviceId', 'challenge'):
            value = data.get(name)
            if not isinstance(value, str) or not 1 <= len(value) <= 128 or '\n' in value:
                raise ValueError('Invalid pairing confirmation')
        if pair.get('completed') and pair.get('deviceId') != data['deviceId']:
            raise ValueError('This Pi is already paired. Its credential was not changed.')
        pair.update(session=data['session'], deviceId=data['deviceId'])
        save('pairing.json', pair)  # Persist key + association BEFORE signing receipt.
        key_hash = hashlib.sha256(pair['key'].encode()).hexdigest()
        message = f"beehave-confirm-v1\n{data['session']}\n{data['challenge']}\n{data['deviceId']}\n{key_hash}"
        return {'signature': private.sign(message.encode()).hex()}
    if action == 'finished':
        if pair.get('session') != data.get('session') or pair.get('deviceId') != data.get('deviceId'):
            raise ValueError('Pairing association does not match. Retry pairing to recover.')
        pair['completed'] = True
        save('pairing.json', pair)
        return {'completed': True}
    raise ValueError('Unsupported setup operation')


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass  # Never log request bodies, codes, Wi-Fi passwords, or credentials.

    def allowed(self):
        peer = ipaddress.ip_address(self.client_address[0])
        if not (peer.is_private or peer.is_link_local or peer.is_loopback):
            return False
        host = self.headers.get('Host', '').split(':')[0].lower()
        if host not in (socket.gethostname().lower() + '.local', 'beehave-pi.local', '192.168.77.1', 'localhost', '127.0.0.1'):
            return False
        origin = self.headers.get('Origin')
        # Setup portal only originates from this Pi. App origins are installed explicitly.
        return not origin or origin in ALLOWED_ORIGINS or origin == 'http://' + self.headers.get('Host', '')

    def reply(self, value, status=200):
        body = json.dumps(value).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        origin = self.headers.get('Origin')
        if origin and self.allowed():
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        if not self.allowed():
            return self.reply({}, 403)
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', self.headers.get('Origin', ''))
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Access-Control-Allow-Private-Network', 'true')
        self.end_headers()

    def do_GET(self):
        if not self.allowed():
            return self.reply({}, 403)
        if self.path in ('/', '/portal.js'):
            # Serve the Wi-Fi page only on the protected setup hotspot, not the LAN.
            if self.connection.getsockname()[0] != '192.168.77.1' or not ipaddress.ip_address(self.client_address[0]) in ipaddress.ip_network('192.168.77.0/24'):
                return self.reply({'error': 'Join the protected BeeHave setup hotspot to open Wi-Fi setup.'}, 403)
            filename = 'portal.html' if self.path == '/' else 'portal.js'
            body = (Path(__file__).parent / filename).read_bytes()
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8' if self.path == '/' else 'text/javascript')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'")
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path == '/info':
            _, _, public = identity()
            return self.reply({'id': hashlib.sha256(bytes.fromhex(public)).hexdigest(), 'name': socket.gethostname(), 'url': 'http://' + socket.gethostname().lower() + '.local:8765'})
        if self.path == '/challenge':
            with LOCK:
                now = time.monotonic()
                for nonce, expiry in list(CHALLENGES.items()):
                    if expiry < now:
                        del CHALLENGES[nonce]
                if len(CHALLENGES) >= 64:
                    return self.reply({}, 429)
                nonce = secrets.token_hex(24)
                CHALLENGES[nonce] = now + 30
            return self.reply({'nonce': nonce})
        return self.reply({}, 404)

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def do_POST(self):
        if not self.allowed() or self.path != '/command':
            return self.reply({}, 403)
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 16384:
                return self.reply({}, 413)
            request = json.loads(self.rfile.read(length))
            with LOCK:
                nonce = request['nonce']
                expiry = CHALLENGES.pop(nonce, 0)
                if expiry < time.monotonic():
                    return self.reply({}, 403)
                iv = bytes.fromhex(nonce)
                info, _, _ = identity()
                key = hashlib.sha256(('beehave-local-v1\n' + info['code']).encode()).digest()
                client_nonce = bytes.fromhex(request['clientNonce'])
                if len(client_nonce) != 32:
                    return self.reply({}, 400)
                key = HKDF(algorithm=hashes.SHA256(), length=32, salt=iv, info=client_nonce).derive(key)
                aes = AESGCM(key)
                data = json.loads(aes.decrypt(iv[:12], bytes.fromhex(request['ciphertext']), None))
                try:
                    result = command(data)
                except ValueError as error:
                    result = {'error': str(error)}
                ciphertext = aes.encrypt(iv[12:], json.dumps(result).encode(), None).hex()
            self.reply({'ciphertext': ciphertext})
        except Exception:
            self.reply({'error': 'Setup request could not be verified.'}, 400)


CREDENTIAL_INFO = b'beehave-wifi-credential-v1'


def credential_key():
    """X25519 key for Wi-Fi passwords sent through BeeHave. The private half stays in the
    root-only state directory; only the public half is ever reported."""
    with LOCK:
        info = load('credential-key.json')
        if not info.get('privateKey'):
            info = {'privateKey': X25519PrivateKey.generate().private_bytes(
                serialization.Encoding.Raw, serialization.PrivateFormat.Raw, serialization.NoEncryption()).hex()}
            save('credential-key.json', info)
    private = X25519PrivateKey.from_private_bytes(bytes.fromhex(info['privateKey']))
    public = private.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    return private, public


def open_credential(envelope, command_id, ssid):
    """Decrypt a sealed Wi-Fi password (see packages/shared/src/wifi-credential.ts). Bound to
    this request and network name; any tampering fails authentication."""
    if not isinstance(envelope, dict) or envelope.get('v') != 1:
        raise ValueError('Unsupported Wi-Fi credential')
    private, public = credential_key()
    ephemeral = bytes.fromhex(envelope['epk'])
    shared = private.exchange(X25519PublicKey.from_public_bytes(ephemeral))
    key = HKDF(algorithm=hashes.SHA256(), length=32, salt=ephemeral + public, info=CREDENTIAL_INFO).derive(shared)
    aad = f'beehave-wifi-v1\n{command_id}\n{ssid}'.encode()
    try:
        return AESGCM(key).decrypt(bytes.fromhex(envelope['nonce']), bytes.fromhex(envelope['ct']), aad).decode()
    except Exception:
        raise ValueError('The Wi-Fi password could not be verified.') from None


def iso(epoch):
    return datetime.fromtimestamp(epoch, timezone.utc).isoformat() if epoch else None


def network_status():
    """Secret-free summary of the Pi's network for the agent. Read-only: no rescan, no
    profile is changed. Never includes passwords, BSSIDs, or profile secrets."""
    devices = {}
    for row in nm('-t', '-f', 'DEVICE,TYPE,STATE,CONNECTION', 'device').splitlines():
        parts = split_fields(row)
        if len(parts) >= 4:
            devices[parts[0]] = parts
    up = lambda name: name in devices and devices[name][2].startswith('connected') and devices[name][3] not in ('', '--')
    setup_mode = up('wlan0') and devices['wlan0'][3] == HOTSPOT
    method = 'setup' if setup_mode else 'wifi' if up('wlan0') else 'ethernet' if up('eth0') else 'offline'
    status = {'method': method, 'setupMode': setup_mode}
    visible = {}
    try:
        for row in nm('-t', '-f', 'ACTIVE,SSID,SIGNAL', 'device', 'wifi', 'list', 'ifname', 'wlan0', '--rescan', 'no').splitlines():
            active, ssid, signal = (split_fields(row) + ['', '', ''])[:3]
            level = min(int(signal), 100) if signal.isdigit() else 0
            if ssid and len(ssid.encode()) <= 32:
                visible[ssid] = max(visible.get(ssid, 0), level)
                if active == 'yes' and method == 'wifi':
                    status.update(ssid=ssid, signal=level)
    except subprocess.SubprocessError:
        pass
    interface = 'wlan0' if method in ('wifi', 'setup') else 'eth0' if method == 'ethernet' else None
    if interface:
        try:
            address = nm('-g', 'IP4.ADDRESS', 'device', 'show', interface).split('|')[0].split('/')[0].strip()
            if address:
                status['ipAddress'] = address
        except subprocess.SubprocessError:
            pass
    try:
        # NetworkManager's last connectivity result; no new check is triggered.
        internet = nm('-t', '-f', 'CONNECTIVITY', 'general')
        status['internet'] = internet if internet in ('full', 'limited', 'portal', 'none') else 'unknown'
    except subprocess.SubprocessError:
        status['internet'] = 'unknown'
    saved, last = [], 0
    for row in nm('-t', '-f', 'NAME,UUID,TYPE,AUTOCONNECT,AUTOCONNECT-PRIORITY,TIMESTAMP,ACTIVE', 'connection', 'show').splitlines():
        parts = split_fields(row)
        if len(parts) != 7 or parts[2] != '802-11-wireless':
            continue
        details = nm('-g', '802-11-wireless.mode,802-11-wireless.ssid', 'connection', 'show', 'uuid', parts[1]).split('\n', 1)
        if len(details) != 2 or details[0] == 'ap' or not details[1] or len(details[1].encode()) > 32:
            continue  # the setup hotspot is not a farmer network
        stamp = int(parts[5]) if parts[5].isdigit() else 0
        last = max(last, stamp)
        saved.append({
            'id': parts[1][:64],
            'ssid': details[1],
            'profile': parts[0][:64],
            'autoconnect': parts[3] == 'yes',
            'priority': int(parts[4]) if parts[4].lstrip('-').isdigit() else 0,
            'active': parts[6] == 'yes',
            'inRange': details[1] in visible,
            '_stamp': stamp,
        })
    # NetworkManager's own order: auto-join first, then priority, then most recently used.
    saved.sort(key=lambda n: (n['autoconnect'], n['priority'], n['_stamp']), reverse=True)
    for network in saved:
        del network['_stamp']
    status['saved'] = saved[:30]
    status['credentialKey'] = credential_key()[1].hex()
    if last:
        status['lastConnectedAt'] = iso(last)
    attempt = load('wifi-status.json')
    if attempt.get('state') in ('failed', 'interrupted') and attempt.get('at'):
        status['lastFailure'] = {
            'ssid': str(attempt.get('ssid', ''))[:32],
            'stage': str(attempt.get('stage', attempt['state']))[:40],
            'message': str(attempt.get('message') or 'The last Wi-Fi change did not finish.')[:200],
            'at': iso(attempt['at']),
        }
    return status


class Unusable(Exception):
    """Joined the network, but BeeHave cannot be reached from it."""
    def __init__(self, stage):
        super().__init__(stage)
        self.stage = stage


def active_wifi():
    """(profile UUID, SSID) currently active on wlan0, or (None, None)."""
    try:
        profile = nm('-g', 'GENERAL.CON-UUID', 'device', 'show', 'wlan0')
    except subprocess.SubprocessError:
        return None, None
    if not profile or profile == '--':
        return None, None
    try:
        details = nm('-g', '802-11-wireless.mode,802-11-wireless.ssid', 'connection', 'show', 'uuid', profile).split('\n', 1)
    except subprocess.SubprocessError:
        return profile, None
    return profile, (details[1] if len(details) == 2 and details[0] != 'ap' else None)


def saved_profile(profile, ssid):
    """A saved client profile for this network, or None. Saved profiles are activated, never edited."""
    for row in nm('-t', '-f', 'UUID,TYPE', 'connection', 'show').splitlines():
        uuid_, kind = (split_fields(row) + ['', ''])[:2]
        if uuid_ == profile and kind == '802-11-wireless':
            details = nm('-g', '802-11-wireless.mode,802-11-wireless.ssid', 'connection', 'show', 'uuid', profile).split('\n', 1)
            if len(details) == 2 and details[0] != 'ap' and details[1] == ssid:
                return profile
    return None


def cloud_join(ssid, password, hidden=False, profile=None):
    """Switch Wi-Fi for a BeeHave request. Success means joined, an address, internet, and
    BeeHave reachable from the new network; anything less returns to the previous network
    (or another saved one, or the setup hotspot) and removes only what this attempt created."""
    previous, previous_ssid = active_wifi()
    if previous_ssid and previous_ssid == ssid and not password:
        return {'result': 'connected', 'stage': 'online', 'ssid': ssid, 'current': ssid}
    profile_id = profile or str(uuid.uuid4())
    path = Path('/etc/NetworkManager/system-connections') / ('beehave-wifi-' + profile_id + '.nmconnection')
    created = False
    try:
        if not profile:
            created = True
            write_profile(path, profile_id, ssid, password, hidden)
            nm('connection', 'load', str(path))
        nm('--wait', '35', 'connection', 'up', 'uuid', profile_id, timeout=40)
        if not nm('-g', 'IP4.ADDRESS', 'device', 'show', 'wlan0'):
            raise subprocess.CalledProcessError(1, 'nmcli', stderr='ip configuration unavailable')
        stage = connected_stage()
        if stage != 'online':
            raise Unusable(stage)
        if created:
            # Proven usable: save it for automatic use, below the networks already preferred.
            nm('connection', 'modify', 'uuid', profile_id, 'connection.autoconnect', 'yes', 'connection.autoconnect-priority', str(DEFAULT_PRIORITY))
        wifi_status('connected', 'online', ssid)
        return {'result': 'connected', 'stage': 'online', 'ssid': ssid, 'current': ssid, **({'previous': previous_ssid} if previous_ssid else {})}
    except (Unusable, subprocess.SubprocessError, OSError) as error:
        stage = error.stage if isinstance(error, Unusable) else classify_failure(error)
        if created:
            try:
                nm('connection', 'delete', 'uuid', profile_id)
            except subprocess.SubprocessError:
                path.unlink(missing_ok=True)
        result = 'setup_mode'
        try:
            if previous and previous != profile_id:
                nm('--wait', '35', 'connection', 'up', 'uuid', previous, timeout=40)
                result = 'restored'
            elif join_known_network():
                result = 'restored'
            else:
                nm('connection', 'up', HOTSPOT, timeout=40)
        except subprocess.SubprocessError:
            try:
                result = 'restored' if join_known_network() else result
                if result == 'setup_mode':
                    nm('connection', 'up', HOTSPOT, timeout=40)
            except subprocess.SubprocessError:
                pass  # the watch loop keeps trying saved networks and the setup hotspot
        wifi_status('failed', stage, ssid)
        _, current = active_wifi()
        return {'result': result, 'stage': stage, 'ssid': ssid,
                **({'previous': previous_ssid} if previous_ssid else {}), **({'current': current} if current else {})}


def wifi_request(data):
    """A Wi-Fi change requested through BeeHave: validate, decrypt, then switch safely."""
    ssid, command_id = data.get('ssid'), data.get('commandId')
    if not isinstance(ssid, str) or not 1 <= len(ssid.encode()) <= 32 or '\n' in ssid or '\r' in ssid:
        return {'result': 'rejected', 'stage': 'invalid', 'ssid': '', 'message': 'Invalid Wi-Fi network name.'}
    if not isinstance(command_id, str) or not 1 <= len(command_id) <= 64:
        return {'result': 'rejected', 'stage': 'invalid', 'ssid': ssid, 'message': 'Invalid request.'}
    hidden = data.get('hidden') is True
    profile = data.get('profile') if isinstance(data.get('profile'), str) else None
    password = ''
    if profile:
        if not saved_profile(profile, ssid):
            return {'result': 'rejected', 'stage': 'not_saved', 'ssid': ssid, 'message': 'That network is no longer saved on the device. Scan again and enter its password.'}
    elif data.get('credential') is not None:
        try:
            password = open_credential(data['credential'], command_id, ssid)
        except (ValueError, KeyError, TypeError):
            return {'result': 'rejected', 'stage': 'credential', 'ssid': ssid, 'message': 'The Wi-Fi password could not be verified. Nothing was changed.'}
        if not 8 <= len(password.encode()) <= 63 or '\n' in password or '\r' in password:
            return {'result': 'rejected', 'stage': 'password', 'ssid': ssid, 'message': 'Wi-Fi passwords are 8–63 characters. Nothing was changed.'}
    if load('wifi-status.json').get('state') == 'connecting':
        return {'result': 'rejected', 'stage': 'busy', 'ssid': ssid, 'message': 'Another Wi-Fi change is already in progress. Nothing was changed.'}
    save('wifi-status.json', {'state': 'connecting', 'ssid': ssid, 'message': f'Connecting to {ssid}…', 'at': int(time.time())})
    try:
        return cloud_join(ssid, password, hidden, profile)
    finally:
        password = ''


def other_network(skip):
    """Join the best other saved network in range from which BeeHave is reachable. Its SSID,
    or None. Saved profiles are only activated, never edited."""
    try:
        visible = visible_ssids()
    except subprocess.SubprocessError:
        visible = None
    for profile, ssid in known_networks():
        if profile == skip or (visible is not None and ssid not in visible):
            continue
        try:
            nm('--wait', '30', 'connection', 'up', 'uuid', profile, timeout=35)
        except subprocess.SubprocessError:
            continue
        if connected_stage() == 'online':
            return ssid
    return None


def manage_network(data):
    """Disconnect from, forget, or reprioritise one saved network, as asked through BeeHave.
    Leaving the active network first moves to another saved network where BeeHave is
    reachable; if there is none, the device goes back to it and nothing is deleted."""
    action, profile, ssid = data.get('action'), data.get('profile'), data.get('ssid')
    name = ssid if isinstance(ssid, str) else ''
    reply = lambda result, stage, message, **extra: {'result': result, 'stage': stage, 'ssid': name, 'message': message, **extra}
    if action not in ('disconnect', 'forget', 'priority'):
        return reply('rejected', 'invalid', 'Unsupported network change. Nothing was changed.')
    if not isinstance(profile, str) or not name or not saved_profile(profile, name):
        return reply('rejected', 'not_saved', 'That network is no longer saved on the device. Nothing was changed.')
    if load('wifi-status.json').get('state') == 'connecting':
        return reply('rejected', 'busy', 'Another Wi-Fi change is already in progress. Nothing was changed.')
    if action == 'priority':
        priority = data.get('priority')
        if not isinstance(priority, int) or isinstance(priority, bool) or not 0 <= priority <= 100:
            return reply('rejected', 'invalid', 'Priority must be a whole number from 0 to 100. Nothing was changed.')
        nm('connection', 'modify', 'uuid', profile, 'connection.autoconnect-priority', str(priority))
        return reply('updated', 'priority', f'{name} now has priority {priority}.', priority=priority)
    active, _ = active_wifi()
    if action == 'disconnect' and active != profile:
        return reply('rejected', 'not_active', f'The device is not connected to {name}. Nothing was changed.')
    current = None
    if active == profile:
        save('wifi-status.json', {'state': 'connecting', 'ssid': name, 'message': f'Leaving {name}…', 'at': int(time.time())})
        try:
            current = other_network(profile)
            if not current:
                try:
                    nm('--wait', '35', 'connection', 'up', 'uuid', profile, timeout=40)
                except subprocess.SubprocessError:
                    pass  # the watch loop keeps trying saved networks and the setup hotspot
                return reply('stayed', 'no_other_network', f'No other saved network with BeeHave access is in range, so the device stayed on {name}. Nothing was {"deleted" if action == "forget" else "changed"}.')
        finally:
            save('wifi-status.json', {'state': 'idle'})
    if action == 'disconnect':
        return reply('disconnected', 'switched', f'Disconnected from {name}. The device is now on {current}. {name} stays saved.', current=current)
    nm('connection', 'delete', 'uuid', profile)
    return reply('forgotten', 'deleted', f'Forgot {name}.' + (f' The device is now on {current}.' if current else ''), **({'current': current} if current else {}))


def agent_request(line):
    """What the agent may ask: network status, a Wi-Fi scan, a Wi-Fi change, or a change to one
    saved network it was asked to make through BeeHave. Pairing and the setup portal's
    operations are not reachable here."""
    request = json.loads(line) if line.strip() else {}
    op = request.get('op')
    if op == 'status':
        return network_status()
    if op == 'scan':
        return scan_networks()
    if op == 'connect':
        return wifi_request(request)
    if op == 'manage':
        return manage_network(request)
    return {'error': 'Unsupported request'}


def allowed_peer(connection):
    _, uid, _ = struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i')))
    try:
        import pwd
        return uid in (0, pwd.getpwnam(AGENT_USER).pw_uid)
    except KeyError:
        return uid == 0


def serve_agent(connection):
    with connection:
        try:
            connection.settimeout(45)
            if not allowed_peer(connection):
                return
            connection.settimeout(180)  # a Wi-Fi change can take a couple of minutes
            line = connection.makefile('r', encoding='utf-8').readline(4096)
            connection.sendall((json.dumps(agent_request(line)) + '\n').encode())
        except (OSError, ValueError, subprocess.SubprocessError):
            pass


def agent_socket():
    if not AGENT_SOCKET.parent.is_dir():
        return  # installed without the runtime directory: the agent simply reports no network details
    AGENT_SOCKET.unlink(missing_ok=True)
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(str(AGENT_SOCKET))
    os.chmod(AGENT_SOCKET, 0o666)  # access is decided by the peer's user, checked per connection
    server.listen(8)
    while True:
        connection, _ = server.accept()
        threading.Thread(target=serve_agent, args=(connection,), daemon=True).start()


def known_networks():
    """Saved client Wi-Fi profiles that may autoconnect: highest NetworkManager
    autoconnect-priority first, then most recently used (NetworkManager's own order)."""
    networks = []
    for row in nm('-t', '-f', 'UUID,TYPE,AUTOCONNECT,AUTOCONNECT-PRIORITY,TIMESTAMP', 'connection', 'show').splitlines():
        parts = row.split(':')
        if len(parts) != 5 or parts[1] != '802-11-wireless' or parts[2] != 'yes':
            continue
        details = nm('-g', '802-11-wireless.mode,802-11-wireless.ssid', 'connection', 'show', 'uuid', parts[0]).split('\n', 1)
        if len(details) != 2 or details[0] == 'ap':
            continue
        priority = int(parts[3]) if parts[3].lstrip('-').isdigit() else 0
        networks.append((priority, int(parts[4]) if parts[4].isdigit() else 0, parts[0], details[1]))
    return [(profile, ssid) for _, _, profile, ssid in sorted(networks, reverse=True)]


def visible_ssids():
    return {n['ssid'] for n in fresh_scan()}


def join_known_network():
    # Try every saved network in range, by priority then most recent. Saved profiles are only
    # activated, never edited. A failed scan falls back to trying them all.
    networks = known_networks()
    try:
        visible = visible_ssids()
        networks = [(profile, ssid) for profile, ssid in networks if ssid in visible]
    except subprocess.SubprocessError:
        pass
    for profile, _ in networks:
        try:
            nm('--wait', '30', 'connection', 'up', 'uuid', profile, timeout=35)
            return True
        except subprocess.SubprocessError:
            continue
    return False


def hotspot_has_clients():
    try:
        neighbours = json.loads(subprocess.run(['ip', '-j', 'neigh', 'show', 'dev', 'wlan0'], capture_output=True, text=True, timeout=5, check=True).stdout or '[]')
    except (subprocess.SubprocessError, ValueError):
        return True  # Unknown: never pull the hotspot away from someone using it.
    return any(set(n.get('state', [])) & {'REACHABLE', 'DELAY', 'PROBE', 'STALE'} for n in neighbours)


# How often an idle setup hotspot steps aside to look for a saved network (e.g. a
# phone hotspot switched on after the Pi gave up). Skipped while a device uses it.
PROBE_INTERVAL = 120


def watch_step(timers, now):
    """One hotspot-watch tick. timers holds 'disconnected' and 'probed' monotonic times."""
    if load('wifi-status.json').get('state') == 'connecting':
        timers['disconnected'] = now
        return
    state = nm('-g', 'GENERAL.STATE', 'device', 'show', 'wlan0')
    active = nm('-g', 'GENERAL.CONNECTION', 'device', 'show', 'wlan0')
    if state.startswith('100') and active != HOTSPOT:
        # Never interrupt a working saved Wi-Fi connection, including one without Internet.
        timers['disconnected'] = now
    elif state.startswith('100'):
        # On the setup hotspot: periodically look for a known network that came back.
        if now - timers['probed'] > PROBE_INTERVAL and not hotspot_has_clients():
            timers['probed'] = now
            nm('connection', 'down', HOTSPOT)
            if not join_known_network():
                nm('connection', 'up', HOTSPOT)
    elif now - timers['disconnected'] > 90:
        if not join_known_network():
            nm('connection', 'up', HOTSPOT)
        timers['disconnected'] = timers['probed'] = time.monotonic()


def hotspot_watch():
    timers = {'disconnected': time.monotonic(), 'probed': time.monotonic()}
    while True:
        time.sleep(10)
        try:
            watch_step(timers, time.monotonic())
        except subprocess.SubprocessError:
            pass


def main():
    global STATE, ALLOWED_ORIGINS
    parser = argparse.ArgumentParser()
    parser.add_argument('--state', default=str(STATE))
    parser.add_argument('--initialize', action='store_true')
    args = parser.parse_args()
    STATE = Path(args.state)
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    identity()
    credential_key()
    if args.initialize:
        return
    ALLOWED_ORIGINS = set(json.loads((STATE / 'origins.json').read_text()))
    # A reboot interrupts only setup work; never manipulate historical records.
    if load('wifi-status.json').get('state') == 'connecting':
        save('wifi-status.json', {'state': 'interrupted'})
    threading.Thread(target=hotspot_watch, daemon=True).start()
    threading.Thread(target=agent_socket, daemon=True).start()
    server = ThreadingHTTPServer(('0.0.0.0', 8765), Handler)
    server.socket.settimeout(10)
    server.serve_forever()


if __name__ == '__main__':
    main()
