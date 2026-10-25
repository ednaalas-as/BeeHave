#!/usr/bin/env python3
"""Update only the already-installed nearby setup daemon; never touch monitoring data."""
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

OLD_HASH = "4ddb7353f44cfbb4b72a0cca19565b2ea4714ccdc8ae17a92bd3d28e64bf91df"
NEW_HASH = "e5d369eb603de332d011b6dd3ffdd20570078f12e1be72fb438cbc4009ec0a7c"

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def main():
    if os.geteuid() != 0:
        sys.exit('Run this one-time setup-service update with sudo.')
    target = Path('/opt/beehave-setup/service.py')
    source = Path(__file__).with_name('service.py')
    backup = target.with_name('service.py.before-known-networks')
    if target.is_symlink() or not target.is_file() or digest(source) != NEW_HASH:
        sys.exit('Unexpected setup package or destination. Nothing was changed.')
    if digest(target) == NEW_HASH:
        print('This setup-service update is already installed. Nothing was changed.')
        return
    if digest(target) != OLD_HASH or backup.exists():
        sys.exit('The installed setup service differs from the verified version. Stop for review; nothing was changed.')
    compile(source.read_text(), str(source), 'exec')
    shutil.copy2(target, backup)
    temporary = target.with_name('service.py.management-update')
    with temporary.open('xb') as output:
        output.write(source.read_bytes())
    temporary.chmod(target.stat().st_mode & 0o777)
    os.replace(temporary, target)
    try:
        subprocess.run(['systemctl', 'restart', 'beehave-setup.service'], check=True)
        time.sleep(2)
        subprocess.run(['systemctl', 'is-active', '--quiet', 'beehave-setup.service'], check=True)
    except subprocess.CalledProcessError:
        shutil.copy2(backup, target)
        subprocess.run(['systemctl', 'restart', 'beehave-setup.service'], check=False)
        sys.exit('Setup-service update failed; its original code was restored. Monitoring data and service were not touched.')
    print('Updated only beehave-setup.service. Monitoring service, Pi files, saved Wi-Fi profiles, identity, and current pairing are unchanged.')

if __name__ == '__main__':
    main()
