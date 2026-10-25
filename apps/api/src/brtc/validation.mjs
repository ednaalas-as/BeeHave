import { z } from "zod";
export const V = "BRTC/1.0.2",
  C = 8388608;
export const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const uint = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  key = z
    .string()
    .min(1)
    .max(160)
    .regex(/^[^\x00-\x1f\x7f]+$/),
  timestamp = z
    .string()
    .regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
    .refine(
      (v) => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v,
    );
const sourceTime = z
  .object({
    raw: z.string().min(1).max(128),
    utc: timestamp.nullable(),
    basis: z.enum(["CAPTURE_REPORTED", "LOG_REPORTED", "UNKNOWN"]),
    timezone: z.string().nullable(),
  })
  .strict()
  .superRefine((t, ctx) => {
    if (t.timezone !== null && !/^[+-](0\d|1[0-4]):[0-5]\d$/.test(t.timezone)) {
      try {
        new Intl.DateTimeFormat("en", { timeZone: t.timezone }).format();
      } catch {
        ctx.addIssue({ code: "custom", message: "TIME_INCONSISTENT" });
      }
    }
    if (t.utc !== null) {
      let parsed = NaN;
      if (/(?:Z|[+-]\d\d:\d\d)$/.test(t.raw)) parsed = Date.parse(t.raw);
      else if (t.timezone && /^[+-]/.test(t.timezone))
        parsed = Date.parse(t.raw.replace(" ", "T") + t.timezone);
      else if (t.timezone) {
        const m = t.raw.match(
          /^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d):(\d\d)(?:\.(\d{1,3}))?$/,
        );
        if (m) {
          const target = m.slice(1, 7).join("-");
          const formatter = new Intl.DateTimeFormat("en-CA", {
            timeZone: t.timezone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hourCycle: "h23",
          });
          const parts = Object.fromEntries(
            formatter
              .formatToParts(new Date(t.utc))
              .map((p) => [p.type, p.value]),
          );
          if (
            [
              parts.year,
              parts.month,
              parts.day,
              parts.hour,
              parts.minute,
              parts.second,
            ].join("-") === target &&
            new Date(t.utc).getUTCMilliseconds() ===
              Number((m[7] || "0").padEnd(3, "0"))
          )
            parsed = Date.parse(t.utc);
        }
      }
      if (parsed !== Date.parse(t.utc))
        ctx.addIssue({ code: "custom", message: "TIME_INCONSISTENT" });
    }
  });
const expected = z
  .object({
    byte_length: uint.min(52).max(2000000000),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    format: z.enum(["PI_PCM32_WAV_V1", "PI_PCM16_16K_MONO_WAV_V1"]),
  })
  .strict();
const status = z.enum(["COMPLETE", "PARTIAL", "INTERRUPTED", "UNKNOWN"]);
const reported = z
  .object({
    filename: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[^\x00-\x1f\x7f]+$/),
    started_at: sourceTime.nullable(),
    ended_at: sourceTime.nullable(),
    acquisition_status: status,
    duration_seconds: z.number().min(0).nullable(),
    sample_rate_hz: uint.nullable(),
    channels: uint.nullable(),
    bits_per_sample: uint.nullable(),
    source_metadata: z
      .object({
        schema: z.literal("source/1"),
        values: z
          .record(
            z.string().min(1).max(64),
            z.union([z.string().max(1024), z.number(), z.boolean(), z.null()]),
          )
          .refine((v) => Object.keys(v).length <= 32),
      })
      .strict(),
  })
  .strict();
export const schemas = {
  session: z
    .object({
      contract: z.literal(V),
      source_session_key: uuid,
      source_session_reference: key,
      reported_started_at: sourceTime.nullable(),
      reported_ended_at: sourceTime.nullable(),
      acquisition_status: status,
    })
    .strict(),
  recording: z
    .object({
      contract: z.literal(V),
      session_id: uuid,
      source_part_number: uint.min(1).max(2147483647),
      source_recording_key: key,
      expected,
      reported,
      provenance: z
        .object({
          kind: z.enum([
            "SYNTHETIC_PI_AUDIO_COMPATIBILITY_FIXTURE",
            "DEVICE_ACQUISITION",
          ]),
          producer: key,
        })
        .strict(),
    })
    .strict(),
  upload: z
    .object({
      contract: z.literal(V),
      asset_id: uuid,
      expected,
      mode: z.enum(["RESUME_OR_CREATE", "NEW_ATTEMPT"]),
      previous_upload_id: uuid.nullable(),
    })
    .strict(),
  renew: z
    .object({ contract: z.literal(V), asset_id: uuid, expected })
    .strict(),
};
export function canonical(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  return (
    "{" +
    Object.keys(v)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + canonical(v[k]))
      .join(",") +
    "}"
  );
}
// Reject duplicate object names before JSON.parse; handles escaped names and nesting.
export function strictJSON(text) {
  let i = 0;
  const ws = () => {
    while (/\s/.test(text[i] || "") && i < text.length) i++;
  };
  function str() {
    const start = i++;
    while (i < text.length) {
      if (text[i] === "\\") {
        i += 2;
        continue;
      }
      if (text[i++] === '"') return JSON.parse(text.slice(start, i));
    }
    throw Error("string");
  }
  function value(depth = 0) {
    if (depth > 64) throw Error("depth");
    ws();
    if (text[i] === "{") {
      i++;
      ws();
      const keys = new Set();
      if (text[i] === "}") {
        i++;
        return;
      }
      while (true) {
        ws();
        if (text[i] !== '"') throw Error("key");
        const k = str();
        if (keys.has(k)) throw Error("duplicate");
        keys.add(k);
        ws();
        if (text[i++] !== ":") throw Error("colon");
        value(depth + 1);
        ws();
        const end = text[i++];
        if (end === "}") break;
        if (end !== ",") throw Error("comma");
      }
    } else if (text[i] === "[") {
      i++;
      ws();
      if (text[i] === "]") {
        i++;
        return;
      }
      while (true) {
        value(depth + 1);
        ws();
        const end = text[i++];
        if (end === "]") break;
        if (end !== ",") throw Error("comma");
      }
    } else if (text[i] === '"') str();
    else {
      const m = text
        .slice(i)
        .match(
          /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/,
        );
      if (!m) throw Error("value");
      i += m[0].length;
    }
  }
  value();
  ws();
  if (i !== text.length) throw Error("trailing");
  return JSON.parse(text);
}
