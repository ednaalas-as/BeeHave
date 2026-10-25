"""Synthetic integration harness, never a deployment entry point."""
import json
from pathlib import Path
import sqlite3
import sys
import time

from agent import Api, Config
from audio_sync import AudioSync
from sync import Sync

settings = json.loads(Path(sys.argv[1]).read_text())
root = Path(settings['root'])
if not root.name.startswith('beehave-audio-test-') or settings['device'] != 'audio-test-device':
    raise SystemExit('Synthetic fixture isolation guard')
config = Config({'BEEHAVE_API_URL': settings['origin'], 'BEEHAVE_DEVICE_KEY_FILE': str(root/'device.key'),
    'BEEHAVE_STATE_DIR': str(root), 'BEEHAVE_RUNS_DIR': str(root/'runs'),
    'BEEHAVE_SYNC_ENABLED': '1', 'BEEHAVE_SYNC_FIRST_SESSION': settings['session'],
    'BEEHAVE_AUDIO_ENABLED': '1', 'BEEHAVE_AUDIO_RECORDING_ID': settings['recording']})
config.device_id = settings['device']
api = Api(config)
sync = Sync(config, api, print)
# Only the synthetic fixture's already-confirmed metadata is inserted, never live outboxes.
sync.db.execute('INSERT OR IGNORE INTO recordings(recording_id,session_id,part,path,run,payload,rate,frames,state) VALUES(?,?,?,?,?,?,?,?,?)',
    (settings['recording'],settings['session'],0,settings['path'],settings['session'],json.dumps(settings['metadata']),16000,settings['frames'],'synced'))
# Host load must not make synthetic CI timing nondeterministic. Production uses real load checks.
sync.system_busy = lambda: None
worker = AudioSync(config, api, sync, print)
try:
    for _ in range(250):
        sync.db.execute('UPDATE audio_transfers SET next_attempt=0')
        worker.cycle()
        row = sync.db.execute('SELECT state,details FROM audio_transfers').fetchone()
        if row:
            state, encoded = row
            if state == 'FAILED':
                raise SystemExit('fixture worker failed')
            if state == 'AVAILABLE':
                print('FIXTURE_AVAILABLE')
                break
            details = json.loads(encoded)
            if sys.argv[2] == 'first' and 'upload_id' in details:
                status, snap = api.call('GET', '/v2/uploads/' + details['upload_id'], headers={'BeeHave-Contract':'BRTC/1.0.2'})
                if status == 200 and len(snap['committed_chunks']) == 1:
                    print('FIXTURE_INTERRUPTED_AFTER_CHUNK_ZERO')
                    break
        time.sleep(0.1)
    else:
        raise SystemExit('fixture timeout')
finally:
    worker.close()
    sync.db.close()
