import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createApp } from "./app";
import { openDatabase } from "./database";
import { piDetectionId, windowMismatch, type VerifiedSource } from "./services/audio-windows";

test("Pi detection identity matches the controlled Phase 2 observation", () => {
  assert.equal(
    piDetectionId("9abc7f8e-da43-4515-9ce1-a01a89bb14b4", "20261013T191246Z", 71),
    "pi_d_c463fe8d43d05ba4df2c2eeaaa5f607e5196fac7d86d254648713ea89dabe930",
  );
});

test("audio windows must fit the verified recording", () => {
  const source = {
    sample_rate_hz: 16000, frame_count: "9004000", part: "1", session_reference: "S1",
  } as VerifiedSource;
  const ok = { sessionId: "S1", windowIndex: 71, startFrame: 3408000, frameCount: 48000 };
  assert.equal(windowMismatch(ok, source), null);
  assert.match(windowMismatch({ ...ok, sessionId: "S2" }, source) ?? "", /session/);
  assert.match(windowMismatch({ ...ok, frameCount: 144000 }, source) ?? "", /3 seconds/);
  assert.match(windowMismatch({ ...ok, startFrame: 3408000 + 16000 }, source) ?? "", /index/);
  assert.match(windowMismatch({ ...ok, windowIndex: 187, startFrame: 187 * 48000 }, source) ?? "", /outside/);
  // Later recorder parts start mid-session, so only the bounds can be checked.
  assert.equal(windowMismatch({ ...ok, startFrame: 0 }, { ...source, part: "2" }), null);
});

test("edge batch stores audio windows idempotently and proves their identity", async () => {
  const schema = "beehave_test_" + randomUUID().replaceAll("-", "");
  const administrator = openDatabase();
  await administrator.execute(`CREATE SCHEMA ${schema}`);
  const { app, db } = await createApp(schema);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/api`;
  const call = (path: string, method: string, body: unknown, headers: Record<string, string>) =>
    fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    const registered = await call("/auth/register", "POST", {
      name: "Window tester", farm: "Window farm", email: "windows@example.com",
      password: "a-strong-test-password", platform: "native",
    }, {}).then((r) => r.json());
    const user = { Authorization: `Bearer ${registered.token}` };
    const created = await call("/devices", "POST", { name: "Pi", location: "Hive" }, user).then((r) => r.json());
    const device = { id: created.device.id as string };
    const edge = { "X-Device-Key": created.key as string };
    const detectionId = piDetectionId(device.id, "S1", 71);
    const observedAt = new Date(Date.now() - 60000).toISOString();
    const window = { detectionId, recordingId: "rec-1", sessionId: "S1", windowIndex: 71, startFrame: 3408000, frameCount: 48000 };
    const records = {
      recordings: [{ id: "rec-1", observedAt, duration: 562.75, filename: "audio_part00000.wav" }],
      detections: [{
        id: detectionId, observedAt, species: "Bee", frequency: 144.53125, confidence: 0.55,
        recordingId: "rec-1", modelVersion: "model-a",
      }],
    };
    assert.equal((await call("/edge/batch", "POST", { audioWindows: [window] }, edge)).status, 409, "detection must exist first");
    const first = await call("/edge/batch", "POST", { ...records, audioWindows: [window] }, edge);
    assert.equal(first.status, 200, await first.clone().text());
    assert.equal((await first.json()).accepted.audioWindows, 1);
    assert.equal((await call("/edge/batch", "POST", { audioWindows: [window] }, edge)).status, 200, "identical retry");
    assert.equal(
      (await call("/edge/batch", "POST", { audioWindows: [{ ...window, startFrame: 3408001 }] }, edge)).status,
      409, "stable window cannot be overwritten",
    );
    assert.equal(
      (await call("/edge/batch", "POST", { audioWindows: [{ ...window, windowIndex: 72 }] }, edge)).status,
      400, "window index must reproduce the detection ID",
    );
    assert.equal(
      (await call("/edge/batch", "POST", { audioWindows: [{ ...window, recordingId: "rec-2" }] }, edge)).status,
      400, "window must use the detection's own recording",
    );
    assert.equal(
      (await call("/edge/batch", "POST", { audioWindows: [{ ...window, frameCount: 47999 }] }, edge)).status,
      400, "window must be whole 3-second frames",
    );
    const rows = await db.many("SELECT * FROM detection_audio_windows");
    assert.equal(rows.length, 1);
    const detail = await call(`/detections/${device.id}/${detectionId}`, "GET", undefined, user).then((r) => r.json());
    assert.deepEqual(detail.audioWindow, { windowIndex: 71, startFrame: 3408000, frameCount: 48000 });
    assert.equal(detail.species, "Bee", "detection itself is unchanged");
    assert.equal((await call(`/detections/${device.id}/${detectionId}/audio`, "GET", undefined, {})).status, 401);
    // Without a verified canonical original the window is never served.
    assert.equal((await call(`/detections/${device.id}/${detectionId}/audio`, "GET", undefined, user)).status, 404);

    // A Non-Bee classifier window is listed and filterable, but is not a Bee-positive detection.
    const nonBeeId = piDetectionId(device.id, "S1", 72);
    const nonBee = {
      id: nonBeeId, observedAt, species: "Non-Bee", frequency: 140.6, confidence: 0.01,
      recordingId: "rec-1", modelVersion: "model-a",
    };
    assert.equal((await call("/edge/batch", "POST", { detections: [nonBee] }, edge)).status, 200);
    const day = (offset: number) => new Date(Date.now() + 8 * 3600000 + offset * 86400000).toISOString().slice(0, 10);
    const range = `from=${day(-2)}&to=${day(1)}&device=${device.id}`;
    const summary = await call(`/summary?${range}`, "GET", undefined, user).then((r) => r.json());
    assert.equal(summary.total, 1, "summary counts Bee-positive detections only");
    assert.deepEqual(summary.recent.map((d: { id: string }) => d.id), [detectionId]);
    assert.equal(summary.daily.reduce((n: number, d: { count: number }) => n + d.count, 0), 1);
    const all = await call(`/detections?${range}`, "GET", undefined, user).then((r) => r.json());
    assert.equal(all.total, 2, "All lists both classifier results");
    const onlyNonBee = await call(`/detections?${range}&species=Non-Bee`, "GET", undefined, user).then((r) => r.json());
    assert.deepEqual(onlyNonBee.items.map((d: { id: string }) => d.id), [nonBeeId]);
    const onlyBee = await call(`/detections?${range}&species=Bee`, "GET", undefined, user).then((r) => r.json());
    assert.deepEqual(onlyBee.items.map((d: { id: string }) => d.id), [detectionId]);
    const recording = await call(`/recordings/${device.id}/rec-1`, "GET", undefined, user).then((r) => r.json());
    assert.deepEqual(recording.detectionIds, [detectionId], "linked detections stay Bee-positive");
  } finally {
    server.close();
    await db.close();
    await administrator.execute(`DROP SCHEMA ${schema} CASCADE`);
    await administrator.close();
  }
});
