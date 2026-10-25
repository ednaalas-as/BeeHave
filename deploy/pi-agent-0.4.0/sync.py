"""Offline-first observation sync for the BeeHave agent.

The monitor commits every 3-second window as one line of its session's
classifications.csv. This module reads those files read-only, copies each
committed window into a private outbox (sync.sqlite3 in the agent's state
directory), and sends outbox entries to POST /api/edge/batch until the API
confirms each one by ID. The monitor's files are never written: sync state is
kept only in the outbox.

Identity is device + session_id + window_index, hashed exactly as the existing
Pi importer does, so a resend is an idempotent duplicate and a different
payload for the same identity is a 409 conflict that is kept, never overwritten.
Only sessions at or after BEEHAVE_SYNC_FIRST_SESSION are admitted; earlier
sessions are history and need a separate, approved backfill.
"""
import csv
import hashlib
import http.client
import json
import math
import os
from pathlib import Path
import random
import re
import sqlite3
import struct
import time
import uuid

WINDOW_SECONDS = 3
NON_BEE = "Non-Bee"
SESSION = re.compile(r"\d{8}T\d{6}Z")
RECORDING = re.compile(r"audio/audio_(\d{8}T\d{6}Z)_part(\d{5})\.wav")
MAX_BATCH = 500  # The API accepts at most 1,000 items per array.
RECORDINGS_PER_BATCH = 20
WAV_SETTLE_SECONDS = 300  # A recording modified this recently may still be open.
PRESSURE_PAUSE_SECONDS = 60  # monitoring comes first: back off when it shows strain
RETRY_CAP_SECONDS = 60.0  # longest wait between upload attempts while the API is unreachable

SCHEMA = """
CREATE TABLE IF NOT EXISTS source_files (
  path TEXT PRIMARY KEY,
  inode INTEGER NOT NULL,
  offset INTEGER NOT NULL,
  header TEXT
);
CREATE TABLE IF NOT EXISTS observations (
  session_id TEXT NOT NULL,
  window_index INTEGER NOT NULL,
  source_path TEXT NOT NULL,
  source_line_sha256 TEXT NOT NULL,
  reading TEXT,
  detection TEXT,
  recording_id TEXT,
  note TEXT,
  state TEXT NOT NULL,
  window_state TEXT NOT NULL,
  outcome TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  admitted_at TEXT NOT NULL,
  last_attempt_at TEXT,
  synced_at TEXT,
  PRIMARY KEY (session_id, window_index)
);
CREATE INDEX IF NOT EXISTS observations_state ON observations(state, session_id, window_index);
CREATE TABLE IF NOT EXISTS recordings (
  recording_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  part INTEGER NOT NULL,
  path TEXT NOT NULL,
  run TEXT NOT NULL,
  payload TEXT,
  rate INTEGER,
  frames INTEGER,
  state TEXT NOT NULL,
  last_error TEXT,
  synced_at TEXT
);
"""
# observations.state:  pending | synced | conflict | rejected | held
# observations.window_state: none | pending | synced | conflict | rejected | not_aligned
# recordings.state:    waiting | ready | synced | conflict | rejected


class Retryable(Exception):
    """Nothing was confirmed; every entry stays pending."""


def now_iso():
    now = time.time()
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(now)) + f".{int(now % 1 * 1000):03d}Z"


