import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import subprocess
import time
import unittest
from unittest.mock import patch

from cryptography.hazmat.primitives import serialization

spec = importlib.util.spec_from_file_location('nearby', Path(__file__).with_name('service.py'))
service = importlib.util.module_from_spec(spec)
spec.loader.exec_module(service)


class SetupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        service.STATE = Path(self.temp.name) / 'setup'
        service.STATE.mkdir()
        self.history = Path(self.temp.name) / 'monitoring'
        self.history.mkdir()
        (self.history / 'actual.csv').write_bytes(b'time,temperature\n2026-10-01,28\n')
        (self.history / 'actual.wav').write_bytes(b'RIFF historical recording')
        self.before = {p.name: p.read_bytes() for p in self.history.iterdir()}

    def tearDown(self):
        self.assertEqual(self.before, {p.name:p.read_bytes() for p in self.history.iterdir()})
        self.temp.cleanup()

    def test_pairing_persists_before_proof_and_recovers_without_rotation(self):
        invite = service.command({'action':'invite'})['ticket']
        public = serialization.load_der_public_key(bytes.fromhex(invite['publicKey']))
        public.verify(bytes.fromhex(invite['signature']), f"beehave-pair-v1\n{invite['nonce']}\n{invite['keyHash']}\n{invite['expires']}".encode())
        key = service.load('pairing.json')['key']
        self.assertNotIn(key, json.dumps(invite))
        self.assertEqual(invite['keyHash'], hashlib.sha256(key.encode()).hexdigest())
        request = {'action':'confirm','session':'session-1','deviceId':'device-1','challenge':'challenge-1'}
        response = service.command(request)
        self.assertEqual(service.load('pairing.json')['deviceId'], 'device-1')
        public.verify(bytes.fromhex(response['signature']), f"beehave-confirm-v1\nsession-1\nchallenge-1\ndevice-1\n{invite['keyHash']}".encode())
        self.assertEqual(response, service.command(request))
        service.command({'action':'finished','session':'session-1','deviceId':'device-1'})
        self.assertEqual(service.command({'action':'invite'})['ticket']['keyHash'], invite['keyHash'])
        self.assertEqual(service.load('pairing.json')['key'],key)
        with self.assertRaises(ValueError):
            service.command({**request,'deviceId':'different'})
        self.assertEqual((service.STATE / 'pairing.json').stat().st_mode & 0o777, 0o600)

    def test_release_rotates_only_pairing_credential_and_is_retry_safe(self):
        invite = service.command({'action':'invite'})['ticket']
        identity_before = service.load('identity.json')
        old = service.load('pairing.json')['key']
        with patch.object(service, 'nm') as network:
            service.command({'action':'release','keyHash':invite['keyHash']})
            fresh = service.load('pairing.json')['key']
            self.assertNotEqual(old, fresh)
            service.command({'action':'release','keyHash':invite['keyHash']})
            self.assertEqual(service.load('pairing.json')['key'], fresh)
            network.assert_not_called()
        self.assertEqual(service.load('identity.json'), identity_before)
        self.assertNotIn('deviceId', service.load('pairing.json'))

    def test_expiry_and_invalid_operations(self):
        service.command({'action':'invite'})
        state=service.load('pairing.json');state['expires']=0;service.save('pairing.json',state)
        with self.assertRaises(ValueError):
            service.command({'action':'confirm'})
        with self.assertRaises(ValueError):
            service.command({'action':'upload','path':str(self.history)})
        with self.assertRaises(ValueError):
            service.save('../monitoring/actual.csv',{})
        for password in ('short','secret\nlog injection'):
            with self.assertRaises(ValueError):
                service.command({'action':'wifi','ssid':'test','password':password})

    def test_wifi_creates_only_new_profile_and_keeps_password_out_of_arguments(self):
        profiles = Path(self.temp.name) / 'profiles'
        profiles.mkdir()
        original = profiles / 'existing.nmconnection'
        original.write_bytes(b'Existing saved profile must stay unchanged')
        calls = []
        def network(*args, **kwargs):
            calls.append(args)
            return 'previous-profile' if args[0] == '-g' else ''
        with patch.object(service, 'Path', return_value=profiles), patch.object(service, 'nm', side_effect=network), patch.object(service.time, 'sleep'):
            service.connect_wifi('Test network', 'synthetic-password')
        self.assertEqual(original.read_bytes(), b'Existing saved profile must stay unchanged')
        created = list(profiles.glob('beehave-wifi-*.nmconnection'))
        self.assertEqual(len(created), 1)
        self.assertEqual(created[0].stat().st_mode & 0o777, 0o600)
        self.assertNotIn('synthetic-password', repr(calls))
        self.assertEqual(service.load('wifi-status.json')['state'], 'connected')
        self.assertFalse(any('delete' in call or 'down' in call for call in calls))
        modify = [c for c in calls if 'modify' in c]
        self.assertEqual(len(modify), 1)
        self.assertEqual(modify[0][-4:], ('connection.autoconnect', 'yes', 'connection.autoconnect-priority', str(service.DEFAULT_PRIORITY)))
        # Not saved for automatic use before the connection succeeded.
        self.assertIn('autoconnect=false', created[0].read_text())

    def test_wifi_priority_is_optional_and_bounded(self):
        with patch.object(service.threading, 'Thread') as thread:
            service.command({'action': 'wifi', 'ssid': 'test', 'password': 'test-password', 'priority': 80})
            self.assertEqual(thread.call_args.kwargs['args'], ('test', 'test-password', 80, False))
        for bad in (101, -1, '80', True, 7.5):
            service.save('wifi-status.json', {})
            with patch.object(service.threading, 'Thread') as thread, self.assertRaises(ValueError):
                service.command({'action': 'wifi', 'ssid': 'test', 'password': 'test-password', 'priority': bad})
            thread.assert_not_called()

    def test_failed_wifi_restores_previous_connection(self):
        profiles = Path(self.temp.name) / 'profiles'
        profiles.mkdir()
        calls = []
        def network(*args, **kwargs):
            calls.append(args)
            if args[0] == '-g':
                return 'previous-profile'
            if args[0] == '--wait':
                raise subprocess.CalledProcessError(4, 'nmcli', stderr='Error: Connection activation failed: Secrets were required, but not provided.')
            return ''
        with patch.object(service, 'Path', return_value=profiles), patch.object(service, 'nm', side_effect=network), patch.object(service.time, 'sleep'):
            service.connect_wifi('Test network', 'synthetic-password')
        self.assertEqual(calls[-2], ('connection', 'up', 'uuid', 'previous-profile'))
        # Only the profile this attempt created is removed; nothing pre-existing.
        created = [c for c in calls if c[:2] == ('connection', 'load')][0][-1]
        self.assertEqual(calls[-1], ('connection', 'delete', 'uuid', Path(created).stem.removeprefix('beehave-wifi-')))
        self.assertEqual(sum('delete' in c for c in calls), 1)
        status = service.load('wifi-status.json')
        self.assertEqual((status['state'], status['stage'], status['ssid']), ('failed', 'wrong_password', 'Test network'))
        self.assertIn('Incorrect Wi-Fi password', status['message'])
        self.assertNotIn('synthetic-password', json.dumps(status))
        # Recoverable: another attempt is accepted immediately.
        with patch.object(service.threading, 'Thread'):
            service.command({'action': 'wifi', 'ssid': 'Test network', 'password': 'another-password'})

    def test_only_explicit_wifi_action_schedules_network_change(self):
        with patch.object(service.threading,'Thread') as thread:
            service.command({'action':'invite'})
            service.command({'action':'status'})
            thread.assert_not_called()
            service.command({'action':'wifi','ssid':'test','password':'test-password'})
            thread.assert_called_once()
            with self.assertRaises(ValueError):
                service.command({'action':'wifi','ssid':'test','password':'test-password'})


    def attempt(self, up_error=None, connectivity='full', cloud=True, ip='192.168.1.50/24', **kwargs):
        profiles = Path(self.temp.name) / 'profiles'
        profiles.mkdir(exist_ok=True)
        calls = []
        def network(*args, **_):
            calls.append(args)
            if args[:2] == ('-g', 'GENERAL.CON-UUID'):
                return 'previous-profile'
            if args[:2] == ('-g', 'IP4.ADDRESS'):
                return ip
            if args[0] == '--wait' and up_error:
                raise up_error
            if args[:2] == ('networking', 'connectivity'):
                return connectivity
            return ''
        with patch.object(service, 'Path', return_value=profiles), patch.object(service, 'nm', side_effect=network), \
                patch.object(service, 'cloud_reachable', return_value=cloud), patch.object(service.time, 'sleep'):
            service.connect_wifi(kwargs.pop('ssid', 'Venue'), kwargs.pop('password', 'synthetic-password'), **kwargs)
        return calls, service.load('wifi-status.json'), list(profiles.glob('beehave-wifi-*.nmconnection'))

    def test_failures_are_distinguished(self):
        cases = {
            'Error: Connection activation failed: The Wi-Fi network could not be found': 'not_found',
            'Error: Connection activation failed: IP configuration could not be reserved': 'no_ip',
            'Error: Connection activation failed: 802.1X supplicant took too long to authenticate': 'wrong_password',
            'Error: Connection activation failed: Unknown reason': 'failed',
        }
        for text, stage in cases.items():
            _, status, _ = self.attempt(subprocess.CalledProcessError(4, 'nmcli', stderr=text))
            self.assertEqual((status['state'], status['stage']), ('failed', stage))
        _, status, _ = self.attempt(subprocess.TimeoutExpired('nmcli', 40))
        self.assertEqual(status['stage'], 'timeout')
        calls, status, _ = self.attempt(ip='')
        self.assertEqual(status['stage'], 'no_ip')
        self.assertFalse(any('modify' in c for c in calls))

    def test_progressive_validation_keeps_valid_credentials(self):
        for connectivity, cloud, stage in (('full', True, 'online'), ('full', False, 'cloud_unreachable'),
                                           ('none', False, 'no_internet'), ('limited', True, 'no_internet'),
                                           ('portal', False, 'portal'), ('unknown', None, 'connected')):
            calls, status, _ = self.attempt(connectivity=connectivity, cloud=cloud, priority=60)
            self.assertEqual((status['state'], status['stage']), ('connected', stage))
            # Joined with an address: saved for automatic use even when the cloud is down.
            self.assertIn(('connection.autoconnect', 'yes', 'connection.autoconnect-priority', '60'), [c[-4:] for c in calls if 'modify' in c])
            self.assertFalse(any('delete' in c for c in calls))

    def test_open_and_hidden_networks(self):
        _, _, files = self.attempt(ssid='Guest', password='', hidden=True)
        text = files[-1].read_text()
        self.assertNotIn('wifi-security', text)
        self.assertIn('hidden=true', text)
        with patch.object(service.threading, 'Thread') as thread:
            for bad in ({'password': ''}, {'password': 'secret-pass', 'open': True}, {'password': 'short'}):
                service.save('wifi-status.json', {})
                with self.assertRaises(ValueError):
                    service.command({'action': 'wifi', 'ssid': 'Guest', **bad})
            service.command({'action': 'wifi', 'ssid': 'Guest', 'password': '', 'open': True, 'hidden': True})
            self.assertEqual(thread.call_args.kwargs['args'], ('Guest', '', 50, True))

    def test_wpa3_only_network_uses_sae(self):
        service.SCAN.update(networks=[{'ssid': 'Lab', 'signal': 70, 'security': 'wpa3'}], at=1)
        try:
            _, _, files = self.attempt(ssid='Lab')
        finally:
            service.SCAN.update(networks=[], at=0)
        self.assertIn('key-mgmt=sae', files[-1].read_text())

    def test_scan_is_sanitized_and_falls_back_to_last_scan(self):
        rows = 'eds:92:WPA2\nMSEUF\\:WiFi:70:WPA2 WPA3\neds:40:WPA2\n:88:WPA2\nGuest-WiFi:20:\nCorp:50:WPA2 802.1X'
        with patch.object(service, 'nm', return_value=rows):
            result = service.command({'action': 'scan'})
        self.assertFalse(result['cached'])
        self.assertEqual(result['networks'], [
            {'ssid': 'eds', 'signal': 92, 'security': 'wpa2'},
            {'ssid': 'MSEUF:WiFi', 'signal': 70, 'security': 'wpa2/wpa3'},
            {'ssid': 'Corp', 'signal': 50, 'security': 'enterprise'},
            {'ssid': 'Guest-WiFi', 'signal': 20, 'security': 'open'},
        ])
        with patch.object(service, 'nm', side_effect=subprocess.CalledProcessError(1, 'nmcli')):
            cached = service.command({'action': 'scan'})
        self.assertTrue(cached['cached'])
        self.assertEqual(cached['networks'], result['networks'])
        service.SCAN.update(networks=[], at=0)

    def fake_nm(self, *args, timeout=20):
        """NetworkManager as on the BeeHave 01 Pi: on 'eds', one hidden-autoconnect profile, the hotspot."""
        self.nm_calls.append(args)
        key = ' '.join(args)
        if key == '-t -f DEVICE,TYPE,STATE,CONNECTION device':
            return 'wlan0:wifi:connected:eds\neth0:ethernet:unavailable:\nlo:loopback:connected (externally):lo'
        if key.startswith('-t -f ACTIVE,SSID,SIGNAL device wifi list'):
            return 'yes:eds:72\nno:ALAS :40\nno:Farm\\:Net:20'
        if key == '-g IP4.ADDRESS device show wlan0':
            return '192.168.1.29/24'
        if key == '-t -f CONNECTIVITY general':
            return 'full'
        if key.startswith('-t -f NAME,UUID,TYPE'):
            return ('eds:u1:802-11-wireless:yes:100:1792634400:yes\n'
                    'ALAS :u2:802-11-wireless:yes:80:1792500000:no\n'
                    'beehave-setup-hotspot:u3:802-11-wireless:no:0:0:no\n'
                    'iLounge:u4:802-11-wireless:no:0:1700000000:no\n'
                    'Wired:u5:802-3-ethernet:yes:0:0:no')
        if key.startswith('-g 802-11-wireless.mode,802-11-wireless.ssid connection show uuid'):
            return {'u1': 'infrastructure\neds', 'u2': 'infrastructure\nALAS ', 'u3': 'ap\nBeeHave-01-Setup', 'u4': 'infrastructure\niLounge'}[args[-1]]
        raise AssertionError('unexpected nmcli call: ' + key)

    def test_network_status_is_read_only_and_secret_free(self):
        self.nm_calls = []
        service.save('wifi-status.json', {'state': 'failed', 'stage': 'wrong_password', 'ssid': 'ALAS ', 'message': 'Incorrect Wi-Fi password.', 'at': 1792500100})
        with patch.object(service, 'nm', side_effect=self.fake_nm):
            status = service.network_status()
        self.assertEqual((status['method'], status['setupMode'], status['ssid'], status['signal']), ('wifi', False, 'eds', 72))
        self.assertEqual((status['ipAddress'], status['internet']), ('192.168.1.29', 'full'))
        # NetworkManager's order; the setup hotspot and wired profiles are not farmer networks.
        self.assertEqual([(n['ssid'], n['autoconnect'], n['priority'], n['active'], n['inRange']) for n in status['saved']], [
            ('eds', True, 100, True, True), ('ALAS ', True, 80, False, True), ('iLounge', False, 0, False, False)])
        self.assertEqual(status['lastConnectedAt'], '2026-10-22T02:00:00+00:00')
        self.assertEqual(status['lastFailure']['stage'], 'wrong_password')
        # No rescan, no modify/up/down/delete, no secrets requested.
        flat = [' '.join(call) for call in self.nm_calls]
        self.assertTrue(all('--rescan no' in c for c in flat if 'wifi list' in c))
        self.assertFalse(any(word in c.split() for c in flat for word in ('modify', 'up', 'down', 'delete', '-s', '--show-secrets')))
        # A change made through BeeHave is not a setup page result.
        self.assertNotIn('setupPageResult', status)

    def test_setup_page_result_is_reported_after_the_switch(self):
        self.nm_calls = []
        with patch.object(service, 'nm', side_effect=subprocess.CalledProcessError(4, 'nmcli', stderr='Secrets were required, but not provided')), \
             patch.object(service.time, 'sleep'):
            service.connect_wifi('Farm WiFi', 'password123')
        with patch.object(service, 'nm', side_effect=self.fake_nm):
            result = service.network_status()['setupPageResult']
        self.assertEqual((result['ssid'], result['result'], result['stage']), ('Farm WiFi', 'failed', 'wrong_password'))
        self.assertIn('Incorrect Wi-Fi password', result['message'])
        with patch.object(service, 'nm', return_value='192.168.1.40/24'), patch.object(service, 'connected_stage', return_value='online'), \
             patch.object(service.time, 'sleep'), patch.object(service, 'write_profile'):
            service.connect_wifi('Farm WiFi', 'password123')
        with patch.object(service, 'nm', side_effect=self.fake_nm):
            result = service.network_status()['setupPageResult']
        self.assertEqual((result['result'], result['stage']), ('connected', 'online'))
        self.assertEqual(result['message'], 'Connected to Farm WiFi. BeeHave Cloud is reachable.')

    def test_setup_hotspot_is_reported_as_setup_mode(self):
        self.nm_calls = []
        def hotspot(*args, timeout=20):
            if ' '.join(args) == '-t -f DEVICE,TYPE,STATE,CONNECTION device':
                return 'wlan0:wifi:connected:beehave-setup-hotspot'
            if ' '.join(args) == '-g IP4.ADDRESS device show wlan0':
                return '192.168.77.1/24'
            return self.fake_nm(*args, timeout=timeout)
        with patch.object(service, 'nm', side_effect=hotspot):
            status = service.network_status()
        self.assertEqual((status['method'], status['setupMode']), ('setup', True))
        self.assertNotIn('ssid', status)

    def test_agent_socket_only_reads(self):
        with patch.object(service, 'network_status', return_value={'method': 'offline'}), \
             patch.object(service, 'scan_networks', return_value={'networks': []}):
            self.assertEqual(service.agent_request('{"op": "status"}'), {'method': 'offline'})
            self.assertEqual(service.agent_request('{"op": "scan"}'), {'networks': []})
        with patch.object(service, 'connect_wifi') as connect:
            for op in ('wifi', 'forget', 'release', 'invite'):
                self.assertEqual(service.agent_request(json.dumps({'op': op, 'ssid': 'x', 'password': 'y' * 8})), {'error': 'Unsupported request'})
            connect.assert_not_called()

    def test_setup_label_matches_the_printed_label(self):
        code = service.identity()[0]['code']
        with patch.object(service, 'nm', return_value='BeeHave-01-Setup\nabc\\:123') as nm:
            self.assertEqual(service.agent_request('{"op": "label"}'),
                             {'hotspot': 'BeeHave-01-Setup', 'hotspotPassword': 'abc:123', 'code': code})
        self.assertIn(service.HOTSPOT, nm.call_args.args)
        with patch.object(service, 'nm', return_value=''):
            self.assertIn('error', service.agent_request('{"op": "label"}'))

    def run_manage(self, request, online=('Farm WiFi',)):
        """Manage a saved network while on 'eds' (prev-uuid); 'Farm WiFi' (saved-uuid) is the other one."""
        calls, network = self.join_nm()
        known = [('prev-uuid', 'eds'), ('saved-uuid', 'Farm WiFi')]
        joined = []
        def up(*args, **kwargs):
            if args[:1] == ('--wait',):
                joined.append({'prev-uuid': 'eds', 'saved-uuid': 'Farm WiFi'}[args[-1]])
            return network(*args, **kwargs)
        with patch.object(service, 'nm', side_effect=up), patch.object(service, 'known_networks', return_value=known), \
             patch.object(service, 'visible_ssids', return_value={'eds', 'Farm WiFi'}), \
             patch.object(service, 'connected_stage', side_effect=lambda: 'online' if joined[-1] in online else 'cloud_unreachable'):
            result = service.agent_request(json.dumps({'op': 'manage', **request}))
        return result, calls

    def test_priority_change_only_modifies_that_profile(self):
        result, calls = self.run_manage({'action': 'priority', 'profile': 'saved-uuid', 'ssid': 'Farm WiFi', 'priority': 90})
        self.assertEqual((result['result'], result['priority']), ('updated', 90))
        self.assertIn(('connection', 'modify', 'uuid', 'saved-uuid', 'connection.autoconnect-priority', '90'), calls)
        self.assertFalse(any('up' in c or 'delete' in c for c in calls))
        for priority in (101, -1, '50', True):
            refused, calls = self.run_manage({'action': 'priority', 'profile': 'saved-uuid', 'ssid': 'Farm WiFi', 'priority': priority})
            self.assertEqual(refused['result'], 'rejected')
            self.assertFalse(any('modify' in c for c in calls))

    def test_disconnect_moves_to_another_network_and_keeps_the_profile(self):
        result, calls = self.run_manage({'action': 'disconnect', 'profile': 'prev-uuid', 'ssid': 'eds'})
        self.assertEqual((result['result'], result['current']), ('disconnected', 'Farm WiFi'))
        self.assertFalse(any('delete' in c for c in calls))
        self.assertEqual(service.load('wifi-status.json')['state'], 'idle')

    def test_leaving_without_another_reachable_network_returns_and_deletes_nothing(self):
        for action in ('disconnect', 'forget'):
            result, calls = self.run_manage({'action': action, 'profile': 'prev-uuid', 'ssid': 'eds'}, online=())
            self.assertEqual((result['result'], result['stage']), ('stayed', 'no_other_network'))
            self.assertEqual(calls[-1], ('--wait', '35', 'connection', 'up', 'uuid', 'prev-uuid'))
            self.assertFalse(any('delete' in c for c in calls))

    def test_forget_deletes_only_the_requested_saved_profile(self):
        result, calls = self.run_manage({'action': 'forget', 'profile': 'saved-uuid', 'ssid': 'Farm WiFi'})
        self.assertEqual(result['result'], 'forgotten')
        self.assertEqual([c for c in calls if 'delete' in c], [('connection', 'delete', 'uuid', 'saved-uuid')])
        self.assertFalse(any('up' in c for c in calls))
        result, calls = self.run_manage({'action': 'forget', 'profile': 'prev-uuid', 'ssid': 'eds'})
        self.assertEqual((result['result'], result['current']), ('forgotten', 'Farm WiFi'))
        self.assertEqual([c for c in calls if 'delete' in c], [('connection', 'delete', 'uuid', 'prev-uuid')])
        # A profile that does not match its network, or an inactive network to disconnect, is refused.
        for request in ({'action': 'forget', 'profile': 'saved-uuid', 'ssid': 'Other'},
                        {'action': 'disconnect', 'profile': 'saved-uuid', 'ssid': 'Farm WiFi'},
                        {'action': 'erase', 'profile': 'saved-uuid', 'ssid': 'Farm WiFi'}):
            refused, calls = self.run_manage(request)
            self.assertEqual(refused['result'], 'rejected')
            self.assertFalse(any('delete' in c or 'modify' in c or 'up' in c for c in calls))

    def seal(self, password, command_id, ssid):
        """The browser/phone side of the Wi-Fi envelope, mirrored for tests."""
        from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
        from cryptography.hazmat.primitives.kdf.hkdf import HKDF
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        device_public = service.credential_key()[1]
        ephemeral = X25519PrivateKey.generate()
        epk = ephemeral.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
        from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PublicKey
        shared = ephemeral.exchange(X25519PublicKey.from_public_bytes(device_public))
        key = HKDF(algorithm=hashes.SHA256(), length=32, salt=epk + device_public, info=b'beehave-wifi-credential-v1').derive(shared)
        nonce = b'\x01' * 12
        ct = AESGCM(key).encrypt(nonce, password.encode(), f'beehave-wifi-v1\n{command_id}\n{ssid}'.encode())
        return {'v': 1, 'epk': epk.hex(), 'nonce': nonce.hex(), 'ct': ct.hex()}

    def join_nm(self, cloud_stage='online', fail_up=None):
        """NetworkManager while on 'eds' (profile prev-uuid); records every call."""
        calls = []
        def network(*args, **kwargs):
            calls.append(args)
            key = ' '.join(args)
            if key == '-g GENERAL.CON-UUID device show wlan0':
                return 'prev-uuid'
            if key.startswith('-g 802-11-wireless.mode,802-11-wireless.ssid connection show uuid'):
                return 'infrastructure\n' + {'prev-uuid': 'eds', 'saved-uuid': 'Farm WiFi'}.get(args[-1], 'Farm WiFi')
            if key == '-t -f UUID,TYPE connection show':
                return 'prev-uuid:802-11-wireless\nsaved-uuid:802-11-wireless'
            if args[:1] == ('--wait',) and args[-1] != 'prev-uuid' and fail_up:
                raise subprocess.CalledProcessError(4, 'nmcli', stderr=fail_up)
            if key == '-g IP4.ADDRESS device show wlan0':
                return '10.0.0.5/24'
            return ''
        return calls, network

    def run_join(self, request, cloud_stage='online', fail_up=None):
        profiles = Path(self.temp.name) / 'profiles'
        profiles.mkdir(exist_ok=True)
        calls, network = self.join_nm(cloud_stage, fail_up)
        with patch.object(service, 'Path', side_effect=lambda *a: profiles if a == ('/etc/NetworkManager/system-connections',) else Path(*a)), \
             patch.object(service, 'nm', side_effect=network), patch.object(service, 'connected_stage', return_value=cloud_stage), \
             patch.object(service, 'join_known_network', return_value=False), patch.object(service.time, 'sleep'):
            result = service.agent_request(json.dumps({'op': 'connect', **request}))
        return result, calls, profiles

    def test_cloud_wifi_join_is_saved_only_after_beehave_is_reachable(self):
        sealed = self.seal('synthetic-password', 'cmd-1', 'Farm WiFi')
        result, calls, profiles = self.run_join({'ssid': 'Farm WiFi', 'commandId': 'cmd-1', 'credential': sealed})
        self.assertEqual((result['result'], result['ssid'], result['previous']), ('connected', 'Farm WiFi', 'eds'))
        created = list(profiles.glob('beehave-wifi-*.nmconnection'))
        self.assertEqual(len(created), 1)
        self.assertEqual(created[0].stat().st_mode & 0o777, 0o600)
        self.assertIn('psk=synthetic-password', created[0].read_text())
        self.assertNotIn('synthetic-password', repr(calls))
        self.assertEqual(sum('modify' in c for c in calls), 1)
        self.assertEqual(service.load('wifi-status.json')['state'], 'connected')
        self.assertNotIn('synthetic-password', json.dumps(result))

    def test_cloud_wifi_without_beehave_returns_to_previous_network(self):
        sealed = self.seal('synthetic-password', 'cmd-2', 'Farm WiFi')
        result, calls, profiles = self.run_join({'ssid': 'Farm WiFi', 'commandId': 'cmd-2', 'credential': sealed}, cloud_stage='cloud_unreachable')
        self.assertEqual((result['result'], result['stage']), ('restored', 'cloud_unreachable'))
        self.assertIn(('--wait', '35', 'connection', 'up', 'uuid', 'prev-uuid'), calls)
        # Only the profile this attempt created is removed, and it is never saved for auto-join.
        self.assertEqual(sum('delete' in c for c in calls), 1)
        self.assertFalse(any('modify' in c for c in calls))
        self.assertEqual(service.load('wifi-status.json')['stage'], 'cloud_unreachable')

    def test_cloud_wifi_wrong_password_is_reported_and_restored(self):
        sealed = self.seal('synthetic-password', 'cmd-3', 'Farm WiFi')
        result, calls, _ = self.run_join({'ssid': 'Farm WiFi', 'commandId': 'cmd-3', 'credential': sealed},
                                         fail_up='Error: Connection activation failed: Secrets were required, but not provided.')
        self.assertEqual((result['result'], result['stage']), ('restored', 'wrong_password'))

    def test_saved_network_is_activated_not_rewritten(self):
        result, calls, profiles = self.run_join({'ssid': 'Farm WiFi', 'commandId': 'cmd-4', 'profile': 'saved-uuid'})
        self.assertEqual(result['result'], 'connected')
        self.assertIn(('--wait', '35', 'connection', 'up', 'uuid', 'saved-uuid'), calls)
        self.assertEqual(list(profiles.glob('*.nmconnection')), [])
        self.assertFalse(any('modify' in c or 'delete' in c for c in calls))
        # A profile that does not belong to this network is refused.
        refused, calls, _ = self.run_join({'ssid': 'Other', 'commandId': 'cmd-5', 'profile': 'saved-uuid'})
        self.assertEqual(refused['result'], 'rejected')
        self.assertFalse(any('up' in c for c in calls))

    def test_tampered_or_rebound_password_changes_nothing(self):
        sealed = self.seal('synthetic-password', 'cmd-6', 'Farm WiFi')
        for request in ({'ssid': 'Farm WiFi', 'commandId': 'cmd-other', 'credential': sealed},
                        {'ssid': 'Evil WiFi', 'commandId': 'cmd-6', 'credential': sealed},
                        {'ssid': 'Farm WiFi', 'commandId': 'cmd-6', 'credential': {**sealed, 'ct': '00' + sealed['ct'][2:]}}):
            result, calls, profiles = self.run_join(request)
            self.assertEqual((result['result'], result['stage']), ('rejected', 'credential'))
            self.assertFalse(any('up' in c or 'load' in c for c in calls))
            self.assertEqual(list(profiles.glob('*.nmconnection')), [])

    def test_only_one_wifi_change_at_a_time(self):
        service.save('wifi-status.json', {'state': 'connecting', 'ssid': 'x'})
        result, calls, _ = self.run_join({'ssid': 'Farm WiFi', 'commandId': 'cmd-7', 'credential': self.seal('synthetic-password', 'cmd-7', 'Farm WiFi')})
        self.assertEqual(result['stage'], 'busy')
        self.assertFalse(any('up' in c for c in calls))

    def test_status_publishes_only_the_public_credential_key(self):
        private, public = service.credential_key()
        self.nm_calls = []
        with patch.object(service, 'nm', side_effect=self.fake_nm):
            status = service.network_status()
        self.assertEqual(status['credentialKey'], public.hex())
        stored = service.load('credential-key.json')['privateKey']
        self.assertNotIn(stored, json.dumps(status))
        self.assertEqual((service.STATE / 'credential-key.json').stat().st_mode & 0o777, 0o600)
        self.assertEqual(status['saved'][0]['id'], 'u1')

    def test_cloud_probe_is_unauthenticated_health_only(self):
        env = Path(self.temp.name) / 'agent.env'
        env.write_text('# comment\nBEEHAVE_API_URL=https://beehave.example\n')
        with patch.object(service, 'AGENT_ENV', env), patch.object(service, 'urlopen') as opened:
            opened.return_value.__enter__.return_value.status = 200
            self.assertTrue(service.cloud_reachable())
        opened.assert_called_once_with('https://beehave.example/api/health', timeout=8)
        with patch.object(service, 'AGENT_ENV', env), patch.object(service, 'urlopen', side_effect=service.URLError('down')):
            self.assertFalse(service.cloud_reachable())
        with patch.object(service, 'AGENT_ENV', Path(self.temp.name) / 'missing'):
            self.assertIsNone(service.cloud_reachable())

    def test_priority_order_matches_beehave_01_plan(self):
        # eds 100 > Galaxy/ALAS 80 (tie broken by most recent use) > others 50; autoconnect-off never chosen.
        extra = {
            'eds': ('802-11-wireless', 'yes', '100', '10', 'infrastructure', 'eds'),
            'galaxy': ('802-11-wireless', 'yes', '80', '700', 'infrastructure', 'Galaxy A036539'),
            'alas': ('802-11-wireless', 'yes', '80', '800', 'infrastructure', 'ALAS '),
            'pldt': ('802-11-wireless', 'yes', '50', '900', 'infrastructure', 'PLDTHOMEFIBR2.4'),
            'ilounge': ('802-11-wireless', 'no', '50', '950', 'infrastructure', 'iLounge'),
            'xiaomi': ('802-11-wireless', 'no', '50', '960', 'infrastructure', 'Xiaomi Air Purifier Compact'),
            'galaxy-dup': ('802-11-wireless', 'no', '50', '970', 'infrastructure', 'Galaxy A036539'),
        }
        _, nm = self.fake_network('30', '', extra=extra)
        with patch.object(service, 'nm', side_effect=nm):
            order = [p for p, _ in service.known_networks() if p in extra]
        self.assertEqual(order, ['eds', 'alas', 'galaxy', 'pldt'])
        visible = ('eds', 'Galaxy A036539', 'ALAS ', 'iLounge', 'Xiaomi Air Purifier Compact')
        calls, nm = self.fake_network('30 (disconnected)', '', visible=visible, extra=extra)
        with patch.object(service, 'nm', side_effect=nm):
            service.watch_step({'disconnected': 0, 'probed': 0}, 100)
        self.assertEqual([c[-1] for c in calls if 'up' in c], ['eds'])
        calls, nm = self.fake_network('30 (disconnected)', '', visible=visible[1:], extra=extra)
        with patch.object(service, 'nm', side_effect=nm):
            service.watch_step({'disconnected': 0, 'probed': 0}, 100)
        self.assertEqual([c[-1] for c in calls if 'up' in c], ['alas'])

    def test_no_saved_profiles_at_all_still_opens_setup_hotspot(self):
        calls = []
        def nm(*args, timeout=20):
            calls.append(args)
            return {('-g', 'GENERAL.STATE'): '30 (disconnected)'}.get(args[:2], '')
        with patch.object(service, 'nm', side_effect=nm):
            service.watch_step({'disconnected': 0, 'probed': 0}, 100)
        self.assertEqual([c for c in calls if 'up' in c], [('connection', 'up', service.HOTSPOT)])

    def fake_network(self, state, active, visible=('Home',), failing=(), extra=None):
        calls = []
        profiles = {
            'old-uuid': ('802-11-wireless', 'yes', '0', '100', 'infrastructure', 'Home'),
            'new-uuid': ('802-11-wireless', 'yes', '0', '200', 'infrastructure', 'Farm: Shed'),
            'off-uuid': ('802-11-wireless', 'no', '90', '300', 'infrastructure', 'Home'),
            'ap-uuid': ('802-11-wireless', 'yes', '90', '400', 'ap', 'Home'),
            'eth-uuid': ('802-3-ethernet', 'yes', '90', '500', '', ''),
            **(extra or {}),
        }
        def nm(*args, timeout=20):
            calls.append(args)
            if args[:2] == ('-g', 'GENERAL.STATE'):
                return state
            if args[:2] == ('-g', 'GENERAL.CONNECTION'):
                return active
            if args[-2:] == ('connection', 'show'):
                return '\n'.join(f'{u}:{t}:{a}:{pr}:{ts}' for u, (t, a, pr, ts, _, _) in profiles.items())
            if args[0] == '-g' and args[-3:-1] == ('show', 'uuid'):
                _, _, _, _, mode, ssid = profiles[args[-1]]
                return f'{mode}\n{ssid}'
            if 'wifi' in args and 'list' in args:
                return '\n'.join(name.replace(':', '\\:') for name in visible)
            if 'up' in args and args[-1] in failing:
                raise subprocess.CalledProcessError(1, 'nmcli')
            return ''
        return calls, nm

    def test_known_networks_are_saved_autoconnect_clients_newest_first(self):
        _, nm = self.fake_network('30', '')
        with patch.object(service, 'nm', side_effect=nm):
            self.assertEqual(service.known_networks(), [('new-uuid', 'Farm: Shed'), ('old-uuid', 'Home')])
            self.assertEqual(service.visible_ssids(), {'Home'})

    def test_known_networks_follow_priority_before_recency(self):
        extra = {
            'hotspot-uuid': ('802-11-wireless', 'yes', '80', '50', 'infrastructure', 'Phone'),
            'venue-uuid': ('802-11-wireless', 'yes', '100', '10', 'infrastructure', 'Venue'),
            'low-uuid': ('802-11-wireless', 'yes', '-5', '900', 'infrastructure', 'Old'),
        }
        _, nm = self.fake_network('30', '', extra=extra)
        with patch.object(service, 'nm', side_effect=nm):
            self.assertEqual([p for p, _ in service.known_networks()], ['venue-uuid', 'hotspot-uuid', 'new-uuid', 'old-uuid', 'low-uuid'])

    def test_unavailable_primary_falls_back_to_saved_phone_hotspot(self):
        extra = {
            'home-uuid': ('802-11-wireless', 'yes', '100', '900', 'infrastructure', 'Home Fibre'),
            'phone-uuid': ('802-11-wireless', 'yes', '80', '50', 'infrastructure', 'Phone'),
        }
        calls, nm = self.fake_network('30 (disconnected)', '', visible=('Phone', 'Neighbour'), extra=extra)
        with patch.object(service, 'nm', side_effect=nm):
            service.watch_step({'disconnected': 0, 'probed': 0}, 100)
        self.assertEqual([c[-1] for c in calls if 'up' in c], ['phone-uuid'])
        self.assertFalse(any(service.HOTSPOT in c for c in calls))

    def test_disconnected_pi_tries_every_known_network_before_hotspot(self):
        calls, nm = self.fake_network('30 (disconnected)', '', visible=('Home', 'Farm: Shed'), failing=('new-uuid',))
        timers = {'disconnected': 0, 'probed': 0}
        with patch.object(service, 'nm', side_effect=nm):
            service.watch_step(timers, 100)
        ups = [c[-1] for c in calls if 'up' in c]
        self.assertEqual(ups, ['new-uuid', 'old-uuid'])
        self.assertFalse(any(service.HOTSPOT in c for c in calls))
        self.assertFalse(any('modify' in c or 'delete' in c for c in calls))

    def test_hotspot_used_only_when_no_known_network_is_in_range(self):
        calls, nm = self.fake_network('30 (disconnected)', '', visible=('Neighbour',))
        with patch.object(service, 'nm', side_effect=nm):
            service.watch_step({'disconnected': 0, 'probed': 0}, 100)
        self.assertEqual([c for c in calls if 'up' in c], [('connection', 'up', service.HOTSPOT)])

    def test_hotspot_returns_to_known_network_when_idle(self):
        calls, nm = self.fake_network('100 (connected)', service.HOTSPOT)
        with patch.object(service, 'nm', side_effect=nm), patch.object(service, 'hotspot_has_clients', return_value=False):
            service.watch_step({'disconnected': 0, 'probed': 0}, service.PROBE_INTERVAL + 1)
        self.assertIn(('connection', 'down', service.HOTSPOT), calls)
        self.assertEqual([c[-1] for c in calls if 'up' in c], ['old-uuid'])

    def test_hotspot_kept_while_someone_is_using_it_or_setup_runs(self):
        calls, nm = self.fake_network('100 (connected)', service.HOTSPOT)
        with patch.object(service, 'nm', side_effect=nm), patch.object(service, 'hotspot_has_clients', return_value=True):
            service.watch_step({'disconnected': 0, 'probed': 0}, service.PROBE_INTERVAL + 1)
        service.save('wifi-status.json', {'state': 'connecting'})
        with patch.object(service, 'nm', side_effect=nm):
            service.watch_step({'disconnected': 0, 'probed': 0}, 10000)
        self.assertFalse(any('down' in c or 'up' in c for c in calls))

    def test_working_wifi_is_never_interrupted(self):
        calls, nm = self.fake_network('100 (connected)', 'Home')
        with patch.object(service, 'nm', side_effect=nm):
            service.watch_step({'disconnected': 0, 'probed': 0}, 10000)
        self.assertFalse(any('down' in c or 'up' in c for c in calls))

if __name__ == '__main__':
    unittest.main()
