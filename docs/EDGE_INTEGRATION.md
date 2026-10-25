# Raspberry Pi integration

## Connect a real station

1. Create your own BeeHave account. The sample workspace is viewer-only.
2. Open **Edge Device → Register device**. Save the returned credential once, in a protected environment/configuration on the Pi. Do not commit it or put it in web/mobile code.
3. Make the API reachable on a trusted LAN (`HOST=0.0.0.0`). Use TLS beyond local development.
4. Your existing classifier and sensor process produce the batch below. Generate event IDs once at capture time and reuse them on retries.

## Batch contract

`POST /api/edge/batch`, header `X-Device-Key`, content type `application/json`.

```json
{
  "readings": [
    {
      "id": "env-0001",
      "observedAt": "2026-09-22T01:00:00.000Z",
      "temperature": 30.4,
      "humidity": 71
    }
  ],
  "recordings": [
    {
      "id": "rec-0001",
      "observedAt": "2026-09-22T01:00:04.000Z",
      "duration": 5,
      "filename": "rec-0001.wav",
      "status": "pending"
    }
  ],
  "detections": [
    {
      "id": "det-0001",
      "observedAt": "2026-09-22T01:00:04.000Z",
      "species": "T. biroi",
      "frequency": 201,
      "confidence": 0.98,
      "readingId": "env-0001",
      "recordingId": "rec-0001",
      "modelVersion": "your-validated-model-version"
    }
  ],
  "health": {
    "collecting": true,
    "cpu": 24,
    "ram": 38,
    "cpuTemperature": 48.2,
    "storageUsed": 12.8,
    "storageTotal": 64,
    "queued": 0,
    "microphone": true,
    "sensor": true,
    "softwareVersion": "your-edge-version"
  }
}
```

Use actual capture timestamps and measurements. The example is a contract illustration, not research evidence. Arrays may be omitted; each is limited to 1,000 events. IDs contain only ASCII letters, numbers, `_`, and `-`. Confidence is 0–1, not 0–100. Unknown environmental measurements are `null`. Temperature/humidity timestamps remain distinct from detection timestamps.

The server assigns the device/farm from its credential. Stable event IDs are unique per device. Repeating an identical payload acknowledges it without duplicating records. Conflicting immutable content returns HTTP 409 and rolls back the entire batch. Invalid payloads return 400. Events over five minutes in the future are rejected; older offline observations remain acceptable. The API accepts an explicit sensor reference within ±60 seconds, never silently choosing or inventing a reading. If either linked record arrives later, the reference is resolved after synchronization; invalid late sensor links are rejected atomically.

Recordings/detections may arrive in separate batches in either order. Upload recording metadata before the actual WAV; audio-first upload returns a retryable 409. This prerequisite keeps the prototype protocol small and explicit.

## Audio upload

`PUT /api/edge/recordings/{recordingId}/audio`, headers `X-Device-Key` and `Content-Type: audio/wav`, raw WAV body (maximum 20 MB). The file must have a RIFF/WAVE header. Successful uploads mark it available. Identical retries succeed; different bytes cannot overwrite an existing recording. Playback may still fail for unsupported/corrupt WAV contents and the UI preserves the related detection.

## Durable offline outbox

The included standard-library Python utility can run on a Pi without npm. It does not perform audio capture or AI inference. Enqueue a completed batch as soon as your collection pipeline has durably saved its WAV:

```sh
python3 scripts/edge_queue.py --db beehave-outbox.sqlite enqueue batch.json --audio rec-0001=/path/to/rec-0001.wav
python3 scripts/edge_queue.py --db beehave-outbox.sqlite status
```

Set `BEEHAVE_API_URL` to the reachable backend origin and `BEEHAVE_DEVICE_KEY` to the private credential, then run:

```sh
python3 scripts/edge_queue.py --db beehave-outbox.sqlite flush
```

The central API stores data in PostgreSQL. This separate, optional Pi outbox stores unsent batches in local SQLite, checkpoints metadata/audio acknowledgments separately, validates that queued audio has not changed, and retains failed/unacknowledged work. A crash after server acceptance is safe because retries are idempotent. Do not modify queued files. Completed queue entries and local audio are retained for audit; system-level retention is a separate policy.

Call `flush` from your edge service with exponential backoff and jitter after connectivity failures (for example, 5 seconds, 10 seconds, up to 5 minutes). Stop and inspect permanent 400/401/409 errors instead of blindly retrying them. Send a current health-only batch when connectivity is restored, because a queued historical health report may be stale. `lastSeen`/`lastSync` represent server receipt, while detection and sensor times represent capture. Offline clients may continue collecting, but the app cannot infer their current state.

The server does not yet implement device commands, sensor drivers, clock synchronization, automatic disk cleanup, or deployment provisioning.
