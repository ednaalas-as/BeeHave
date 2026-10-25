import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Request, Response } from "express";
import { root } from "./runtime.mjs";

type Asset = { storage_key: string; actual_byte_length: string | number; sha256: string };
const trusted = new Map<string, string>();
const fingerprint = (s: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>>) =>
  [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].map(String).join(":");

// Opens the canonical original read-only and proves its path, size and SHA-256
// (re-hashed whenever the file's fingerprint changes) before any byte is served.
async function openVerified(asset: Asset, opened: (file: Awaited<ReturnType<typeof open>>) => void) {
  const base = await realpath(root);
  const path = resolve(base, asset.storage_key);
  if (!path.startsWith(base + sep) || await realpath(path) !== path)
    throw new Error("canonical path integrity error");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  opened(file);
  const before = await file.stat();
  const length = Number(asset.actual_byte_length);
  if (!before.isFile() || before.size !== length) throw new Error("canonical length integrity error");
  const mark = fingerprint(before);
  if (trusted.get(asset.storage_key) !== mark) {
    const digest = createHash("sha256");
    for await (const chunk of file.createReadStream({ highWaterMark: 65536, autoClose: false }))
      digest.update(chunk);
    const after = await file.stat();
    if (fingerprint(after) !== mark || digest.digest("hex") !== asset.sha256)
      throw new Error("canonical hash integrity error");
    trusted.set(asset.storage_key, mark);
  }
  return { file, length };
}

export async function serveCanonical(
  req: Request,
  res: Response,
  asset: Asset,
  recordingId: string,
) {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const verified = await openVerified(asset, (f) => (file = f));
    const length = verified.length;
    const etag = `"sha256-${asset.sha256}"`;
    const headers = {
      "Content-Type": "audio/wav",
      "Accept-Ranges": "bytes",
      "Content-Length": String(length),
      ETag: etag,
      "Cache-Control": "private, no-store",
      "Content-Disposition": `inline; filename="${recordingId}.wav"`,
      "X-Content-Type-Options": "nosniff",
      "BeeHave-Contract": "BRTC/1.0.2",
    };
    const inm = req.headers["if-none-match"];
    if (typeof inm === "string" && (inm.trim() === "*" || inm.split(",").some((v) => v.trim().replace(/^W\//, "") === etag))) {
      res.status(304).set(headers).end();
      return;
    }
    let start = 0, end = length - 1, status = 200;
    const range = req.headers.range;
    const ifRange = req.headers["if-range"];
    if (req.method === "GET" && typeof range === "string" && (!ifRange || ifRange === etag)) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2])) {
        res.status(416).set({ ...headers, "Content-Range": `bytes */${length}` }).end();
        return;
      }
      if (!match[1]) {
        const suffix = Number(match[2]);
        if (!Number.isSafeInteger(suffix) || suffix <= 0) {
          res.status(416).set({ ...headers, "Content-Range": `bytes */${length}` }).end();
          return;
        }
        start = Math.max(0, length - suffix);
      } else {
        start = Number(match[1]);
        end = match[2] ? Math.min(Number(match[2]), length - 1) : length - 1;
      }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= length || end < start) {
        res.status(416).set({ ...headers, "Content-Range": `bytes */${length}` }).end();
        return;
      }
      status = 206;
      headers["Content-Length"] = String(end - start + 1);
      res.status(status).set({ ...headers, "Content-Range": `bytes ${start}-${end}/${length}` });
    } else res.status(status).set(headers);
    if (req.method === "HEAD") { res.end(); return; }
    await pipeline(verified.file.createReadStream({ start, end, highWaterMark: 65536, autoClose: false }), res);
  } catch {
    if (!res.headersSent) res.status(503).json({ error: "Verified recording storage is unavailable." });
    else res.destroy();
  } finally {
    await file?.close();
  }
}

