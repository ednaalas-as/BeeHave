import { type AudioWindow } from "@beehave/shared";
import { createHash } from "node:crypto";
import type { Queries } from "../database";

// The Pi classifier analyses fixed, non-overlapping 3-second windows.
export const WINDOW_SECONDS = 3;

// Verified facts about a recording's canonical original, available only once
// BRTC has verified and published it.
export type VerifiedSource = {
  storage_key: string;
  actual_byte_length: string;
  sha256: string;
  format_tag: number;
  channels: number;
  sample_rate_hz: number;
  bits_per_sample: number;
  block_align: number;
  byte_rate: number;
  data_offset: string;
  frame_count: string;
  part: string;
  session_reference: string | null;
};

// Pi detection IDs are "pi_d_" + SHA-256(device NUL session NUL window), so a
// claimed session/window can be proven against the detection ID itself.
export function piDetectionId(deviceId: string, sessionId: string, windowIndex: number) {
  return (
    "pi_d_" +
    createHash("sha256")
      .update(`${deviceId}\0${sessionId}\0${windowIndex}`, "utf8")
      .digest("hex")
  );
}

// Same gates as recording playback: active, frozen, AVAILABLE upload with a
// successful verification job and a published canonical asset.
export function verifiedSource(db: Queries, deviceId: string, recordingId: string) {
  return db.one<VerifiedSource>(
    `SELECT c.storage_key,c.actual_byte_length,c.sha256,c.format_tag,c.channels,
            c.sample_rate_hz,c.bits_per_sample,c.block_align,c.byte_rate,
            c.data_offset,c.frame_count,br.part,
            s.body->>'source_session_reference' AS session_reference
     FROM brtc.beehave_recording_links l
     JOIN brtc.recordings br ON br.id=l.brtc_recording_id
     JOIN brtc.sessions s ON s.id=br.session_id
     JOIN brtc.uploads u ON u.asset_id=l.asset_id AND u.active
     JOIN brtc.verification_jobs j ON j.upload_id=u.id
     JOIN brtc.canonical_assets c ON c.asset_id=l.asset_id
     WHERE l.device_id=$1 AND l.beehave_recording_id=$2
       AND s.device_id=l.device_id AND u.state='AVAILABLE'
       AND u.frozen AND j.state='SUCCEEDED'`,
    [deviceId, recordingId],
  );
}

// Pi session the recording was transferred under, once its transfer identity exists.
export async function transferSession(db: Queries, deviceId: string, recordingId: string) {
  const row = await db.one<{ session_reference: string | null }>(
    `SELECT s.body->>'source_session_reference' AS session_reference
     FROM brtc.beehave_recording_links l
     JOIN brtc.recordings br ON br.id=l.brtc_recording_id
     JOIN brtc.sessions s ON s.id=br.session_id
     WHERE l.device_id=$1 AND l.beehave_recording_id=$2`,
    [deviceId, recordingId],
  );
  return row ? row.session_reference : undefined;
}

// Returns why a window cannot belong to the verified recording, or null.
export function windowMismatch(
  window: Pick<AudioWindow, "sessionId" | "windowIndex" | "startFrame" | "frameCount">,
  source: VerifiedSource,
) {
  if (source.session_reference !== window.sessionId)
    return "Audio window session does not match the recording's acquisition session.";
  if (window.frameCount !== WINDOW_SECONDS * source.sample_rate_hz)
    return "Audio window length does not match 3 seconds at the recording's verified sample rate.";
  if (window.startFrame + window.frameCount > Number(source.frame_count))
    return "Audio window lies outside the verified recording.";
  // The first recorder part starts with the session's first captured sample.
  if (Number(source.part) === 1 && window.startFrame !== window.windowIndex * window.frameCount)
    return "Audio window start does not match its classifier window index.";
  return null;
}
