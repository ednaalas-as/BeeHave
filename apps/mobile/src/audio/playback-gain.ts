const TARGET_GAIN = 8;
const LIMITER_KNEE_START = 0.75;

/**
 * Create a playback-only PCM copy of a supported WAV. The downloaded source is
 * never changed; its RIFF chunks and metadata are copied byte-for-byte.
 */
export function amplifyPcmWav(source: Uint8Array): Uint8Array | null {
  const bytes = source.slice();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.length < 44 ||
    readAscii(view, 0, 4) !== "RIFF" ||
    readAscii(view, 8, 4) !== "WAVE"
  ) {
    return null;
  }

  let formatTag = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataLength = 0;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const id = readAscii(view, offset, 4);
    const length = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (start + length > bytes.length) return null;
    if (id === "fmt " && length >= 16) {
      formatTag = view.getUint16(start, true);
      bitsPerSample = view.getUint16(start + 14, true);
    } else if (id === "data") {
      dataOffset = start;
      dataLength = length;
      break;
    }
    offset = start + length + (length % 2);
  }

  if (formatTag !== 1 || dataOffset < 0) return null;
  if (bitsPerSample === 16) {
    for (
      let offset = dataOffset;
      offset + 2 <= dataOffset + dataLength;
      offset += 2
    ) {
      const sample = view.getInt16(offset, true) / 32768;
      view.setInt16(offset, encodeSample(sample, 32768, 32767), true);
    }
    return bytes;
  }
  if (bitsPerSample === 32) {
    for (
      let offset = dataOffset;
      offset + 4 <= dataOffset + dataLength;
      offset += 4
    ) {
      const sample = view.getInt32(offset, true) / 2147483648;
      view.setInt32(offset, encodeSample(sample, 2147483648, 2147483647), true);
    }
    return bytes;
  }
  return null;
}

function encodeSample(sample: number, scale: number, maximum: number): number {
  // Bring up quiet audio near 8x and smoothly limit stronger peaks below full scale.
  const magnitude = Math.abs(sample) * TARGET_GAIN;
  const amplifiedMagnitude =
    magnitude <= LIMITER_KNEE_START
      ? magnitude
      : LIMITER_KNEE_START +
        (1 - LIMITER_KNEE_START) *
          (1 - Math.exp(-(magnitude - LIMITER_KNEE_START) / (1 - LIMITER_KNEE_START)));
  const amplified = Math.sign(sample) * amplifiedMagnitude;
  return Math.max(-scale, Math.min(maximum - 1, Math.round(amplified * scale)));
}

function readAscii(view: DataView, offset: number, length: number): string {
  let result = "";
  for (let i = 0; i < length; i++)
    result += String.fromCharCode(view.getUint8(offset + i));
  return result;
}
