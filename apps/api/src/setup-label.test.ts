import { withFarm } from "@beehave/shared";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createApp } from "./app";
import { openDatabase } from "./database";

test("the device shares its setup label, sealed, and only its farm's owners can read it", async () => {
  const schema = "beehave_test_" + randomUUID().replaceAll("-", "");
  const administrator = openDatabase();
  await administrator.execute(`CREATE SCHEMA ${schema}`);
  const { app, db } = await createApp(schema);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/api`;
  const request = (path: string, init: { method?: string; body?: unknown; token?: string; key?: string } = {}) =>
    fetch(base + path, {
      method: init.method ?? (init.body ? "POST" : "GET"),
      headers: {
        "Content-Type": "application/json",
        ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
        ...(init.key ? { "X-Device-Key": init.key } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
  const register = async (email: string) => {
    const session = await (
      await request("/auth/register", { body: { name: "Person", farm: email, email, password: "strong-test-password", platform: "native" } })
    ).json();
    return { token: session.token as string, id: session.account.id as string, farm: session.account.farmId as string };
  };
  try {
    const owner = await register("owner@example.com");
    const other = await register("other@example.com");
    const viewer = await register("viewer@example.com");
    await db.execute("INSERT INTO farm_members (farm_id, account_id, role) VALUES($1,$2,'viewer')", [owner.farm, viewer.id]);
    const registered = await (await request(withFarm("/devices", owner.farm), { body: { name: "Pi", location: "Hive" }, token: owner.token })).json();
    const id = registered.device.id as string, key = registered.key as string;
    const read = (token: string) => request(withFarm(`/devices/${id}/setup-label`, owner.farm), { token });

    // Nothing shared yet: owners are told the device will share it.
    const missing = await read(owner.token);
    assert.equal(missing.status, 404);
    assert.match((await missing.json()).error, /not shared its setup label yet/);

    const label = { hotspot: "BeeHave-01-Setup", hotspotPassword: "0123456789abcdef01234567", code: "c".repeat(32) };
    const share = (body: unknown, deviceKey = key) => request("/edge/setup-label", { method: "PUT", body, key: deviceKey });
    assert.equal((await share({ ...label, extra: "x" })).status, 400);
    assert.equal((await share({ ...label, code: "" })).status, 400);
    assert.equal((await share(label, "wrong-key")).status, 401);
    assert.equal((await share(label)).status, 200);

    // Stored sealed: the database holds none of the secrets.
    const [row] = await db.many<{ sealed: string }>("SELECT sealed FROM device_setup_labels WHERE device_id=$1", [id]);
    for (const secret of Object.values(label)) assert(!row.sealed.includes(secret));

    const shown = await read(owner.token);
    assert.equal(shown.status, 200);
    const body = await shown.json();
    assert.deepEqual({ hotspot: body.hotspot, hotspotPassword: body.hotspotPassword, code: body.code }, label);
    assert.ok(Date.parse(body.updatedAt));

    // A changed label replaces the old one.
    assert.equal((await share({ ...label, hotspotPassword: "fedcba9876543210fedcba98" })).status, 200);
    assert.equal((await (await read(owner.token)).json()).hotspotPassword, "fedcba9876543210fedcba98");

    // Viewers cannot read it; other farms cannot even see the device.
    assert.equal((await read(viewer.token)).status, 403);
    assert.equal((await request(`/devices/${id}/setup-label`, { token: other.token })).status, 404);
    assert.equal((await request(withFarm(`/devices/${id}/setup-label`, other.farm), { token: other.token })).status, 404);

    // Still readable after the device is disconnected (e.g. to re-pair it), but it can no longer update it.
    assert.equal((await request(`/devices/${id}/unpair`, { body: { confirm: true }, token: owner.token })).status, 200);
    assert.equal((await read(owner.token)).status, 200);
    assert.equal((await share(label)).status, 401);
  } finally {
    server.close();
    await db.close();
    await administrator.execute(`DROP SCHEMA ${schema} CASCADE`);
    await administrator.close();
  }
});
