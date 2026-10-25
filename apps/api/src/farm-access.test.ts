import { manilaDate, withFarm } from "@beehave/shared";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createApp } from "./app";
import { hashCode, hashToken } from "./auth";
import { openDatabase } from "./database";

test("farm memberships decide which farm, device and controls an account reaches", async () => {
  const schema = "beehave_test_" + randomUUID().replaceAll("-", "");
  const administrator = openDatabase();
  await administrator.execute(`CREATE SCHEMA ${schema}`);
  const { app, db } = await createApp(schema);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/api`;
  const request = (path: string, body?: unknown, token?: string, key?: string) =>
    fetch(base + path, {
      method: body ? "POST" : "GET",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(key ? { "X-Device-Key": key } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  const json = async (path: string, token: string) => {
    const response = await request(path, undefined, token);
    assert.equal(response.status, 200, `${path} → ${response.status}`);
    return response.json();
  };
  const register = async (email: string, farm: string) => {
    const session = await (
      await request("/auth/register", { name: email.split("@")[0], farm, email, password: "strong-test-password", platform: "native" })
    ).json();
    return { token: session.token as string, id: session.account.id as string, farm: session.account.farmId as string };
  };
  const health = {
    collecting: true, cpu: 4, ram: 20, cpuTemperature: 45, storageUsed: 8, storageTotal: 32, queued: 0,
    microphone: true, sensor: true, softwareVersion: "agent test", ipAddress: "192.168.1.29", wifiNetwork: "farm-wifi",
    network: { method: "wifi", setupMode: false, ssid: "farm-wifi", signal: 72, ipAddress: "192.168.1.29", internet: "full", saved: [] },
  };
  const at = new Date().toISOString();
  const event = (id: string) => ({ id, observedAt: at, species: "T. biroi", frequency: 201, confidence: 0.98, readingId: `env-${id}`, recordingId: `rec-${id}`, modelVersion: "test-v1" });
  const upload = (key: string, ids: string[]) =>
    request("/edge/batch", {
      health,
      readings: ids.map((id) => ({ id: `env-${id}`, observedAt: at, temperature: 30, humidity: 70 })),
      recordings: ids.map((id) => ({ id: `rec-${id}`, observedAt: at, duration: 1, filename: `${id}.wav`, status: "pending" })),
      detections: ids.map(event),
    }, undefined, key);
  try {
    const a = await register("owner-a@example.com", "Farm A");
    const b = await register("owner-b@example.com", "Farm B");
    const v = await register("viewer@example.com", "Viewer's own farm");
    assert.notEqual(a.farm, b.farm);
    // A new account belongs to its own farm only.
    assert.deepEqual((await json("/farms", v.token)).map((farm: { id: string; role: string }) => [farm.id, farm.role]), [[v.farm, "owner"]]);

    const deviceA = await (await request(withFarm("/devices", a.farm), { name: "A station", location: "Hive A" }, a.token)).json();
    const deviceB = await (await request(withFarm("/devices", b.farm), { name: "B station", location: "Hive B" }, b.token)).json();
    const idA = deviceA.device.id as string, idB = deviceB.device.id as string;
    assert.equal((await upload(deviceA.key, ["a-1"])).status, 200);
    assert.equal((await upload(deviceB.key, ["b-1", "b-2"])).status, 200);
    const today = manilaDate();
    const summary = (farm: string, token: string, device = "") =>
      json(withFarm(`/summary?from=${today}&to=${today}&device=${device}`, farm), token);

    // Owner reaches its own farm, devices, controls and network details.
    const [ownedA] = await json(withFarm("/devices", a.farm), a.token);
    assert.equal(ownedA.access, "administrator");
    assert.equal(ownedA.health.network.ssid, "farm-wifi");
    assert.equal((await summary(a.farm, a.token)).total, 1);
    assert.equal((await request(`/devices/${idA}/commands`, undefined, a.token)).status, 200);
    // Clients that send no farm keep their own farm.
    assert.equal((await json("/devices", a.token))[0].id, idA);

    // Another farm is invisible: unknown and inaccessible farms answer alike.
    const hidden = await request(withFarm("/summary", a.farm), undefined, b.token);
    const unknown = await request(withFarm("/summary", "no-such-farm"), undefined, b.token);
    assert.equal(hidden.status, 404);
    assert.equal(unknown.status, 404);
    assert.deepEqual(await hidden.json(), await unknown.json());
    for (const path of ["/devices", "/detections", "/recordings", "/export", ""])
      assert.equal((await request(withFarm(path || `/farms/${a.farm}`, path ? a.farm : undefined), undefined, b.token)).status, 404, path);
    // Editing a device ID never reaches another farm's device, with or without a farm selected.
    for (const path of [
      `/detections/${idA}/a-1`, `/detections/${idA}/a-1/audio`, `/recordings/${idA}/rec-a-1`, `/recordings/${idA}/rec-a-1/audio`,
      `/devices/${idA}/commands`,
    ]) {
      assert.equal((await request(path, undefined, b.token)).status, 404, path);
      assert.equal((await request(withFarm(path, b.farm), undefined, b.token)).status, 404, path);
    }
    assert.equal((await request(withFarm(`/summary?device=${idA}`, b.farm), undefined, b.token)).status, 404);
    assert.equal((await request(withFarm(`/detections?device=${idA}`, b.farm), undefined, b.token)).status, 404);
    assert.equal((await request(`/devices/${idA}/commands`, { action: "reboot", confirm: true }, b.token)).status, 404);
    assert.equal((await request(`/devices/${idA}/unpair`, { confirm: true }, b.token)).status, 404);
    // Owner's own device under the wrong selected farm is refused too.
    assert.equal((await request(withFarm(`/detections/${idA}/a-1`, v.farm), undefined, a.token)).status, 404);

    // Access is granted only to an existing account.
    const missing = await request(`/farms/${a.farm}/members`, { email: "nobody@example.com" }, a.token);
    assert.equal(missing.status, 404);
    assert.match((await missing.json()).error, /create a BeeHave account first/);
    assert.equal((await request(`/farms/${a.farm}/members`, { email: "sample@beehave.local" }, a.token)).status, 404);
    const added = await request(`/farms/${a.farm}/members`, { email: "Viewer@Example.com" }, a.token);
    assert.equal(added.status, 201);
    assert.equal((await added.json()).role, "viewer");
    assert.equal((await request(`/farms/${a.farm}/members`, { email: "viewer@example.com" }, a.token)).status, 409);
    // The viewer now sees both farms; its own farm is still the default.
    const me = (await json("/auth/me", v.token)).account;
    assert.equal(me.farmId, v.farm);
    assert.deepEqual(me.farms.map((farm: { id: string; role: string }) => [farm.id, farm.role]).sort(), [[a.farm, "viewer"], [v.farm, "owner"]].sort());

    // Viewer reads every kind of farm data.
    assert.equal((await summary(a.farm, v.token)).total, 1);
    assert.equal((await summary(a.farm, v.token, idA)).total, 1);
    assert.equal((await json(withFarm("/detections", a.farm), v.token)).total, 1);
    assert.equal((await json(withFarm("/recordings", a.farm), v.token)).total, 1);
    const detection = await json(withFarm(`/detections/${idA}/a-1`, a.farm), v.token);
    assert.equal(detection.frequency, 201);
    assert.equal(detection.reading.temperature, 30);
    assert.equal(detection.reading.humidity, 70);
    assert.equal((await json(withFarm(`/recordings/${idA}/rec-a-1`, a.farm), v.token)).id, "rec-a-1");
    assert.equal((await request(withFarm("/export", a.farm), undefined, v.token)).status, 200);
    // Viewer sees basic status and monitoring, never network details.
    const [viewed] = await json(withFarm("/devices", a.farm), v.token);
    assert.equal(viewed.access, "viewer");
    assert.equal(viewed.health.cpu, 4);
    assert.equal(viewed.health.collecting, true);
    assert.ok(viewed.monitoring && viewed.lastSeen && viewed.lastSync);
    for (const field of ["network", "ipAddress", "wifiNetwork"]) assert.equal(viewed.health[field], undefined, field);
    assert.equal(viewed.setupId, null);
    const viewedSummary = await summary(a.farm, v.token);
    assert.equal(viewedSummary.devices[0].health.network, undefined);
    assert.doesNotMatch(JSON.stringify(viewedSummary), /farm-wifi|192\.168/);
    // Viewer cannot control, read command history, register, pair or manage members — whatever it sends.
    for (const action of ["reboot", "shutdown", "monitoring_stop", "monitoring_start", "monitoring_restart", "network_scan", "wifi_disconnect"])
      assert.equal((await request(withFarm(`/devices/${idA}/commands`, a.farm), { action, confirm: true }, v.token)).status, 403, action);
    assert.equal((await request(withFarm(`/devices/${idA}/commands`, a.farm), undefined, v.token)).status, 403);
    assert.equal((await request(`/devices/${idA}/commands`, undefined, v.token)).status, 403);
    assert.equal((await request(`/devices/${idA}/commands/${randomUUID()}/cancel`, {}, v.token)).status, 403);
    assert.equal((await request(`/devices/${idA}/unpair`, { confirm: true }, v.token)).status, 403);
    assert.equal((await request(`/devices/${idA}/delete`, { confirm: true }, v.token)).status, 403);
    assert.equal((await request(withFarm("/devices", a.farm), { name: "Sneaky", location: "Hive" }, v.token)).status, 403);
    assert.equal((await request(withFarm("/pairing/start", a.farm), {}, v.token)).status, 403);
    assert.equal((await request(withFarm("/pairing/complete", a.farm), {}, v.token)).status, 403);
    assert.equal((await request(`/farms/${a.farm}/members`, { email: "owner-b@example.com" }, v.token)).status, 403);
    assert.equal((await request(`/farms/${a.farm}/members/${v.id}/role`, { role: "owner" }, v.token)).status, 403);
    assert.equal((await request(`/farms/${a.farm}`, { name: "Renamed" }, v.token)).status, 403);
    const viewerProfile = await json(`/farms/${a.farm}`, v.token);
    assert.equal(viewerProfile.members, null);
    assert.deepEqual(viewerProfile.owners, ["owner-a"]);
    assert.deepEqual(viewerProfile.devices, [{ id: idA, name: "A station" }]);

    // Multiple owners: B becomes an owner of farm A as well as its own.
    assert.equal((await request(`/farms/${a.farm}/members`, { email: "owner-b@example.com", role: "owner" }, a.token)).status, 201);
    assert.equal((await request(withFarm(`/devices/${idA}/commands`, a.farm), undefined, b.token)).status, 200);
    assert.equal((await json(withFarm("/devices", a.farm), b.token))[0].health.network.ssid, "farm-wifi");
    // "All devices in this farm" aggregates the selected farm only, even for a member of both.
    assert.equal((await summary(a.farm, b.token)).total, 1);
    assert.equal((await summary(b.farm, b.token)).total, 2);
    assert.deepEqual((await summary(a.farm, b.token)).devices.map((device: { id: string }) => device.id), [idA]);
    const listed = await json(withFarm("/detections", a.farm), b.token);
    assert.deepEqual(listed.items.map((item: { deviceId: string }) => item.deviceId), [idA]);
    assert.equal((await request(withFarm(`/summary?device=${idB}`, a.farm), undefined, b.token)).status, 404);
    assert.equal((await request(withFarm(`/detections/${idB}/b-1`, a.farm), undefined, b.token)).status, 404);
    // Same request path, different farm: the farm is part of every farm-scoped path.
    assert.notEqual(withFarm("/devices", a.farm), withFarm("/devices", b.farm));
    assert.notDeepEqual(await json(withFarm("/devices", a.farm), b.token), await json(withFarm("/devices", b.farm), b.token));

    // A farm always keeps an owner.
    const role = (farm: string, account: string, value: string, token: string) =>
      request(`/farms/${farm}/members/${account}/role`, { role: value }, token);
    const remove = (farm: string, account: string, token: string) =>
      request(`/farms/${farm}/members/${account}/remove`, { confirm: true }, token);
    assert.equal((await role(v.farm, v.id, "viewer", v.token)).status, 409, "sole owner cannot demote itself");
    assert.equal((await remove(v.farm, v.id, v.token)).status, 409, "sole owner cannot leave");
    assert.equal((await role(a.farm, b.id, "viewer", a.token)).status, 200);
    assert.equal((await role(a.farm, a.id, "viewer", a.token)).status, 409, "last owner cannot be demoted");
    assert.equal((await remove(a.farm, a.id, a.token)).status, 409, "last owner cannot leave");
    assert.equal((await role(a.farm, b.id, "owner", a.token)).status, 200);
    assert.equal((await role(a.farm, a.id, "viewer", b.token)).status, 200, "one of two owners can be demoted");
    assert.equal((await role(a.farm, b.id, "viewer", b.token)).status, 409);
    assert.equal((await role(a.farm, a.id, "owner", b.token)).status, 200);
    // A viewer may leave; an owner removes members; the removed account loses the farm at once.
    assert.equal((await remove(a.farm, v.id, v.token)).status, 200);
    assert.equal((await request(withFarm("/summary", a.farm), undefined, v.token)).status, 404);
    assert.equal((await remove(a.farm, b.id, a.token)).status, 200);
    assert.equal((await request(withFarm("/devices", a.farm), undefined, b.token)).status, 404);
    assert.equal((await remove(a.farm, b.id, a.token)).status, 404);

    // The sample farm is read-only, even if a membership row ever says otherwise.
    const demo = await (await request("/auth/demo", { platform: "native" })).json();
    const sample = demo.token as string;
    assert.equal(demo.account.role, "viewer");
    assert.deepEqual(demo.account.farms.map((farm: { id: string; role: string }) => [farm.id, farm.role]), [["sample-farm", "viewer"]]);
    await db.execute("UPDATE farm_members SET role='owner' WHERE farm_id='sample-farm'");
    const [sampleDevice] = await json("/devices", sample);
    assert.equal(sampleDevice.access, "viewer");
    assert.equal(sampleDevice.health.network, undefined);
    assert.equal((await request(`/devices/${sampleDevice.id}/commands`, { action: "reboot", confirm: true }, sample)).status, 403);
    assert.equal((await request(`/devices/${sampleDevice.id}/commands`, undefined, sample)).status, 403);
    assert.equal((await request(`/devices/${sampleDevice.id}/unpair`, { confirm: true }, sample)).status, 403);
    assert.equal((await request("/farms/sample-farm/members", { email: "owner-a@example.com" }, sample)).status, 403);
    assert.equal((await json("/farms/sample-farm", sample)).members, null);
    assert.ok((await json("/detections", sample)).total > 0);
    // The sample farm never appears for a real account.
    assert.deepEqual((await json("/farms", a.token)).map((farm: { id: string }) => farm.id), [a.farm]);
    assert.equal((await request(withFarm("/summary", "sample-farm"), undefined, a.token)).status, 404);

    // The backfill runs once: existing accounts keep their farm and role; a removed member stays removed.
    await db.execute("DELETE FROM schema_migrations WHERE id='002-farm-members'");
    await db.execute("DELETE FROM farm_members WHERE account_id=$1", [b.id]);
    await db.execute("UPDATE accounts SET role='viewer' WHERE id=$1", [v.id]);
    await db.execute("DELETE FROM farm_members WHERE account_id=$1", [v.id]);
    await db.initialize();
    assert.equal((await db.one("SELECT role FROM farm_members WHERE account_id=$1 AND farm_id=$2", [b.id, b.farm]))?.role, "owner");
    assert.equal((await db.one("SELECT role FROM farm_members WHERE account_id=$1 AND farm_id=$2", [v.id, v.farm]))?.role, "viewer");
    assert.equal((await db.one("SELECT 1 AS present FROM farm_members WHERE account_id=$1 AND farm_id=$2", [b.id, a.farm])), undefined);
    await db.execute("DELETE FROM farm_members WHERE account_id=$1", [b.id]);
    await db.initialize();
    assert.equal(await db.one("SELECT 1 AS present FROM farm_members WHERE account_id=$1", [b.id]), undefined);
  } finally {
    server.close();
    await db.close();
    await administrator.execute(`DROP SCHEMA ${schema} CASCADE`);
    await administrator.close();
  }
});

test("farms are created or joined by invite code, and devices are claimed and transferred by farm owners", async () => {
  const schema = "beehave_test_" + randomUUID().replaceAll("-", "");
  const administrator = openDatabase();
  await administrator.execute(`CREATE SCHEMA ${schema}`);
  const { app, db } = await createApp(schema);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/api`;
  const request = (path: string, body?: unknown, token?: string, key?: string) =>
    fetch(base + path, {
      method: body ? "POST" : "GET",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(key ? { "X-Device-Key": key } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  const json = async (path: string, token: string, body?: unknown) => {
    const response = await request(path, body, token);
    assert.ok(response.status < 300, `${path} → ${response.status}`);
    return response.json();
  };
  // Today's sign-up forms send no farm name.
  const register = async (email: string) => {
    const session = await (
      await request("/auth/register", { name: email.split("@")[0], email, password: "strong-test-password", platform: "native" })
    ).json();
    return { token: session.token as string, id: session.account.id as string, account: session.account };
  };
  const upload = (key: string, id: string) => {
    const at = new Date().toISOString();
    return request("/edge/batch", {
      readings: [{ id: `env-${id}`, observedAt: at, temperature: 30, humidity: 70 }],
      recordings: [{ id: `rec-${id}`, observedAt: at, duration: 1, filename: `${id}.wav`, status: "pending" }],
      detections: [{ id, observedAt: at, species: "T. biroi", frequency: 201, confidence: 0.98, readingId: `env-${id}`, recordingId: `rec-${id}`, modelVersion: "test-v1" }],
    }, undefined, key);
  };
  const today = manilaDate();
  const ids = async (farm: string, token: string) =>
    ((await json(withFarm(`/detections?from=${today}&to=${today}`, farm), token)).items as { id: string }[]).map((item) => item.id).sort();
  try {
    const owner = await register("owner@example.com");
    const helper = await register("helper@example.com");
    // A new account has no farm and reaches nothing until it creates or joins one.
    assert.deepEqual(owner.account.farms, []);
    assert.equal(owner.account.farmId, "");
    assert.deepEqual(await json("/farms", owner.token), []);
    assert.equal((await request("/devices", undefined, owner.token)).status, 404);
    // Farms are never listed for accounts outside them.
    assert.equal((await request("/farm-directory", undefined, helper.token)).status, 404);

    // Creating farms: each makes the account its owner; the first becomes the default.
    const farmA = await json("/farms", owner.token, { name: "Farm A" });
    const farmB = await json("/farms", owner.token, { name: "Farm B" });
    assert.deepEqual([farmA.role, farmB.role], ["owner", "owner"]);
    const me = (await json("/auth/me", owner.token)).account;
    assert.equal(me.farmId, farmA.id);
    assert.deepEqual(me.farms.map((farm: { name: string; role: string }) => [farm.name, farm.role]), [["Farm A", "owner"], ["Farm B", "owner"]]);
    assert.equal((await request("/farms", { name: "x" }, owner.token)).status, 400);
    // Farm location: optional, set at creation or by an owner, read by any member; viewers cannot edit.
    const located = await json("/farms", owner.token, { name: "Farm C", location: "Sariaya, Quezon" });
    assert.equal((await json(`/farms/${located.id}`, owner.token)).location, "Sariaya, Quezon");
    assert.equal((await json(`/farms/${farmA.id}`, owner.token)).location, null);
    await json(`/farms/${farmA.id}`, owner.token, { name: "Farm A", location: "Tiaong, Quezon" });
    assert.equal((await json(`/farms/${farmA.id}`, owner.token)).location, "Tiaong, Quezon");
    // Account profile: name changes freely; an email change needs the current password.
    assert.equal((await json("/auth/profile", owner.token, { name: "Owner Renamed", email: "owner@example.com" })).account.name, "Owner Renamed");
    assert.equal((await request("/auth/profile", { name: "Owner", email: "new-owner@example.com" }, owner.token)).status, 400);
    assert.equal((await request("/auth/profile", { name: "Owner", email: "new-owner@example.com", currentPassword: "wrong-password-123" }, owner.token)).status, 400);
    assert.equal((await request("/auth/profile", { name: "Owner", email: "helper@example.com", currentPassword: "strong-test-password" }, owner.token)).status, 409);
    assert.equal((await json("/auth/profile", owner.token, { name: "owner", email: "Owner2@Example.com", currentPassword: "strong-test-password" })).account.email, "owner2@example.com");

    // Joining needs an owner's invite code; the role comes from the invite.
    assert.equal((await request(`/farms/${farmA.id}/invites`, { role: "viewer" }, helper.token)).status, 404);
    const invite = await json(`/farms/${farmA.id}/invites`, owner.token, { role: "viewer" });
    assert.match(invite.code, /^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    assert.equal((await json(`/farms/${farmA.id}`, owner.token)).invites.length, 1);
    assert.equal((await request("/farm-invites/redeem", { code: "AAAAA-AAAAA" }, helper.token)).status, 404);
    const joined = await json("/farm-invites/redeem", helper.token, { code: ` ${invite.code.toLowerCase().replace("-", " ")} ` });
    assert.deepEqual([joined.id, joined.role], [farmA.id, "viewer"]);
    assert.equal((await request("/farm-invites/redeem", { code: invite.code }, helper.token)).status, 404, "single use");
    assert.equal((await json(`/farms/${farmA.id}`, owner.token)).invites.length, 0);
    assert.deepEqual((await json("/farms", helper.token)).map((farm: { id: string; role: string }) => [farm.id, farm.role]), [[farmA.id, "viewer"]]);
    // Roles are per farm: the helper administers Farm B through a second invite, but only views Farm A.
    const adminInvite = await json(`/farms/${farmB.id}/invites`, owner.token, { role: "owner" });
    assert.equal((await json("/farm-invites/redeem", helper.token, { code: adminInvite.code })).role, "owner");
    assert.equal((await request(`/farms/${farmA.id}/invites`, {}, helper.token)).status, 403);
    assert.equal((await request(`/farms/${farmA.id}`, { name: "Viewer edit", location: "Nowhere" }, helper.token)).status, 403);
    // Revoked and expired codes grant nothing.
    const third = await register("third@example.com");
    const revoked = await json(`/farms/${farmA.id}/invites`, owner.token, {});
    assert.equal((await request(`/farms/${farmA.id}/invites/${revoked.id}/revoke`, {}, helper.token)).status, 403);
    assert.equal((await request(`/farms/${farmA.id}/invites/${revoked.id}/revoke`, {}, owner.token)).status, 200);
    assert.equal((await request("/farm-invites/redeem", { code: revoked.code }, third.token)).status, 404);
    const expired = await json(`/farms/${farmA.id}/invites`, owner.token, {});
    await db.execute("UPDATE farm_invites SET expires_at=NOW() - INTERVAL '1 second' WHERE id=$1", [expired.id]);
    assert.equal((await request("/farm-invites/redeem", { code: expired.code }, third.token)).status, 404);
    assert.deepEqual(await json("/farms", third.token), []);
    const sample = (await (await request("/auth/demo", { platform: "native" })).json()).token as string;
    assert.equal((await request("/farms", { name: "Sample's farm" }, sample)).status, 403);

    // A provisioned device starts unclaimed: no farm, and its key is refused.
    const deviceKey = "k".repeat(64);
    await db.execute(
      "INSERT INTO device_registry (device_uid, key_hash, claim_code_hash) VALUES('pi-0001',$1,$2)",
      [hashToken(deviceKey), hashCode("PAIR2-CODE3")],
    );
    assert.equal((await upload(deviceKey, "early")).status, 401);
    // Only an owner of the selected farm looks up and claims it; the lookup links nothing.
    assert.equal((await request(withFarm("/device-claims/lookup", farmA.id), { code: "PAIR2-CODE3" }, helper.token)).status, 403);
    assert.equal((await request(withFarm("/device-claims/lookup", farmA.id), { code: "WRONG-CODE2" }, owner.token)).status, 404);
    assert.deepEqual(await json(withFarm("/device-claims/lookup", farmA.id), owner.token, { code: "pair2code3" }), { deviceUid: "pi-0001", farm: "Farm A" });
    assert.equal((await db.one("SELECT status FROM device_registry WHERE device_uid='pi-0001'"))?.status, "unclaimed");
    const claim = { code: "PAIR2-CODE3", name: "Hive 1 Monitor", location: "North apiary", confirm: true };
    assert.equal((await request(withFarm("/device-claims", farmA.id), { ...claim, deviceUid: "pi-other" }, owner.token)).status, 404, "confirmed device only");
    assert.equal((await request(withFarm("/device-claims", farmA.id), { ...claim, confirm: undefined, deviceUid: "pi-0001" }, owner.token)).status, 400);
    const claimed = await json(withFarm("/device-claims", farmA.id), owner.token, { ...claim, deviceUid: "pi-0001" });
    assert.equal(claimed.id, "pi-0001");
    assert.equal((await request(withFarm("/device-claims/lookup", farmB.id), { code: "PAIR2-CODE3" }, owner.token)).status, 404, "a claimed device cannot be claimed again");
    assert.deepEqual((await json(withFarm("/devices", farmA.id), helper.token)).map((device: { id: string }) => device.id), ["pi-0001"]);
    assert.deepEqual(await json(withFarm("/devices", farmB.id), helper.token), []);
    assert.equal((await upload(deviceKey, "before")).status, 200);

    // Transfer: only someone who administers both farms; history stays with Farm A.
    const transfer = (farm: string, token: string, body: Record<string, unknown> = {}) =>
      request(withFarm("/devices/pi-0001/transfer", farmA.id), { farm, confirm: true, ...body }, token);
    assert.equal((await transfer(farmB.id, helper.token)).status, 403, "viewer of the current farm");
    assert.equal((await transfer("no-such-farm", owner.token)).status, 404);
    assert.equal((await transfer(farmA.id, owner.token)).status, 409);
    assert.equal((await transfer(farmB.id, owner.token, { confirm: false })).status, 400);
    assert.equal((await transfer(farmB.id, owner.token)).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((await upload(deviceKey, "after")).status, 200);
    assert.deepEqual(await json(withFarm("/devices", farmA.id), owner.token), []);
    assert.deepEqual((await json(withFarm("/devices", farmB.id), owner.token)).map((device: { id: string }) => device.id), ["pi-0001"]);
    assert.deepEqual(await ids(farmA.id, helper.token), ["before"]);
    assert.deepEqual(await ids(farmB.id, helper.token), ["after"]);
    const summaryA = await json(withFarm(`/summary?from=${today}&to=${today}`, farmA.id), helper.token);
    const summaryB = await json(withFarm(`/summary?from=${today}&to=${today}`, farmB.id), helper.token);
    assert.deepEqual([summaryA.total, summaryB.total], [1, 1]);
    // Each record opens only under the farm that held the device when it was observed.
    assert.equal((await request(withFarm("/detections/pi-0001/before", farmA.id), undefined, helper.token)).status, 200);
    assert.equal((await request(withFarm("/detections/pi-0001/before", farmB.id), undefined, helper.token)).status, 404);
    assert.equal((await request(withFarm("/recordings/pi-0001/rec-after", farmA.id), undefined, helper.token)).status, 404);
    assert.equal((await request(withFarm("/recordings/pi-0001/rec-after", farmB.id), undefined, helper.token)).status, 200);
    // An account in Farm A only keeps Farm A's history and never sees the device's new data.
    const viewerA = await register("viewer-a@example.com");
    await json("/farm-invites/redeem", viewerA.token, { code: (await json(`/farms/${farmA.id}/invites`, owner.token, {})).code });
    assert.deepEqual(await ids(farmA.id, viewerA.token), ["before"]);
    assert.equal((await request("/detections/pi-0001/before", undefined, viewerA.token)).status, 200);
    assert.equal((await request("/detections/pi-0001/after", undefined, viewerA.token)).status, 404);
    assert.equal((await request(withFarm("/devices", farmB.id), undefined, viewerA.token)).status, 404);
    const periods = await db.many("SELECT farm_id, ended_at IS NULL AS current FROM device_farm_assignments WHERE device_id='pi-0001' ORDER BY assigned_at");
    assert.deepEqual(periods.map((row) => [row.farm_id, row.current]), [[farmA.id, false], [farmB.id, true]]);
  } finally {
    server.close();
    await db.close();
    await administrator.execute(`DROP SCHEMA ${schema} CASCADE`);
    await administrator.close();
  }
});
