import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import time
import unittest

HERE = Path(__file__).resolve().parent


def load(name):
    spec = importlib.util.spec_from_file_location(name, HERE / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


agent = load("agent")
HEADER = "window_end_utc,audio_valid,audio_warning,audio_status_events,dropped_audio_blocks,sensor_status,ram_status,latest_storage_status,model_sha256"

FAKE_SYSTEMCTL = """#!/usr/bin/env python3
import sys
from pathlib import Path
base = Path(__file__).parent
state = base / "state"
with (base / "calls").open("a") as calls:
    calls.write(" ".join(sys.argv[1:]) + "\\n")
verb = sys.argv[1]
if verb == "is-active":
    value = state.read_text().strip() if state.exists() else "inactive"
    print(value)
    sys.exit(0 if value == "active" else 3)
if verb == "show":
    print("exit-code")
elif verb in ("start", "restart"):
    state.write_text((base / "start_result").read_text() if (base / "start_result").exists() else "active")
elif verb == "stop":
    state.write_text("inactive")
"""


class FakeApi:
    def __init__(self, commands=(), ack_status=200, claim_status=200):
        self.commands = list(commands)
        self.ack_status = ack_status
        self.claim_status = claim_status
        self.calls = []

    def call(self, method, path, body=None):
        self.calls.append((method, path, body))
        if path == "/edge/commands":
            return 200, self.commands
        if path.endswith("/ack"):
            return self.claim_status, {}
        if path.startswith("/edge/commands/"):
            return self.ack_status, {}
        return 200, {"ok": True}

    def acks(self):
        """Reported results (not claims)."""
        return [(path.rsplit("/", 1)[1], body) for method, path, body in self.calls
                if path.startswith("/edge/commands/") and not path.endswith("/ack")]

    def claims(self):
        return [path.split("/")[3] for method, path, body in self.calls if path.endswith("/ack")]


class AgentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        base = Path(self.temp.name)
        self.root = base / "root"
        for relative, content in {
            "proc/stat": "cpu  100 0 100 800 0 0 0 0 0 0\n",
            "proc/meminfo": "MemTotal: 4000000 kB\nMemAvailable: 3000000 kB\n",
            "proc/uptime": "7380.5 1000.0\n",
            "proc/asound/cards": " 2 [ICS43434       ]: simple-card - ICS43434\n",
            "sys/class/thermal/thermal_zone0/temp": "48250\n",
        }.items():
            path = self.root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
        self.runs = base / "runs"
        self.write_row("True,,0,0,ok,ok,ok,abcdef0123456789")
        self.tools = base / "tools"
        self.tools.mkdir()
        systemctl = self.tools / "systemctl"
        systemctl.write_text(FAKE_SYSTEMCTL)
        systemctl.chmod(systemctl.stat().st_mode | stat.S_IEXEC)
        (self.tools / "state").write_text("active")
        self.state = base / "state"
        self.state.mkdir()
        self.config = agent.Config({
            "BEEHAVE_API_URL": "http://127.0.0.1:9",
            "BEEHAVE_RUNS_DIR": str(self.runs),
            "BEEHAVE_STATE_DIR": str(self.state),
            "BEEHAVE_SYSTEM_ROOT": str(self.root),
            "BEEHAVE_SYSTEMCTL": str(systemctl),
            "BEEHAVE_NMCLI": str(self.tools / "missing-nmcli"),
            "BEEHAVE_SETTLE_SECONDS": "0",
        })

    def tearDown(self):
        self.temp.cleanup()

    def write_row(self, values, run="20261019T210110Z"):
        path = self.runs / run / "classifications.csv"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"{HEADER}\n2026-10-19T21:01:10+00:00,{values}\n")
        return path

    def calls(self):
        path = self.tools / "calls"
        return path.read_text().splitlines() if path.exists() else []

    def test_health_from_running_monitor(self):
        health = agent.Health(self.config).collect()
        self.assertTrue(health["collecting"])
        self.assertTrue(health["microphone"])
        self.assertTrue(health["sensor"])
        self.assertEqual(health["cpuTemperature"], 48.2)
        self.assertEqual(health["ram"], 25.0)
        self.assertEqual(health["uptimeSeconds"], 7380.5)
        self.assertEqual(health["monitoringService"], "active")
        self.assertEqual(health["uploader"], "not installed")
        self.assertEqual(health["queued"], 0)
        self.assertEqual(health["errors"], [])
        self.assertIn("model abcdef01", health["softwareVersion"])
        self.assertNotIn("key", json.dumps(health).lower())

    def test_quiet_hive_is_not_a_microphone_fault(self):
        self.write_row("False,too_quiet,0,0,ok,ok,ok,abc")
        self.assertTrue(agent.Health(self.config).collect()["microphone"])

    def test_sensor_and_audio_problems_are_reported(self):
        self.write_row("True,,2,5,initialization_error:OSError,ok,warning,abc")
        health = agent.Health(self.config).collect()
        self.assertFalse(health["microphone"])
        self.assertFalse(health["sensor"])
        self.assertEqual(len(health["errors"]), 3)

    def test_stopped_monitor_reports_last_known_state(self):
        (self.tools / "state").write_text("inactive")
        old = time.time() - 3600
        path = self.runs / "20261019T210110Z" / "classifications.csv"
        os.utime(path, (old, old))
        health = agent.Health(self.config).collect()
        self.assertFalse(health["collecting"])
        self.assertEqual(health["sensorStatusDetail"], "Was reading normally when monitoring last ran")
        self.assertEqual(health["audioStatusDetail"], "Was recording normally when monitoring last ran")

    def test_newest_run_is_used(self):
        self.write_row("True,,0,0,initialization_error:OSError,ok,ok,abc", run="20261020T000000Z")
        self.assertFalse(agent.Health(self.config).collect()["sensor"])

    def test_restart_monitoring_reports_real_state(self):
        api = FakeApi([{"id": "c1", "action": "monitoring_restart"}])
        agent.Agent(self.config, api).poll()
        self.assertIn("restart beehave-continuous.service", self.calls())
        self.assertEqual(api.acks(), [("c1", {"status": "succeeded", "message": "Monitoring is running."})])

    def test_monitor_that_does_not_stay_up_is_a_failure(self):
        (self.tools / "start_result").write_text("failed")
        (self.tools / "state").write_text("inactive")
        api = FakeApi([{"id": "c2", "action": "monitoring_start"}])
        agent.Agent(self.config, api).poll()
        [(command, body)] = api.acks()
        self.assertEqual(body["status"], "failed")
        self.assertIn("did not stay running", body["message"])

    def test_stop_monitoring(self):
        api = FakeApi([{"id": "c3", "action": "monitoring_stop"}])
        agent.Agent(self.config, api).poll()
        self.assertEqual(api.acks()[0][1]["status"], "succeeded")
        self.assertEqual((self.tools / "state").read_text(), "inactive")

    def test_reboot_runs_only_after_the_api_accepts_the_result(self):
        api = FakeApi([{"id": "r1", "action": "reboot"}])
        agent.Agent(self.config, api).poll()
        self.assertEqual(api.acks()[0][1]["status"], "succeeded")
        self.assertIn("reboot", self.calls())

    def test_cancelled_power_request_does_nothing(self):
        api = FakeApi([{"id": "r2", "action": "shutdown"}], ack_status=409)
        agent.Agent(self.config, api).poll()
        self.assertNotIn("poweroff", self.calls())

    def test_monitoring_is_claimed_before_it_runs(self):
        api = FakeApi([{"id": "c5", "action": "monitoring_stop", "expiresIn": 180}])
        agent.Agent(self.config, api).poll()
        self.assertEqual(api.claims(), ["c5"])
        paths = [path for method, path, body in api.calls]
        self.assertLess(paths.index("/edge/commands/c5/ack"), paths.index("/edge/commands/c5"))

    def test_refused_claim_never_runs(self):
        # Expired, cancelled or already claimed: the API refuses and the device does nothing.
        for action, effect in (("monitoring_stop", "stop beehave-continuous.service"), ("reboot", "reboot")):
            api = FakeApi([{"id": "x-" + action, "action": action}], claim_status=409)
            agent.Agent(self.config, api).poll()
            self.assertNotIn(effect, self.calls())
            self.assertEqual(api.acks(), [])
            # A later delivery of the same request is still ignored.
            agent.Agent(self.config, api).poll()
            self.assertEqual(api.claims(), ["x-" + action])

    def test_request_past_its_deadline_is_ignored(self):
        api = FakeApi([{"id": "t1", "action": "monitoring_stop", "expiresIn": 0}])
        agent.Agent(self.config, api).poll()
        self.assertEqual((api.claims(), api.acks()), ([], []))
        self.assertNotIn("stop beehave-continuous.service", self.calls())

    def test_claimed_reboot_is_not_repeated_after_a_crash(self):
        # The agent claimed the restart and then stopped before recording an outcome.
        (self.state / "commands.json").write_text(json.dumps(
            {"r4": {"action": "reboot", "outcome": None, "reported": False}}))
        api = FakeApi([{"id": "r4", "action": "reboot"}])
        agent.Agent(self.config, api).poll()
        self.assertEqual((api.claims(), api.acks()), ([], []))
        self.assertNotIn("reboot", self.calls())

    def test_reported_reboot_is_not_repeated_after_booting(self):
        api = FakeApi([{"id": "r5", "action": "reboot"}])
        agent.Agent(self.config, api).poll()
        self.assertEqual(self.calls().count("reboot"), 1)
        # After the boot the API still lists it while it verifies the reconnect.
        agent.Agent(self.config, api).poll()
        self.assertEqual(self.calls().count("reboot"), 1)

    def test_unknown_action_is_refused(self):
        api = FakeApi([{"id": "u1", "action": "format_disk"}])
        agent.Agent(self.config, api).poll()
        self.assertEqual(api.acks()[0][1]["status"], "failed")
        self.assertEqual(self.calls(), [])

    def test_request_is_never_run_twice(self):
        api = FakeApi([{"id": "c4", "action": "monitoring_restart"}])
        worker = agent.Agent(self.config, api)
        worker.poll()
        worker.poll()
        self.assertEqual(self.calls().count("restart beehave-continuous.service"), 1)
        # A new process reads the same journal.
        agent.Agent(self.config, api).poll()
        self.assertEqual(self.calls().count("restart beehave-continuous.service"), 1)

    def test_unreported_reboot_is_finished_after_a_crash(self):
        (self.state / "commands.json").write_text(json.dumps(
            {"r3": {"action": "reboot", "outcome": "succeeded", "message": "Restarting now.", "reported": False}}))
        api = FakeApi([{"id": "r3", "action": "reboot"}])
        agent.Agent(self.config, api).poll()
        self.assertEqual(len(api.acks()), 1)
        self.assertIn("reboot", self.calls())

    def test_heartbeat_sends_health_only(self):
        api = FakeApi()
        agent.Agent(self.config, api).heartbeat()
        [(method, path, body)] = api.calls
        self.assertEqual((method, path, list(body)), ("POST", "/edge/batch", ["health"]))

    def test_api_url_must_be_an_origin(self):
        with self.assertRaises(SystemExit):
            agent.Config({"BEEHAVE_API_URL": "http://192.168.1.27:3001/api"})


