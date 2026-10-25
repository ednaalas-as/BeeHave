import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Pool } from "pg";

const hash = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const C = 8388608;
function sessionKey(device: string, session: string) {
  const bytes = createHash("sha1").update(Buffer.from("6ba7b8109dad11d180b400c04fd430c8", "hex"))
    .update(`beehave:pi-session:v1:${device}:${session}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 80; bytes[8] = (bytes[8] & 63) | 128;
  const s = bytes.toString("hex");
  return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`;
}
async function stop(child?: ChildProcess) {
  if (child && child.exitCode === null && child.signalCode === null) {
    const done = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGKILL"); // Deliberate crash: only this synthetic test's API.
    await done;
  }
}

test("Pi worker: multi-chunk interruption, API/worker restart, verification, canonical and detection playback", { timeout: 120000 }, async () => {
  const name = "beehave_audio_test_" + randomUUID().replaceAll("-", "");
  const dir = await mkdtemp(join(tmpdir(), "beehave-audio-test-"));
  const config = { host: process.env.PGHOST ?? "localhost", database: process.env.PGDATABASE ?? "beehave", connectionString: process.env.DATABASE_URL };
  const admin = new Pool(config);
  let db: Pool | undefined, child: ChildProcess | undefined;
  const url = config.connectionString ? new URL(config.connectionString) : undefined;
  if (url) url.pathname = "/" + name;
  const env = { ...process.env, PGDATABASE: name, DATABASE_URL: url?.toString() ?? "", BEEHAVE_RECORDING_ROOT: join(dir, "assets"), BRTC_TEST_MODE: "", NODE_ENV: "test" };
  async function start() {
    child = spawn(process.execPath, ["--import", "tsx", resolve(repo, "apps/api/src/test-fixtures/audio-backend.ts")], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
    const current = child;
    let stderr = "";
    current.stderr!.on("data", (b) => { stderr += b.toString(); });
    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("Isolated backend startup timeout: " + stderr)), 20000);
      current.once("exit", () => { clearTimeout(timer); reject(Error("Backend exited: " + stderr)); });
      current.stdout!.on("data", (b) => {
        const match = b.toString().match(/\{"port":(\d+)\}/);
        if (match) { clearTimeout(timer); resolve("http://127.0.0.1:" + match[1]); }
      });
    });
  }
  async function runner(mode: string) {
    const worker = spawn("python3", [resolve(repo, "scripts/edge_agent/audio_fixture_runner.py"), join(dir, "fixture.json"), mode], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    worker.stdout.on("data", b => { output += b.toString(); });
    worker.stderr.on("data", b => { output += b.toString(); });
    const timer = setTimeout(() => worker.kill("SIGKILL"), 60000);
    const code = await new Promise<number | null>(r => worker.once("exit", r));
    clearTimeout(timer);
    assert.equal(code, 0, output);
    return output;
  }
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    db = new Pool({ ...config, database: name, connectionString: url?.toString() });
    let origin = await start();
    const post = async (path: string, body: unknown, headers: Record<string,string> = {}) => {
      const r = await fetch(origin + "/api" + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
      const result = await r.json(); assert(r.ok, JSON.stringify(result)); return result;
    };
    const account = await post("/auth/register", { name: "Synthetic audio test", farm: "Synthetic audio test", email: "audio@example.test", password: "synthetic-test-password", platform: "native" });
    const farm = (await db.query("SELECT farm_id FROM accounts LIMIT 1")).rows[0].farm_id;
    const device = "audio-test-device", key = randomUUID(), session = "20261020T124852Z";
    await db.query("INSERT INTO devices(id,farm_id,name,location,model,key_hash) VALUES($1,$2,'Synthetic audio fixture','test','test',$3)", [device, farm, hash(key)]);
    const rid = "pi_" + hash(`${device}\0${sessionKey(device, session)}\0pi-part-v1:0`);
    const filename = "audio_20261020T124853Z_part00000.wav";
    const path = join(dir, "runs", session, "audio", filename);
    await mkdir(join(dir, "runs", session, "audio"), { recursive: true });
    const frames = 530 * 16000, pcm = Buffer.alloc(frames * 2);
    for (let i = 0; i < frames; i++) pcm.writeInt16LE((i % 65536) - 32768, i * 2);
    const header = Buffer.alloc(44);
    header.write("RIFF"); header.writeUInt32LE(pcm.length + 36, 4); header.write("WAVEfmt ", 8);
    header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
    header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
    header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
    const original = Buffer.concat([header, pcm]);
    await writeFile(path, original);
    const { utimes } = await import("node:fs/promises");
    await utimes(path, new Date(Date.now() - 600000), new Date(Date.now() - 600000));
    const metadata = { id: rid, filename, duration: 530, observedAt: "2026-10-20T12:48:53Z", status: "pending" };
    const batch = { recordings: [metadata], readings: [{ id: "reading", observedAt: metadata.observedAt, temperature: 25.3, humidity: 64.2 }],
      detections: [{ id: "detection", observedAt: metadata.observedAt, species: "Bee", frequency: 230, confidence: 0.9, modelVersion: "fixture", readingId: "reading", recordingId: rid }],
      audioWindows: [{ detectionId: "detection", recordingId: rid, sessionId: session, windowIndex: 2, startFrame: 96000, frameCount: 48000 }] };
    await post("/edge/batch", batch, { "X-Device-Key": key });
    const baseline = async () => Promise.all(["recordings", "readings", "detections", "detection_audio_windows"].map(async table => (await db!.query(`SELECT row_to_json(t) value FROM public.${table} t ORDER BY 1::text`)).rows));
    const before = await baseline();
    const settings = { root: dir, origin, device, session, recording: rid, path, frames, metadata };
    await writeFile(join(dir, "device.key"), key, { mode: 0o600 });
    await writeFile(join(dir, "fixture.json"), JSON.stringify(settings));
    assert.match(await runner("first"), /FIXTURE_INTERRUPTED_AFTER_CHUNK_ZERO/);
    const upload = (await db.query("SELECT id FROM brtc.uploads")).rows[0].id;
    const presence = (await db.query("SELECT idx,generation,ack FROM brtc.presence")).rows;
    assert.equal(presence.length, 1); assert.equal(presence[0].idx, 0);
    const brtcHeaders = { "X-Device-Key": key, "BeeHave-Contract": "BRTC/1.0.2" };
    const duplicate = await fetch(`${origin}/api/v2/uploads/${upload}/chunks/0`, { method: "PUT", headers: { ...brtcHeaders, "Content-Type": "application/octet-stream", "X-Chunk-SHA256": hash(original.subarray(0,C)) }, body: original.subarray(0,C) });
    assert.equal(duplicate.status, 200); assert.equal((await duplicate.json()).outcome, "ALREADY_COMMITTED");
    // Wrong SHA and wrong byte count must not become durable.
    const wrong = await fetch(`${origin}/api/v2/uploads/${upload}/chunks/1`, { method: "PUT", headers: { ...brtcHeaders, "Content-Type": "application/octet-stream", "X-Chunk-SHA256": "0".repeat(64) }, body: original.subarray(C,2*C) });
    assert.equal(wrong.status, 422);
    const short = await fetch(`${origin}/api/v2/uploads/${upload}/chunks/1`, { method: "PUT", headers: { ...brtcHeaders, "Content-Type": "application/octet-stream", "X-Chunk-SHA256": hash(original.subarray(C,C+100)) }, body: original.subarray(C,C+100) });
    assert.equal(short.status, 422);
    await stop(child);
    origin = await start(); settings.origin = origin;
    await writeFile(join(dir, "fixture.json"), JSON.stringify(settings));
    assert.match(await runner("resume"), /FIXTURE_AVAILABLE/);
    assert.deepEqual((await db.query("SELECT idx,generation,ack FROM brtc.presence WHERE idx=0")).rows, presence, "durable chunk zero survives API and Pi-worker restarts unchanged");
    const status = (await db.query("SELECT u.state,j.state job,c.sha256,c.actual_byte_length FROM brtc.uploads u JOIN brtc.verification_jobs j ON j.upload_id=u.id JOIN brtc.canonical_assets c ON c.asset_id=u.asset_id")).rows[0];
    assert.equal(status.state, "AVAILABLE"); assert.equal(status.job, "SUCCEEDED");
    assert.equal(status.sha256, hash(original)); assert.equal(Number(status.actual_byte_length), original.length);
    const playback = `/api/recordings/${device}/${rid}/audio`;
    const auth = { Authorization: `Bearer ${account.token}` };
    const full = await fetch(origin + playback, { headers: auth });
    assert.equal(full.status, 200); assert.equal(hash(Buffer.from(await full.arrayBuffer())), hash(original));
    const segment = await fetch(`${origin}/api/detections/${device}/detection/audio`, { headers: auth });
    assert.equal(segment.status, 200);
    const clip = Buffer.from(await segment.arrayBuffer());
    assert.equal(clip.length, 96044); assert(clip.subarray(44).equals(pcm.subarray(96000*2,144000*2)));
    assert.deepEqual(await baseline(), before, "existing metadata, readings, classifications, timestamps and window offsets untouched");
    assert.equal(hash(await readFile(path)), hash(original), "Pi original unchanged");
  } finally {
    await stop(child);
    await db?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); // only UUID-named DB created above
    await admin.end();
    await rm(dir, { recursive: true, force: true }); // only mkdtemp fixture directory
  }
});
