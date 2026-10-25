#!/usr/bin/env python3
"""Durable BeeHave metadata/audio outbox. Capture and inference remain external."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys
import urllib.request
import urllib.error


def connect(path):
    db = sqlite3.connect(path)
    db.execute('PRAGMA journal_mode=WAL')
    db.executescript('''
      CREATE TABLE IF NOT EXISTS batches (
        id TEXT PRIMARY KEY, payload TEXT NOT NULL, metadata_sent INTEGER DEFAULT 0,
        completed INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS uploads (
        batch_id TEXT, recording_id TEXT, path TEXT, digest TEXT, sent INTEGER DEFAULT 0,
        PRIMARY KEY(batch_id, recording_id));
    ''')
    return db


def enqueue(db, filename, audio):
    payload = json.loads(Path(filename).read_text())
    encoded = json.dumps(payload, sort_keys=True, separators=(',', ':'))
    batch_id = hashlib.sha256(encoded.encode()).hexdigest()
    with db:
        db.execute('INSERT OR IGNORE INTO batches(id,payload) VALUES (?,?)', (batch_id, encoded))
        for entry in audio:
            recording_id, path = entry.split('=', 1)
            file = Path(path).resolve()
            digest = hashlib.sha256(file.read_bytes()).hexdigest()
            if not any(r['id'] == recording_id for r in payload.get('recordings', [])):
                raise ValueError('Audio must reference recording metadata in the batch')
            existing = db.execute('SELECT digest FROM uploads WHERE batch_id=? AND recording_id=?', (batch_id, recording_id)).fetchone()
            if existing and existing[0] != digest:
                raise ValueError('A queued recording cannot be overwritten')
            db.execute('INSERT OR IGNORE INTO uploads(batch_id,recording_id,path,digest) VALUES (?,?,?,?)', (batch_id, recording_id, str(file), digest))
            db.execute('UPDATE batches SET completed=0 WHERE id=?', (batch_id,))
    print('Persisted batch', batch_id, '(retain audio files until acknowledged)')


def send(url, key, body, content_type, method='POST'):
    req = urllib.request.Request(url, data=body, method=method,
        headers={'Content-Type': content_type, 'X-Device-Key': key})
    with urllib.request.urlopen(req, timeout=30) as response:
        if response.status not in (200, 201):
            raise RuntimeError('Unexpected server status')
        return json.load(response)


def flush(db):
    url = os.environ['BEEHAVE_API_URL'].rstrip('/') + '/api'
    key = os.environ['BEEHAVE_DEVICE_KEY']
    batches = db.execute('SELECT id,payload,metadata_sent FROM batches WHERE completed=0 ORDER BY rowid').fetchall()
    for batch_id, payload, metadata_sent in batches:
        if not metadata_sent:
            result = send(url + '/edge/batch', key, payload.encode(), 'application/json')
            expected = {name: len(json.loads(payload).get(name, [])) for name in ('readings', 'recordings', 'detections')}
            if result.get('accepted') != expected:
                raise RuntimeError('Unexpected acknowledgment; batch remains queued')
            with db:
                db.execute('UPDATE batches SET metadata_sent=1 WHERE id=?', (batch_id,))
        for recording_id, filename, digest in db.execute('SELECT recording_id,path,digest FROM uploads WHERE batch_id=? AND sent=0', (batch_id,)).fetchall():
            audio = Path(filename).read_bytes()
            if hashlib.sha256(audio).hexdigest() != digest:
                raise ValueError('Queued audio changed; refusing to upload')
            if send(url + '/edge/recordings/' + recording_id + '/audio', key, audio, 'audio/wav', 'PUT').get('ok') is not True:
                raise RuntimeError('Audio not acknowledged')
            with db:
                db.execute('UPDATE uploads SET sent=1 WHERE batch_id=? AND recording_id=?', (batch_id, recording_id))
        with db:
            db.execute('UPDATE batches SET completed=1 WHERE id=?', (batch_id,))
        print('Synchronized batch', batch_id)
    print('Queue flush complete. Local evidence files have not been deleted.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db', default='beehave-outbox.sqlite')
    sub = parser.add_subparsers(dest='command', required=True)
    add = sub.add_parser('enqueue')
    add.add_argument('json_file')
    add.add_argument('--audio', action='append', default=[], metavar='RECORDING_ID=FILE.wav')
    sub.add_parser('flush')
    sub.add_parser('status')
    args = parser.parse_args()
    db = connect(args.db)
    try:
        if args.command == 'enqueue':
            enqueue(db, args.json_file, args.audio)
        elif args.command == 'flush':
            flush(db)
        else:
            print('Pending batches:', db.execute('SELECT count(*) FROM batches WHERE completed=0').fetchone()[0])
    except (OSError, ValueError, KeyError, RuntimeError, urllib.error.URLError) as exc:
        print('Synchronization stopped; unacknowledged items are preserved:', exc, file=sys.stderr)
        return 1
    finally:
        db.close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
