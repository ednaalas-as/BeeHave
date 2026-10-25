import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('wifi_profiles', Path(__file__).with_name('wifi_profiles.py'))
wifi = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wifi)

PROFILES = {
    'u-home': ('ALAS ', 'yes', '0', 'yes', 'infrastructure', 'ALAS '),
    'u-phone': ('Galaxy A036539', 'yes', '100', 'no', 'infrastructure', 'Galaxy A036539'),
    'u-colon': ('Farm: Shed', 'yes', '0', 'no', 'infrastructure', 'Farm: Shed'),
    'u-ap': ('beehave-setup-hotspot', 'no', '0', 'no', 'ap', 'BeeHave-Setup-x'),
}


class WifiProfileTests(unittest.TestCase):
    def setUp(self):
        self.calls = []

    def nm(self, *args):
        self.calls.append(args)
        if args[-2:] == ('connection', 'show'):
            rows = [f"{n.replace(':', chr(92) + ':')}:{u}:802-11-wireless:{a}:{p}:{act}" for u, (n, a, p, act, _, _) in PROFILES.items()]
            return '\n'.join(rows + ['lo:u-lo:loopback:no:0:yes']) + '\n'
        if args[0] == '-g':
            _, _, _, _, mode, ssid = PROFILES[args[-1]]
            return f'{mode}\n{ssid}\n'
        return ''

    def test_names_with_spaces_and_colons_resolve_exactly(self):
        with patch.object(wifi, 'nm', side_effect=self.nm):
            self.assertEqual(wifi.find('ALAS ')['uuid'], 'u-home')
            self.assertEqual(wifi.find('Farm: Shed')['uuid'], 'u-colon')
            with self.assertRaises(SystemExit):
                wifi.find('ALAS')

    def test_setup_hotspot_is_never_modified(self):
        with patch.object(wifi, 'nm', side_effect=self.nm), self.assertRaises(SystemExit):
            wifi.find('beehave-setup-hotspot')
        self.assertFalse(any('modify' in c for c in self.calls))

    def test_add_saves_without_password_in_arguments_or_switching(self):
        with tempfile.TemporaryDirectory() as folder, \
                patch.object(wifi, 'PROFILES', Path(folder)), \
                patch.object(wifi, 'nm', side_effect=self.nm), \
                patch.object(wifi.getpass, 'getpass', return_value='synthetic pass'):
            wifi.add('Venue Wi-Fi', 50, hidden=True, open_network=False)
            files = list(Path(folder).glob('beehave-wifi-*.nmconnection'))
            self.assertEqual(len(files), 1)
            text = files[0].read_text()
            self.assertEqual(files[0].stat().st_mode & 0o777, 0o600)
        self.assertIn('autoconnect=true\nautoconnect-priority=50\n', text)
        self.assertIn('hidden=true', text)
        self.assertIn('psk=synthetic\\spass', text)
        self.assertNotIn('synthetic', repr(self.calls))
        self.assertEqual([c[:2] for c in self.calls], [('connection', 'load')])

    def test_priority_bounds(self):
        self.assertEqual(wifi.priority_value('80'), 80)
        for bad in ('101', '-1'):
            with self.assertRaises(Exception):
                wifi.priority_value(bad)


if __name__ == '__main__':
    unittest.main()
