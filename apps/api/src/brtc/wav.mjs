import { open } from "node:fs/promises";
export class VerificationError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const reject = (code, reason) => {
  throw new VerificationError(code, reason);
};
export function durationFromFrames(frames, sampleRateHz = 48000) {
  const duration = frames / sampleRateHz;
  if (!(duration > 0 && duration <= 3600))
    reject(
      "DURATION_OUT_OF_POLICY",
      "Derived duration must be >0 and <=3600 seconds",
    );
  return duration;
}
// Read only the RIFF header, chunk headers, and fixed fmt bytes. PCM payload is hashed by the worker.
export async function parseWav(path, declaredFormat = "PI_PCM32_WAV_V1") {
  const formatContracts = {
    PI_PCM32_WAV_V1: { sample_rate_hz: 48000, channels: 2, bits_per_sample: 32, block_align: 8, byte_rate: 384000, codec: "PCM_S32LE", sample_width_bytes: 4 },
    PI_PCM16_16K_MONO_WAV_V1: { sample_rate_hz: 16000, channels: 1, bits_per_sample: 16, block_align: 2, byte_rate: 32000, codec: "PCM_S16LE", sample_width_bytes: 2 },
  };
  const contract = formatContracts[declaredFormat];
  if (!contract) reject("FORMAT_UNSUPPORTED", "Declared WAV format is not supported");
  const file = await open(path, "r");
  try {
    const size = (await file.stat()).size;
    async function read(offset, length) {
      if (offset < 0 || offset + length > size)
        reject("WAV_INVALID", "Truncated chunk");
      const b = Buffer.alloc(length);
      const r = await file.read(b, 0, length, offset);
      if (r.bytesRead !== length) reject("WAV_INVALID", "Truncated read");
      return b;
    }
    const header = await read(0, 12);
    if (header.toString("latin1", 0, 4) === "RF64")
      reject("FORMAT_UNSUPPORTED", "RF64 not supported");
    if (
      header.toString("latin1", 0, 4) !== "RIFF" ||
      header.toString("latin1", 8, 12) !== "WAVE"
    )
      reject("WAV_INVALID", "RIFF/WAVE signature required");
    if (header.readUInt32LE(4) + 8 !== size)
      reject("WAV_INVALID", "RIFF size must equal complete file length");
    let cursor = 12,
      fmt = null,
      data = null;
    while (cursor < size) {
      const ch = await read(cursor, 8),
        tag = ch.toString("latin1", 0, 4),
        length = ch.readUInt32LE(4),
        start = cursor + 8,
        end = start + length,
        padded = end + (length % 2);
      if (end > size || padded > size)
        reject("WAV_INVALID", "Chunk extent/padding exceeds RIFF");
      if (tag === "fmt ") {
        if (fmt) reject("WAV_INVALID", "Duplicate fmt chunk");
        if (data) reject("WAV_INVALID", "fmt must precede data");
        if (length !== 16) reject("FORMAT_UNSUPPORTED", "fmt size must be16");
        const b = await read(start, 16);
        fmt = {
          format_tag: b.readUInt16LE(0),
          channels: b.readUInt16LE(2),
          sample_rate_hz: b.readUInt32LE(4),
          byte_rate: b.readUInt32LE(8),
          block_align: b.readUInt16LE(12),
          bits_per_sample: b.readUInt16LE(14),
        };
        if (fmt.format_tag !== 1)
          reject(
            "FORMAT_UNSUPPORTED",
            "Only integer PCM format tag1 is supported",
          );
        if (
          fmt.sample_rate_hz !== contract.sample_rate_hz ||
          fmt.channels !== contract.channels ||
          fmt.bits_per_sample !== contract.bits_per_sample
        )
          reject("FORMAT_UNSUPPORTED", "WAV format does not match declared source-format contract");
        if (fmt.block_align !== contract.block_align || fmt.byte_rate !== contract.byte_rate)
          reject("WAV_INVALID", "PCM block alignment/byte rate mismatch");
      } else if (tag === "data") {
        if (!fmt) reject("WAV_INVALID", "data before fmt");
        if (data) reject("WAV_INVALID", "Duplicate data chunk");
        if (!length || length % contract.block_align)
          reject("WAV_INVALID", "PCM data must be nonempty and frame-aligned");
        data = { data_offset: start, data_byte_length: length };
      }
      if (length % 2) {
        const pad = await read(end, 1);
        if (pad[0] !== 0)
          reject("WAV_INVALID", "RIFF padding byte must be zero");
      }
      cursor = padded;
    }
    if (!fmt || !data || cursor !== size)
      reject("WAV_INVALID", "Exactly one fmt and data required");
    const frame_count = data.data_byte_length / contract.block_align;
    return {
      container: "WAV",
      codec: contract.codec,
      ...fmt,
      sample_width_bytes: contract.sample_width_bytes,
      declared_format: declaredFormat,
      ...data,
      frame_count,
      duration_seconds: durationFromFrames(frame_count, contract.sample_rate_hz),
      verifier_version: "wav-pcm/1.0.0",
    };
  } finally {
    await file.close();
  }
}
