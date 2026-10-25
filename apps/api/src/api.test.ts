import { manilaDate } from "@beehave/shared";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createApp } from "./app";
import { openDatabase } from "./database";
import { canonicalTimestamp } from "./timestamp";

test("private database monitoring flow, ingestion integrity, audio and sessions", async () => {
  const schema = "beehave_test_" + randomUUID().replaceAll("-", "");
  const administrator = openDatabase();
  await administrator.execute(`CREATE SCHEMA ${schema}`);
  const { app, db } = await createApp(schema);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/api`;
  async function request(
    path: string,
    method = "GET",
    body?: unknown,
    token?: string,
    extra: Record<string, string> = {},
  ) {
    return fetch(base + path, {
      method,
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...extra,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  }
  try {
    assert.equal((await request("/devices")).status, 401);
    const registration = await request("/auth/register", "POST", {
      name: "Test farmer",
      farm: "Test farm",
      email: "test@example.com",
      password: "a-strong-test-password",
      platform: "native",
    });
    assert.equal(registration.status, 200);
    const registered = await registration.json();
    const token = registered.token as string;
    assert(token);
    assert.match(registration.headers.get("set-cookie") ?? "", /HttpOnly/);
    const me = await fetch(base + "/auth/me", {
      headers: {
        Cookie: (registration.headers.get("set-cookie") ?? "").split(";")[0],
      },
    });
    assert.equal(me.status, 200, "browser cookie restores session");
    assert.equal(
      (await request("/devices", "GET", undefined, token).then((r) => r.json()))
        .length,
      0,
    );
    const device = await request(
      "/devices",
      "POST",
      { name: "Station 01", location: "Quezon" },
      token,
    ).then((r) => r.json());
    assert(device.key);
    const deviceHeaders = { "X-Device-Key": device.key };
    const now = new Date();
    const at = now.toISOString().replace(/Z$/, "287Z");
    const batch = {
      readings: [
        {
          id: "env-01",
          observedAt: new Date(now.getTime() - 4000).toISOString().replace(/Z$/, "123Z"),
          temperature: 30.4,
          humidity: 71,
        },
      ],
      recordings: [
        {
          id: "rec-01",
          observedAt: at,
          duration: 1,
          filename: "rec.wav",
          status: "pending",
        },
      ],
      detections: [
        {
          id: "event-01",
          observedAt: at,
          species: "T. biroi",
          frequency: 201,
          confidence: 0.98,
          readingId: "env-01",
          recordingId: "rec-01",
          modelVersion: "test-v1",
        },
      ],
    };
    // PostgreSQL accepts concurrent retries of a new stable ID exactly once.
    const simultaneousUploads = await Promise.all(
      Array.from({ length: 3 }, () =>
        request("/edge/batch", "POST", batch, undefined, deviceHeaders),
      ),
    );
    assert.deepEqual(
      simultaneousUploads.map((response) => response.status),
      [200, 200, 200],
    );
    // Each reply confirms every submitted ID: stored once, already present otherwise.
    const replies = await Promise.all(simultaneousUploads.map((response) => response.json()));
    assert.deepEqual(
      replies.map((reply) => [...reply.stored.detections, ...reply.alreadyPresent.detections]),
      [["event-01"], ["event-01"], ["event-01"]],
    );
    assert.equal(replies.filter((reply) => reply.stored.detections.length).length, 1);
    const retry = await request("/edge/batch", "POST", batch, undefined, deviceHeaders);
    assert.equal(retry.status, 200, "identical retries are accepted");
    assert.deepEqual(await retry.json().then((reply) => [reply.stored, reply.alreadyPresent]), [
      { readings: [], recordings: [], detections: [], audioWindows: [] },
      { readings: ["env-01"], recordings: ["rec-01"], detections: ["event-01"], audioWindows: [] },
    ]);
    const list = await request("/detections", "GET", undefined, token).then(
      (r) => r.json(),
    );
    assert.equal(list.total, 1);
    assert.equal(list.items[0].observedAt, at);
    assert.equal(list.items[0].reading.observedAt, batch.readings[0].observedAt);
    assert.equal(list.items[0].recording.observedAt, at);
    assert.equal(Date.parse(at), now.getTime(), "existing JS date parsing remains compatible");
    for (const [table, expected] of [
      ["readings", batch.readings[0].observedAt],
      ["detections", at],
      ["recordings", at],
    ]) {
      const stored = await db.one(`SELECT observed_at, data, COUNT(*) OVER()::integer AS count,
        to_char(observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS precise
        FROM ${table} WHERE device_id=$1`, [device.device.id]);
      assert.equal(stored?.count, 1);
      assert.equal(stored?.observed_at, expected);
      assert.equal(stored?.precise, expected);
      assert.equal(stored?.data.observedAt, expected);
    }
    const offsetRetry = structuredClone(batch);
    for (const item of [...offsetRetry.readings, ...offsetRetry.detections, ...offsetRetry.recordings])
      item.observedAt = item.observedAt.replace("Z", "0+00:00");
    assert.equal((await request("/edge/batch", "POST", offsetRetry, undefined, deviceHeaders)).status, 200);
    for (const query of [
      "species=T.%20biroi",
      `device=${device.device.id}&species=T.%20biroi`,
    ]) {
      const filtered = await request(
        `/detections?${query}`,
        "GET",
        undefined,
        token,
      ).then((response) => response.json());
      assert.equal(
        filtered.total,
        1,
        "species and device filters use the correct SQL parameters",
      );
    }
    const nonmatching = await request(
      "/detections?species=Other",
      "GET",
      undefined,
      token,
    ).then((response) => response.json());
    assert.equal(nonmatching.total, 0);

    assert.equal(list.items[0].reading.temperature, 30.4);
    assert.notEqual(list.items[0].reading.observedAt, list.items[0].observedAt);
    assert.equal(list.items[0].recording.status, "pending");
    const summary = await request("/summary", "GET", undefined, token).then(
      (r) => r.json(),
    );
    assert.equal(summary.total, 1);
    assert.equal(summary.averageFrequency, 201);
    assert.equal(summary.daily[0].date, manilaDate());
    assert.equal(
      summary.hourly.reduce(
        (n: number, h: { count: number }) => n + h.count,
        0,
      ),
      1,
    );
    assert.equal(summary.resolution, "hour");
    assert.equal(summary.series.length, 24);
    assert.equal(
      summary.series.reduce((n: number, p: { count: number | null }) => n + (p.count ?? 0), 0),
      1,
      "the chart series aggregates the same Bee detections as the totals",
    );
    assert.deepEqual(
      summary.series.flatMap((p: { frequency: number | null }) => (p.frequency === null ? [] : [p.frequency])),
      [201],
      "the chart series carries the detection's acoustic frequency in Hz",
    );
    assert.equal(summary.peakVisitation.count, 1);
    assert.equal(new Date(summary.peakVisitation.start).getUTCMinutes(), 0);
    assert.ok(summary.visitationFrequency > 0 && summary.visitationFrequency <= 1);
    const conflict = structuredClone(batch);
    conflict.detections[0].frequency = 400;
    assert.equal(
      (await request("/edge/batch", "POST", conflict, undefined, deviceHeaders))
        .status,
      409,
    );
    const invalid = structuredClone(batch);
    invalid.detections[0].id = "event-02";
    invalid.detections[0].observedAt = new Date(
      now.getTime() - 120000,
    ).toISOString();
    assert.equal(
      (await request("/edge/batch", "POST", invalid, undefined, deviceHeaders))
        .status,
      400,
    );
    assert.equal(
      (
        await request("/detections", "GET", undefined, token).then((r) =>
          r.json(),
        )
      ).total,
      1,
      "invalid transaction rolled back",
    );
    // A reading that arrives after its detection is checked against that stored detection too.
    const early = structuredClone(batch);
    early.readings = [];
    early.recordings = [];
    early.detections[0].id = "event-03";
    early.detections[0].readingId = "env-03";
    assert.equal((await request("/edge/batch", "POST", early, undefined, deviceHeaders)).status, 200);
    const late = { readings: [{ ...batch.readings[0], id: "env-03", observedAt: new Date(now.getTime() - 120000).toISOString() }] };
    assert.equal((await request("/edge/batch", "POST", late, undefined, deviceHeaders)).status, 400);
    await db.execute("DELETE FROM detections WHERE device_id=$1 AND id='event-03'", [device.device.id]);
    assert.equal(
      (
        await request(
          `/recordings/${device.device.id}/rec-01/audio`,
          "GET",
          undefined,
          token,
        )
      ).status,
      404,
    );
    const wav = Buffer.alloc(100);
    wav.write("RIFF");
    wav.writeUInt32LE(92, 4);
    wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(8000, 24);
    wav.writeUInt32LE(16000, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write("data", 36);
    wav.writeUInt32LE(56, 40);
    const upload = () =>
      fetch(base + "/edge/recordings/rec-01/audio", {
        method: "PUT",
        headers: { ...deviceHeaders, "Content-Type": "audio/wav" },
        body: wav,
      });
    assert.equal((await upload()).status, 200);
    assert.equal((await upload()).status, 200);
    assert.equal(
      (await request("/edge/batch", "POST", batch, undefined, deviceHeaders))
        .status,
      200,
      "metadata retry after upload preserves audio",
    );
    const audio = await request(
      `/recordings/${device.device.id}/rec-01/audio`,
      "GET",
      undefined,
      token,
      { Range: "bytes=0-43" },
    );
    assert.equal(audio.status, 206);
    assert.equal((await audio.arrayBuffer()).byteLength, 44);
    assert.equal(
      (
        await request(
          `/recordings/${device.device.id}/rec-01`,
          "DELETE",
          undefined,
          token,
        )
      ).status,
      404,
      "no user deletion endpoint",
    );
    // Sign-up no longer asks for a farm, and none is created: the account creates or joins one later.
    const second = await request("/auth/register", "POST", {
      name: "Other farmer",
      email: "other@example.com",
      password: "a-strong-test-password",
      platform: "native",
    }).then((r) => r.json());
    assert.equal(second.account.farm, "");
    assert.deepEqual(second.account.farms, []);
    assert.equal(
      (
        await request(
          `/detections/${device.device.id}/event-01`,
          "GET",
          undefined,
          second.token,
        )
      ).status,
      404,
    );
    // Without a farm there is nothing to list.
    assert.equal(
      (await request("/detections", "GET", undefined, second.token)).status,
      404,
    );
    assert.equal(
      (
        await request(
          `/recordings/${device.device.id}/rec-01/audio`,
          "GET",
          undefined,
          second.token,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await request("/edge/batch", "POST", batch, undefined, {
          "X-Device-Key": "wrong",
        })
      ).status,
      401,
    );
    const csv = await request("/export", "GET", undefined, token).then((r) =>
      r.text(),
    );
    assert.match(csv, /sensor_timestamp_utc/);
    assert.match(csv, /event-01/);
    assert.equal(
      (
        await request(
          "/auth/password",
          "POST",
          {
            currentPassword: "a-strong-test-password",
            password: "a-new-strong-test-password",
          },
          token,
        )
      ).status,
      200,
    );
    assert.equal(
      (await request("/auth/me", "GET", undefined, token)).status,
      401,
    );
    assert.equal(
      (
        await request("/auth/login", "POST", {
          email: "test@example.com",
          password: "a-strong-test-password",
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await request("/auth/login", "POST", {
          email: "test@example.com",
          password: "a-new-strong-test-password",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request(
          "/auth/login",
          "POST",
          { email: "test@example.com", password: "a-new-strong-test-password" },
          undefined,
          { Origin: "https://untrusted.example" },
        )
      ).status,
      403,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await db.close();
    await administrator.execute(`DROP SCHEMA ${schema} CASCADE`);
    await administrator.close();
  }
});

test("canonical timestamps retain fractional precision across timezones", () => {
  assert.equal(canonicalTimestamp("2026-10-19T10:23:27.001884+08:00"), "2026-10-19T02:23:27.001884Z");
  assert.equal(canonicalTimestamp("2026-10-19T02:23:27.001000+00:00"), "2026-10-19T02:23:27.001Z");
  assert.equal(canonicalTimestamp("2026-10-19T02:23:27+00:00"), "2026-10-19T02:23:27.000Z");
});