class NetworkTests(AgentTests):
    """Read-only network status and Wi-Fi scan through the setup service's socket."""

    STATUS = {
        "method": "wifi", "setupMode": False, "ssid": "eds", "signal": 72, "ipAddress": "192.168.1.29",
        "internet": "full", "lastConnectedAt": "2026-10-22T05:00:00+00:00",
        "lastFailure": {"ssid": "ALAS ", "stage": "wrong_password", "message": "Incorrect Wi-Fi password.", "at": "2026-10-21T10:00:00+00:00"},
        "saved": [
            {"ssid": "eds", "profile": "eds", "autoconnect": True, "priority": 100, "active": True, "inRange": True},
            {"ssid": "iLounge", "profile": "iLounge", "autoconnect": False, "priority": 0, "active": False, "inRange": False},
        ],
        "psk": "must-never-leave", "bssid": "aa:bb:cc:dd:ee:ff",
    }

    def setUp(self):
        super().setUp()
        import socket
        import threading
        # Short path: macOS limits AF_UNIX socket paths to about 100 bytes.
        self.socket_dir = tempfile.TemporaryDirectory(dir="/tmp")
        path = Path(self.socket_dir.name) / "s.sock"
        self.requests = []
        self.replies = {"status": self.STATUS, "scan": {"networks": [
            {"ssid": "Farm WiFi", "signal": 81, "security": "wpa2"}, {"ssid": "Open Cafe", "signal": 30, "security": "open"},
            {"ssid": "x" * 40, "signal": 10, "security": "wpa2"}], "scannedAt": 1792634400, "cached": False}}
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(str(path))
        server.listen(4)
        self.server = server

        def serve():
            while True:
                try:
                    connection, _ = server.accept()
                except OSError:
                    return
                with connection:
                    op = json.loads(connection.makefile("r").readline())["op"]
                    self.requests.append(op)
                    connection.sendall((json.dumps(self.replies.get(op, {"error": "Unsupported request"})) + "\n").encode())

        threading.Thread(target=serve, daemon=True).start()
        self.config.setup_socket = path

    def tearDown(self):
        self.server.close()
        self.socket_dir.cleanup()
        super().tearDown()

    def test_heartbeat_carries_whitelisted_network_status(self):
        network = agent.Health(self.config).collect()["network"]
        self.assertEqual(network["ssid"], "eds")
        self.assertEqual(network["signal"], 72)
        self.assertEqual(network["lastFailure"]["stage"], "wrong_password")
        self.assertEqual([n["ssid"] for n in network["saved"]], ["eds", "iLounge"])
        text = json.dumps(network)
        self.assertNotIn("must-never-leave", text)
        self.assertNotIn("aa:bb:cc", text)
        self.assertEqual(self.requests, ["status"])

    def test_setup_label_is_shared_once_and_again_when_it_changes(self):
        label = {"hotspot": "BeeHave-01-Setup", "hotspotPassword": "p" * 24, "code": "c" * 32}
        self.replies["label"] = {**label, "extra": "never sent"}
        api = FakeApi()
        device = agent.Agent(self.config, api)
        device.heartbeat()
        device.heartbeat()
        self.replies["label"] = {**label, "hotspotPassword": "q" * 24}
        device.heartbeat()
        shared = [body for method, path, body in api.calls if path == "/edge/setup-label"]
        self.assertEqual(shared, [label, {**label, "hotspotPassword": "q" * 24}])

    def test_setup_label_waits_for_an_accepted_heartbeat(self):
        self.replies["label"] = {"hotspot": "BeeHave-01-Setup", "hotspotPassword": "p" * 24, "code": "c" * 32}
        api = FakeApi()
        api.call = lambda method, path, body=None: (api.calls.append((method, path, body)) or (503, {}))
        agent.Agent(self.config, api).heartbeat()
        self.assertEqual([path for _, path, _ in api.calls], ["/edge/batch"])

    def test_setup_page_result_is_whitelisted(self):
        self.replies["status"] = {**self.STATUS, "setupPageResult": {
            "ssid": "Farm WiFi", "result": "failed", "stage": "wrong_password", "message": "Incorrect Wi-Fi password.",
            "at": "2026-10-25T01:00:00+00:00", "password": "must-never-leave"}}
        result = agent.Health(self.config).collect()["network"]["setupPageResult"]
        self.assertEqual(result, {"ssid": "Farm WiFi", "result": "failed", "stage": "wrong_password",
                                  "message": "Incorrect Wi-Fi password.", "at": "2026-10-25T01:00:00+00:00"})
        self.replies["status"] = {**self.STATUS, "setupPageResult": {"result": "maybe", "at": "2026-10-25T01:00:00+00:00"}}
        self.assertNotIn("setupPageResult", agent.Health(self.config).collect()["network"])

    def test_missing_or_malformed_status_is_left_out(self):
        self.replies["status"] = {"method": "teleport"}
        self.assertNotIn("network", agent.Health(self.config).collect())
        self.config.setup_socket = Path(self.socket_dir.name) / "missing.sock"
        self.assertNotIn("network", agent.Health(self.config).collect())

    def test_scan_is_claimed_and_reports_sanitized_networks(self):
        api = FakeApi([{"id": "s1", "action": "network_scan", "expiresIn": 120}])
        agent.Agent(self.config, api).poll()
        self.assertEqual(api.claims(), ["s1"])
        [(command, body)] = api.acks()
        self.assertEqual(body["status"], "succeeded")
        self.assertEqual(body["message"], "Found 2 Wi-Fi networks.")
        self.assertEqual([n["ssid"] for n in body["data"]["networks"]], ["Farm WiFi", "Open Cafe"])
        self.assertEqual(body["data"]["scannedAt"], "2026-10-22T02:00:00Z")
        # A scan never touches monitoring or power.
        self.assertEqual(self.calls(), [])

    WIFI = {"id": "w1", "action": "wifi_connect", "target": "Farm WiFi", "params": {"hidden": False},
            "credential": {"v": 1, "epk": "ab" * 32, "nonce": "cd" * 12, "ct": "ef" * 30}}

    def test_wifi_change_passes_the_sealed_password_through_untouched(self):
        self.replies["connect"] = {"result": "connected", "stage": "online", "ssid": "Farm WiFi", "previous": "eds", "current": "Farm WiFi"}
        received = []
        original = agent.setup_request
        agent.setup_request = lambda path, op, timeout, **fields: (received.append((op, fields)), original(path, op, timeout, **fields))[1]
        try:
            api = FakeApi([dict(self.WIFI)])
            agent.Agent(self.config, api).poll()
        finally:
            agent.setup_request = original
        self.assertEqual(api.claims(), ["w1"])
        [(op, fields)] = received
        self.assertEqual((op, fields["ssid"], fields["commandId"], fields["credential"]), ("connect", "Farm WiFi", "w1", self.WIFI["credential"]))
        [(command, body)] = api.acks()
        self.assertEqual((body["status"], body["message"]), ("succeeded", "Connected to Farm WiFi."))
        self.assertEqual(body["data"]["result"], "connected")
        # The journal keeps the outcome for retries, never the sealed password.
        self.assertNotIn("ef" * 30, (self.state / "commands.json").read_text())

    def test_failed_wifi_change_explains_what_happened(self):
        self.replies["connect"] = {"result": "restored", "stage": "wrong_password", "ssid": "Farm WiFi", "previous": "eds", "current": "eds"}
        api = FakeApi([dict(self.WIFI)])
        agent.Agent(self.config, api).poll()
        [(command, body)] = api.acks()
        self.assertEqual(body["status"], "failed")
        self.assertEqual(body["message"], "Incorrect password, or the network rejected it. BeeHave restored the previous network (eds).")
        self.replies["connect"] = {"result": "setup_mode", "stage": "not_found", "ssid": "Farm WiFi"}
        api = FakeApi([dict(self.WIFI, id="w2")])
        agent.Agent(self.config, api).poll()
        self.assertIn("setup mode", api.acks()[0][1]["message"])

    def test_interrupted_wifi_change_is_not_repeated(self):
        (self.state / "commands.json").write_text(json.dumps({"w3": {"action": "wifi_connect", "outcome": None, "reported": False}}))
        api = FakeApi([dict(self.WIFI, id="w3")])
        agent.Agent(self.config, api).poll()
        self.assertEqual((api.claims(), api.acks()), ([], []))
        self.assertNotIn("connect", self.requests)

    def test_saved_network_changes_go_to_the_setup_service(self):
        received = []
        original = agent.setup_request
        agent.setup_request = lambda path, op, timeout, **fields: (received.append((op, fields)), original(path, op, timeout, **fields))[1]
        try:
            self.replies["manage"] = {"result": "updated", "stage": "priority", "ssid": "eds", "message": "eds now has priority 90."}
            api = FakeApi([{"id": "p1", "action": "wifi_priority", "target": "eds", "params": {"profile": "u1", "priority": 90}}])
            agent.Agent(self.config, api).poll()
            self.assertEqual(api.acks()[0][1], {"status": "succeeded", "message": "eds now has priority 90."})
            self.replies["manage"] = {"result": "stayed", "stage": "no_other_network", "ssid": "eds", "message": "No other saved network is in range."}
            api = FakeApi([{"id": "f1", "action": "wifi_forget", "target": "eds", "params": {"profile": "u1"}}])
            agent.Agent(self.config, api).poll()
            self.assertEqual(api.acks()[0][1]["status"], "failed")
        finally:
            agent.setup_request = original
        self.assertEqual(received, [("manage", {"action": "priority", "ssid": "eds", "profile": "u1", "priority": 90}),
                                    ("manage", {"action": "forget", "ssid": "eds", "profile": "u1", "priority": None})])
        self.assertEqual(self.calls(), [])

    def test_scan_without_setup_service_fails_visibly(self):
        self.config.setup_socket = Path(self.socket_dir.name) / "missing.sock"
        api = FakeApi([{"id": "s2", "action": "network_scan"}])
        agent.Agent(self.config, api).poll()
        [(command, body)] = api.acks()
        self.assertEqual(body["status"], "failed")
        self.assertNotIn("data", body)


