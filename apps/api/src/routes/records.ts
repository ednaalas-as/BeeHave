import { z } from "zod";
import type { RouteContext } from "../context";
import { HttpError,type EventRow } from "../types";
import { serveCanonical,serveCanonicalSegment } from "../brtc/canonical-media";
import { verifiedSource,windowMismatch } from "../services/audio-windows";
export function registerRecordsRoutes(context: RouteContext) {
  const {
    app,
    db,
    authenticate,
    farmAccess,
    eventScope,
    brtcEnabled = true,
    recordingView,
    detectionView,
    filters,
  } = context;

  for (const table of ["detections", "recordings"] as const) {
    app.get(`/api/${table}`, async (req, res) => {
      const account = await authenticate(req);
      const farm = await farmAccess(req, account, "view");
      const { where, params } = await filters(req, farm.farmId, table);
      const page = z.coerce
        .number()
        .int()
        .min(1)
        .max(100000)
        .parse(req.query.page ?? 1);
      const size = z.coerce
        .number()
        .int()
        .refine((value) => [10, 20, 50, 100].includes(value), "Choose a page size of 10, 20, 50, or 100.")
        .parse(req.query.size ?? 20);
      const total = (
        (await db.one(`SELECT COUNT(*)::integer count ${where}`, [
          ...params,
        ])) as {
          count: number;
        }
      ).count;
      const asc = req.query.order === "oldest";
      const rows = (await db.many(
        `SELECT e.id,e.device_id,e.observed_at,e.data ${where} ORDER BY e.observed_at ${asc ? "ASC" : "DESC"},e.id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, size, (page - 1) * size],
      )) as EventRow[];
      res.json({
        items: await Promise.all(
          rows.map(async (row) =>
            table === "detections"
              ? await detectionView(row)
              : await recordingView(row),
          ),
        ),
        total,
        page,
        pages: Math.max(1, Math.ceil(total / size)),
      });
    });
  }
  app.get("/api/detections/:device/:id", async (req, res) => {
    const account = await authenticate(req);
    await eventScope(req, account, "detections", String(req.params.device), String(req.params.id));
    const row = (await db.one(
      "SELECT * FROM detections WHERE device_id=$1 AND id=$2",
      [req.params.device, req.params.id],
    )) as EventRow | undefined;
    if (!row) throw new HttpError(404, "Detection not found.");
    res.json(await detectionView(row));
  });
  // Plays only this detection's 3-second window, cut on request from the
  // verified canonical original; the Pi copy is not needed.
  app.get("/api/detections/:device/:id/audio", async (req, res) => {
    const account = await authenticate(req);
    await eventScope(req, account, "detections", String(req.params.device), String(req.params.id));
    const window = await db.one<{
      recording_id: string; session_id: string; window_index: string; start_frame: string; frame_count: string;
    }>(
      `SELECT w.recording_id,w.session_id,w.window_index,w.start_frame,w.frame_count
       FROM detection_audio_windows w
       JOIN detections d ON d.device_id=w.device_id AND d.id=w.detection_id
       WHERE w.device_id=$1 AND w.detection_id=$2 AND (d.data->>'recordingId')=w.recording_id`,
      [req.params.device, req.params.id],
    );
    if (!window)
      throw new HttpError(404, "This detection's audio window is not available.");
    const source = brtcEnabled
      ? await verifiedSource(db, String(req.params.device), window.recording_id)
      : undefined;
    if (!source)
      throw new HttpError(404, "Audio is not available yet. The detection is preserved.");
    const segment = {
      sessionId: window.session_id,
      windowIndex: Number(window.window_index),
      startFrame: Number(window.start_frame),
      frameCount: Number(window.frame_count),
    };
    const mismatch = windowMismatch(segment, source);
    if (mismatch) throw new HttpError(409, mismatch);
    await serveCanonicalSegment(req, res, source, source, {
      startFrame: segment.startFrame,
      frameCount: segment.frameCount,
      name: String(req.params.id),
    });
  });
  app.get("/api/recordings/:device/:id", async (req, res) => {
    const account = await authenticate(req);
    await eventScope(req, account, "recordings", String(req.params.device), String(req.params.id));
    const row = (await db.one(
      "SELECT id,device_id,observed_at,data FROM recordings WHERE device_id=$1 AND id=$2",
      [req.params.device, req.params.id],
    )) as EventRow | undefined;
    if (!row) throw new HttpError(404, "Recording not found.");
    res.json(await recordingView(row));
  });
  app.get("/api/export", async (req, res) => {
    const account = await authenticate(req);
    const farm = await farmAccess(req, account, "view");
    const { where, params } = await filters(req, farm.farmId, "detections");
    const rows = (await db.many(
      `SELECT e.* ${where} ORDER BY e.observed_at LIMIT 50001`,
      [...params],
    )) as EventRow[];
    if (rows.length > 50000)
      throw new HttpError(
        400,
        "Narrow the date range to export at most 50,000 records.",
      );
    const csv = [
      [
        "id",
        "timestamp_utc",
        "species",
        "frequency_hz",
        "confidence",
        "temperature_c",
        "humidity_percent",
        "sensor_timestamp_utc",
        "device_id",
        "recording_id",
        "model_version",
      ],
      ...(await Promise.all(
        rows.map(async (row) => {
          const detection = await detectionView(row);
          return [
            detection.id,
            detection.observedAt,
            detection.species,
            detection.frequency,
            detection.confidence,
            detection.reading?.temperature ?? "",
            detection.reading?.humidity ?? "",
            detection.reading?.observedAt ?? "",
            detection.deviceId,
            detection.recordingId ?? "",
            detection.modelVersion,
          ];
        }),
      )),
    ]
      .map((row) =>
        row
          .map(
            (v) =>
              `"${String(v)
                .replace(/^[=+@\-]/, "'$&")
                .replaceAll('"', '""')}"`,
          )
          .join(","),
      )
      .join("\r\n");
    res.type("text/csv").attachment("beehave-detections.csv").send(csv);
  });
  app.get("/api/recordings/:device/:id/audio", async (req, res) => {
    const account = await authenticate(req);
    await eventScope(req, account, "recordings", String(req.params.device), String(req.params.id));
    const row = (await db.one(
      "SELECT * FROM recordings WHERE device_id=$1 AND id=$2",
      [req.params.device, req.params.id],
    )) as EventRow | undefined;
    if (!row)
      throw new HttpError(
        404,
        "Audio is not available yet. The detection is preserved.",
      );
    if (!row.audio && brtcEnabled) {
      const asset = await db.one<{
        storage_key: string;
        actual_byte_length: string;
        sha256: string;
      }>(
        `SELECT c.storage_key,c.actual_byte_length,c.sha256
         FROM brtc.beehave_recording_links l
         JOIN brtc.recordings br ON br.id=l.brtc_recording_id
         JOIN brtc.sessions s ON s.id=br.session_id
         JOIN brtc.uploads u ON u.asset_id=l.asset_id AND u.active
         JOIN brtc.verification_jobs j ON j.upload_id=u.id
         JOIN brtc.canonical_assets c ON c.asset_id=l.asset_id
         WHERE l.device_id=$1 AND l.beehave_recording_id=$2
           AND s.device_id=l.device_id AND u.state='AVAILABLE'
           AND u.frozen AND j.state='SUCCEEDED'`,
        [req.params.device, req.params.id],
      );
      if (!asset)
        throw new HttpError(
          404,
          "Audio is not available yet. The detection is preserved.",
        );
      await serveCanonical(req, res, asset, String(req.params.id));
      return;
    }
    if (!row.audio)
      throw new HttpError(
        404,
        "Audio is not available yet. The detection is preserved.",
      );
    const audio = row.audio;
    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Accept-Ranges", "bytes");
    if (req.query.download === "1")
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${row.id}.wav"`,
      );
    const range = req.headers.range;
    if (range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (!match)
        return res
          .status(416)
          .set("Content-Range", `bytes */${audio.length}`)
          .end();
      const start = Number(match[1]);
      const end = match[2]
        ? Math.min(Number(match[2]), audio.length - 1)
        : audio.length - 1;
      if (start >= audio.length || end < start)
        return res
          .status(416)
          .set("Content-Range", `bytes */${audio.length}`)
          .end();
      return res
        .status(206)
        .set("Content-Range", `bytes ${start}-${end}/${audio.length}`)
        .send(audio.subarray(start, end + 1));
    }
    res.send(audio);
  });
}
