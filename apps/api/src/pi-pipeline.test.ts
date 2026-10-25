import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, chmod, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";

// The whole Pi → API → PostgreSQL path with the real agent (observation sync and BRTC audio
// worker, production intervals) behind a proxy that simulates network loss and API failures.
// Synthetic only: a UUID-named database, a temporary storage root and a temporary runs folder.
const repo = resolve(import.meta.dirname, "../../..");
const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const fakeSystemctl = `#!/usr/bin/env python3
import sys
from pathlib import Path
if sys.argv[1] == "is-active":
    print((Path(__file__).parent / "state").read_text().strip())
`;

async function until<T>(check: () => Promise<T | undefined | false>, what: string, seconds = 120) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

test("Pi pipeline: real-time sync, outages, restarts, BRTC transfer and playback", { timeout: 900000 }, async () => {
  const name = "beehave_audio_test_" + randomUUID().replaceAll("-", "");
  const config = { host: process.env.PGHOST ?? "localhost", database: process.env.PGDATABASE ?? "beehave", connectionString: process.env.DATABASE_URL };
  const admin = new Pool(config);
  const dir = await mkdtemp(join(tmpdir(), "beehave-pipeline-test-"));
  const url = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : undefined;
  if (url) url.pathname = "/" + name;
  const env = { ...process.env, PGDATABASE: name, DATABASE_URL: url?.toString() ?? "", BEEHAVE_RECORDING_ROOT: join(dir, "assets"), BRTC_TEST_MODE: "", NODE_ENV: "test" };
  let backend: ChildProcess | undefined, agent: ChildProcess | undefined, db: Pool | undefined;
  let agentLog = "";
  const timings: Record<string, number> = {};
  const startBackend = () => new Promise<string>((ok, fail) => {
    backend = spawn(process.execPath, ["--import", "tsx", resolve(repo, "apps/api/src/test-fixtures/audio-backend.ts")], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    backend.stdout!.on("data", (d) => { output += d; const m = /\{"port":(\d+)\}/.exec(output); if (m) ok(`http://127.0.0.1:${m[1]}`); });
    backend.stderr!.on("data", (d) => { output += d; });
    backend.once("exit", (code) => fail(Error(`backend exited ${code}: ${output}`)));
  });
  const stop = async (child?: ChildProcess) => {
    if (!child || child.exitCode !== null || child.signalCode) return;
    const exited = new Promise((r) => child.once("exit", r));
    child.kill("SIGKILL"); // only this test's own processes
    await exited;
  };
  // Proxy between the agent and the API: "pass", "drop" (network loss) or "503" (API failure).
  let target = "", mode: "pass" | "drop" | "503" = "pass";
  const proxy = createServer((req, res) => {
    if (mode === "drop") return void req.socket.destroy();
    if (mode === "503") { req.resume(); res.writeHead(503, { "Content-Type": "application/json" }); return void res.end('{"error":"unavailable"}'); }
    const out = httpRequest(new URL(req.url!, target), { method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode!, r.headers); r.pipe(res); });
    out.on("error", () => req.socket.destroy());
    req.pipe(out);
  });
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  const proxyAddress = proxy.address();
  assert(proxyAddress && typeof proxyAddress !== "string");
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    db = new Pool({ ...config, database: name, connectionString: url?.toString() });
    target = await startBackend();
    const api = async (path: string, init: RequestInit = {}) => fetch(target + "/api" + path, init);
    const owner = await (await api("/auth/register", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Pipeline", farm: "Pipeline farm", email: "pipeline@example.test", password: "synthetic-test-password", platform: "native" }) })).json();
    const auth = { Authorization: `Bearer ${owner.token}` };
    const registered = await (await api("/devices", { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ name: "Pipeline Pi", location: "Hive" }) })).json();
    const device = registered.device.id as string;

    // Fake Pi: a session that started 15 minutes ago with a closed 10-minute WAV (3 BRTC chunks).
    const started = new Date(Math.floor(Date.now() / 1000) * 1000 - 900000);
    const stamp = started.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const session = stamp, run = join(dir, "runs", session);
    const wavPath = join(run, "audio", `audio_${stamp}_part00000.wav`);
    const frames = 600 * 16000, pcm = Buffer.alloc(frames * 2);
    for (let i = 0; i < frames; i++) pcm.writeInt16LE((i % 65536) - 32768, i * 2);
    const header = Buffer.alloc(44);
    header.write("RIFF"); header.writeUInt32LE(pcm.length + 36, 4); header.write("WAVEfmt ", 8);
    header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
    header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
    header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
    const original = Buffer.concat([header, pcm]);
    const columns = "session_id,window_index,window_end_utc,predicted_label,predicted_class,bee_probability,temperature_c,humidity_pct,dominant_frequency_hz,model_sha256,recording_file_relative_path,audio_status_events,dropped_audio_blocks,sensor_status,ram_status,latest_storage_status,deadline_missed\n";
    const row = (w: number, end: Date) => {
      const bee = w % 10 === 0;
      const part = w < 200 ? `audio/audio_${stamp}_part00000.wav` : `audio/audio_${stamp}_part00001.wav`;
      return `${session},${w},${end.toISOString().slice(0, 19)}+00:00,${bee ? 1 : 0},${bee ? "bee" : "non_bee"},${bee ? 0.9 : 0.1},25.5,64,231.5,modelsha256abc,${part},0,0,ok,ok,ok,False\n`;
    };
    let next = 0;
    const append = async (count: number, end?: Date) => {
      let lines = "";
      for (let i = 0; i < count; i++, next++) lines += row(next, end ?? new Date(started.getTime() + (next + 1) * 3000));
      await appendFile(join(run, "classifications.csv"), lines);
      return next;
    };
    const files: Record<string, string> = {
      "root/proc/stat": "cpu  100 0 100 800 0 0 0 0 0 0\n",
      "root/proc/meminfo": "MemTotal: 4000000 kB\nMemAvailable: 3000000 kB\n",
      "root/proc/uptime": "7380.5 1000.0\n",
      "root/proc/asound/cards": " 2 [ICS43434       ]: simple-card - ICS43434\n",
      "root/sys/class/thermal/thermal_zone0/temp": "48250\n",
      "tools/systemctl": fakeSystemctl, "tools/state": "active",
      "device.key": registered.key, "device.id": device,
      [`runs/${session}/run_metadata.json`]: JSON.stringify({ capture: { recording_chunk_minutes: 60, capture_rate_hz: 16000 } }),
      [`runs/${session}/classifications.csv`]: columns,
    };
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(dir, path, ".."), { recursive: true });
      await writeFile(join(dir, path), content);
    }
    await chmod(join(dir, "tools/systemctl"), 0o755);
    await mkdir(join(dir, "state"));
    await mkdir(join(run, "audio"));
    await writeFile(wavPath, original);
    await utimes(wavPath, new Date(Date.now() - 1200000), new Date(Date.now() - 1200000)); // closed long ago
    await append(200); // the WAV's 200 classifier windows

    const startAgent = () => {
      agent = spawn("python3", [resolve(repo, "scripts/edge_agent/agent.py")], { env: { ...process.env,
        BEEHAVE_API_URL: `http://127.0.0.1:${proxyAddress.port}`, BEEHAVE_DEVICE_KEY_FILE: join(dir, "device.key"),
        BEEHAVE_DEVICE_ID_FILE: join(dir, "device.id"), BEEHAVE_RUNS_DIR: join(dir, "runs"), BEEHAVE_STATE_DIR: join(dir, "state"),
        BEEHAVE_SYSTEM_ROOT: join(dir, "root"), BEEHAVE_SYSTEMCTL: join(dir, "tools/systemctl"), BEEHAVE_NMCLI: join(dir, "tools/none"),
        BEEHAVE_SETUP_SOCKET: join(dir, "none.sock"), BEEHAVE_FRESH_SECONDS: "100000",
        // Production schedule (heartbeat 30 s, requests 10 s, sync 10 s, audio 2 s); all recordings eligible.
        BEEHAVE_SYNC_ENABLED: "1", BEEHAVE_SYNC_FIRST_SESSION: session, BEEHAVE_AUDIO_ENABLED: "1" }, stdio: ["ignore", "pipe", "pipe"] });
      agent.stdout!.on("data", (d) => { agentLog += d; });
      agent.stderr!.on("data", (d) => { agentLog += d; });
    };
    const count = async (table: string) => Number((await db!.query(`SELECT COUNT(*) n FROM ${table} WHERE device_id=$1`, [device])).rows[0].n);
    const outboxPending = () => Number(execFileSync("python3", ["-c",
      "import sqlite3,sys;c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True);print(c.execute(\"SELECT COUNT(*) FROM observations WHERE state='pending'\").fetchone()[0])",
      join(dir, "state", "sync.sqlite3")]).toString());
    const arrives = async (total: number, label: string, seconds = 150) => {
      const t0 = Date.now();
      await until(async () => (await count("detections")) >= total, label, seconds);
      timings[label] = (Date.now() - t0) / 1000;
    };

    // 1. Pi online: backlog then near-real-time sync.
    let t0 = Date.now();
    startAgent();
    await arrives(200, "initial backlog of 200 windows");
    timings["initial backlog of 200 windows"] = (Date.now() - t0) / 1000;
    for (let i = 0; i < 3; i++) {
      const total = await append(1, new Date());
      t0 = Date.now();
      await until(async () => {
        const page = await (await api(`/detections?device=${device}&size=10`, { headers: auth })).json();
        return page.total >= total;
      }, "live window visible through the API", 60);
      timings[`live window ${i + 1}: CSV line → GET /api/detections`] = (Date.now() - t0) / 1000;
    }
    // 2. Network loss once the first audio chunk is durable (interrupts the BRTC transfer too).
    await until(async () => Number((await db!.query("SELECT COUNT(*) n FROM brtc.presence")).rows[0].n) >= 1, "first durable chunk");
    const chunkZero = (await db.query("SELECT idx,generation,ack FROM brtc.presence ORDER BY idx")).rows;
    mode = "drop";
    let total = await append(5, new Date());
    await new Promise((r) => setTimeout(r, 40000));
    assert.equal(await count("detections"), total - 5, "nothing arrives while offline");
    assert.equal(outboxPending(), 5, "offline windows are queued durably on the Pi");
    const interrupted = (await db.query("SELECT state FROM brtc.uploads")).rows[0].state;
    assert.notEqual(interrupted, "AVAILABLE");
    // 3. Network restored: automatic catch-up.
    mode = "pass";
    await arrives(total, "catch-up after 40 s network loss");
    // 4. API temporary failure (HTTP 503).
    mode = "503";
    total = await append(2, new Date());
    await new Promise((r) => setTimeout(r, 20000));
    assert.equal(outboxPending(), 2);
    mode = "pass";
    await arrives(total, "catch-up after 20 s of HTTP 503");
    // 5. Pi reboot: agent killed mid-transfer; outbox survives.
    await stop(agent);
    total = await append(2, new Date());
    startAgent();
    await arrives(total, "catch-up after agent restart (reboot)");
    // 6. Backend restart: new process, same database.
    await stop(backend);
    total = await append(2, new Date());
    target = await startBackend();
    await arrives(total, "catch-up after backend restart");
    // 7–9. Resumed BRTC upload completes and is verified.
    t0 = Date.now();
    await until(async () => (await db!.query("SELECT u.state FROM brtc.uploads u WHERE u.active")).rows[0]?.state === "AVAILABLE", "verified recording", 300);
    timings["remaining audio transfer + verification after restarts"] = (Date.now() - t0) / 1000;
    assert.equal(Number((await db.query("SELECT COUNT(*) n FROM brtc.uploads")).rows[0].n), 1, "one upload, resumed, not restarted");
    assert.deepEqual((await db.query(`SELECT idx,generation,ack FROM brtc.presence WHERE idx=${chunkZero[0].idx}`)).rows, [chunkZero[0]], "the durable chunk was not re-sent");
    const status = (await db.query("SELECT j.state job,c.sha256,c.actual_byte_length FROM brtc.uploads u JOIN brtc.verification_jobs j ON j.upload_id=u.id JOIN brtc.canonical_assets c ON c.asset_id=u.asset_id")).rows[0];
    assert.equal(status.job, "SUCCEEDED");
    assert.equal(status.sha256, hash(original));
    const recording = (await db.query("SELECT id FROM recordings WHERE device_id=$1", [device])).rows[0].id as string;
    const view = await (await api(`/recordings/${device}/${recording}`, { headers: auth })).json();
    assert.equal(view.status, "available"); assert.equal(view.transfer, "available");
    // 11. Full recording playback is the original, byte for byte.
    const full = Buffer.from(await (await api(`/recordings/${device}/${recording}/audio`, { headers: auth })).arrayBuffer());
    assert.equal(hash(full), hash(original));
    // 10. Detection playback: exactly the classifier window, cut on request.
    await until(async () => (await count("detection_audio_windows")) >= 200, "audio windows");
    for (const window of [0, 1, 137, 199]) {
      const id = "pi_d_" + hash(`${device}\0${session}\0${window}`);
      const clip = await api(`/detections/${device}/${id}/audio`, { headers: auth });
      assert.equal(clip.status, 200);
      const body = Buffer.from(await clip.arrayBuffer());
      assert.equal(body.length, 44 + 96000);
      assert(body.subarray(44).equals(pcm.subarray(window * 96000, (window + 1) * 96000)), `window ${window} is its own 3 s`);
    }
    // 12. Idempotency: every window stored once; a resend is acknowledged as already present.
    assert.equal(await count("detections"), next);
    assert.equal(await count("readings"), next);
    const firstId = "pi_d_" + hash(`${device}\0${session}\0${0}`);
    const stored = (await db.query("SELECT data FROM detections WHERE device_id=$1 AND id=$2", [device, firstId])).rows[0].data;
    const resend = await (await api("/edge/batch", { method: "POST", headers: { "X-Device-Key": registered.key, "Content-Type": "application/json" }, body: JSON.stringify({ detections: [stored] }) })).json();
    assert.deepEqual(resend.alreadyPresent.detections, [firstId]);
    // 13–14. Stale heartbeat: monitoring becomes Unknown, never Paused.
    const live = (await (await api("/devices", { headers: auth })).json()).find((d: { id: string }) => d.id === device);
    assert.equal(live.monitoring.current, "active");
    await stop(agent);
    await db.query("UPDATE devices SET last_seen=NOW()-interval '10 minutes',health_at=NOW()-interval '10 minutes' WHERE id=$1", [device]);
    const stale = (await (await api("/devices", { headers: auth })).json()).find((d: { id: string }) => d.id === device);
    assert.equal(stale.monitoring.current, "unknown");
    assert.equal(stale.monitoring.lastReported, "active");
    // Protected source: the Pi WAV is unchanged and no clip files were written anywhere.
    assert.equal(hash(await readFile(wavPath)), hash(original));
    assert.deepEqual(await readdir(join(run, "audio")), [`audio_${stamp}_part00000.wav`]);
    const stored_assets = execFileSync("find", [join(dir, "assets"), "-type", "f", "-name", "*.wav"]).toString().trim().split("\n");
    assert.equal(stored_assets.filter((p) => p.includes("/canonical/")).length, 1, "one canonical WAV, no 3-second files");
    console.log("PIPELINE_TIMINGS " + JSON.stringify(timings, null, 1));
  } catch (error) {
    console.log("AGENT LOG\n" + agentLog.split("\n").slice(-80).join("\n"));
    throw error;
  } finally {
    await stop(agent);
    await stop(backend);
    proxy.close();
    await db?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); // only the UUID-named database above
    await admin.end();
    await rm(dir, { recursive: true, force: true }); // only the mkdtemp folder above
  }
});