class ClockJumpTests(AgentTests):
    def test_status_follows_the_run_being_written_not_the_highest_name(self):
        # 2026-10-22: power was lost during run 044111Z (its CSV ends in NUL padding); after the
        # reboot the clock was behind, so the live run got the earlier name 044026Z.
        dead = self.write_row("True,,0,3,ok,ok,ok,deadrun000000000", run="20261022T044111Z")
        with dead.open("ab") as handle:
            handle.write(b"\0" * 4096)
        os.utime(dead, (time.time() - 6866, time.time() - 6866))
        self.write_row("True,,0,0,ok,ok,ok,liverun000000000", run="20261022T044026Z")
        row, age = agent.Health(self.config).latest_row()
        self.assertEqual(row["model_sha256"], "liverun000000000")
        self.assertLess(age, 60)
        self.assertTrue(agent.Health(self.config).collect()["collecting"])

    def test_nul_padding_after_power_loss_is_not_read_as_a_row(self):
        dead = self.write_row("True,,0,0,ok,ok,ok,lastgoodrow00000", run="20261022T044111Z")
        with dead.open("ab") as handle:
            handle.write(b"\0" * 4096)
        row, _ = agent.Health(self.config).latest_row()
        self.assertEqual(row["model_sha256"], "lastgoodrow00000")


