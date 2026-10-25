import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import express from "express";

// The storage root is read when the BRTC runtime loads, so this file imports
// the media module only after pointing it at a temporary directory.
test("segment playback serves only the window, unchanged, with correct ranges", async () => {
  const dir = await mkdtemp(join(tmpdir(), "beehave-segment-"));
  process.env.BEEHAVE_RECORDING_ROOT = dir;
  const { serveCanonicalSegment } = await import("./brtc/canonical-media");
  const rate = 16000, frames = rate * 10;
  const pcm = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) pcm.writeInt16LE((i % 65536) - 32768, i * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii"); header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8, "ascii"); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii"); header.writeUInt32LE(pcm.length, 40);
  const original = Buffer.concat([header, pcm]);
  await mkdir(join(dir, "canonical"));
  await writeFile(join(dir, "canonical", "a.wav"), original);
  const asset = {
    storage_key: "canonical/a.wav",
    actual_byte_length: original.length,
    sha256: createHash("sha256").update(original).digest("hex"),
  };
  const format = {
    format_tag: 1, channels: 1, sample_rate_hz: rate, bits_per_sample: 16,
    block_align: 2, byte_rate: rate * 2, data_offset: 44, frame_count: frames,
  };
  let segment = { startFrame: 2 * 48000, frameCount: 48000, name: "d1" };
  const app = express();
  app.get("/segment", (req, res) => void serveCanonicalSegment(req, res, asset, format, segment));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/segment`;
  try {
    const full = await fetch(url);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get("content-type"), "audio/wav");
    const wav = Buffer.from(await full.arrayBuffer());
    assert.equal(wav.length, 44 + 96000);
    assert.equal(wav.toString("ascii", 0, 4), "RIFF");
    assert.equal(wav.readUInt32LE(4), 36 + 96000);
    assert.equal(wav.readUInt32LE(24), rate);
    assert.equal(wav.readUInt16LE(22), 1);
    assert.equal(wav.readUInt16LE(34), 16);
    assert.equal(wav.readUInt32LE(40), 96000);
    assert(wav.subarray(44).equals(original.subarray(44 + 96000 * 2, 44 + 96000 * 3)), "window bytes copied unchanged");
    const head = await fetch(url, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), "96044");
    const part = await fetch(url, { headers: { Range: "bytes=40-47" } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get("content-range"), "bytes 40-47/96044");
    assert(Buffer.from(await part.arrayBuffer()).equals(wav.subarray(40, 48)));
    const suffix = await fetch(url, { headers: { Range: "bytes=-10" } });
    assert(Buffer.from(await suffix.arrayBuffer()).equals(wav.subarray(-10)));
    const beyond = await fetch(url, { headers: { Range: "bytes=96044-" } });
    assert.equal(beyond.status, 416);
    assert.equal(beyond.headers.get("content-range"), "bytes */96044");
    assert.equal((await beyond.arrayBuffer()).byteLength, 0, "416 completes without a body");
    segment = { startFrame: frames - 100, frameCount: 48000, name: "d2" };
    assert.equal((await fetch(url)).status, 503, "window beyond the original is refused");
    segment = { startFrame: 0, frameCount: 48000, name: "d3" };
    const tampered = Buffer.from(original);
    tampered[100] ^= 1;
    await writeFile(join(dir, "canonical", "a.wav"), tampered);
    assert.equal((await fetch(url)).status, 503, "modified original is refused");
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
