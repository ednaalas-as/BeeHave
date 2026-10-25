import { manilaDate } from "@beehave/shared";
import { randomUUID } from "node:crypto";
import { hashPassword } from "./auth";
import type { DB } from "./database";
export async function ensureDemo(db: DB) {
  const existing = (await db.one("SELECT id FROM accounts WHERE email=$1", [
    "sample@beehave.local",
  ])) as
    | {
        id: string;
      }
    | undefined;
  if (existing) return existing.id;
  const id = randomUUID();
  const now = new Date();
  const device = "sample-edge-01";
  return db.transaction(async (transaction) => {
    await transaction.execute("SELECT pg_advisory_xact_lock(246813580)");
    const existing = await transaction.one<{ id: string }>(
      "SELECT id FROM accounts WHERE email=$1",
      ["sample@beehave.local"],
    );
    if (existing) return existing.id;
    await transaction.execute(
      "INSERT INTO farms (id, name, demo) VALUES($1,$2,TRUE)",
      ["sample-farm", "Quezon Research Farm"],
    );
    await transaction.execute(
      "INSERT INTO accounts (id, farm_id, name, email, password, role) VALUES($1,$2,$3,$4,$5,$6)",
      [
        id,
        "sample-farm",
        "Sample observer",
        "sample@beehave.local",
        hashPassword(randomUUID()),
        "viewer",
      ],
    );
    await transaction.execute(
      "INSERT INTO farm_members (farm_id, account_id, role) VALUES($1,$2,'viewer')",
      ["sample-farm", id],
    );
    await transaction.execute(
      "INSERT INTO devices (id, farm_id, name, location, model, key_hash, last_seen, last_sync, health) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [
        device,
        "sample-farm",
        "Coconut grove · Station 01",
        "Lucban, Quezon",
        "Raspberry Pi 4 Model B",
        "disabled",
        now.toISOString(),
        now.toISOString(),
        JSON.stringify({
          collecting: true,
          cpu: 24,
          ram: 38,
          cpuTemperature: 48.2,
          storageUsed: 12.8,
          storageTotal: 64,
          queued: 0,
          microphone: true,
          sensor: true,
          softwareVersion: "sample / 0.1.0",
        }),
      ],
    );
    const today = manilaDate(now);
    let n = 0;
    const waves = new Map<number, Buffer>();
    const wave = (hz: number) => {
      if (!waves.has(hz)) waves.set(hz, makeWave(hz));
      return waves.get(hz)!;
    };
    for (let day = 29; day >= 0; day--) {
      const midnight = Date.parse(`${today}T00:00:00+08:00`) - day * 86400000;
      for (let hour = 5; hour <= 17; hour++) {
        const count = Math.round(
          (hour < 10 ? (hour - 3) * 3 : (20 - hour) * 1.5) + (day % 5),
        );
        for (let k = 0; k < count; k++) {
          const at = new Date(midnight + hour * 3600000 + k * 150000);
          if (at > now) continue;
          n++;
          const event = `sample-${String(n).padStart(5, "0")}`;
          const reading = {
            id: `env-${event}`,
            observedAt: new Date(at.getTime() - 4000).toISOString(),
            temperature:
              Math.round((27 + hour * 0.25 + (day % 3) * 0.2) * 10) / 10,
            humidity: Math.round(83 - hour * 0.8 + (day % 3)),
          };
          await transaction.execute(
            "INSERT INTO readings (id, device_id, observed_at, data) VALUES($1,$2,$3,$4)",
            [reading.id, device, reading.observedAt, JSON.stringify(reading)],
          );
          const recordingId = n % 13 === 0 ? null : `rec-${event}`;
          if (recordingId) {
            const recording = {
              id: recordingId,
              observedAt: at.toISOString(),
              duration: 5,
              filename: `${recordingId}.wav`,
              status: n % 17 === 0 ? "pending" : "available",
              synthetic: true,
            };
            await transaction.execute(
              "INSERT INTO recordings (id, device_id, observed_at, data, audio) VALUES($1,$2,$3,$4,$5)",
              [
                recordingId,
                device,
                recording.observedAt,
                JSON.stringify(recording),
                recording.status === "available" ? wave(190 + (n % 55)) : null,
              ],
            );
          }
          const detection = {
            id: event,
            observedAt: at.toISOString(),
            species: "T. biroi",
            frequency: 190 + (n % 55),
            confidence: 0.87 + (n % 12) / 100,
            readingId: n % 19 === 0 ? null : reading.id,
            recordingId,
            modelVersion: "synthetic-sample-v1",
          };
          await transaction.execute(
            "INSERT INTO detections (id, device_id, observed_at, data) VALUES($1,$2,$3,$4)",
            [event, device, detection.observedAt, JSON.stringify(detection)],
          );
        }
      }
    }
    return id;
  });
}
function makeWave(frequency: number) {
  const rate = 8000;
  const count = rate * 5;
  const b = Buffer.alloc(44 + count * 2);
  b.write("RIFF");
  b.writeUInt32LE(b.length - 8, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i++) {
    const t = i / rate;
    const envelope =
      Math.min(1, t * 3, (5 - t) * 3) * (0.6 + 0.4 * Math.sin(t * 5) ** 2);
    b.writeInt16LE(
      Math.round(Math.sin(2 * Math.PI * frequency * t) * 2400 * envelope),
      44 + i * 2,
    );
  }
  return b;
}