def number(value):
    if value is None or value == "":
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def sha256(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def observation_ids(device, session, window):
    key = sha256(f"{device}\0{session}\0{window}")
    return "pi_r_" + key, "pi_d_" + key


def recording_id(device, session, part):
    source_session = uuid.uuid5(uuid.NAMESPACE_DNS, f"beehave:pi-session:v1:{device}:{session}")
    return "pi_" + sha256(f"{device}\0{source_session}\0pi-part-v1:{part}")


def wav_info(path):
    """Rate and frames of a closed, structurally consistent mono 16-bit PCM WAV, else None.
    The recorder fixes the header only when it closes the file, so an open file is not ready."""
    try:
        size = os.path.getsize(path)
        if time.time() - os.path.getmtime(path) < WAV_SETTLE_SECONDS:
            return None
        with open(path, "rb") as handle:
            head = handle.read(44)
    except OSError:
        return None
    if len(head) < 44 or head[:4] != b"RIFF" or head[8:16] != b"WAVEfmt " or head[36:40] != b"data":
        return None
    tag, channels, rate, byte_rate, align, bits = struct.unpack_from("<HHIIHH", head, 20)
    riff, data = struct.unpack_from("<I", head, 4)[0], struct.unpack_from("<I", head, 40)[0]
    if (tag, channels, bits, align) != (1, 1, 16, 2) or byte_rate != rate * 2:
        return None
    if riff + 8 != size or 44 + data != size or data % align or not data:
        return None
    return {"rate": rate, "frames": data // align}


def observation_payload(device, row, recording_exists, include_non_bee):
    """(reading, detection, recording_part, note) for one CSV row, mapped exactly as the
    historical importer maps it. Missing values stay None; nothing is estimated."""
    session, window = row["session_id"], int(row["window_index"])
    reading_id, detection_id = observation_ids(device, session, window)
    end = (row.get("window_end_utc") or "").replace("+00:00", "Z")
    notes = []
    t, h = number(row.get("temperature_c")), number(row.get("humidity_pct"))
    reading = None
    if (t is None or -40 <= t <= 85) and (h is None or 0 <= h <= 100):
        reading = {"id": reading_id, "observedAt": end, "temperature": t, "humidity": h}
    else:
        notes.append("sensor_out_of_range")
    bee = row.get("predicted_label") == "1"
    detection, part = None, None
    if bee or include_non_bee:
        frequency, model = number(row.get("dominant_frequency_hz")), row.get("model_sha256") or ""
        if frequency is None or not 0 < frequency <= 100000 or not model:
            notes.append("detection_not_representable_no_frequency")
        else:
            match = RECORDING.fullmatch(row.get("recording_file_relative_path") or "")
            recording = None
            if match and recording_exists(match.group(0)):
                part = int(match.group(2))
                recording = recording_id(device, session, part)
            detection = {
                "id": detection_id, "observedAt": end, "species": "Bee" if bee else NON_BEE,
                "frequency": frequency, "confidence": number(row.get("bee_probability")),
                "readingId": reading_id if reading else None, "recordingId": recording,
                "modelVersion": model,
            }
    return reading, detection, part, ";".join(notes) or None


def problem(row, run):
    """Why a committed CSV row cannot be represented faithfully, or None."""
    session, window = row.get("session_id"), row.get("window_index")
    if not session or not str(window or "").isdigit():
        return "unusable_key"
    if session != run or not SESSION.fullmatch(session):
        return "session_differs_from_run_folder"
    if not (row.get("window_end_utc") or "").endswith("+00:00"):
        return "window_end_not_utc"
    if row.get("predicted_label") not in ("0", "1"):
        return "missing_classification"
    if {"0": "non_bee", "1": "bee"}[row["predicted_label"]] != row.get("predicted_class"):
        return "label_class_mismatch"
    if number(row.get("bee_probability")) is None or not 0 <= number(row.get("bee_probability")) <= 1:
        return "missing_probability"
    return None


class Sync:
    def __init__(self, config, api, log):
        self.config, self.api, self.log = config, api, log
        self.device = config.device_id
        config.state.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(config.state / "sync.sqlite3", isolation_level=None)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")  # an acknowledged row survives power loss
        self.db.executescript(SCHEMA)
        self.batch = max(1, min(MAX_BATCH, config.sync_batch))
        self.failures = 0
        self.unreachable = False  # the last failure was a network error, not an API refusal
        self.next_attempt = 0.0
        self.reported = None
        self.backlog_pause = max(1.0, getattr(config, "sync_backlog_pause", 2.0))
        self.pressure = None  # why monitoring looked strained in the rows read this pass
        self.dropped = {}  # last dropped_audio_blocks per session (the monitor's counter)

    # ---- discovery -------------------------------------------------------
    def admitted(self):
        return self.db.execute("SELECT COUNT(*) FROM observations").fetchone()[0]

    def scan(self):
        """Copies newly committed CSV lines into the outbox. Returns how many were admitted."""
        added = 0
        try:
            runs = sorted(p for p in self.config.runs.iterdir() if p.is_dir())
        except OSError:
            return 0
        for run in runs:
            if run.name < self.config.sync_first_session:
                continue  # history: not part of automatic sync
            path = run / "classifications.csv"
            try:
                added += self.scan_file(run.name, path)
            except OSError as failure:
                self.log(f"Sync: cannot read {path.name} in {run.name} ({type(failure).__name__}).")
            if self.limit_reached():
                break
        return added

    def limit_reached(self):
        limit = self.config.sync_admit_limit
        return limit is not None and self.admitted() >= limit

    def scan_file(self, run, path):
        stat = path.stat()
        state = self.db.execute("SELECT inode, offset, header FROM source_files WHERE path=?", (str(path),)).fetchone()
        inode, offset, header = state if state else (stat.st_ino, 0, None)
        if state and (inode != stat.st_ino or stat.st_size < offset):
            # The monitor only appends. Re-reading is safe: identities are unique and differing
            # content for an identity is flagged below, never overwritten.
            self.log(f"Sync: {run}/classifications.csv was replaced or shortened; re-reading it.")
            inode, offset, header = stat.st_ino, 0, None
        if stat.st_size <= offset:
            return 0
        with path.open("rb") as handle:
            handle.seek(offset)
            data = handle.read(stat.st_size - offset)
        added = 0
        position = 0
        while True:
            end = data.find(b"\n", position)
            if end < 0:
                break  # a line without its newline is not committed yet
            raw = data[position:end + 1]
            text = raw.decode("utf-8", errors="replace").lstrip("﻿")
            if header is None:
                header = text.rstrip("\r\n")
                self.save_offset(path, inode, offset + end + 1, header)
            elif text.strip():
                if self.limit_reached():
                    break  # leave the rest for when the limit is raised
                row = next(csv.DictReader([header, text.rstrip("\r\n")]), None) or {}
                added += self.admit(run, path, row, raw)
                self.save_offset(path, inode, offset + end + 1, header)
            else:
                self.save_offset(path, inode, offset + end + 1, header)
            position = end + 1
        return added

    def save_offset(self, path, inode, offset, header):
        self.db.execute(
            "INSERT INTO source_files(path, inode, offset, header) VALUES(?,?,?,?) "
            "ON CONFLICT(path) DO UPDATE SET inode=excluded.inode, offset=excluded.offset, header=excluded.header",
            (str(path), inode, offset, header),
        )

    def watch(self, row):
        """Notes signs that the monitor is under strain in a row it just committed."""
        session = row.get("session_id")
        if (row.get("deadline_missed") or "").lower() in ("true", "1"):
            self.pressure = f"monitor missed its window deadline ({session}#{row.get('window_index')})"
        dropped = number(row.get("dropped_audio_blocks"))
        if dropped is not None:
            if dropped > self.dropped.get(session, dropped):
                self.pressure = f"monitor dropped audio blocks ({session}#{row.get('window_index')})"
            self.dropped[session] = dropped

    def system_busy(self):
        try:
            load = float(Path("/proc/loadavg").read_text().split()[0])
        except (OSError, ValueError, IndexError):
            return None
        cores = os.cpu_count() or 1
        return f"load average {load:.2f} on {cores} cores" if load > cores else None

    def admit(self, run, path, row, raw):
        self.watch(row)
        line_hash = hashlib.sha256(raw).hexdigest()
        reason = problem(row, run)
        if reason == "unusable_key":
            self.log(f"Sync: skipped a CSV line without a session/window key in {run}.")
            return 0
        session, window = row["session_id"], int(row["window_index"])
        existing = self.db.execute(
            "SELECT source_line_sha256 FROM observations WHERE session_id=? AND window_index=?", (session, window)
        ).fetchone()
        if existing:
            if existing[0] != line_hash:
                self.log(f"Sync: source line for {session}#{window} changed after it was queued; kept the first copy.")
            return 0
        reading = detection = None
        part = None
        note = reason
        if reason is None:
            reading, detection, part, note = observation_payload(
                self.device, row, lambda rel: (path.parent / rel).is_file(), self.config.sync_non_bee
            )
        rec = detection["recordingId"] if detection else None
        state = "held" if reason else ("pending" if reading or detection else "held")
        self.db.execute("BEGIN")
        try:
            self.db.execute(
                "INSERT INTO observations(session_id, window_index, source_path, source_line_sha256, reading, detection,"
                " recording_id, note, state, window_state, admitted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (session, window, str(path), line_hash, json.dumps(reading) if reading else None,
                 json.dumps(detection) if detection else None, rec, note or None, state,
                 "pending" if rec else "none", now_iso()),
            )
            if rec:
                self.db.execute(
                    "INSERT OR IGNORE INTO recordings(recording_id, session_id, part, path, run, state) VALUES(?,?,?,?,?,?)",
                    (rec, session, part, str(path.parent / row["recording_file_relative_path"]), run, "waiting"),
                )
            self.db.execute("COMMIT")
        except Exception:
            self.db.execute("ROLLBACK")
            raise
        if state == "held":
            self.log(f"Sync: holding {session}#{window} locally ({note}).")
        return 1

    def refresh_recordings(self):
        """A recording becomes sendable once the recorder has closed it with a consistent header."""
        for rec, session, part, path, run in self.db.execute(
            "SELECT recording_id, session_id, part, path, run FROM recordings WHERE state='waiting'"
        ).fetchall():
            info = wav_info(path)
            if not info or not 0 < info["frames"] / info["rate"] <= 3600:
                continue
            stamp = RECORDING.fullmatch("audio/" + os.path.basename(path)).group(1)
            payload = {
                "id": rec,
                "observedAt": f"{stamp[0:4]}-{stamp[4:6]}-{stamp[6:8]}T{stamp[9:11]}:{stamp[11:13]}:{stamp[13:15]}Z",
                "duration": info["frames"] / info["rate"],
                "filename": os.path.basename(path),
                "status": "pending",
            }
            self.db.execute(
                "UPDATE recordings SET payload=?, rate=?, frames=?, state='ready' WHERE recording_id=?",
                (json.dumps(payload), info["rate"], info["frames"], rec),
            )

    def audio_window(self, session, window, detection, rec):
        """The detection's 3-second span inside its recording, or None when it cannot be placed exactly."""
        rate, frames, part, run = rec
        try:
            capture = json.loads((self.config.runs / run / "run_metadata.json").read_text()).get("capture", {})
        except (OSError, ValueError):
            capture = {}
        chunk = capture.get("recording_chunk_minutes")
        span = WINDOW_SECONDS * rate
        part_start = 0 if part == 0 else (round(rate * float(chunk) * 60) * part if chunk else None)
        start = None if part_start is None else window * span - part_start
        if start is None or capture.get("capture_rate_hz") not in (None, rate) or start < 0 or start + span > frames:
            return None
        return {"detectionId": detection["id"], "recordingId": detection["recordingId"], "sessionId": session,
                "windowIndex": window, "startFrame": start, "frameCount": span}

    # ---- sending ---------------------------------------------------------
    def units(self):
        """The next batch: pending observations, closed recordings, and placeable audio windows."""
        units = []
        recs = {}
        for rec, payload, rate, frames, part, run, state in self.db.execute(
            "SELECT recording_id, payload, rate, frames, part, run, state FROM recordings WHERE state IN ('ready','synced')"
        ):
            recs[rec] = (rate, frames, part, run)
            if state == "ready" and sum(u["kind"] == "recording" for u in units) < RECORDINGS_PER_BATCH:
                units.append({"kind": "recording", "id": rec, "recording": json.loads(payload)})
        # Pending observations first; then audio windows whose recording has closed. Windows that
        # still wait for their recording are not selected, so they never hold up newer observations.
        rows = self.db.execute(
            "SELECT session_id, window_index, reading, detection, recording_id, state, window_state FROM observations "
            "WHERE state='pending' ORDER BY session_id, window_index LIMIT ?", (self.batch,),
        ).fetchall()
        if len(rows) < self.batch:
            rows += self.db.execute(
                "SELECT o.session_id, o.window_index, o.reading, o.detection, o.recording_id, o.state, o.window_state "
                "FROM observations o JOIN recordings r ON r.recording_id=o.recording_id "
                "WHERE o.state='synced' AND o.window_state='pending' AND r.state IN ('ready','synced') "
                "ORDER BY o.session_id, o.window_index LIMIT ?", (self.batch - len(rows),),
            ).fetchall()
        for session, window, reading, detection, rec, state, window_state in rows:
            detection = json.loads(detection) if detection else None
            unit = {"kind": "observation", "key": (session, window), "send_observation": state == "pending",
                    "reading": json.loads(reading) if reading else None, "detection": detection, "window": None}
            if window_state == "pending" and rec in recs:
                placed = self.audio_window(session, window, detection, recs[rec])
                if placed is None:
                    self.db.execute("UPDATE observations SET window_state='not_aligned' WHERE session_id=? AND window_index=?",
                                    (session, window))
                else:
                    unit["window"] = placed
            if unit["send_observation"] or unit["window"]:
                units.append(unit)
        return units

    @staticmethod
    def body(units):
        body = {"readings": [], "recordings": [], "detections": [], "audioWindows": []}
        for unit in units:
            if unit["kind"] == "recording":
                body["recordings"].append(unit["recording"])
                continue
            if unit["send_observation"]:
                if unit["reading"]:
                    body["readings"].append(unit["reading"])
                if unit["detection"]:
                    body["detections"].append(unit["detection"])
            if unit["window"]:
                body["audioWindows"].append(unit["window"])
        return body

    def send(self, units):
        """Sends units; isolates permanently refused entries by halving. Raises Retryable otherwise."""
        body = self.body(units)
        status, payload = self.api.call("POST", "/edge/batch", body, timeout=self.config.sync_timeout)
        if status == 200:
            self.confirm(units, body, payload)
            return
        if status in (408, 425, 429) or status >= 500 or status == 413:
            if status == 413:
                self.batch = max(1, self.batch // 2)
            raise Retryable(f"HTTP {status}")
        if status in (400, 409, 422):
            if len(units) > 1:
                half = len(units) // 2
                self.send(units[:half])
                self.send(units[half:])
                return
            error = str((payload or {}).get("error", ""))
            if not self.names(units[0], error):
                # Not about this entry (for example a device-wide check): keep everything pending.
                raise Retryable(f"HTTP {status} not tied to one record: {error[:200]}")
            self.refuse(units[0], status, error)
            return
        raise Retryable(f"HTTP {status}")

    @staticmethod
    def names(unit, error):
        """True when the API's refusal is about this single entry."""
        if unit["kind"] == "recording":
            ids = [unit["id"]]
        else:
            ids = [p["id"] for p in (unit["reading"], unit["detection"]) if p] if unit["send_observation"] else []
            if unit["window"]:
                ids.append(unit["window"]["detectionId"])
        if any(i in error for i in ids):
            return True
        # Schema errors name the field path inside this one-entry batch.
        return bool(re.match(r"(readings|recordings|detections|audioWindows)\.0\.", error)) or error.startswith(
            ("Event timestamp is more than five minutes in the future", "An audio window", "Audio window"))

    def confirm(self, units, body, payload):
        """Marks entries synced only if the API listed every submitted ID as stored or already present."""
        stored, present = (payload or {}).get("stored"), (payload or {}).get("alreadyPresent")
        if not isinstance(stored, dict) or not isinstance(present, dict):
            raise Retryable("API reply did not confirm individual records")
        confirmed = {}
        for kind, field in (("readings", "id"), ("recordings", "id"), ("detections", "id"), ("audioWindows", "detectionId")):
            ids_new, ids_old = set(stored.get(kind) or []), set(present.get(kind) or [])
            for item in body[kind]:
                ident = item[field]
                if ident in ids_new:
                    confirmed[(kind, ident)] = "stored"
                elif ident in ids_old:
                    confirmed[(kind, ident)] = "already_present"
                else:
                    raise Retryable(f"API reply did not confirm {kind} {ident}")
        at = now_iso()
        self.db.execute("BEGIN")
        try:
            for unit in units:
                if unit["kind"] == "recording":
                    self.db.execute("UPDATE recordings SET state='synced', synced_at=? WHERE recording_id=?", (at, unit["id"]))
                    continue
                session, window = unit["key"]
                if unit["send_observation"]:
                    outcomes = [confirmed[(k, unit[s]["id"])] for k, s in (("readings", "reading"), ("detections", "detection")) if unit[s]]
                    outcome = "stored" if "stored" in outcomes else "already_present"
                    self.db.execute(
                        "UPDATE observations SET state='synced', outcome=?, synced_at=?, last_error=NULL "
                        "WHERE session_id=? AND window_index=?", (outcome, at, session, window))
                if unit["window"]:
                    self.db.execute("UPDATE observations SET window_state='synced' WHERE session_id=? AND window_index=?",
                                    (session, window))
            self.db.execute("COMMIT")
        except Exception:
            self.db.execute("ROLLBACK")
            raise

    def refuse(self, unit, status, error):
        """A single entry the API refuses: kept locally, logged with its identity, not retried."""
        state = "conflict" if status == 409 else "rejected"
        detail = f"HTTP {status}: {error}"[:500]
        if unit["kind"] == "recording":
            self.db.execute("UPDATE recordings SET state=?, last_error=? WHERE recording_id=?", (state, detail, unit["id"]))
            self.log(f"Sync: recording {unit['id']} {state} ({detail}). Kept on the device.")
            return
        session, window = unit["key"]
        if unit["send_observation"]:
            self.db.execute("UPDATE observations SET state=?, last_error=? WHERE session_id=? AND window_index=?",
                            (state, detail, session, window))
        else:
            self.db.execute("UPDATE observations SET window_state=?, last_error=? WHERE session_id=? AND window_index=?",
                            (state, detail, session, window))
        ident = (unit["detection"] or unit["reading"] or {}).get("id")
        self.log(f"Sync: {session}#{window} ({ident}) {state} ({detail}). Kept on the device; not retried.")

    # ---- loop ------------------------------------------------------------
    def due(self, now):
        return now >= self.next_attempt

    def cycle(self, now=None):
        """One pass: discover, then send at most one batch. Returns seconds until the next pass."""
        now = time.monotonic() if now is None else now
        try:
            return self._cycle(now)
        finally:
            self.report()

    def report(self):
        """Logs the outbox state whenever it changes (the outbox itself is private to this user)."""
        counts = self.counts()
        windows = dict(self.db.execute("SELECT window_state, COUNT(*) FROM observations GROUP BY 1").fetchall())
        recordings = dict(self.db.execute("SELECT state, COUNT(*) FROM recordings GROUP BY 1").fetchall())
        state = (tuple(sorted(counts.items())), tuple(sorted(windows.items())), tuple(sorted(recordings.items())))
        if state != self.reported:
            self.reported = state
            self.log(f"Sync status: observations {counts or {}}; audio windows {windows or {}}; recordings {recordings or {}}.")

    def _cycle(self, now):
        self.pressure = None
        self.scan()  # reading committed lines is cheap and always continues
        self.refresh_recordings()
        strain = self.pressure or self.system_busy()
        if strain:
            # Uploading can wait; monitoring cannot. Everything stays queued.
            self.log(f"Sync: paused {PRESSURE_PAUSE_SECONDS} s because the {strain}; {self.pending()} entries stay queued.")
            self.next_attempt = now + PRESSURE_PAUSE_SECONDS
            return PRESSURE_PAUSE_SECONDS
        units = self.units()
        if not units:
            self.failures, self.unreachable = 0, False
            self.next_attempt = now + self.config.sync_interval
            return self.config.sync_interval
        keys = [u["key"] for u in units if u["kind"] == "observation" and u["send_observation"]]
        if keys:
            self.db.executemany(
                "UPDATE observations SET attempts=attempts+1, last_attempt_at=? WHERE session_id=? AND window_index=?",
                [(now_iso(), s, w) for s, w in keys])
        started = time.monotonic()
        try:
            self.send(units)
        except (Retryable, OSError, ValueError, http.client.HTTPException) as failure:
            self.failures += 1
            self.unreachable = not isinstance(failure, Retryable)
            # Same 60 s cap as heartbeats; the agent also retries at once when the API answers again.
            ceiling = min(RETRY_CAP_SECONDS, 5.0 * 2 ** (self.failures - 1))
            delay = random.uniform(ceiling / 2, ceiling)  # jitter spreads retries from many devices
            reason = str(failure) if isinstance(failure, Retryable) else type(failure).__name__
            if keys:
                self.db.executemany("UPDATE observations SET last_error=? WHERE session_id=? AND window_index=?",
                                    [(reason[:500], s, w) for s, w in keys])
            self.log(f"Sync: {len(units)} entries stay pending ({reason}); retrying in {delay:.0f} s.")
            self.next_attempt = now + delay
            return delay
        self.failures, self.unreachable = 0, False
        left = self.pending()
        sent = [u["key"] for u in units if u["kind"] == "observation" and u["send_observation"]]
        span = f" {sent[0][0]}#{sent[0][1]}..#{sent[-1][1]}" if sent else ""
        self.log(f"Sync: acknowledged {len(sent)} observations{span} and {len(units) - len(sent)} other entries"
                 f" in {(time.monotonic() - started) * 1000:.0f} ms at {now_iso()}; {left} queued.")
        # A backlog drains in bounded batches spaced apart, never as one burst.
        self.next_attempt = now + (self.backlog_pause if left else self.config.sync_interval)
        return self.next_attempt - now

    def pending(self):
        """Entries that can be sent now (windows waiting for their recording to close are not counted)."""
        return self.db.execute(
            "SELECT (SELECT COUNT(*) FROM observations WHERE state='pending')"
            " + (SELECT COUNT(*) FROM recordings WHERE state='ready')"
            " + (SELECT COUNT(*) FROM observations o JOIN recordings r ON r.recording_id=o.recording_id"
            "    WHERE o.state='synced' AND o.window_state='pending' AND r.state IN ('ready','synced'))"
        ).fetchone()[0]

    def counts(self):
        rows = self.db.execute("SELECT state, COUNT(*) FROM observations GROUP BY state").fetchall()
        return dict(rows)
