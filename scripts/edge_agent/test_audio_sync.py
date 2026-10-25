"""Synthetic temporary WAVs only; no Pi or live backend is contacted."""
import copy
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import patch
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent))
import audio_sync as audio
import sync
from test_sync import wav


class Server:
    def __init__(self):
        self.session = str(uuid.uuid4())
        self.recording = str(uuid.uuid4())
        self.asset = str(uuid.uuid4())
        self.upload = str(uuid.uuid4())
        self.expected = None
        self.chunks = {}
        self.puts = []
        self.state = 'CREATED'
        self.fail = None
        self.lose_ack = False
        self.renewal = False
        self.finalizes = 0
        self.bad_verified = None
        self.calls = []

    def snapshot(self):
        count = (self.expected['byte_length'] + audio.CHUNK - 1) // audio.CHUNK
        return dict(contract=audio.CONTRACT, upload_id=self.upload, recording_id=self.recording, asset_id=self.asset,
                    expected=self.expected, state=self.state, chunk_size_bytes=audio.CHUNK, chunk_count=count,
                    committed_chunks=[dict(index=i) for i in self.chunks],
                    missing_chunks=[dict(first_index=i, last_index=i) for i in range(count) if i not in self.chunks],
                    committed_byte_length=sum(map(len, self.chunks.values())), renewal_required=self.renewal,
                    expires_at='2026-10-21T00:00:00.000Z')

    def call(self, method, path, body=None, timeout=15, headers=None):
        self.calls.append((method, path))
        assert headers['BeeHave-Contract'] == audio.CONTRACT
        assert timeout <= 60
        if method == 'POST':
            uuid.UUID(headers['Idempotency-Key'])
        if self.fail:
            if isinstance(self.fail, Exception):
                raise self.fail
            return self.fail, dict(error=dict(code='TEST_REJECTION'))
        result = dict(contract=audio.CONTRACT)
        if path == '/v2/acquisition-sessions':
            result['session_id'] = self.session
        elif path == '/v2/recordings':
            self.expected = body['expected']
            result.update(expected=self.expected, recording_id=self.recording, original_asset_id=self.asset)
        elif path == f'/v2/recordings/{self.recording}':
            verified = dict(sha256=self.expected['sha256'], byte_length=self.expected['byte_length'])
            if self.bad_verified:
                verified[self.bad_verified] = 'wrong'
            result.update(expected=self.expected, storage_state=self.state, validation_state='VALID', verified=verified)
        elif path.endswith('/uploads'):
            result = self.snapshot()
        elif '/chunks/' in path:
            index = int(path.rsplit('/', 1)[1])
            self.puts.append(index)
            assert hashlib.sha256(body).hexdigest() == headers['X-Chunk-SHA256']
            assert len(body) == min(audio.CHUNK, self.expected['byte_length'] - index * audio.CHUNK)
            if index in self.chunks:
                assert self.chunks[index] == body
            self.chunks[index] = body
            self.state = 'UPLOADING' if self.snapshot()['missing_chunks'] else 'UPLOADED'
            result.update(upload_id=self.upload, outcome='COMMITTED', chunk=dict(index=index, byte_length=len(body), sha256=hashlib.sha256(body).hexdigest()))
            if self.lose_ack:
                self.lose_ack = False
                raise TimeoutError()
        elif path.endswith('/finalize'):
            assert not self.snapshot()['missing_chunks']
            self.finalizes += 1
            self.state = 'VERIFYING'
            result.update(job_id=str(uuid.uuid4()), upload_id=self.upload, state='QUEUED')
        elif path.endswith('/renew'):
            self.renewal = False
            self.state = 'UPLOADING'
        elif path == f'/v2/uploads/{self.upload}':
            result = self.snapshot()
        else:
            raise AssertionError(path)
        return 200, result


class AudioTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.session = '20261020T124852Z'
        self.device = 'device'
        self.path = root / 'runs' / self.session / 'audio' / 'audio_20261020T124853Z_part00000.wav'
        self.path.parent.mkdir(parents=True)
        wav(self.path, 530)  # 2 full chunks plus a partial chunk
        old = time.time() - 600
        os.utime(self.path, (old, old))
        self.config = types.SimpleNamespace(state=root, runs=root/'runs', device_id=self.device,
            audio_recording='', audio_timeout=20, audio_interval=2)
        self.db = sqlite3.connect(root / 'sync.sqlite3', isolation_level=None)
        self.db.executescript(sync.SCHEMA)
        self.rid = sync.recording_id(self.device, self.session, 0)
        payload = dict(id=self.rid, observedAt='2026-10-20T12:48:53Z', filename=self.path.name, duration=530, status='pending')
        self.db.execute('INSERT INTO recordings(recording_id,session_id,part,path,run,payload,rate,frames,state) VALUES(?,?,?,?,?,?,?,?,?)',
            (self.rid,self.session,0,str(self.path),self.session,json.dumps(payload),16000,530*16000,'synced'))
        self.original_rows = self.db.execute('SELECT * FROM recordings').fetchall()
        self.original_hash = hashlib.sha256(self.path.read_bytes()).hexdigest()
        self.logs = []
        self.server = Server()
        self.sync = types.SimpleNamespace(db=self.db, pressure=None, system_busy=lambda: None)
        self.worker = audio.AudioSync(self.config, self.server, self.sync, self.logs.append)

    def tearDown(self):
        self.worker.close()
        self.db.close()
        self.tmp.cleanup()

    def state(self):
        row = self.db.execute('SELECT state FROM audio_transfers').fetchone()
        return row[0] if row else None

    def tick(self, n=1):
        for _ in range(n):
            self.db.execute('UPDATE audio_transfers SET next_attempt=0')
            self.worker.cycle()

    def until(self, state):
        for _ in range(30):
            self.tick()
            if self.state() == state:
                return
        self.fail(f'{self.state()} did not reach {state}; {self.logs}')

    def restart(self):
        self.worker.close()
        self.db.close()
        self.db = sqlite3.connect(self.config.state/'sync.sqlite3', isolation_level=None)
        self.sync.db = self.db
        self.worker = audio.AudioSync(self.config, self.server, self.sync, self.logs.append)

    def test_new_multichunk_partial_finalize_and_available_preserves_all_sources(self):
        self.until('VERIFYING')
        self.assertEqual(self.server.puts, [0, 1, 2])
        self.assertLess(len(self.server.chunks[2]), audio.CHUNK)
        self.assertEqual(self.server.finalizes, 1)
        self.assertEqual(self.state(), 'VERIFYING')
        self.server.state = 'AVAILABLE'
        self.tick()
        self.assertEqual(self.state(), 'AVAILABLE')
        self.assertEqual(self.db.execute('SELECT * FROM recordings').fetchall(), self.original_rows)
        self.assertEqual(hashlib.sha256(self.path.read_bytes()).hexdigest(), self.original_hash)
        self.assertEqual(hashlib.sha256(b''.join(self.server.chunks.values())).hexdigest(), self.original_hash)

    def test_lost_ack_restart_resumes_without_resending_durable_chunk(self):
        self.until('TRANSFERRING')
        self.tick()  # initialize upload
        self.server.lose_ack = True
        self.tick()  # durable 0, lost acknowledgement
        self.assertEqual(self.server.puts, [0])
        self.restart()
        self.until('VERIFYING')
        self.assertEqual(self.server.puts, [0, 1, 2])

    def test_duplicate_workers_serialize_and_use_server_truth(self):
        other = audio.AudioSync(self.config, self.server, self.sync, self.logs.append)
        try:
            audio.fcntl.flock(other.lock, audio.fcntl.LOCK_EX | audio.fcntl.LOCK_NB)
            self.tick()
            self.assertIsNone(self.state())
            audio.fcntl.flock(other.lock, audio.fcntl.LOCK_UN)
            self.until('VERIFYING')
            self.server.state = 'AVAILABLE'
            other.cycle()
            self.tick()
            self.assertEqual(self.server.puts, [0, 1, 2])
        finally:
            other.close()

    def test_backend_already_some_or_all_chunks(self):
        self.until('TRANSFERRING')
        with self.path.open('rb') as f:
            self.server.chunks[0] = f.read(audio.CHUNK)
        self.server.state = 'INTERRUPTED'
        self.until('VERIFYING')
        self.assertEqual(self.server.puts, [1, 2])

    def test_backend_all_chunks_only_finalizes(self):
        self.until('TRANSFERRING')
        with self.path.open('rb') as f:
            for i in range(3):
                self.server.chunks[i] = f.read(audio.CHUNK)
        self.server.state = 'UPLOADED'
        self.until('VERIFYING')
        self.assertEqual(self.server.puts, [])
        self.assertEqual(self.server.finalizes, 1)

    def test_backend_already_available_no_upload(self):
        self.until('TRANSFERRING')
        self.server.state = 'AVAILABLE'
        self.tick()
        self.assertEqual(self.state(), 'AVAILABLE')
        self.assertFalse(self.server.puts)
        self.assertEqual(self.server.finalizes, 0)

    def test_network_timeout_and_server_unavailable_backoff_survive_restart(self):
        self.until('TRANSFERRING')
        for failure in (OSError(), TimeoutError(), 503):
            self.server.fail = failure
            self.tick()
            row = self.db.execute('SELECT attempts,next_attempt FROM audio_transfers').fetchone()
            self.assertGreater(row[0], 0)
            self.assertGreater(row[1], time.time())
            before = len(self.server.calls)
            self.restart()
            self.worker.cycle()
            self.assertEqual(len(self.server.calls), before)
        self.server.fail = None
        self.until('VERIFYING')

    def test_verification_failure_stays_failed_keeps_source(self):
        self.until('VERIFYING')
        self.server.state = 'INVALID'
        self.tick()
        self.assertEqual(self.state(), 'FAILED')
        self.assertTrue(self.path.exists())

    def test_wrong_server_sha_or_byte_size_never_available(self):
        self.until('TRANSFERRING')
        self.server.state = 'AVAILABLE'
        for field in ('sha256', 'byte_length'):
            self.server.bad_verified = field
            self.db.execute("UPDATE audio_transfers SET state='TRANSFERRING'")
            self.tick()
            self.assertEqual(self.state(), 'FAILED')

    def test_missing_local_wav(self):
        self.path.unlink()  # synthetic fixture only
        self.tick()
        self.assertNotEqual(self.state(), 'AVAILABLE')
        self.assertFalse(self.server.calls)
        self.assertIn('FileNotFoundError', self.logs[-1])

    def test_still_writing_or_bad_header_not_eligible(self):
        os.utime(self.path, None)
        self.tick(2)
        self.assertFalse(self.server.calls)
        self.assertEqual(self.state(), 'HASHING')

    def test_local_change_after_manifest_is_integrity_failure(self):
        self.until('TRANSFERRING')
        with self.path.open('r+b') as f:
            f.seek(50)
            f.write(b'xx')
        self.tick()
        self.assertEqual(self.state(), 'FAILED')
        self.assertFalse(self.server.puts)

    def test_hash_restarts_and_all_reads_bounded(self):
        self.tick()
        self.restart()
        sizes = []
        original = self.worker.read_slice
        def read(d, offset, length):
            sizes.append(length)
            self.assertLessEqual(length, audio.CHUNK)
            return original(d, offset, length)
        with patch.object(self.worker, 'read_slice', read), patch.object(Path, 'read_bytes', side_effect=AssertionError('whole read')):
            self.until('VERIFYING')
        self.assertGreater(len(sizes), 3)
        self.assertEqual(self.server.expected['sha256'], self.original_hash)

    def test_metadata_must_be_confirmed_and_selector_limits_discovery(self):
        self.db.execute("UPDATE recordings SET state='ready'")
        self.tick()
        self.assertIsNone(self.state())
        self.db.execute("UPDATE recordings SET state='synced'")
        self.config.audio_recording = 'another-recording'
        self.tick()
        self.assertIsNone(self.state())

    def test_monitor_pressure_defers_audio(self):
        self.sync.pressure = 'deadline missed'
        self.tick()
        self.assertIsNone(self.state())
        self.assertGreater(self.worker.next_attempt, time.monotonic() + 50)

    def test_expired_upload_renewed_without_new_attempt(self):
        self.until('TRANSFERRING')
        self.tick()
        self.server.state, self.server.renewal = 'EXPIRED', True
        self.tick()
        self.assertTrue(any(p.endswith('/renew') for _, p in self.server.calls))
        self.until('VERIFYING')

    def test_rejected_hash_size_format_are_held_not_retried(self):
        self.until('TRANSFERRING')
        self.server.fail = 422
        self.tick()
        self.assertEqual(self.state(), 'FAILED')
        before = len(self.server.calls)
        self.tick()
        self.assertEqual(len(self.server.calls), before)

    def test_single_chunk_wav(self):
        wav(self.path, 3)
        old = time.time() - 301
        os.utime(self.path, (old, old))
        self.db.execute('UPDATE recordings SET frames=?', (48000,))
        self.until('VERIFYING')
        self.assertEqual(self.server.puts, [0])
        self.assertEqual(len(self.server.chunks[0]), 96044)

    def test_invalid_header_not_uploaded_or_repaired(self):
        with self.path.open('r+b') as handle:
            handle.seek(40)
            handle.write(b'\x00' * 4)
        old = time.time() - 600
        os.utime(self.path, (old, old))
        before = self.path.read_bytes()
        self.tick()
        self.assertFalse(self.server.calls)
        self.assertEqual(self.path.read_bytes(), before)

    def test_existing_settle_rule_not_an_additional_timer(self):
        old = time.time() - 299
        os.utime(self.path, (old, old))
        self.tick()
        self.assertFalse(self.worker.hashing)
        old = time.time() - 301
        os.utime(self.path, (old, old))
        self.tick()
        self.assertTrue(self.worker.hashing)  # eligible immediately; no second five-minute wait

    def test_missing_candidate_does_not_block_another_recording(self):
        self.path.unlink()
        self.tick()
        second = self.path.with_name('audio_20261020T124856Z_part00001.wav')
        wav(second, 3)
        old = time.time() - 600
        os.utime(second, (old, old))
        rid = sync.recording_id(self.device, self.session, 1)
        payload = dict(id=rid, observedAt='2026-10-20T12:48:56Z', filename=second.name, duration=3, status='pending')
        self.db.execute('INSERT INTO recordings(recording_id,session_id,part,path,run,payload,rate,frames,state) VALUES(?,?,?,?,?,?,?,?,?)',
            (rid,self.session,1,str(second),self.session,json.dumps(payload),16000,48000,'synced'))
        self.worker.cycle()
        self.assertEqual(self.db.execute('SELECT state FROM audio_transfers WHERE recording_id=?',(rid,)).fetchone()[0], 'REGISTERING')


if __name__ == '__main__':
    unittest.main()
