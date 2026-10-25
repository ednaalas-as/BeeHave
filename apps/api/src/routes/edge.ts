import {
batchSchema,
type Detection,
type Reading,
type Recording,
} from "@beehave/shared";
import express from "express";
import { isDeepStrictEqual } from "node:util";
import type { RouteContext } from "../context";
import {
  piDetectionId,
  transferSession,
  verifiedSource,
  WINDOW_SECONDS,
  windowMismatch,
} from "../services/audio-windows";
import { canonicalTimestamp } from "../timestamp";
import { HttpError,type EventRow } from "../types";
export function registerEdgeRoutes(context: RouteContext) {
  const { app, db, edge, brtcEnabled, deviceOnline, dispatchNotifications } = context;

  app.post("/api/edge/batch", async (req, res) => {
    const device = await edge(req);
    const batch = batchSchema.parse(req.body);
    const now = new Date().toISOString();
    let announced: string | null = null;
    for (const item of [
      ...batch.readings,
      ...batch.recordings,
      ...batch.detections,
    ]) {
      item.observedAt = canonicalTimestamp(item.observedAt);
      if (Date.parse(item.observedAt) > Date.now() + 300000)
        throw new HttpError(
          400,
          "Event timestamp is more than five minutes in the future. Check the device clock.",
        );
    }
    // Per-item acknowledgement: every submitted ID is listed once, either as newly
    // stored or as already present with identical content. Sent only after commit.
    const stored = { readings: [] as string[], recordings: [] as string[], detections: [] as string[], audioWindows: [] as string[] };
    const alreadyPresent = { readings: [] as string[], recordings: [] as string[], detections: [] as string[], audioWindows: [] as string[] };
    // Serialize this device’s uploads so concurrent retries cannot overwrite data.
    await db.transaction(async (transaction) => {
      const authorized = await transaction.one<{ id: string; farm_id: string; name: string; last_seen: string | null }>(
        "SELECT id,farm_id,name,last_seen FROM devices WHERE id=$1 AND key_hash=$2 AND disconnected_at IS NULL FOR UPDATE", [device.id, device.key_hash],
      );
      if (!authorized) throw new HttpError(401, "Device credential has been revoked.");
      for (const [table, items] of [
        ["readings", batch.readings],
        ["recordings", batch.recordings],
        ["detections", batch.detections],
      ] as const) {
        for (const item of items) {
          const json = JSON.stringify(item);
          const existing = (await transaction.one(
            `SELECT data FROM ${table} WHERE device_id=$1 AND id=$2`,
            [device.id, item.id],
          )) as
            | {
                data: Reading | Recording | Detection;
              }
            | undefined;
          if (existing) {
            const old = { ...existing.data };
            if (table === "recordings" && "status" in item)
              (old as Recording).status = item.status;
            if (!isDeepStrictEqual(old, item))
              throw new HttpError(
                409,
                `Conflicting payload for ${item.id}; stable IDs cannot be overwritten.`,
              );
            alreadyPresent[table].push(item.id);
          } else {
            await transaction.execute(
              `INSERT INTO ${table}(id,device_id,observed_at,data) VALUES($1,$2,$3,$4)`,
              [item.id, device.id, item.observedAt, json],
            );
            stored[table].push(item.id);
          }
        }
      }
      // Only links this batch can create need checking: detections it carries, and stored
      // detections that name a reading it carries. Earlier pairs were checked when stored.
      const linked = (await transaction.many(
        `SELECT data FROM detections WHERE device_id=$1
         AND (id=ANY($2::text[]) OR (data->>'readingId')=ANY($3::text[]))`,
        [device.id, batch.detections.map((d) => d.id), batch.readings.map((r) => r.id)],
      )) as {
        data: Reading | Recording | Detection;
      }[];
      for (const row of linked) {
        const event = row.data as Detection;
        if (event.readingId) {
          const reading = (await transaction.one(
            "SELECT observed_at FROM readings WHERE device_id=$1 AND id=$2",
            [device.id, event.readingId],
          )) as
            | {
                observed_at: string;
              }
            | undefined;
          if (
            reading &&
            Math.abs(
              Date.parse(reading.observed_at) - Date.parse(event.observedAt),
            ) > 60000
          )
            throw new HttpError(
              400,
              "Associated sensor readings must be within 60 seconds of the detection.",
            );
        }
      }
      for (const window of batch.audioWindows) {
        const detection = (await transaction.one(
          "SELECT data FROM detections WHERE device_id=$1 AND id=$2",
          [device.id, window.detectionId],
        )) as { data: Detection } | undefined;
        if (!detection)
          throw new HttpError(409, `Synchronize detection ${window.detectionId} before its audio window.`);
        if (detection.data.recordingId !== window.recordingId)
          throw new HttpError(400, "An audio window must use its detection's own recording.");
        if (
          window.detectionId.startsWith("pi_d_") &&
          piDetectionId(device.id, window.sessionId, window.windowIndex) !== window.detectionId
        )
          throw new HttpError(400, "Audio window session and index do not match the detection identity.");
        if (window.frameCount % WINDOW_SECONDS !== 0)
          throw new HttpError(400, "Audio window length must be 3 seconds of whole frames.");
        // Isolated test schemas have no BRTC storage; playback re-checks these gates.
        const session = brtcEnabled
          ? await transferSession(transaction, device.id, window.recordingId)
          : undefined;
        if (session !== undefined && session !== window.sessionId)
          throw new HttpError(409, "Audio window session does not match the recording's acquisition session.");
        const source = brtcEnabled
          ? await verifiedSource(transaction, device.id, window.recordingId)
          : undefined;
        const mismatch = source && windowMismatch(window, source);
        if (mismatch) throw new HttpError(409, mismatch);
        const existing = await transaction.one<{
          recording_id: string; session_id: string; window_index: string; start_frame: string; frame_count: string;
        }>(
          "SELECT recording_id,session_id,window_index,start_frame,frame_count FROM detection_audio_windows WHERE device_id=$1 AND detection_id=$2",
          [device.id, window.detectionId],
        );
        if (existing) {
          if (
            existing.recording_id !== window.recordingId ||
            existing.session_id !== window.sessionId ||
            Number(existing.window_index) !== window.windowIndex ||
            Number(existing.start_frame) !== window.startFrame ||
            Number(existing.frame_count) !== window.frameCount
          )
            throw new HttpError(409, `Conflicting audio window for ${window.detectionId}; stable windows cannot be overwritten.`);
          alreadyPresent.audioWindows.push(window.detectionId);
        } else {
          await transaction.execute(
            "INSERT INTO detection_audio_windows(device_id,detection_id,recording_id,session_id,window_index,start_frame,frame_count) VALUES($1,$2,$3,$4,$5,$6,$7)",
            [device.id, window.detectionId, window.recordingId, window.sessionId, window.windowIndex, window.startFrame, window.frameCount],
          );
          stored.audioWindows.push(window.detectionId);
        }
      }
      // A heartbeat without records is not a data sync.
      const synced =
        batch.readings.length + batch.recordings.length + batch.detections.length + batch.audioWindows.length > 0;
      await transaction.execute(
        "UPDATE devices SET last_seen=$1,last_sync=COALESCE($2,last_sync),health=COALESCE($3,health),health_at=CASE WHEN $3::jsonb IS NULL THEN health_at ELSE $1 END WHERE id=$4",
        [
          now,
          synced ? now : null,
          batch.health ? JSON.stringify(batch.health) : null,
          device.id,
        ],
      );
      // Online is BeeHave's own rule (a report within FRESH_REPORT_MS), decided here under the
      // device row lock; a report that ends an offline period is announced once.
      announced = await deviceOnline(transaction, authorized, authorized.last_seen, Date.parse(now));
      // A restart is verified only by the device reconnecting after it rebooted: its reported
      // uptime must place the boot after the device claimed the restart request.
      if (batch.health?.uptimeSeconds !== undefined)
        await transaction.execute(
          `UPDATE device_commands SET status='succeeded',message='The device rebooted and reconnected.',finished_at=NOW(),updated_at=NOW()
          WHERE device_id=$1 AND action='reboot' AND status='executing' AND verify_until>NOW()
            AND started_at IS NOT NULL AND NOW() - make_interval(secs => $2::double precision) > started_at`,
          [device.id, batch.health.uptimeSeconds],
        );
    });
    if (announced) void dispatchNotifications();
    res.json({
      accepted: {
        readings: batch.readings.length,
        recordings: batch.recordings.length,
        detections: batch.detections.length,
        audioWindows: batch.audioWindows.length,
      },
      stored,
      alreadyPresent,
      synchronizedAt: now,
    });
  });
  app.put(
    "/api/edge/recordings/:id/audio",
    express.raw({ type: "audio/wav", limit: "20mb" }),
    async (req, res) => {
      const device = await edge(req);
      const body = req.body as Buffer;
      if (
        !Buffer.isBuffer(body) ||
        body.length < 44 ||
        body.toString("ascii", 0, 4) !== "RIFF" ||
        body.toString("ascii", 8, 12) !== "WAVE"
      )
        throw new HttpError(400, "Upload a valid WAV recording as audio/wav.");
      await db.transaction(async (transaction) => {
        const authorized = await transaction.one(
          "SELECT id FROM devices WHERE id=$1 AND key_hash=$2 AND disconnected_at IS NULL FOR UPDATE", [device.id, device.key_hash],
        );
        if (!authorized) throw new HttpError(401, "Device credential has been revoked.");
        const row = (await transaction.one(
          "SELECT * FROM recordings WHERE device_id=$1 AND id=$2",
          [device.id, req.params.id],
        )) as EventRow | undefined;
        if (!row)
          throw new HttpError(
            409,
            "Synchronize recording metadata before uploading audio.",
          );
        if (row.audio && !row.audio.equals(body))
          throw new HttpError(
            409,
            "An existing recording cannot be overwritten.",
          );
        const data = row.data as Recording;
        data.status = "available";
        await transaction.execute(
          "UPDATE recordings SET audio=$1,data=$2 WHERE device_id=$3 AND id=$4",
          [body, JSON.stringify(data), device.id, req.params.id],
        );
      });
      res.json({ ok: true });
    },
  );
}
