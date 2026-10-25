import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import struct
import sys
import tempfile
import time
import types
import unittest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
spec = importlib.util.spec_from_file_location("sync", HERE / "sync.py")
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)

DEVICE = "5661f1a4-8571-4a02-892c-9b760cb1dd92"
FIELDS = ["session_id", "window_index", "window_end_utc", "bee_probability", "predicted_label", "predicted_class",
          "dominant_frequency_hz", "temperature_c", "humidity_pct", "recording_file_relative_path", "model_sha256"]
MODEL = "592525669d9d876cbd9fe852da1bb5182a0f19bc0f61d01ea08cb1c30b5ebf22"


def line(session, window, label=0, temperature="24.170", humidity="48.446", frequency="609.375000", probability="0.0000000013"):
    seconds = 55.990590 + 3 * window  # session start + window_index x 3 s, as the monitor computes it
    end = f"2026-10-20T12:{48 + int(seconds // 60):02d}:{seconds % 60:09.6f}+00:00"
    values = [session, str(window), end, probability, str(label), "bee" if label else "non_bee", frequency,
              temperature, humidity, "audio/audio_20261020T124853Z_part00000.wav", MODEL]
    return ",".join(values) + "\n"


class FakeEdgeApi:
    """Same rules as POST /api/edge/batch: atomic, (device,id) identity, deep equality, 409 on conflict."""

    def __init__(self):
        self.tables = {"readings": {}, "recordings": {}, "detections": {}, "audioWindows": {}}
        self.calls = 0
        self.mode = "ok"  # ok | down | 500 | no_ack | lose_ack | global_400

    def call(self, method, path, body=None, timeout=15):
        self.calls += 1
        if self.mode == "down":
            raise OSError("network unreachable")
        if self.mode == "500":
            return 500, {"error": "The server could not complete this request."}
        if self.mode == "global_400":
            return 400, {"error": "Associated sensor readings must be within 60 seconds of the detection."}
        staged = copy.deepcopy(self.tables)
        stored = {k: [] for k in staged}
        present = {k: [] for k in staged}
        for kind in ("readings", "recordings", "detections", "audioWindows"):
            for item in body.get(kind, []):
                ident = item["detectionId"] if kind == "audioWindows" else item["id"]
                if ident in staged[kind]:
                    if staged[kind][ident] != item:
                        return 409, {"error": f"Conflicting payload for {ident}; stable IDs cannot be overwritten."}
                    present[kind].append(ident)
                else:
                    if kind == "audioWindows" and item["detectionId"] not in staged["detections"]:
                        return 409, {"error": f"Synchronize detection {ident} before its audio window."}
                    staged[kind][ident] = item
                    stored[kind].append(ident)
        self.tables = staged  # committed
        if self.mode == "lose_ack":
            raise TimeoutError("reply lost after commit")
        if self.mode == "no_ack":
            return 200, {"accepted": {k: len(body.get(k, [])) for k in staged}}
        return 200, {"accepted": {}, "stored": stored, "alreadyPresent": present}


def wav(path, seconds, rate=16000):
    data = seconds * rate * 2
    header = b"RIFF" + struct.pack("<I", 36 + data) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16)
    header += b"data" + struct.pack("<I", data)
    path.write_bytes(header + b"\0" * data)


class SyncTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.runs, self.state = root / "runs", root / "state"
        self.session = "20261020T124852Z"
        run = self.runs / self.session
        (run / "audio").mkdir(parents=True)
        (run / "run_metadata.json").write_text(json.dumps({"capture": {"capture_rate_hz": 16000, "recording_chunk_minutes": 60.0}}))
        self.audio = run / "audio" / "audio_20261020T124853Z_part00000.wav"
        wav(self.audio, 90)
        old = time.time() - 3600
        os.utime(self.audio, (old, old))
        self.csv = run / "classifications.csv"
        self.csv.write_text(",".join(FIELDS) + "\n" + "".join(line(self.session, w) for w in range(5)))
        history = self.runs / "20261017T053709Z"
        history.mkdir()
        (history / "classifications.csv").write_text(",".join(FIELDS) + "\n" + line("20261017T053709Z", 0))
        self.api = FakeEdgeApi()
        self.logs = []

    def tearDown(self):
        self.tmp.cleanup()

    def config(self, **overrides):
        values = dict(runs=self.runs, state=self.state, device_id=DEVICE, sync_first_session=self.session,
                      sync_admit_limit=None, sync_batch=200, sync_interval=15.0, sync_timeout=60.0, sync_non_bee=True)
        values.update(overrides)
        return types.SimpleNamespace(**values)

    def agent(self, **overrides):
        return sync.Sync(self.config(**overrides), self.api, self.logs.append)

    def rows(self, s, where=""):
        return s.db.execute(f"SELECT session_id, window_index, state, window_state, outcome FROM observations {where} ORDER BY 1,2").fetchall()

    def source_digest(self):
        return {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(self.runs.rglob("*")) if p.is_file()}

    def test_identity_matches_existing_beehave_rows(self):
        reading, detection = sync.observation_ids(DEVICE, "20261014T070921Z", 1300)
        self.assertEqual(detection, "pi_d_5692eaa95e2aab54acf4b4d4412f31615a26f67d7a340e2e3c0328c7d2f07415")
        self.assertEqual(sync.recording_id(DEVICE, "20261014T070921Z", 1),
                         "pi_8dfdba9b028f52134e5b04c75b82d39a19ae6ce107463fc245eb9be079f00d87")

    def test_history_is_never_admitted_and_partial_lines_wait(self):
        with self.csv.open("a") as handle:
            handle.write(line(self.session, 5).rstrip("\n"))  # the monitor is mid-write
        s = self.agent()
        self.assertEqual(s.scan(), 5)
        self.assertEqual({r[0] for r in self.rows(s)}, {self.session})
        with self.csv.open("a") as handle:
            handle.write("\n")
        self.assertEqual(s.scan(), 1)
        self.assertEqual(s.scan(), 0)

    def test_admit_limit_bounds_the_controlled_sample(self):
        s = self.agent(sync_admit_limit=2)
        s.scan()
        self.assertEqual([r[1] for r in self.rows(s)], [0, 1])
        s2 = self.agent(sync_admit_limit=4)  # raising the limit continues where it stopped
        s2.scan()
        self.assertEqual([r[1] for r in self.rows(s2)], [0, 1, 2, 3])

    def test_sync_preserves_values_and_records_success(self):
        before = self.source_digest()
        s = self.agent()
        s.cycle(0)
        self.assertEqual({r[2] for r in self.rows(s)}, {"synced"})
        self.assertEqual({r[4] for r in self.rows(s)}, {"stored"})
        reading_id, detection_id = sync.observation_ids(DEVICE, self.session, 0)
        self.assertEqual(self.api.tables["detections"][detection_id], {
            "id": detection_id, "observedAt": "2026-10-20T12:48:55.990590Z", "species": "Non-Bee",
            "frequency": 609.375, "confidence": 1.3e-09, "readingId": reading_id,
            "recordingId": sync.recording_id(DEVICE, self.session, 0), "modelVersion": MODEL})
        self.assertEqual(self.api.tables["readings"][reading_id]["temperature"], 24.17)
        self.assertEqual(self.source_digest(), before)  # monitor files untouched

    def test_bee_null_sensor_and_missing_frequency(self):
        with self.csv.open("a") as handle:
            handle.write(line(self.session, 5, label=1, temperature="", humidity="", probability="0.8385081887"))
            handle.write(line(self.session, 6, label=1, frequency=""))
        s = self.agent()
        s.cycle(0)
        r5, d5 = sync.observation_ids(DEVICE, self.session, 5)
        self.assertEqual(self.api.tables["detections"][d5]["species"], "Bee")
        self.assertIsNone(self.api.tables["readings"][r5]["temperature"])
        self.assertIsNone(self.api.tables["readings"][r5]["humidity"])
        r6, d6 = sync.observation_ids(DEVICE, self.session, 6)
        self.assertNotIn(d6, self.api.tables["detections"])  # never invented
        self.assertIn(r6, self.api.tables["readings"])
        note = s.db.execute("SELECT note FROM observations WHERE window_index=6").fetchone()[0]
        self.assertIn("no_frequency", note)

    def test_outage_keeps_pending_then_retries_with_backoff(self):
        s = self.agent()
        self.api.mode = "down"
        delay = s.cycle(0)
        self.assertTrue(2.5 <= delay <= 5)
        self.assertEqual({r[2] for r in self.rows(s)}, {"pending"})
        self.assertTrue(4 <= s.cycle(100) <= 10)  # grows
        self.api.mode = "500"
        s.cycle(200)
        self.assertEqual({r[2] for r in self.rows(s)}, {"pending"})
        self.api.mode = "ok"
        s.cycle(300)
        self.assertEqual({r[2] for r in self.rows(s)}, {"synced"})
        self.assertEqual(s.failures, 0)

    def test_long_outage_retries_at_most_every_60_seconds(self):
        s = self.agent()
        self.api.mode = "down"
        delays = [s.cycle(i * 1000) for i in range(12)]
        self.assertLessEqual(max(delays), 60)
        self.assertTrue(s.unreachable)
        self.api.mode = "500"  # an API refusal is not a network outage
        s.cycle(20000)
        self.assertFalse(s.unreachable)
        self.api.mode = "ok"
        s.cycle(30000)
        self.assertEqual({r[2] for r in self.rows(s)}, {"synced"})

    def test_lost_acknowledgement_is_resolved_by_idempotent_resend(self):
        s = self.agent()
        self.api.mode = "lose_ack"
        s.cycle(0)
        self.assertEqual({r[2] for r in self.rows(s)}, {"pending"})  # committed remotely but not confirmed
        self.api.mode = "ok"
        s.cycle(100)
        self.assertEqual({r[4] for r in self.rows(s)}, {"already_present"})
        self.assertEqual(len(self.api.tables["detections"]), 5)

    def test_http_200_without_per_item_confirmation_is_not_success(self):
        s = self.agent()
        self.api.mode = "no_ack"
        s.cycle(0)
        self.assertEqual({r[2] for r in self.rows(s)}, {"pending"})

    def test_conflict_is_isolated_kept_and_not_retried(self):
        s = self.agent()
        s.scan()
        _, d2 = sync.observation_ids(DEVICE, self.session, 2)
        self.api.tables["detections"][d2] = {"id": d2, "species": "Bee"}  # server already holds different content
        s.cycle(0)
        states = {r[1]: r[2] for r in self.rows(s)}
        self.assertEqual(states, {0: "synced", 1: "synced", 2: "conflict", 3: "synced", 4: "synced"})
        self.assertEqual(self.api.tables["detections"][d2], {"id": d2, "species": "Bee"})  # not overwritten
        calls = self.api.calls
        s.cycle(100)
        self.assertEqual(self.api.calls - calls, 0 if s.pending() == 0 else 1)
        self.assertTrue(any(d2 in entry for entry in self.logs))

    def test_refusal_not_tied_to_one_record_keeps_everything_pending(self):
        s = self.agent()
        self.api.mode = "global_400"
        s.cycle(0)
        self.assertEqual({r[2] for r in self.rows(s)}, {"pending"})

    def test_restart_resumes_without_readmitting(self):
        s = self.agent()
        self.api.mode = "down"
        s.cycle(0)
        s.db.close()
        s2 = self.agent()  # agent or Pi restart: state is on disk
        self.assertEqual(s2.scan(), 0)
        self.api.mode = "ok"
        s2.cycle(0)
        self.assertEqual(len(self.rows(s2, "WHERE state='synced'")), 5)
        self.assertEqual(len(self.api.tables["detections"]), 5)

    def test_recording_and_audio_windows_follow_once_the_file_is_closed(self):
        os.utime(self.audio, None)  # just written: may still be open
        s = self.agent()
        s.cycle(0)
        self.assertEqual(self.api.tables["recordings"], {})
        self.assertEqual({r[3] for r in self.rows(s)}, {"pending"})
        self.assertEqual(s.pending(), 0)  # waiting windows do not count as sendable
        old = time.time() - 3600
        os.utime(self.audio, (old, old))
        s.cycle(100)
        s.cycle(200)
        rec = sync.recording_id(DEVICE, self.session, 0)
        self.assertEqual(self.api.tables["recordings"][rec]["duration"], 90)
        _, d3 = sync.observation_ids(DEVICE, self.session, 3)
        self.assertEqual(self.api.tables["audioWindows"][d3]["startFrame"], 3 * 48000)
        self.assertEqual({r[3] for r in self.rows(s)}, {"synced"})

    def append(self, *lines):
        with self.csv.open("a") as handle:
            handle.write("".join(lines))

    def strained_csv(self, deadline, dropped):
        """Rewrites the test CSV with the monitor's strain columns (test fixture only)."""
        fields = FIELDS + ["deadline_missed", "dropped_audio_blocks"]
        rows = [line(self.session, w).rstrip("\n") + f",{deadline[w]},{dropped[w]}\n" for w in range(5)]
        self.csv.write_text(",".join(fields) + "\n" + "".join(rows))

    def test_sync_pauses_when_monitor_misses_a_deadline(self):
        self.strained_csv(["False", "False", "True", "False", "False"], [0] * 5)
        s = self.agent()
        self.assertEqual(s.cycle(0), sync.PRESSURE_PAUSE_SECONDS)
        self.assertEqual(self.api.calls, 0)
        self.assertEqual({r[2] for r in self.rows(s)}, {"pending"})  # still queued, nothing lost
        s.cycle(100)  # no new strain: sends
        self.assertEqual({r[2] for r in self.rows(s)}, {"synced"})

    def test_sync_pauses_when_monitor_drops_audio(self):
        self.strained_csv(["False"] * 5, [0, 0, 0, 2, 2])
        s = self.agent()
        self.assertEqual(s.cycle(0), sync.PRESSURE_PAUSE_SECONDS)
        self.assertEqual(self.api.calls, 0)

    def test_backlog_drains_in_paced_bounded_batches(self):
        self.append(*(line(self.session, w) for w in range(5, 12)))
        s = self.agent(sync_batch=5, sync_backlog_pause=2.0)
        sizes, delays, t = [], [], 0.0
        original = self.api.call
        self.api.call = lambda m, p, body=None, timeout=15: (sizes.append(len(body["detections"])), original(m, p, body, timeout))[1]
        while True:
            delay = s.cycle(t)
            delays.append(delay)
            t += delay
            if delay == 15.0:
                break
        self.assertTrue(all(size <= 5 for size in sizes))  # bounded
        self.assertEqual(delays[:-1], [2.0] * (len(delays) - 1))  # paced, never a burst
        self.assertEqual(len(self.rows(s, "WHERE state='synced' AND window_state='synced'")), 12)
        self.assertTrue(any("acknowledged 5 observations" in entry for entry in self.logs))

    def test_batch_size_is_bounded(self):
        with self.csv.open("a") as handle:
            handle.write("".join(line(self.session, w) for w in range(5, 12)))
        s = self.agent(sync_batch=5)
        s.cycle(0)
        self.assertEqual(len(self.rows(s, "WHERE state='synced'")), 5)
        self.assertEqual(sync.Sync(self.config(sync_batch=10_000), self.api, print).batch, sync.MAX_BATCH)


if __name__ == "__main__":
    unittest.main()