export type SegmentFormat = {
  format_tag: number;
  channels: number;
  sample_rate_hz: number;
  bits_per_sample: number;
  block_align: number;
  byte_rate: number;
  data_offset: string | number;
  frame_count: string | number;
};

// Serves frames [startFrame, startFrame + frameCount) of a verified canonical
// PCM original as a standalone WAV. The header is rebuilt from the verified
// format; sample bytes are copied unchanged and nothing is written to disk.
export async function serveCanonicalSegment(
  req: Request,
  res: Response,
  asset: Asset,
  format: SegmentFormat,
  segment: { startFrame: number; frameCount: number; name: string },
) {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const verified = await openVerified(asset, (f) => (file = f));
    const dataBytes = segment.frameCount * format.block_align;
    const offset = Number(format.data_offset) + segment.startFrame * format.block_align;
    if (
      format.format_tag !== 1 ||
      segment.startFrame + segment.frameCount > Number(format.frame_count) ||
      offset + dataBytes > verified.length
    )
      throw new Error("segment outside verified audio");
    const body = Buffer.alloc(44 + dataBytes);
    body.write("RIFF", 0, "ascii");
    body.writeUInt32LE(36 + dataBytes, 4);
    body.write("WAVEfmt ", 8, "ascii");
    body.writeUInt32LE(16, 16);
    body.writeUInt16LE(format.format_tag, 20);
    body.writeUInt16LE(format.channels, 22);
    body.writeUInt32LE(format.sample_rate_hz, 24);
    body.writeUInt32LE(format.byte_rate, 28);
    body.writeUInt16LE(format.block_align, 32);
    body.writeUInt16LE(format.bits_per_sample, 34);
    body.write("data", 36, "ascii");
    body.writeUInt32LE(dataBytes, 40);
    const { bytesRead } = await verified.file.read(body, 44, dataBytes, offset);
    if (bytesRead !== dataBytes) throw new Error("short canonical read");
    const length = body.length;
    const etag = `"sha256-${asset.sha256}-${segment.startFrame}-${segment.frameCount}"`;
    const headers: Record<string, string> = {
      "Content-Type": "audio/wav",
      "Accept-Ranges": "bytes",
      ETag: etag,
      "Cache-Control": "private, no-store",
      "Content-Disposition": `inline; filename="${segment.name}.wav"`,
      "X-Content-Type-Options": "nosniff",
    };
    const unsatisfiable = () =>
      res.status(416).set({ ...headers, "Content-Range": `bytes */${length}`, "Content-Length": "0" }).end();
    const inm = req.headers["if-none-match"];
    if (typeof inm === "string" && (inm.trim() === "*" || inm.split(",").some((v) => v.trim().replace(/^W\//, "") === etag))) {
      res.status(304).set(headers).end();
      return;
    }
    let start = 0, end = length - 1;
    const range = req.headers.range;
    const ifRange = req.headers["if-range"];
    if (req.method === "GET" && typeof range === "string" && (!ifRange || ifRange === etag)) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2])) return void unsatisfiable();
      if (!match[1]) {
        const suffix = Number(match[2]);
        if (!Number.isSafeInteger(suffix) || suffix <= 0) return void unsatisfiable();
        start = Math.max(0, length - suffix);
      } else {
        start = Number(match[1]);
        end = match[2] ? Math.min(Number(match[2]), length - 1) : length - 1;
      }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= length || end < start)
        return void unsatisfiable();
      res.status(206).set({ ...headers, "Content-Length": String(end - start + 1), "Content-Range": `bytes ${start}-${end}/${length}` });
    } else res.status(200).set({ ...headers, "Content-Length": String(length) });
    if (req.method === "HEAD") { res.end(); return; }
    res.end(body.subarray(start, end + 1));
  } catch {
    if (!res.headersSent) res.status(503).json({ error: "Verified recording storage is unavailable." });
    else res.destroy();
  } finally {
    await file?.close();
  }
}
