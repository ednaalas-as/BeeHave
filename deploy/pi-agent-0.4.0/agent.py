#!/usr/bin/env python3
"""BeeHave device agent: heartbeat with health, remote requests from the API, and
(when enabled) offline-first upload of the monitor's observations (see sync.py).

Runs as the unprivileged ``beehave-agent`` user. It reads monitoring files only
through a read-only mount, never edits or deletes them, and never logs the device key.
"""
import csv
import http.client
import io
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import time
from urllib import error, request
from urllib.parse import urlparse

VERSION = "0.4.0"
ACTIONS = {"reboot", "shutdown", "monitoring_start", "monitoring_stop", "monitoring_restart", "network_scan", "wifi_connect"}


class Unauthorized(Exception):
    """The device key was rejected; systemd restarts the agent with a fresh key."""


class Config:
    def __init__(self, env=os.environ):
        self.api = env["BEEHAVE_API_URL"].rstrip("/")
        parsed = urlparse(self.api)
        if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.path not in ("", "/"):
            raise SystemExit("BEEHAVE_API_URL must be an http(s) origin such as http://192.168.1.27:3001")
        self.key_file = Path(env.get("BEEHAVE_DEVICE_KEY_FILE", "/run/beehave-agent/device.key"))
        self.runs = Path(env.get("BEEHAVE_RUNS_DIR", "/run/beehave-monitor-runs"))
        self.state = Path(env.get("BEEHAVE_STATE_DIR", "/var/lib/beehave-agent"))
        # Test prefix for /proc and /sys; "/" on the Pi.
        self.root = Path(env.get("BEEHAVE_SYSTEM_ROOT", "/"))
        self.unit = env.get("BEEHAVE_MONITOR_UNIT", "beehave-continuous.service")
        self.systemctl = env.get("BEEHAVE_SYSTEMCTL", "/usr/bin/systemctl")
        self.nmcli = env.get("BEEHAVE_NMCLI", "/usr/bin/nmcli")
        # Read-only network status/scan socket of the BeeHave setup service (which runs as root).
        self.setup_socket = Path(env.get("BEEHAVE_SETUP_SOCKET", "/run/beehave-setup/agent.sock"))
        self.mic_card = env.get("BEEHAVE_MIC_CARD", "ICS43434")
        self.heartbeat = float(env.get("BEEHAVE_HEARTBEAT_SECONDS", "30"))
        self.poll = float(env.get("BEEHAVE_POLL_SECONDS", "10"))
        self.settle = float(env.get("BEEHAVE_SETTLE_SECONDS", "5"))
        self.fresh = float(env.get("BEEHAVE_FRESH_SECONDS", "60"))
        # Observation sync is off unless explicitly enabled, and never reaches back before
        # BEEHAVE_SYNC_FIRST_SESSION: earlier sessions are history and need an approved backfill.
        self.sync_enabled = env.get("BEEHAVE_SYNC_ENABLED", "0") == "1"
        self.sync_first_session = env.get("BEEHAVE_SYNC_FIRST_SESSION", "")
        if self.sync_enabled and not re.fullmatch(r"\d{8}T\d{6}Z", self.sync_first_session):
            raise SystemExit("BEEHAVE_SYNC_FIRST_SESSION must be a session ID such as 20261020T124852Z")
        limit = env.get("BEEHAVE_SYNC_ADMIT_LIMIT", "")
        self.sync_admit_limit = int(limit) if limit else None
        self.sync_batch = int(env.get("BEEHAVE_SYNC_BATCH", "100"))
        self.sync_interval = float(env.get("BEEHAVE_SYNC_SECONDS", "10"))
        self.sync_backlog_pause = float(env.get("BEEHAVE_SYNC_BACKLOG_PAUSE_SECONDS", "2"))
        self.sync_timeout = float(env.get("BEEHAVE_SYNC_TIMEOUT_SECONDS", "60"))
        self.sync_non_bee = env.get("BEEHAVE_SYNC_NON_BEE", "1") == "1"
        self.device_id_file = Path(env.get("BEEHAVE_DEVICE_ID_FILE", "/run/beehave-agent/device.id"))
        self.device_id = None
        # Explicit activation prevents a new installation from uploading history.
        self.audio_enabled = env.get("BEEHAVE_AUDIO_ENABLED", "0") == "1"
        self.audio_recording = env.get("BEEHAVE_AUDIO_RECORDING_ID", "")
        self.audio_interval = max(2.0, float(env.get("BEEHAVE_AUDIO_SECONDS", "2")))
        self.audio_timeout = max(1.0, min(60.0, float(env.get("BEEHAVE_AUDIO_TIMEOUT_SECONDS", "20"))))
        if self.audio_enabled and not self.sync_enabled:
            raise SystemExit("Audio transfer requires observation sync")


