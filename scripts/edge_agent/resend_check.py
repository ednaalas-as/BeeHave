#!/usr/bin/env python3
"""Idempotency check: re-send already-synchronized observations exactly as the agent stored them.

    sudo python3 -I resend_check.py SESSION_ID COUNT

Reads the agent's outbox read-only and the device key from /run/beehave-agent; prints the
API's per-record reply. Every record must come back as alreadyPresent. The key is never printed.
"""
import json
import sqlite3
import sys
import urllib.error
import urllib.request

API = "http://192.168.1.88:3001"
session, count = sys.argv[1], int(sys.argv[2])
db = sqlite3.connect("file:/var/lib/beehave-agent/sync.sqlite3?mode=ro", uri=True)
rows = db.execute(
    "SELECT window_index, reading, detection FROM observations WHERE session_id=? AND state='synced' "
    "AND detection IS NOT NULL ORDER BY json_extract(detection,'$.species')='Bee' DESC, window_index LIMIT ?",
    (session, count)).fetchall()
body = {"readings": [json.loads(r) for _, r, _ in rows if r], "detections": [json.loads(d) for _, _, d in rows]}
print(f"re-sending windows {[w for w, _, _ in rows]} ({sum(d['species'] == 'Bee' for d in body['detections'])} Bee)")
request = urllib.request.Request(API + "/api/edge/batch", data=json.dumps(body).encode(), method="POST", headers={
    "Content-Type": "application/json", "X-Device-Key": open("/run/beehave-agent/device.key").read().strip()})
try:
    with urllib.request.urlopen(request, timeout=120) as response:
        reply = json.loads(response.read())
except urllib.error.HTTPError as failure:
    sys.exit(f"HTTP {failure.code}: {failure.read()[:300]!r}")
print("HTTP", response.status)
print("stored (new):", {k: len(v) for k, v in reply["stored"].items()})
print("alreadyPresent:", {k: len(v) for k, v in reply["alreadyPresent"].items()})
ok = (not any(reply["stored"].values())
      and sorted(reply["alreadyPresent"]["detections"]) == sorted(d["id"] for d in body["detections"])
      and sorted(reply["alreadyPresent"]["readings"]) == sorted(r["id"] for r in body["readings"]))
print("RESULT:", "every record alreadyPresent, nothing new stored" if ok else "UNEXPECTED")