class BackoffTests(AgentTests):
    def test_sync_wakeups_do_not_reset_heartbeat_backoff(self):
        class DownApi:
            def call(self, *args, **kwargs):
                raise OSError("unreachable")

        class EagerSync:
            next_attempt = 0.0
            def due(self, now):
                return now >= self.next_attempt
            def cycle(self, now):
                self.next_attempt = now + 2  # wakes the loop far more often than the heartbeat backoff
            def pending(self):
                return 0

        clock = [0.0]
        logs = []
        originals = (agent.time.monotonic, agent.time.sleep, agent.log)
        agent.time.monotonic = lambda: clock[0]
        agent.time.sleep = lambda seconds: clock.__setitem__(0, clock[0] + seconds)
        agent.log = logs.append
        try:
            worker = agent.Agent(self.config, DownApi())
            worker.sync = EagerSync()
            worker.run(stop_after=1000)
        finally:
            agent.time.monotonic, agent.time.sleep, agent.log = originals
        delays = [float(line.split("retrying in ")[1].split()[0]) for line in logs if "API unreachable" in line]
        self.assertEqual(delays[:7], [5, 10, 20, 40, 60, 60, 60])
        self.assertLessEqual(max(delays), 60)


    def test_reconnect_starts_queued_sync_without_waiting_out_its_backoff(self):
        class FlakyApi:
            up = False
            def call(self, *args, **kwargs):
                if not self.up:
                    raise OSError("unreachable")
                return 200, []

        class OfflineSync:
            def __init__(self):
                self.next_attempt, self.failures, self.unreachable, self.passes = 0.0, 0, False, []
            def due(self, now):
                return now >= self.next_attempt
            def cycle(self, now):
                self.passes.append(now)
                if not api.up:
                    self.failures, self.unreachable, self.next_attempt = self.failures + 1, True, now + 1000  # a long sync backoff
                else:
                    self.failures, self.unreachable, self.next_attempt = 0, False, now + 10
            def pending(self):
                return 0

        api = FlakyApi()
        clock = [0.0]
        originals = (agent.time.monotonic, agent.time.sleep, agent.log)
        agent.time.monotonic = lambda: clock[0]
        def sleep(seconds):
            clock[0] += seconds
            if clock[0] >= 100:
                api.up = True  # network returns
        agent.time.sleep = sleep
        agent.log = lambda message: None
        try:
            worker = agent.Agent(self.config, api)
            worker.sync = OfflineSync()
            worker.run(stop_after=200)
        finally:
            agent.time.monotonic, agent.time.sleep, agent.log = originals
        # The heartbeat retry (at most 60 s) finds the API again and releases the queued data.
        self.assertTrue(any(100 <= t <= 161 for t in worker.sync.passes), worker.sync.passes)