def setup_request(path, op, timeout, **fields):
    """Ask the setup service for network information or a requested Wi-Fi change. None when
    unavailable. A sealed Wi-Fi password passes through untouched: only the service can open it."""
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(timeout)
            client.connect(str(path))
            client.sendall((json.dumps({"op": op, **fields}) + "\n").encode())
            line = client.makefile("r", encoding="utf-8").readline(262144)
        reply = json.loads(line)
        return reply if isinstance(reply, dict) and "error" not in reply else None
    except (OSError, ValueError):
        return None


def _text(value, limit):
    return value if isinstance(value, str) and value and len(value) <= limit else None


def _when(value):
    return value if isinstance(value, str) and re.fullmatch(r"\d{4}-\d\d-\d\dT[\d:.]+(Z|[+-]\d\d:\d\d)", value) else None


def sanitize_network(raw):
    """Whitelist the setup service's status so a surprise can never break heartbeats."""
    if not isinstance(raw, dict) or raw.get("method") not in ("wifi", "ethernet", "setup", "offline"):
        return None
    network = {"method": raw["method"], "setupMode": raw.get("setupMode") is True}
    for name, limit in (("ssid", 32), ("ipAddress", 64)):
        if _text(raw.get(name), limit):
            network[name] = raw[name]
    if isinstance(raw.get("signal"), int) and not isinstance(raw["signal"], bool) and 0 <= raw["signal"] <= 100:
        network["signal"] = raw["signal"]
    if raw.get("internet") in ("full", "limited", "portal", "none", "unknown"):
        network["internet"] = raw["internet"]
    if _when(raw.get("lastConnectedAt")):
        network["lastConnectedAt"] = raw["lastConnectedAt"]
    failure = raw.get("lastFailure")
    if isinstance(failure, dict) and _when(failure.get("at")):
        network["lastFailure"] = {
            "ssid": (_text(failure.get("ssid"), 32) or ""), "stage": (_text(failure.get("stage"), 40) or "failed"),
            "message": (_text(failure.get("message"), 200) or "The last Wi-Fi change did not finish."), "at": failure["at"],
        }
    saved = []
    for item in raw.get("saved") if isinstance(raw.get("saved"), list) else []:
        if isinstance(item, dict) and _text(item.get("ssid"), 32) and isinstance(item.get("priority"), int):
            saved.append({
                **({"id": item["id"]} if _text(item.get("id"), 64) else {}),
                "ssid": item["ssid"], "profile": _text(item.get("profile"), 64) or "",
                "autoconnect": item.get("autoconnect") is True, "priority": max(-999, min(999, item["priority"])),
                "active": item.get("active") is True, "inRange": item.get("inRange") is True,
            })
    network["saved"] = saved[:30]
    if isinstance(raw.get("credentialKey"), str) and re.fullmatch(r"[0-9a-f]{64}", raw["credentialKey"]):
        network["credentialKey"] = raw["credentialKey"]
    return network


