# BeeHave Pi agent 0.4.0 update

Built 2026-10-22 from the **installed** agent 0.3.1 (update `20261022b`, sha256 `403ff129…`), plus only:

- the automatic BRTC WAV upload worker (`audio_sync.py`) and its hook in the agent loop;
- device status reads the run being written now, not the highest-named one (correct after a reboot clock jump), and ignores power-loss NUL padding;
- observation sync retries at most every 60 s (was up to 300 s), and starts again as soon as a heartbeat gets through.

Everything already in 0.3.1, including the Wi-Fi changes, is kept unchanged.

## Install (on the Pi, from this folder)

```sh
sudo sh install.sh                 # code only; audio upload stays off
sudo sh install.sh --enable-audio  # also upload every closed recording in the outbox
sudo sh rollback.sh                # undo
```

The installer refuses to run if the installed agent is not exactly 0.3.1. It backs up `agent.py`, `sync.py` and `agent.env`, and restores them if the new agent does not start. It never touches monitoring, the runs folder, the WAVs or the outbox.

## What audio upload does

- A recording is picked up once its metadata is confirmed by the API. That happens 300 s after the WAV was last written.
- It is uploaded in 8 MiB chunks, one per pass, with at least 2 s between passes.
- After a network loss or restart it resumes from the chunks the server already holds.
- It is marked AVAILABLE only after the server has verified the SHA-256, the size and the WAV format.
- Local WAVs are never deleted or modified.

Data volume: about 115 MB per hour of audio, so about 2.7 GB per day of continuous monitoring. Use Wi-Fi, not a metered mobile hotspot.

## Before installing

The agent reports to `BEEHAVE_API_URL`, which is currently `http://Ednas-MacBook-Air.local:3001`. That name only resolves while the Pi and the Mac are on the same network.
