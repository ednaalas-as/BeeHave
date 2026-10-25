import { NON_BEE_CLASSIFICATION,type Detection,type Reading,type Recording,type RecordingTransfer } from "@beehave/shared";
import { type Request } from "express";
import { z } from "zod";
import type { DB } from "../database";
import { type EventRow } from "../types";
import { heldBy } from "./access";
import { range } from "./date-range";
import type { createDeviceService } from "./devices";
export function createRecordService(
  db: DB,
  ownedDevice: ReturnType<typeof createDeviceService>["ownedDevice"],
  brtcEnabled = true,
) {
  async function recordingView(row: EventRow): Promise<Recording> {
    const value = row.data as Recording;
    const brtc = brtcEnabled ? await db.one<{ state: string; job_state: string | null; asset_id: string | null }>(
      `SELECT u.state,j.state AS job_state,c.asset_id
       FROM brtc.beehave_recording_links l
       LEFT JOIN brtc.uploads u ON u.asset_id=l.asset_id AND u.active
       LEFT JOIN brtc.verification_jobs j ON j.upload_id=u.id
       LEFT JOIN brtc.canonical_assets c ON c.asset_id=l.asset_id
       WHERE l.device_id=$1 AND l.beehave_recording_id=$2`,
      [row.device_id, row.id],
    ) : undefined;
    const ids = (
      (await db.many(
        "SELECT id FROM detections WHERE device_id=$1 AND (data->>'recordingId')=$2 AND (data->>'species') IS DISTINCT FROM $3 ORDER BY observed_at DESC",
        [row.device_id, row.id, NON_BEE_CLASSIFICATION],
      )) as {
        id: string;
      }[]
    ).map((d) => d.id);
    const transfer: RecordingTransfer | undefined = !brtcEnabled
      ? undefined
      : !brtc || !brtc.state || brtc.state === "CREATED"
        ? value.status === "available" ? "available" : "waiting"
        : brtc.state === "AVAILABLE" && brtc.job_state === "SUCCEEDED" && brtc.asset_id
          ? "available"
          : ["INVALID", "FAILED"].includes(brtc.state)
            ? "failed"
            : ["INTERRUPTED", "EXPIRED"].includes(brtc.state)
              ? "interrupted" // the device resumes or renews it; committed chunks are kept
              : brtc.state === "UPLOADING"
                ? "uploading"
                : "verifying";
    return {
      ...value,
      status: brtc
        ? transfer === "available"
          ? "available"
          : transfer === "failed"
            ? "missing"
            : "pending"
        : value.status,
      ...(transfer ? { transfer } : {}),
      deviceId: row.device_id,
      detectionIds: ids,
      synthetic: !!value.synthetic,
    };
  }
  async function detectionView(row: EventRow): Promise<Detection> {
    const detection = row.data as Detection;
    const reading = detection.readingId
      ? ((await db.one(
          "SELECT data FROM readings WHERE device_id=$1 AND id=$2",
          [row.device_id, detection.readingId],
        )) as
          | {
              data: Reading | Recording | Detection;
            }
          | undefined)
      : undefined;
    const recordingRow = detection.recordingId
      ? ((await db.one(
          "SELECT id,device_id,observed_at,data FROM recordings WHERE device_id=$1 AND id=$2",
          [row.device_id, detection.recordingId],
        )) as EventRow | undefined)
      : undefined;
    const window = await db.one<{ window_index: string; start_frame: string; frame_count: string }>(
      "SELECT window_index,start_frame,frame_count FROM detection_audio_windows WHERE device_id=$1 AND detection_id=$2 AND recording_id=$3",
      [row.device_id, row.id, detection.recordingId],
    );
    return {
      ...detection,
      deviceId: row.device_id,
      reading: reading ? (reading.data as Reading) : null,
      recording: recordingRow ? await recordingView(recordingRow) : null,
      audioWindow: window
        ? {
            windowIndex: Number(window.window_index),
            startFrame: Number(window.start_frame),
            frameCount: Number(window.frame_count),
          }
        : null,
    };
  }
  async function filters(
    req: Request,
    farm: string,
    table: "detections" | "recordings",
  ) {
    const dateRange = range(req, 30);
    // A device filter must belong to the selected farm; "all devices" stays inside it.
    const device = typeof req.query.device === "string" ? req.query.device : "";
    if (device) await ownedDevice(device, farm);
    const params: (string | number)[] = [
      farm,
      dateRange.start,
      dateRange.end,
    ];
    // Records observed while the device belonged to this farm, including before a transfer away.
    const conditions = [
      heldBy("e", "$1"),
      "e.observed_at>=$2",
      "e.observed_at<$3",
    ];
    if (device) {
      params.push(device);
      conditions.push(`d.id=$${params.length}`);
    }
    if (table === "detections" && req.query.species) {
      params.push(z.string().max(100).parse(req.query.species));
      conditions.push(`e.data->>'species'=$${params.length}`);
    }
    // table is limited to the two allowed names above; user values stay separate.
    const where = `FROM ${table} e JOIN devices d ON e.device_id=d.id WHERE ${conditions.join(" AND ")}`;
    return { where, params };
  }
  return { recordingView, detectionView, filters };
}
