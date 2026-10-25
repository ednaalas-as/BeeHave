#!/usr/bin/env python3
"""Cap the installed agent's API-unreachable retry delay at 60 s (was 300 s).

  sudo python3 update_retry_cap.py            apply
  sudo python3 update_retry_cap.py --rollback restore the previous agent.py

Edits exactly one line of the INSTALLED /opt/beehave-agent/agent.py (verified by
hash before and after) rather than copying the repository agent, whose audio-transfer
additions are not deployed. Restarts only beehave-agent.service; its sync queue,
records, audio state, and the monitoring service are not touched.
"""
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

TARGET = Path('/opt/beehave-agent/agent.py')
BACKUP = TARGET.with_name('agent.py.bak-retry-cap')
BEFORE = 'cc4142b4f960bab0c4d20bde45da34f38c038b4b7c48b7fd199593982dc7c3b8'
AFTER = '606b8706b1f45a2636b23eb969c64093df9d388f9d825f17f3f92180086c419f'
OLD = b'backoff = min(300.0, max(5.0, backoff * 2))'
NEW = b'backoff = min(60.0, max(5.0, backoff * 2))'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def restart():
    subprocess.run(['systemctl', 'restart', 'beehave-agent.service'], check=True)
    time.sleep(5)
    subprocess.run(['systemctl', 'is-active', '--quiet', 'beehave-agent.service'], check=True)


def main():
    if os.geteuid() != 0:
        sys.exit('Run this agent update with sudo.')
    if sys.argv[1:] == ['--rollback']:
        if not BACKUP.is_file() or digest(BACKUP.read_bytes()) != BEFORE:
            sys.exit('No verified backup from this update was found. Nothing was changed.')
        shutil.copy2(BACKUP, TARGET)
        restart()
        BACKUP.unlink()
        print('Restored the previous agent (300 s retry cap).')
        return
    current = TARGET.read_bytes()
    if digest(current) == AFTER:
        print('The 60 s retry cap is already installed. Nothing was changed.')
        return
    if TARGET.is_symlink() or digest(current) != BEFORE or current.count(OLD) != 1 or BACKUP.exists():
        sys.exit('The installed agent differs from the verified version. Stop for review; nothing was changed.')
    patched = current.replace(OLD, NEW)
    if digest(patched) != AFTER:
        sys.exit('Unexpected patch result. Nothing was changed.')
    compile(patched, str(TARGET), 'exec')
    shutil.copy2(TARGET, BACKUP)
    temporary = TARGET.with_name('agent.py.retry-cap-update')
    with temporary.open('xb') as output:
        output.write(patched)
    temporary.chmod(TARGET.stat().st_mode & 0o777)
    os.replace(temporary, TARGET)
    try:
        restart()
    except subprocess.CalledProcessError:
        shutil.copy2(BACKUP, TARGET)
        subprocess.run(['systemctl', 'restart', 'beehave-agent.service'], check=False)
        sys.exit('The updated agent did not start; the previous agent was restored.')
    print('Agent retry cap is now 60 s. Only beehave-agent.service was restarted; sync queue, records, '
          'audio state, and monitoring were not touched.')


if __name__ == '__main__':
    main()
