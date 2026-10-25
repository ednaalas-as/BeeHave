import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createApp } from "./app";
import { openDatabase } from "./database";

test("disconnect revokes access; history and audio survive; deletion requires no references", async () => {
  const schema = "beehave_test_" + randomUUID().replaceAll("-", "");
  const admin = openDatabase();
  await admin.execute(`CREATE SCHEMA ${schema}`);
  const { app, db } = await createApp(schema);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/api`;
  const request = (
    endpoint: string,
    body?: unknown,
    token?: string,
    key?: string,
  ) =>
    fetch(base + endpoint, {
      method: body ? "POST" : "GET",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(key ? { "X-Device-Key": key } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  const user = async (email: string) =>
    (
      await (
        await request("/auth/register", {
          name: "Owner",
          farm: email,
          email,
          password: "strong-test-password",
          platform: "native",
        })
      ).json()
    ).token as string;
  try {
    const owner = await user("owner@example.com"),
      other = await user("other@example.com");
    const register = async () =>
      await (
        await request(
          "/devices",
          { name: "Test Pi", location: "Test hive" },
          owner,
        )
      ).json();
    const record = await register(),
      id = record.device.id;
    const action = (name: string, token = owner, confirm = true) =>
      request(`/devices/${id}/${name}`, { confirm }, token);
    assert.equal((await action("delete")).status, 409);
    assert.equal((await action("unpair", other)).status, 404);
    assert.equal((await action("unpair", owner, false)).status, 400);
    const at = new Date().toISOString();
    await db.execute(
      "INSERT INTO readings(id,device_id,observed_at,data) VALUES('r',$1,$2,$3)",
      [
        id,
        at,
        JSON.stringify({
          id: "r",
          observedAt: at,
          temperature: 28,
          humidity: 60,
        }),
      ],
    );
    await db.execute(
      "INSERT INTO recordings(id,device_id,observed_at,data,audio) VALUES('a',$1,$2,$3,$4)",
      [
        id,
        at,
        JSON.stringify({
          id: "a",
          observedAt: at,
          duration: 1,
          filename: "test.wav",
          status: "available",
        }),
        Buffer.from("synthetic audio fixture"),
      ],
    );
    await db.execute(
      "INSERT INTO detections(id,device_id,observed_at,data) VALUES('d',$1,$2,$3)",
      [
        id,
        at,
        JSON.stringify({
          id: "d",
          observedAt: at,
          readingId: "r",
          recordingId: "a",
        }),
      ],
    );
    const snapshot = async () =>
      Promise.all(
        ["readings", "recordings", "detections"].map((table) =>
          db.many(`SELECT * FROM ${table} WHERE device_id=$1`, [id]),
        ),
      );
    const before = await snapshot();
    assert.equal((await action("unpair")).status, 200);
    assert.equal((await action("unpair")).status, 200);
    assert.equal(
      (await request("/edge/batch", {}, undefined, record.key)).status,
      401,
    );
    assert.equal((await action("delete")).status, 409);
    assert.deepEqual(await snapshot(), before);
    const list = await (await request("/devices", undefined, owner)).json();
    assert(list[0].disconnectedAt);
    const audio = await request(`/recordings/${id}/a/audio`, undefined, owner);
    assert.equal(audio.status, 200);
    assert.equal(await audio.text(), "synthetic audio fixture");
    assert.equal(
      (await request(`/recordings/${id}/a/audio`, undefined, other)).status,
      404,
    );
    // Each reference type independently blocks deletion, including sensor-only history.
    for (const table of ["readings", "recordings", "detections"]) {
      const one = await register();
      await db.execute(
        `INSERT INTO ${table}(id,device_id,observed_at,data) VALUES('only',$1,$2,'{}')`,
        [one.device.id, at],
      );
      await request(
        `/devices/${one.device.id}/unpair`,
        { confirm: true },
        owner,
      );
      assert.equal(
        (
          await request(
            `/devices/${one.device.id}/delete`,
            { confirm: true },
            owner,
          )
        ).status,
        409,
      );
    }
    const empty = await register();
    await request(
      `/devices/${empty.device.id}/unpair`,
      { confirm: true },
      owner,
    );
    assert.equal(
      (
        await request(
          `/devices/${empty.device.id}/delete`,
          { confirm: true },
          owner,
        )
      ).status,
      200,
    );
    assert.equal(
      await db.one("SELECT id FROM devices WHERE id=$1", [empty.device.id]),
      undefined,
    );
    assert.deepEqual(await snapshot(), before);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
    await admin.execute(`DROP SCHEMA ${schema} CASCADE`);
    await admin.close();
  }
});
