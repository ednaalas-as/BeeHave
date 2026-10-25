"""Bounded, resumable BRTC/1.0.2 uploads. Source WAVs are opened read-only.

Only metadata-confirmed recordings from Sync's existing outbox are eligible.
The server owns chunk progress and verification; this table stores identities,
immutable source manifests and retry deadlines, never a second chunk ledger.
"""
import fcntl
import hashlib
import http.client
import json
import math
import os
from pathlib import Path
import random
import re
import stat
import time
import uuid

from sync import RECORDING, recording_id, wav_info

CONTRACT = "BRTC/1.0.2"
CHUNK = 8 * 1024 * 1024
SCHEMA = """
CREATE TABLE IF NOT EXISTS audio_transfers (
 recording_id TEXT PRIMARY KEY REFERENCES recordings(recording_id),
 device_id TEXT NOT NULL,
 details TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'HASHING',
 attempts INTEGER NOT NULL DEFAULT 0,
 next_attempt REAL NOT NULL DEFAULT 0,
 last_error TEXT
);
"""


class IntegrityError(Exception):
    pass


class Deferred(Exception):
    pass


def fingerprint(s):
    return [s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns]


class AudioSync:
    def __init__(self, config, api, sync, log):
        self.config, self.api, self.sync, self.log = config, api, sync, log
        self.db = sync.db
        self.db.executescript(SCHEMA)
        self.next_attempt = 0.0
        self.hashing = {}  # bounded: at most one incremental hash; restart rehashes safely
        self.lock = open(config.state / "audio-sync.lock", "a")
        self.pause = max(2.0, getattr(config, "audio_interval", 2.0))

    def close(self):
        self.lock.close()

    def save(self, rid, details, state, delay=None):
        self.db.execute(
            "UPDATE audio_transfers SET details=?,state=?,attempts=0,last_error=NULL,next_attempt=? WHERE recording_id=?",
            (json.dumps(details), state, time.time() + (self.pause if delay is None else delay), rid))

    def cycle(self):
        """At most one hash slice or one transfer stage per pass, no retry loop."""
        self.next_attempt = time.monotonic() + self.pause
        try:
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        try:
            if self.sync.pressure or self.sync.system_busy():
                self.next_attempt = time.monotonic() + 60
                return
            self.discover()
            row = self.db.execute(
                "SELECT a.recording_id,a.details,a.state,a.attempts FROM audio_transfers a "
                "JOIN recordings r ON r.recording_id=a.recording_id "
                "WHERE a.device_id=? AND a.state NOT IN ('AVAILABLE','FAILED') AND a.next_attempt<=? "
                "AND r.state='synced' AND (?='' OR a.recording_id=?) "
                "ORDER BY CASE WHEN a.recording_id=? THEN 0 ELSE 1 END,a.next_attempt,a.recording_id LIMIT 1",
                (self.config.device_id, time.time(), self.config.audio_recording, self.config.audio_recording,
                 next(iter(self.hashing), ''))).fetchone()
            if not row:
                return
            rid, encoded, state, attempts = row
            details = json.loads(encoded)
            try:
                self.step(rid, details, state)
            except IntegrityError as exc:
                self.hashing.clear()
                self.db.execute("UPDATE audio_transfers SET state='FAILED',last_error=? WHERE recording_id=?", (str(exc), rid))
                self.log(f"Audio {rid}: integrity/contract failure ({exc}); source retained; review required.")
            except (Deferred, OSError, ValueError, KeyError, TypeError, http.client.HTTPException) as exc:
                self.hashing.clear()
                delay = random.uniform(0.5, 1) * min(60, 5 * 2 ** min(attempts, 6))  # never long after a short outage
                # Never log remote bodies, URLs, headers or credentials.
                reason = str(exc) if isinstance(exc, Deferred) else type(exc).__name__
                self.db.execute("UPDATE audio_transfers SET attempts=attempts+1,next_attempt=?,last_error=? WHERE recording_id=?",
                                (time.time() + delay, reason, rid))
                self.log(f"Audio {rid}: {reason}; retry deferred {delay:.0f}s; source retained.")
        finally:
            fcntl.flock(self.lock, fcntl.LOCK_UN)

    def discover(self):
        # No scan of historical WAVs: use only the existing admitted metadata queue.
        if self.hashing:
            return
        rows = self.db.execute(
            "SELECT r.recording_id,r.session_id,r.part,r.path,r.payload,r.rate,r.frames FROM recordings r "
            "LEFT JOIN audio_transfers a ON a.recording_id=r.recording_id "
            "WHERE r.state='synced' AND a.recording_id IS NULL AND (?='' OR r.recording_id=?) LIMIT 1",
            (self.config.audio_recording, self.config.audio_recording)).fetchall()
        for rid, session, part, path, payload, rate, frames in rows:
            d = dict(path=path, session=session, part=part, metadata=json.loads(payload), rate=rate, frames=frames)
            self.db.execute("INSERT OR IGNORE INTO audio_transfers(recording_id,device_id,details) VALUES(?,?,?)",
                            (rid, self.config.device_id, json.dumps(d)))
            self.log(f"Audio upload candidate: {rid}")

    def check_source(self, rid, d):
        path = Path(d['path'])
        match = RECORDING.fullmatch('audio/' + path.name)
        if (not match or int(match.group(2)) != d['part'] or path.parent.parent.name != d['session']
                or recording_id(self.config.device_id, d['session'], d['part']) != rid
                or path.resolve().parent.parent.parent != self.config.runs.resolve()):
            raise IntegrityError('SOURCE_IDENTITY_MISMATCH')
        s = path.stat()  # missing files remain retryable, never successful
        if not stat.S_ISREG(s.st_mode) or path.is_symlink():
            raise IntegrityError('SOURCE_NOT_REGULAR')
        if d.get('fingerprint') and fingerprint(s) != d['fingerprint']:
            raise IntegrityError('LOCAL_WAV_CHANGED')
        info = wav_info(path)  # same 300-second mtime guard, no extra settling timer
        if info is None:
            raise Deferred('WAV not closed/eligible')
        if info != {'rate': d['rate'], 'frames': d['frames']} or info['rate'] != 16000:
            raise IntegrityError('SOURCE_FORMAT_OR_METADATA_MISMATCH')
        return s

    def read_slice(self, d, offset, length):
        fd = os.open(d['path'], os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, 'rb') as handle:
            if fingerprint(os.fstat(handle.fileno())) != d['fingerprint']:
                raise IntegrityError('LOCAL_WAV_CHANGED')
            handle.seek(offset)
            data = handle.read(length)
            if len(data) != length or fingerprint(os.fstat(handle.fileno())) != d['fingerprint']:
                raise IntegrityError('LOCAL_WAV_CHANGED')
        if fingerprint(os.stat(d['path'])) != d['fingerprint']:
            raise IntegrityError('LOCAL_WAV_CHANGED')
        return data

    def call(self, method, path, body=None, key=None):
        headers = {'BeeHave-Contract': CONTRACT}
        if method == 'POST':
            headers['Idempotency-Key'] = key
        if isinstance(body, bytes):
            headers.update({'Content-Type': 'application/octet-stream', 'X-Chunk-SHA256': hashlib.sha256(body).hexdigest()})
        status, result = self.api.call(method, '/v2' + path, body, timeout=self.config.audio_timeout, headers=headers)
        if status not in (200, 201, 202):
            error = result.get('error', {}) if isinstance(result, dict) else {}
            code = error.get('code', '') if isinstance(error, dict) else ''
            code = code if isinstance(code, str) and re.fullmatch('[A-Z_]{1,80}', code) else 'UNKNOWN'
            if status in (400, 403, 404, 415, 422) or code in ('IDENTITY_CONFLICT', 'MANIFEST_CONFLICT', 'CHUNK_CONFLICT'):
                raise IntegrityError(f'BRTC_HTTP_{status}_{code}')
            # Includes races, expiry and capacity errors. Next pass re-queries server truth.
            raise Deferred(f'BRTC HTTP {status} {code}')
        if not isinstance(result, dict) or result.get('contract') != CONTRACT:
            raise Deferred('Invalid BRTC response')
        return result

    def key(self, rid, action):
        return str(uuid.uuid5(uuid.NAMESPACE_DNS, f'beehave:audio-worker:v1:{self.config.device_id}:{rid}:{action}'))

    def step(self, rid, d, state):
        s = self.check_source(rid, d)
        if not d.get('fingerprint'):
            d['fingerprint'] = fingerprint(s)
            self.save(rid, d, state)
        if 'expected' not in d:
            if rid not in self.hashing:
                self.hashing = {rid: [hashlib.sha256(), 0, []]}
            h, offset, chunks = self.hashing[rid]
            data = self.read_slice(d, offset, min(CHUNK, s.st_size - offset))
            h.update(data)
            chunks.append(hashlib.sha256(data).hexdigest())
            offset += len(data)
            self.hashing[rid][1] = offset
            if offset == s.st_size:
                d['expected'] = {'byte_length': s.st_size, 'sha256': h.hexdigest(), 'format': 'PI_PCM16_16K_MONO_WAV_V1'}
                d['chunk_hashes'] = chunks
                self.hashing.clear()
                self.save(rid, d, 'REGISTERING')
            else:
                self.save(rid, d, 'HASHING')
            return
        if 'session_id' not in d:
            body = dict(contract=CONTRACT, source_session_key=str(uuid.uuid5(uuid.NAMESPACE_DNS,
                        f"beehave:pi-session:v1:{self.config.device_id}:{d['session']}")),
                        source_session_reference=d['session'], reported_started_at=None, reported_ended_at=None,
                        acquisition_status='UNKNOWN')
            result = self.call('POST', '/acquisition-sessions', body, self.key(d['session'], 'session'))
            d['session_id'] = result['session_id']
            self.save(rid, d, 'REGISTERING')
            return
        if 'recording_id' not in d:
            raw = d['metadata']['observedAt'].replace('.000Z', 'Z')
            utc = raw[:-1] + '.000Z' if '.' not in raw else raw
            body = dict(contract=CONTRACT, session_id=d['session_id'], source_part_number=d['part'] + 1,
                source_recording_key=f"pi-part-v1:{d['part']}", expected=d['expected'],
                reported=dict(filename=Path(d['path']).name,
                    started_at=dict(raw=raw, utc=utc, basis='CAPTURE_REPORTED', timezone='UTC'),
                    ended_at=None, acquisition_status='UNKNOWN', duration_seconds=d['frames']/d['rate'],
                    sample_rate_hz=d['rate'], channels=1, bits_per_sample=16,
                    source_metadata=dict(schema='source/1', values=dict(pi_session_id=d['session'], pi_part_index=d['part'],
                        timestamp_source='recorder _open UTC filename timestamp; seconds precision'))),
                provenance=dict(kind='DEVICE_ACQUISITION', producer='BeeHave Pi continuous monitor'))
            result = self.call('POST', '/recordings', body, self.key(rid, 'recording'))
            if result['expected'] != d['expected']:
                raise IntegrityError('MANIFEST_MISMATCH')
            d['recording_id'], d['asset_id'] = result['recording_id'], result['original_asset_id']
            self.save(rid, d, 'TRANSFERRING')
            return
        # Recording GET is necessary before creating an upload (ALREADY_AVAILABLE) and
        # while verifying; availability must carry matching server-derived integrity.
        if 'upload_id' not in d or state == 'VERIFYING':
            result = self.call('GET', f"/recordings/{d['recording_id']}")
            if result['expected'] != d['expected']:
                raise IntegrityError('MANIFEST_MISMATCH')
            if result['storage_state'] == 'AVAILABLE':
                verified = result.get('verified') or {}
                if result.get('validation_state') != 'VALID' or any(verified.get(k) != d['expected'][k] for k in ('sha256', 'byte_length')):
                    raise IntegrityError('VERIFIED_MANIFEST_MISMATCH')
                self.check_source(rid, d)
                self.save(rid, d, 'AVAILABLE')
                self.log(f'Audio {rid}: recording AVAILABLE; verified size/SHA-256; local WAV retained.')
                return
            if result['storage_state'] in ('INVALID', 'FAILED'):
                raise IntegrityError('BACKEND_VERIFICATION_' + result['storage_state'])
            if state == 'VERIFYING':
                self.save(rid, d, state, 10)
                return
            body = dict(contract=CONTRACT, asset_id=d['asset_id'], expected=d['expected'], mode='RESUME_OR_CREATE', previous_upload_id=None)
            result = self.call('POST', f"/recordings/{d['recording_id']}/uploads", body, self.key(rid, 'upload'))
            d['upload_id'] = result['upload_id']
            self.save(rid, d, 'TRANSFERRING')
            return
        snap = self.call('GET', f"/uploads/{d['upload_id']}")
        if (snap['expected'] != d['expected'] or snap['asset_id'] != d['asset_id']
                or snap['recording_id'] != d['recording_id'] or snap['upload_id'] != d['upload_id']
                or snap['chunk_size_bytes'] != CHUNK or snap['chunk_count'] != math.ceil(s.st_size / CHUNK)):
            raise IntegrityError('UPLOAD_MANIFEST_MISMATCH')
        server_state = snap['state']
        if server_state in ('INVALID', 'FAILED'):
            raise IntegrityError('BACKEND_VERIFICATION_' + server_state)
        if server_state in ('AVAILABLE', 'VERIFYING'):
            self.save(rid, d, 'VERIFYING', 10)
            self.log(f'Audio {rid}: recording entered {server_state}; checking verified recording.')
            return
        manifest = dict(contract=CONTRACT, asset_id=d['asset_id'], expected=d['expected'])
        if snap['renewal_required'] or server_state == 'EXPIRED':
            # Epoch saved before request: retry the same renewal after ambiguous ACK loss.
            epoch = str(snap['expires_at'])
            self.call('POST', f"/uploads/{d['upload_id']}/renew", manifest, self.key(rid, 'renew:' + epoch))
            self.save(rid, d, 'TRANSFERRING')
            return
        missing = snap['missing_chunks']
        if missing:
            index = missing[0]['first_index']
            if not isinstance(index, int) or not 0 <= index < len(d['chunk_hashes']):
                raise IntegrityError('INVALID_CHUNK_INDEX')
            data = self.read_slice(d, index * CHUNK, min(CHUNK, s.st_size - index * CHUNK))
            if hashlib.sha256(data).hexdigest() != d['chunk_hashes'][index]:
                raise IntegrityError('LOCAL_CHUNK_CHANGED')
            self.log(f"Audio {rid}: {len(snap['committed_chunks'])}/{snap['chunk_count']} chunks durable; uploading chunk {index}/{snap['chunk_count']-1}.")
            ack = self.call('PUT', f"/uploads/{d['upload_id']}/chunks/{index}", data)
            chunk = ack.get('chunk') or {}
            if (ack.get('upload_id') != d['upload_id'] or chunk.get('index') != index
                    or chunk.get('sha256') != d['chunk_hashes'][index] or chunk.get('byte_length') != len(data)
                    or ack.get('outcome') not in ('COMMITTED', 'ALREADY_COMMITTED')):
                raise Deferred('Chunk acknowledgement incomplete')
            self.check_source(rid, d)
            self.log(f'Audio {rid}: chunk {index} acknowledged.')
            self.save(rid, d, 'TRANSFERRING')
            return
        if snap['committed_byte_length'] != s.st_size or server_state != 'UPLOADED':
            raise Deferred('Server transfer not complete')
        self.log(f'Audio {rid}: all chunks durable; requesting verification.')
        job = self.call('POST', f"/uploads/{d['upload_id']}/finalize", manifest, self.key(rid, 'finalize'))
        if (not job.get('job_id') or job.get('upload_id') != d['upload_id']
                or job.get('state') not in ('QUEUED', 'RUNNING', 'SUCCEEDED', 'INVALID', 'FAILED')):
            raise Deferred('Verification acknowledgement incomplete')
        self.save(rid, d, 'VERIFYING', 10)
