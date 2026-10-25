#!/usr/bin/env python3
"""Read-only summary of the agent's sync outbox (run with sudo; the outbox is private to beehave-agent)."""
import sqlite3
import sys

DB = "/var/lib/beehave-agent/sync.sqlite3"
try:
    db = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    print("outbox:", DB)
    print("observations by session/state:", db.execute(
        "SELECT session_id, state, COUNT(*) FROM observations GROUP BY 1,2 ORDER BY 1,2").fetchall())
    print("audio windows:", db.execute("SELECT window_state, COUNT(*) FROM observations GROUP BY 1").fetchall())
    print("recordings:", db.execute("SELECT state, COUNT(*) FROM recordings GROUP BY 1").fetchall())
    print("scan offsets:", db.execute("SELECT path, offset FROM source_files ORDER BY path").fetchall())
except sqlite3.Error as failure:
    sys.exit(f"cannot read outbox: {failure}")