class LoadKeyTests(unittest.TestCase):
    def run_loader(self, pairing):
        with tempfile.TemporaryDirectory() as temp:
            source, target = Path(temp) / "pairing.json", Path(temp) / "device.key"
            source.write_text(json.dumps(pairing))
            result = subprocess.run([sys.executable, str(HERE / "load_key.py")], capture_output=True, text=True,
                                    env={**os.environ, "BEEHAVE_PAIRING_FILE": str(source), "BEEHAVE_DEVICE_KEY_FILE": str(target)})
            self.assertEqual(result.returncode, 0)
            self.assertNotIn("secret-key", result.stdout + result.stderr)
            return (target.read_text(), stat.S_IMODE(target.stat().st_mode)) if target.exists() else None

    def test_paired_key_is_copied_privately(self):
        self.assertEqual(self.run_loader({"key": "secret-key", "completed": True}), ("secret-key", 0o400))

    def test_unpaired_pi_gets_no_key(self):
        self.assertIsNone(self.run_loader({"key": "secret-key"}))

    def test_device_id_is_published_for_observation_identities(self):
        with tempfile.TemporaryDirectory() as temp:
            source, target = Path(temp) / "pairing.json", Path(temp) / "device.key"
            source.write_text(json.dumps({"key": "secret-key", "completed": True, "deviceId": "device-1"}))
            subprocess.run([sys.executable, str(HERE / "load_key.py")], check=True, capture_output=True,
                           env={**os.environ, "BEEHAVE_PAIRING_FILE": str(source), "BEEHAVE_DEVICE_KEY_FILE": str(target)})
            self.assertEqual((Path(temp) / "device.id").read_text(), "device-1")


if __name__ == "__main__":
    unittest.main()
