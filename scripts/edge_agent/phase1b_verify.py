#!/usr/bin/env python3
"""Phase 1B: install the sync-capable agent and verify it on the Pi (run once with sudo).

    sudo python3 -I phase1b_verify.py

What it changes: /opt/beehave-agent/{agent,sync,load_key}.py and the BEEHAVE_SYNC_*
lines of /etc/beehave-agent/agent.env (backups are kept), then restarts only
beehave-agent. Monitoring, its service and its files are never touched; their
SHA-256 is compared before and after. The device key is never printed.

The run expects the API to be unreachable at first (the operator stops the LAN
forwarder) so the outage, restart-with-pending, and automatic retry are observed.
"""
import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request

HERE = Path(__file__).resolve().parent
OPT = Path("/opt/beehave-agent")
ENV = Path("/etc/beehave-agent/agent.env")
OUTBOX = Path("/var/lib/beehave-agent/sync.sqlite3")
KEY = Path("/run/beehave-agent/device.key")
MONITOR = Path("/home/beehave-host/raspberry_pi_continuous_monitor_20261008")
API = "http://192.168.1.88:3001"
SESSION = "20261020T124852Z"
SETTINGS = {
    "BEEHAVE_API_URL": API,
    "BEEHAVE_SYNC_ENABLED": "1",
    "BEEHAVE_SYNC_FIRST_SESSION": SESSION,
    "BEEHAVE_SYNC_ADMIT_LIMIT": "5",
    "BEEHAVE_SYNC_BATCH": "200",
}
STAMP = "bak-phase1b-20261021"


def say(text):
    print(f"[{time.strftime('%H:%M:%S')}] {text}", flush=True)


def digests():
    """SHA-256 of every monitor file this test could plausibly touch."""
    files = sorted((MONITOR / "runs" / SESSION).rglob("*")) + sorted((MONITOR / "data" / "visitation").glob("*"))
    out = {}
    for path in files:
        if path.is_file():
            out[str(path.relative_to(MONITOR))] = hashlib.sha256(path.read_bytes()).hexdigest()
    return out


def reachable():
    try:
        with urllib.request.urlopen(API + "/api/health", timeout=5) as response:
            return response.status == 200
    except (OSError, ValueError):
        return False


def outbox():
    if not OUTBOX.exists():
        return None
    db = sqlite3.connect(f"file:{OUTBOX}?mode=ro", uri=True)
    try:
        rows = db.execute(
            "SELECT session_id, window_index, state, window_state, outcome, attempts, last_error, note,"
            " json_extract(detection,'$.id') FROM observations ORDER BY 1,2").fetchall()
        recs = db.execute("SELECT recording_id, state, last_error FROM recordings").fetchall()
    finally:
        db.close()
    return rows, recs


def show_outbox(title):
    state = outbox()
    say(title)
    if state is None:
        print("   (no outbox yet)")
        return []
    rows, recs = state
    for s, w, st, ws, outcome, attempts, err, note, det in rows:
        print(f"   {s}#{w} {(det or '')[:18]}… state={st} window={ws} outcome={outcome} attempts={attempts}"
              f"{' error=' + err[:80] if err else ''}{' note=' + note if note else ''}")
    for rec, st, err in recs:
        print(f"   recording {rec[:16]}… state={st}{' error=' + err[:80] if err else ''}")
    return rows


def journal(since):
    out = subprocess.run(["journalctl", "-u", "beehave-agent", "--since", since, "--no-pager", "-o", "short-iso"],
                         capture_output=True, text=True).stdout
    for line in out.splitlines():
        if "Sync" in line or "agent 0." in line or "unreachable" in line or "Heartbeat" in line:
            print("   " + line)


def restart(reason):
    say(f"Restarting beehave-agent ({reason}).")
    subprocess.run(["systemctl", "restart", "beehave-agent"], check=True)