def sanitize_scan(raw):
    networks = []
    for item in raw.get("networks", []) if isinstance(raw, dict) and isinstance(raw.get("networks"), list) else []:
        if isinstance(item, dict) and _text(item.get("ssid"), 32) and isinstance(item.get("signal"), int):
            networks.append({"ssid": item["ssid"], "signal": max(0, min(100, item["signal"])),
                             "security": _text(item.get("security"), 20) or "secured"})
    scanned = raw.get("scannedAt") if isinstance(raw, dict) else None
    return {
        "networks": networks[:40],
        "cached": isinstance(raw, dict) and raw.get("cached") is True,
        **({"scannedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(scanned))} if isinstance(scanned, int) and scanned > 0 else {}),
    }


def log(message):
    print(message, flush=True)


class Api:
    def __init__(self, config):
        self.base = config.api + "/api"
        self.key = config.key_file.read_text().strip()
        if not self.key:
            raise SystemExit("Device key file is empty; the Pi may not be paired.")

    def call(self, method, path, body=None, timeout=15, headers=None):
        data = body if isinstance(body, bytes) else json.dumps(body).encode() if body is not None else None
        req = request.Request(self.base + path, data=data, method=method)
        req.add_header("X-Device-Key", self.key)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        for name, value in (headers or {}).items():
            req.add_header(name, value)
        try:
            with request.urlopen(req, timeout=timeout) as response:
                return response.status, json.loads(response.read() or b"null")
        except error.HTTPError as failure:
            if failure.code == 401:
                raise Unauthorized() from None
            try:
                payload = json.loads(failure.read() or b"null")
            except ValueError:
                payload = None
            return failure.code, payload


class Health:
    def __init__(self, config):
        self.config = config
        self.cpu_sample = self._cpu_times()
        self.sync = None

    def _read(self, relative):
        try:
            return (self.config.root / relative).read_text()
        except OSError:
            return ""

    def _cpu_times(self):
        fields = self._read("proc/stat").split("\n", 1)[0].split()[1:]
        values = [int(v) for v in fields if v.isdigit()]
        if len(values) < 4:
            return None
        idle = values[3] + (values[4] if len(values) > 4 else 0)
        return sum(values), idle

    def cpu(self):
        current = self._cpu_times()
        previous, self.cpu_sample = self.cpu_sample, current
        if not current or not previous or current[0] <= previous[0]:
            return 0.0
        total = current[0] - previous[0]
        return round(100 * (1 - (current[1] - previous[1]) / total), 1)

    def ram(self):
        info = {}
        for line in self._read("proc/meminfo").splitlines():
            name, _, value = line.partition(":")
            if value.strip():
                info[name] = int(value.split()[0])
        if not info.get("MemTotal"):
            return 0.0
        return round(100 * (1 - info.get("MemAvailable", 0) / info["MemTotal"]), 1)

    def cpu_temperature(self):
        try:
            return round(int(self._read("sys/class/thermal/thermal_zone0/temp").strip()) / 1000, 1)
        except ValueError:
            return 0.0

    def uptime(self):
        try:
            return float(self._read("proc/uptime").split()[0])
        except (IndexError, ValueError):
            return None

    def microphone_present(self):
        return self.config.mic_card in self._read("proc/asound/cards")

    def latest_row(self):
        """Last window written by the monitor, and the age of its file in seconds."""
        # Newest-written first, not by name: a run started before the clock was set after a
        # power loss is named earlier than the runs it actually follows.
        runs = []
        try:
            for run in self.config.runs.iterdir():
                try:
                    runs.append(((run / "classifications.csv").stat().st_mtime, run.name, run))
                except OSError:
                    continue
        except OSError:
            return None, None
        for mtime, _, run in sorted(runs, reverse=True):
            path = run / "classifications.csv"
            try:
                age = time.time() - mtime
                with path.open("rb") as handle:
                    header = handle.readline().decode()
                    handle.seek(0, os.SEEK_END)
                    end = handle.tell()
                    handle.seek(max(len(header), end - 16384))
                    tail = handle.read().decode(errors="replace")
            except OSError:
                continue
            # A power cut can leave NUL padding and a cut-short last line: use the newest line
            # that has every column, and try an older run only if this one has none.
            rows = [line for line in tail.replace("\x00", "").splitlines() if line.strip()]
            for line in reversed(rows):
                if line == header.strip():
                    continue
                parsed = next(csv.DictReader(io.StringIO(header + line + "\n")), None)
                if parsed and None not in parsed and None not in parsed.values():
                    return parsed, age
        return None, None

    def service_state(self):
        try:
            result = subprocess.run([self.config.systemctl, "is-active", self.config.unit],
                                    capture_output=True, text=True, timeout=10)
            return result.stdout.strip() or "unknown"
        except (OSError, subprocess.TimeoutExpired):
            return "unknown"

    def ip_address(self):
        target = urlparse(self.config.api)
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
                # Connecting a UDP socket sends nothing; it only selects the outgoing interface.
                probe.connect((target.hostname, target.port or 80))
                return probe.getsockname()[0]
        except OSError:
            return None

    def wifi_network(self):
        if not shutil.which(self.config.nmcli):
            return None
        try:
            output = subprocess.run([self.config.nmcli, "-t", "-f", "active,ssid", "dev", "wifi"],
                                    capture_output=True, text=True, timeout=10).stdout
        except (OSError, subprocess.TimeoutExpired):
            return None
        for line in output.splitlines():
            if line.startswith("yes:"):
                return line[4:].replace("\\:", ":")[:64] or None
        return None

    def collect(self):
        row, age = self.latest_row()
        service = self.service_state()
        collecting = service == "active" and age is not None and age <= self.config.fresh
        mic_present = self.microphone_present()
        errors = []
        if service == "failed":
            errors.append("Monitoring service failed.")
        if row:
            stream_ok = row.get("audio_status_events", "0") in ("", "0") and row.get("dropped_audio_blocks", "0") in ("", "0")
            microphone = mic_present and stream_ok
            sensor_status = row.get("sensor_status", "")
            sensor = sensor_status == "ok"
            when = "" if collecting else " when monitoring last ran"
            audio_detail = (("Recording normally" if collecting else "Was recording normally") if stream_ok else "Audio stream reported problems") + when
            if not mic_present:
                audio_detail = "Microphone not detected"
            sensor_detail = (("Reading normally" if collecting else "Was reading normally") if sensor else f"Sensor status: {sensor_status or 'unknown'}") + when
            if not stream_ok:
                errors.append("Audio stream reported dropped blocks or status events.")
            if not sensor:
                errors.append(f"Temperature & humidity sensor status: {sensor_status or 'unknown'}.")
            if row.get("ram_status") not in (None, "", "ok"):
                errors.append(f"Memory status: {row['ram_status']}.")
            if row.get("latest_storage_status") not in (None, "", "ok"):
                errors.append(f"Storage status: {row['latest_storage_status']}.")
            model = (row.get("model_sha256") or "")[:8]
        else:
            microphone, sensor = mic_present, False
            audio_detail = "Microphone detected; no monitoring data yet" if mic_present else "Microphone not detected"
            sensor_detail = "No monitoring data yet"
            model = ""
        usage = shutil.disk_usage(self.config.root)
        health = {
            "collecting": collecting,
            "cpu": max(0.0, min(100.0, self.cpu())),
            "ram": max(0.0, min(100.0, self.ram())),
            "cpuTemperature": max(-40.0, min(150.0, self.cpu_temperature())),
            "storageUsed": round(usage.used / 2**30, 1),
            "storageTotal": round(usage.total / 2**30, 1),
            "queued": self.sync.pending() if self.sync else 0,
            "microphone": microphone,
            "sensor": sensor,
            "softwareVersion": f"agent {VERSION}" + (f" · model {model}" if model else ""),
            "hostname": socket.gethostname()[:100],
            "monitoringService": service[:32],
            "audioStatusDetail": audio_detail[:200],
            "sensorStatusDetail": sensor_detail[:200],
            "errors": [e[:200] for e in errors[:10]],
            "uploader": "installed" if self.sync else "not installed",
        }
        if age is not None:
            health["lastWindowAgeSeconds"] = round(max(0.0, age), 1)
        for name, value in (("ipAddress", self.ip_address()), ("wifiNetwork", self.wifi_network()),
                            ("uptimeSeconds", self.uptime())):
            if value is not None:
                health[name] = value
        network = sanitize_network(setup_request(self.config.setup_socket, "status", 5))
        if network:
            health["network"] = network
        return health


class Agent:
    def __init__(self, config, api=None):
        self.config = config
        self.api = api or Api(config)
        self.health = Health(config)
        self.sync = None
        self.audio = None
        if config.sync_enabled and config.device_id:
            import sync  # bundled next to this file
            self.sync = sync.Sync(config, self.api, log)
            self.health.sync = self.sync
            if getattr(config, "audio_enabled", False):
                from audio_sync import AudioSync
                self.audio = AudioSync(config, self.api, self.sync, log)
        self.journal_path = config.state / "commands.json"
        try:
            self.journal = json.loads(self.journal_path.read_text())
        except (OSError, ValueError):
            self.journal = {}

    def save_journal(self):
        # Keep the newest entries only; IDs are random UUIDs.
        recent = dict(list(self.journal.items())[-200:])
        temporary = self.journal_path.with_suffix(".tmp")
        temporary.write_text(json.dumps(recent))
        temporary.replace(self.journal_path)
        self.journal = recent

    def heartbeat(self):
        status, payload = self.api.call("POST", "/edge/batch", {"health": self.health.collect()})
        if status != 200:
            log(f"Heartbeat rejected ({status}): {(payload or {}).get('error', '')}")

    def report(self, command_id, outcome, message, data=None):
        body = {"status": outcome, "message": message[:500], **({"data": data} if data else {})}
        status, _ = self.api.call("POST", f"/edge/commands/{command_id}", body)
        return status == 200

    def connect_wifi(self, command):
        """Ask the setup service to switch Wi-Fi as requested through BeeHave. The connection to
        BeeHave drops while it switches; the result is reported once it is back."""
        target = command.get("target")
        params = command.get("params") if isinstance(command.get("params"), dict) else {}
        reply = setup_request(self.config.setup_socket, "connect", 180, ssid=target, commandId=command.get("id"),
                              hidden=params.get("hidden") is True, profile=params.get("profile"),
                              credential=command.get("credential"))
        if reply is None:
            return "failed", "The device's network service did not answer. Nothing was changed.", None
        result = reply.get("result") if reply.get("result") in ("connected", "restored", "setup_mode", "rejected") else "rejected"
        data = {"ssid": (_text(reply.get("ssid"), 32) or (target if isinstance(target, str) else ""))[:32],
                "result": result, "stage": (_text(reply.get("stage"), 40) or "failed")}
        for name in ("previous", "current"):
            if _text(reply.get(name), 32):
                data[name] = reply[name]
        if result == "connected":
            return "succeeded", f"Connected to {data['ssid']}.", data
        reasons = {
            "wrong_password": "Incorrect password, or the network rejected it.",
            "not_found": "Network not found. Check the name and that the device is in range.",
            "no_ip": "The device joined but did not get an address from the router.",
            "no_internet": "The device joined but there is no internet access there.",
            "cloud_unreachable": "The device joined and has internet, but could not reach BeeHave from there.",
            "portal": "The network needs a sign-in page the device cannot complete.",
            "timeout": "The connection attempt timed out.",
        }
        reason = _text(reply.get("message"), 200) or reasons.get(data["stage"], "The device could not use this network.")
        after = (f" BeeHave restored the previous network ({data['current']})." if result == "restored" and data.get("current")
                 else " BeeHave restored a saved network." if result == "restored"
                 else " The device is in setup mode: join its setup hotspot to reconfigure it." if result == "setup_mode"
                 else "")
        return "failed", reason + after, data

    def scan_wifi(self):
        """Read-only: the networks the Pi itself can see. Never changes a connection."""
        raw = setup_request(self.config.setup_socket, "scan", 45)
        if raw is None:
            return "failed", "The device's network service did not answer the scan request.", None
        result = sanitize_scan(raw)
        count = len(result["networks"])
        message = f"Found {count} Wi-Fi network{'s' if count != 1 else ''}" + (" (from the last scan; the radio was busy)." if result["cached"] else ".")
        return "succeeded", message, result

    def systemctl(self, *args, timeout=40):
        return subprocess.run([self.config.systemctl, *args], capture_output=True, text=True, timeout=timeout)

    def run_monitoring(self, verb):
        result = self.systemctl(verb, self.config.unit)
        if result.returncode != 0:
            reason = (result.stderr or result.stdout).strip().splitlines()
            return "failed", f"The device could not {verb} monitoring: {reason[-1] if reason else 'permission or service error'}."
        # The monitor exits early if the microphone or sensor fails, so require it to stay up.
        time.sleep(self.config.settle)
        state = self.health.service_state()
        if verb == "stop":
            return ("succeeded", "Monitoring is stopped.") if state != "active" else ("failed", "Monitoring is still running.")
        if state == "active":
            return "succeeded", "Monitoring is running."
        detail = self.systemctl("show", self.config.unit, "-p", "Result", "--value", timeout=10).stdout.strip()
        return "failed", f"Monitoring did not stay running (state: {state}, result: {detail or 'unknown'}). Check the microphone and sensor connections."

    def claim(self, command_id):
        """Ask the API for permission to act. Anything but 200 means the request expired, was
        cancelled or is already claimed, so it must not run (also against an older API)."""
        status, _ = self.api.call("POST", f"/edge/commands/{command_id}/ack", {"stage": "executing"})
        return status == 200

    def power(self, action):
        self.systemctl("reboot" if action == "reboot" else "poweroff")

    def execute(self, command, received=None):
        command_id, action = command.get("id"), command.get("action")
        data = None
        if not isinstance(command_id, str):
            return
        previous = self.journal.get(command_id)
        if previous and previous.get("reported"):
            return
        if previous:
            if previous.get("outcome") is None:
                # Claimed before a crash. A power action or Wi-Fi change never runs twice: the API
                # verifies a restart from the next heartbeat, and otherwise times the request out.
                return
            # Acted on before a crash or restart; report the recorded outcome instead of acting twice.
            if self.report(command_id, previous["outcome"], previous["message"], previous.get("data")):
                previous["reported"] = True
                self.save_journal()
                if previous["outcome"] == "succeeded" and previous.get("action") in ("reboot", "shutdown"):
                    self.power(previous["action"])
            return
        # The API's own deadline, measured on this clock from when the list arrived.
        expires_in = command.get("expiresIn")
        if isinstance(expires_in, (int, float)) and received is not None and time.monotonic() - received >= expires_in:
            log(f"Request {action} arrived too late to run; ignored.")
            return
        if action not in ACTIONS:
            outcome, message = "failed", f"This device does not support '{action}'."
        else:
            self.journal[command_id] = {"action": action, "outcome": None, "reported": False}
            self.save_journal()
            if not self.claim(command_id):
                self.journal[command_id] = {"action": action, "outcome": "refused", "reported": True}
                self.save_journal()
                log(f"Request {action} is no longer active; not run.")
                return
            if action in ("reboot", "shutdown"):
                outcome, message = "succeeded", "Restarting now." if action == "reboot" else "Shutting down now."
            elif action == "network_scan":
                outcome, message, data = self.scan_wifi()
            elif action == "wifi_connect":
                self.journal[command_id] = {"action": action, "outcome": None, "reported": False}
                self.save_journal()
                outcome, message, data = self.connect_wifi(command)
            else:
                self.journal[command_id] = {"action": action, "outcome": "failed", "message": "Interrupted before finishing.", "reported": False}
                self.save_journal()
                outcome, message = self.run_monitoring(action.split("_", 1)[1])
        # Results carry no secrets (a Wi-Fi result names networks only), so they may be kept for retries.
        self.journal[command_id] = {"action": action, "outcome": outcome, "message": message, "reported": False,
                                    **({"data": data} if data else {})}
        self.save_journal()
        reported = self.report(command_id, outcome, message, data)
        self.journal[command_id]["reported"] = reported
        self.save_journal()
        log(f"Request {action}: {outcome} — {message}" + ("" if reported else " (result not accepted by the API)"))
        # Power actions run only after the API accepted the result; the journal stops a repeat.
        if reported and outcome == "succeeded" and action in ("reboot", "shutdown"):
            self.power(action)

    def poll(self):
        status, commands = self.api.call("GET", "/edge/commands")
        received = time.monotonic()
        if status != 200 or not isinstance(commands, list):
            log(f"Could not fetch requests ({status}).")
            return
        for command in commands:
            if isinstance(command, dict):
                self.execute(command, received)

    def run(self, stop_after=None):
        next_heartbeat = next_poll = 0.0
        backoff = 0.0
        started = time.monotonic()
        while stop_after is None or time.monotonic() - started < stop_after:
            now = time.monotonic()
            # Observation sync has its own schedule and backoff: an unreachable API delays
            # uploads, never monitoring, and a heartbeat failure never marks data as sent.
            if self.sync and self.sync.due(now):
                try:
                    self.sync.cycle(now)
                except Unauthorized:
                    log("Device key was rejected; the device may be disconnected or re-paired.")
                    raise
                except Exception as failure:  # never let sync stop heartbeats or remote requests
                    log(f"Sync pass failed ({type(failure).__name__}: {failure}); data stays queued.")
                    self.sync.next_attempt = time.monotonic() + 60
            now = time.monotonic()
            try:
                contacted = False
                if now >= next_heartbeat:
                    self.heartbeat()
                    next_heartbeat = now + self.config.heartbeat
                    contacted = True
                if now >= next_poll:
                    self.poll()
                    next_poll = now + self.config.poll
                    contacted = True
                # Only a successful API call ends the backoff; waking early for a sync pass does not.
                if contacted:
                    backoff = 0.0
                    # The API answers again: queued observations need not wait out the sync backoff.
                    if self.sync and self.sync.unreachable and self.sync.next_attempt > now:
                        self.sync.unreachable = False
                        self.sync.next_attempt = now
            except Unauthorized:
                log("Device key was rejected; the device may be disconnected or re-paired.")
                raise
            except (OSError, ValueError, subprocess.SubprocessError, http.client.HTTPException) as failure:
                # Offline is normal for a field device; monitoring continues locally.
                backoff = min(60.0, max(5.0, backoff * 2))
                log(f"API unreachable ({type(failure).__name__}); retrying in {backoff:.0f} s.")
                next_heartbeat = next_poll = time.monotonic() + backoff
            if self.audio and time.monotonic() >= self.audio.next_attempt:
                try:
                    self.audio.cycle()
                except Unauthorized:
                    raise
                except Exception as failure:
                    log(f"Audio pass failed ({type(failure).__name__}); source retained.")
                    self.audio.next_attempt = time.monotonic() + 60
            wake = min(next_heartbeat, next_poll, self.sync.next_attempt if self.sync else next_poll,
                       self.audio.next_attempt if self.audio else next_poll)
            time.sleep(max(0.2, wake - time.monotonic()))


def main():
    config = Config()
    # Monitoring and classification come first: the agent yields CPU to them.
    try:
        os.nice(10)
    except OSError:
        pass
    if not config.key_file.exists():
        log("No device key: the Pi is not paired with a BeeHave farm. Waiting.")
        time.sleep(300)
        return 0
    config.state.mkdir(parents=True, exist_ok=True)
    if config.sync_enabled:
        try:
            config.device_id = config.device_id_file.read_text().strip() or None
        except OSError:
            config.device_id = None
        if not config.device_id:
            log("Observation sync is enabled but the device ID is unknown; sync is off until the agent restarts.")
    log(f"BeeHave agent {VERSION} reporting to {config.api}" + (
        f"; observation sync from session {config.sync_first_session}"
        + (f" (at most {config.sync_admit_limit} observations)" if config.sync_admit_limit is not None else "")
        if config.sync_enabled and config.device_id else "; observation sync off"))
    try:
        Agent(config).run()
    except Unauthorized:
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