def install():
    for name in ("agent.py", "sync.py", "load_key.py"):
        target = OPT / name
        if target.exists() and not target.with_name(f"{name}.{STAMP}").exists():
            shutil.copy2(target, target.with_name(f"{name}.{STAMP}"))
        shutil.copyfile(HERE / name, target)
        target.chmod(0o644)
    if not ENV.with_name(f"agent.env.{STAMP}").exists():
        shutil.copy2(ENV, ENV.with_name(f"agent.env.{STAMP}"))
    lines = [l for l in ENV.read_text().splitlines() if l.split("=", 1)[0] not in SETTINGS]
    ENV.write_text("\n".join(lines + [f"{k}={v}" for k, v in SETTINGS.items()]) + "\n")
    say("Installed agent 0.2.0 files and sync settings (backups: *." + STAMP + ").")
    print("   " + "\n   ".join(l for l in ENV.read_text().splitlines() if l.startswith("BEEHAVE_")))


def resend_duplicates(rows):
    """Re-sends the exact payloads the agent recorded as synced; the API must store nothing new."""
    db = sqlite3.connect(f"file:{OUTBOX}?mode=ro", uri=True)
    payloads = db.execute("SELECT reading, detection FROM observations WHERE state='synced'").fetchall()
    db.close()
    body = {"readings": [json.loads(r) for r, _ in payloads if r],
            "detections": [json.loads(d) for _, d in payloads if d]}
    request = urllib.request.Request(API + "/api/edge/batch", data=json.dumps(body).encode(), method="POST",
                                     headers={"Content-Type": "application/json", "X-Device-Key": KEY.read_text().strip()})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            reply = json.loads(response.read())
            say(f"Duplicate re-send of {len(body['detections'])} detections + {len(body['readings'])} readings: HTTP {response.status}")
            print(f"   stored (new): {reply.get('stored')}")
            print(f"   alreadyPresent: { {k: len(v) for k, v in (reply.get('alreadyPresent') or {}).items()} }")
    except urllib.error.HTTPError as failure:
        say(f"Duplicate re-send refused: HTTP {failure.code} {failure.read()[:200]!r}")


def main():
    if subprocess.run(["id", "-u"], capture_output=True, text=True).stdout.strip() != "0":
        sys.exit("Run with sudo.")
    before = digests()
    say(f"Recorded SHA-256 of {len(before)} monitor files (session {SESSION} and visitation data).")
    monitoring = subprocess.run(["systemctl", "is-active", "beehave-continuous"], capture_output=True, text=True).stdout.strip()
    say(f"Monitoring service is {monitoring}; this run does not start, stop or restart it.")
    say(f"API reachable before install: {reachable()} (expected False: LAN forwarder stopped for the outage test).")
    started = time.strftime("%Y-%m-%d %H:%M:%S")
    install()
    restart("load agent 0.2.0 with sync enabled")
    time.sleep(45)
    rows = show_outbox("STEP outage: observations discovered and queued while the API is unreachable:")
    journal(started)
    mark = time.strftime("%Y-%m-%d %H:%M:%S")
    restart("restart with pending data")
    time.sleep(30)
    show_outbox("STEP restart: outbox after agent restart (nothing lost, nothing re-admitted):")
    journal(mark)
    say("WAITING FOR API — restore the LAN forwarder now.")
    deadline = time.time() + 900
    while not reachable():
        if time.time() > deadline:
            sys.exit("API did not come back within 15 minutes; data stays queued. Stopping.")
        time.sleep(5)
    say("API reachable again. Waiting for the agent's automatic retry (backoff is at most 300 s).")
    deadline = time.time() + 600
    while True:
        rows = outbox()[0]
        if rows and all(r[2] != "pending" and r[3] != "pending" for r in rows):
            break
        if time.time() > deadline:
            break
        time.sleep(5)
    time.sleep(20)  # let the recording and audio-window pass run
    rows = show_outbox("STEP reconnect: outbox after automatic retry:")
    journal(mark)
    resend_duplicates(rows)
    mark = time.strftime("%Y-%m-%d %H:%M:%S")
    restart("restart after success: synced entries must not be re-sent")
    time.sleep(30)
    show_outbox("STEP final outbox:")
    journal(mark)
    after = digests()
    changed = [p for p in before if before[p] != after.get(p)]
    say("Monitor files unchanged: " + ("YES" if not changed and set(before) == set(after) else f"NO {changed}"))
    say("Done.")


if __name__ == "__main__":
    main()
