import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createApp } from "./app";
import { openDatabase } from "./database";

test("device commands require ownership, confirmation and the device key", async () => {
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
    const registered = await (
      await request("/devices", { name: "Test Pi", location: "Hive" }, owner)
    ).json();
    const id = registered.device.id as string,
      key = registered.key as string;
    const send = (body: unknown, token = owner) =>
      request(`/devices/${id}/commands`, body, token);

    // A device that has never reported (or stopped reporting) cannot be controlled.
    const offline = await send({ action: "reboot", confirm: true });
    assert.equal(offline.status, 409);
    assert.match((await offline.json()).error, /cannot currently be reached/);
    const beat = (health = {}) =>
      request(
        "/edge/batch",
        {
          health: {
            collecting: true, cpu: 4, ram: 20, cpuTemperature: 45, storageUsed: 8,
            storageTotal: 32, queued: 0, microphone: true, sensor: true,
            softwareVersion: "agent test", ...health,
          },
        },
        undefined,
        key,
      );
    assert.equal((await beat()).status, 200);

    // Validation: confirmation, known actions, and sensor targets only on sensor actions.
    assert.equal((await send({ action: "reboot" })).status, 400);
    assert.equal((await send({ action: "format", confirm: true })).status, 400);
    assert.equal((await send({ action: "sensor_stop", confirm: true })).status, 400);
    // Ownership: another farm cannot see or command the device.
    assert.equal((await send({ action: "reboot", confirm: true }, other)).status, 404);
    assert.equal((await request(`/devices/${id}/commands`, undefined, other)).status, 404);
    assert.equal((await request("/edge/commands")).status, 401);

    const created = await send({ action: "monitoring_restart", confirm: true });
    assert.equal(created.status, 201);
    const command = await created.json();
    assert.equal(command.status, "pending");
    // Only one command may wait at a time.
    assert.equal((await send({ action: "shutdown", confirm: true })).status, 409);

    const collected = await (await request("/edge/commands", undefined, undefined, key)).json();
    assert.equal(collected.length, 1);
    assert.equal(collected[0].id, command.id);
    assert.equal(collected[0].action, "monitoring_restart");
    assert.ok(collected[0].expiresIn > 170 && collected[0].expiresIn <= 180);
    const stage = async () =>
      (await (await request(`/devices/${id}/commands`, undefined, owner)).json())[0];
    assert.equal((await stage()).status, "sent");
    assert.ok((await stage()).receivedAt);
    // The device claims the request before acting; only one claim succeeds.
    const claim = (commandId: string) =>
      request(`/edge/commands/${commandId}/ack`, { stage: "executing" }, undefined, key);
    assert.equal((await claim(command.id)).status, 200);
    assert.equal((await claim(command.id)).status, 409);
    assert.equal((await stage()).status, "executing");
    // Collected requests are listed again until they finish, so an interrupted device can report.
    assert.equal(
      (await (await request("/edge/commands", undefined, undefined, key)).json()).length,
      1,
    );
    const ack = (body: unknown) =>
      request(`/edge/commands/${command.id}`, body, undefined, key);
    assert.equal((await ack({ status: "done" })).status, 400);
    assert.equal(
      (await ack({ status: "succeeded", message: "Sensor restarted" })).status,
      200,
    );
    assert.equal((await ack({ status: "failed" })).status, 409);
    const history = await (
      await request(`/devices/${id}/commands`, undefined, owner)
    ).json();
    assert.equal(history[0].status, "succeeded");
    assert.equal(history[0].message, "Sensor restarted");

    // A heartbeat (health only) updates the last report but not the last data sync.
    const heartbeat = await beat({ hostname: "test-pi", uploader: "not installed" });
    assert.equal(heartbeat.status, 200);
    const [reported] = await (await request("/devices", undefined, owner)).json();
    assert.ok(reported.lastSeen);
    assert.equal(reported.lastSync, null);
    assert.equal(reported.health.hostname, "test-pi");
    // The account's role on the device comes from its farm role; other farms never see it.
    assert.equal(reported.access, "administrator");
    // Health carries its own report time; a batch without health leaves it alone.
    assert.ok(reported.healthAt);
    await db.execute("UPDATE devices SET health_at=NOW() - INTERVAL '10 minutes' WHERE id=$1", [id]);
    assert.equal(
      (await request("/edge/batch", { readings: [] }, undefined, key)).status,
      200,
    );
    const afterData = (await (await request("/devices", undefined, owner)).json())[0];
    assert.ok(Date.now() - Date.parse(afterData.healthAt) > 9 * 60_000);
    assert.ok(Date.now() - Date.parse(afterData.lastSeen) < 60_000);
    assert.equal(afterData.monitoring.current, "unknown");
    assert.equal((await beat()).status, 200);
    const afterBeat = (await (await request("/devices", undefined, owner)).json())[0];
    assert.ok(Date.now() - Date.parse(afterBeat.healthAt) < 60_000);
    assert.equal(afterBeat.monitoring.current, "active");
    // Network status travels in the heartbeat; a malformed report is dropped, not the heartbeat.
    const network = {
      method: "wifi", setupMode: false, ssid: "eds", signal: 72, ipAddress: "192.168.1.29", internet: "full",
      saved: [{ ssid: "eds", profile: "eds", autoconnect: true, priority: 100, active: true, inRange: true }],
    };
    assert.equal((await beat({ network })).status, 200);
    assert.deepEqual((await (await request("/devices", undefined, owner)).json())[0].health.network, network);
    assert.equal((await beat({ network: { method: "teleport" } })).status, 200);
    assert.equal((await (await request("/devices", undefined, owner)).json())[0].health.network, undefined);

    // A request can be withdrawn only by its farm, and only before the device collects it.
    const cancel = (command: string, token = owner) =>
      request(`/devices/${id}/commands/${command}/cancel`, {}, token);
    const waiting = await (await send({ action: "shutdown", confirm: true })).json();
    assert.equal((await cancel(waiting.id, other)).status, 404);
    const cancelled = await cancel(waiting.id);
    assert.equal(cancelled.status, 200);
    assert.equal((await cancelled.json()).status, "cancelled");
    assert.deepEqual(
      await (await request("/edge/commands", undefined, undefined, key)).json(),
      [],
    );
    assert.equal(
      (await request(`/edge/commands/${waiting.id}`, { status: "succeeded" }, undefined, key)).status,
      409,
    );
    assert.equal((await cancel(waiting.id)).status, 409);
    // A cancelled request can never be claimed.
    assert.equal((await claim(waiting.id)).status, 409);

    // Restart: "restarting now" is not success; only a reconnect after a fresh boot is.
    const collectedFirst = await (await send({ action: "reboot", confirm: true })).json();
    await request("/edge/commands", undefined, undefined, key);
    assert.equal((await cancel(collectedFirst.id)).status, 409);
    assert.equal((await claim(collectedFirst.id)).status, 200);
    const restarting = await request(`/edge/commands/${collectedFirst.id}`, { status: "succeeded", message: "Restarting now." }, undefined, key);
    assert.equal(restarting.status, 200);
    assert.equal((await restarting.json()).verifying, true);
    assert.equal((await stage()).status, "executing");
    // A heartbeat from before the reboot (long uptime) proves nothing.
    assert.equal((await beat({ uptimeSeconds: 86_400 })).status, 200);
    assert.equal((await stage()).status, "executing");
    // Another request cannot start while the restart is being verified.
    assert.equal((await send({ action: "monitoring_stop", confirm: true })).status, 409);
    // Backdate the claim, then report a boot that happened after it.
    await db.execute("UPDATE device_commands SET started_at=NOW() - INTERVAL '90 seconds' WHERE id=$1", [collectedFirst.id]);
    assert.equal((await beat({ uptimeSeconds: 30 })).status, 200);
    const restarted = await stage();
    assert.equal(restarted.status, "succeeded");
    assert.match(restarted.message, /rebooted and reconnected/);

    // A restart that never reconnects times out; a late power report is refused.
    const lost = await (await send({ action: "reboot", confirm: true })).json();
    await request("/edge/commands", undefined, undefined, key);
    assert.equal((await claim(lost.id)).status, 200);
    await db.execute("UPDATE device_commands SET verify_until=NOW() - INTERVAL '1 second' WHERE id=$1", [lost.id]);
    assert.equal((await stage()).status, "timed_out");
    assert.equal((await request(`/edge/commands/${lost.id}`, { status: "succeeded" }, undefined, key)).status, 409);

    // A monitoring request collected but confirmed late stays timed out; the late report is kept.
    const slow = await (await send({ action: "monitoring_stop", confirm: true })).json();
    await request("/edge/commands", undefined, undefined, key);
    assert.equal((await claim(slow.id)).status, 200);
    await db.execute("UPDATE device_commands SET verify_until=NOW() - INTERVAL '1 second' WHERE id=$1", [slow.id]);
    const lateReport = await request(`/edge/commands/${slow.id}`, { status: "succeeded", message: "Monitoring is stopped." }, undefined, key);
    assert.equal(lateReport.status, 200);
    const timedOut = await stage();
    assert.equal(timedOut.status, "timed_out");
    assert.match(timedOut.message, /after the deadline: succeeded/);

    // Wi-Fi scan: read-only, verified like any request, and its result is stored as data.
    const scanCmd = await (await send({ action: "network_scan", confirm: true })).json();
    const picked = await (await request("/edge/commands", undefined, undefined, key)).json();
    assert.ok(picked[0].expiresIn > 100 && picked[0].expiresIn <= 120);
    assert.equal((await claim(scanCmd.id)).status, 200);
    const scanned = await request(`/edge/commands/${scanCmd.id}`, {
      status: "succeeded",
      message: "Found 1 Wi-Fi network.",
      data: { networks: [{ ssid: "Farm WiFi", signal: 81, security: "wpa2" }], cached: false, scannedAt: "2026-10-22T02:00:00Z" },
    }, undefined, key);
    assert.equal(scanned.status, 200);
    const scanView = await stage();
    assert.equal(scanView.status, "succeeded");
    assert.deepEqual(scanView.result.networks, [{ ssid: "Farm WiFi", signal: 81, security: "wpa2" }]);
    // Malformed scan data is dropped, never stored, and does not lose the verified outcome.
    const badScan = await (await send({ action: "network_scan", confirm: true })).json();
    await request("/edge/commands", undefined, undefined, key);
    await claim(badScan.id);
    assert.equal((await request(`/edge/commands/${badScan.id}`, { status: "succeeded", data: { networks: "lots" } }, undefined, key)).status, 200);
    assert.equal((await stage()).result, null);

    // Wi-Fi change: validated, the sealed password goes only to the device and only until it
    // claims the request, and success requires the device to confirm the requested network.
    const sealed = { v: 1, epk: "ab".repeat(32), nonce: "cd".repeat(12), ct: "ef".repeat(30) };
    const wifiSend = (wifi: unknown, id: string | undefined = randomUUID()) => send({ action: "wifi_connect", confirm: true, id, wifi });
    assert.equal((await wifiSend({ ssid: "Farm WiFi" })).status, 400); // no password, profile or open
    assert.equal((await wifiSend({ ssid: "Farm WiFi", credential: sealed, open: true })).status, 400);
    assert.equal((await wifiSend({ ssid: "x".repeat(33), credential: sealed })).status, 400);
    assert.equal((await wifiSend({ ssid: "Farm WiFi", credential: { ...sealed, ct: "not hex" } })).status, 400);
    assert.equal((await send({ action: "wifi_connect", confirm: true, wifi: { ssid: "Farm WiFi", credential: sealed } })).status, 400); // needs its ID
    assert.equal((await send({ action: "reboot", confirm: true, wifi: { ssid: "x", open: true } })).status, 400);
    const wifiId = randomUUID();
    const wifiCreated = await wifiSend({ ssid: "Farm WiFi", credential: sealed }, wifiId);
    assert.equal(wifiCreated.status, 201);
    const wifiView = await wifiCreated.json();
    assert.equal(wifiView.target, "Farm WiFi");
    assert.doesNotMatch(JSON.stringify(wifiView), /efef|credential/);
    assert.doesNotMatch(JSON.stringify(await (await request(`/devices/${id}/commands`, undefined, owner)).json()), /efefef/);
    const [delivered] = await (await request("/edge/commands", undefined, undefined, key)).json();
    assert.deepEqual([delivered.target, delivered.params, delivered.credential], ["Farm WiFi", { hidden: false, open: false }, sealed]);
    assert.equal((await claim(wifiId)).status, 200);
    // Claimed: the sealed password is gone from the database and from later deliveries.
    assert.equal((await db.one<{ credential: unknown }>("SELECT credential FROM device_commands WHERE id=$1", [wifiId]))!.credential, null);
    const [redelivered] = await (await request("/edge/commands", undefined, undefined, key)).json();
    assert.equal(redelivered.credential, undefined);
    // Reporting a different network than requested is not success.
    await request(`/edge/commands/${wifiId}`, { status: "succeeded", message: "Connected.", data: { ssid: "eds", result: "connected", stage: "online" } }, undefined, key);
    const mismatch = await stage();
    assert.equal(mismatch.status, "failed");
    assert.match(mismatch.message, /did not confirm it joined Farm WiFi/);
    // A confirmed join of the requested network succeeds and keeps the outcome as evidence.
    const okId = randomUUID();
    await wifiSend({ ssid: "Farm WiFi", profile: "saved-uuid" }, okId);
    await request("/edge/commands", undefined, undefined, key);
    await claim(okId);
    await request(`/edge/commands/${okId}`, { status: "succeeded", data: { ssid: "Farm WiFi", result: "connected", stage: "online", previous: "eds" } }, undefined, key);
    const joined = await stage();
    assert.equal(joined.status, "succeeded");
    assert.equal(joined.result.previous, "eds");
    // An uncollected request's sealed password is wiped when it expires.
    const staleId = randomUUID();
    await wifiSend({ ssid: "Farm WiFi", credential: sealed }, staleId);
    await db.execute("UPDATE device_commands SET expires_at=NOW() - INTERVAL '1 second' WHERE id=$1", [staleId]);
    assert.equal((await stage()).status, "expired");
    assert.equal((await db.one<{ credential: unknown }>("SELECT credential FROM device_commands WHERE id=$1", [staleId]))!.credential, null);

    // Saved-network changes name one saved profile; a priority change needs a priority in 0–100.
    const manage = (action: string, network: unknown) => send({ action, confirm: true, id: randomUUID(), network });
    assert.equal((await manage("wifi_forget", undefined)).status, 400);
    assert.equal((await manage("wifi_forget", { ssid: "eds" })).status, 400); // no profile
    assert.equal((await manage("wifi_priority", { ssid: "eds", profile: "u1" })).status, 400); // no priority
    assert.equal((await manage("wifi_priority", { ssid: "eds", profile: "u1", priority: 101 })).status, 400);
    assert.equal((await manage("wifi_forget", { ssid: "eds", profile: "u1", priority: 5 })).status, 400);
    assert.equal((await send({ action: "reboot", confirm: true, network: { ssid: "eds", profile: "u1" } })).status, 400);
    const priorityView = await (await manage("wifi_priority", { ssid: "eds", profile: "u1", priority: 90 })).json();
    assert.equal(priorityView.target, "eds");
    const [priorityDelivered] = await (await request("/edge/commands", undefined, undefined, key)).json();
    assert.deepEqual([priorityDelivered.action, priorityDelivered.target, priorityDelivered.params], ["wifi_priority", "eds", { profile: "u1", priority: 90 }]);
    await claim(priorityView.id);
    await request(`/edge/commands/${priorityView.id}`, { status: "succeeded", message: "eds now has priority 90." }, undefined, key);
    assert.deepEqual([(await stage()).status, (await stage()).message], ["succeeded", "eds now has priority 90."]);
    const forgetView = await (await manage("wifi_forget", { ssid: "eds", profile: "u1" })).json();
    const [forgetDelivered] = await (await request("/edge/commands", undefined, undefined, key)).json();
    assert.deepEqual(forgetDelivered.params, { profile: "u1" });
    await claim(forgetView.id);
    await request(`/edge/commands/${forgetView.id}`, { status: "failed", message: "No other saved network is in range." }, undefined, key);
    assert.equal((await stage()).status, "failed");

    // A retried submission with the same client ID returns the same request.
    const clientId = randomUUID();
    const first = await send({ action: "monitoring_start", confirm: true, id: clientId });
    assert.equal(first.status, 201);
    const again = await send({ action: "monitoring_start", confirm: true, id: clientId });
    assert.equal(again.status, 200);
    assert.equal((await again.json()).id, clientId);
    assert.equal((await send({ action: "reboot", confirm: true, id: clientId })).status, 409);
    assert.equal((await cancel(clientId)).status, 200);

    // An uncollected command expires instead of waiting forever.
    const late = await (await send({ action: "reboot", confirm: true })).json();
    await db.execute(
      "UPDATE device_commands SET expires_at=NOW() - INTERVAL '1 second' WHERE id=$1",
      [late.id],
    );
    const expired = await (
      await request(`/devices/${id}/commands`, undefined, owner)
    ).json();
    assert.equal(expired[0].status, "expired");
    assert.equal(
      (await request(`/edge/commands/${late.id}`, { status: "succeeded" }, undefined, key)).status,
      409,
    );
    // An expired request is never handed out or claimable when the device comes back.
    assert.deepEqual(await (await request("/edge/commands", undefined, undefined, key)).json(), []);
    assert.equal((await claim(late.id)).status, 409);

    // A heartbeat older than 3 minutes means offline: new requests are refused again,
    // and the API reports monitoring as unknown while keeping the last reported state.
    await db.execute("UPDATE devices SET last_seen=NOW() - INTERVAL '4 minutes' WHERE id=$1", [id]);
    assert.equal((await send({ action: "monitoring_restart", confirm: true })).status, 409);
    const listed = async () =>
      (await (await request("/devices", undefined, owner)).json()).find((d: { id: string }) => d.id === id);
    const staleView = await listed();
    assert.equal(staleView.monitoring.current, "unknown");
    assert.equal(staleView.monitoring.lastReported, "active");
    assert.equal(staleView.health.collecting, true);
    // Back online with a new report: the live state replaces the old one immediately.
    assert.equal((await beat({ collecting: false, monitoringService: "inactive" })).status, 200);
    assert.equal((await listed()).monitoring.current, "stopped");
    assert.equal((await beat()).status, 200);

    // Disconnected devices cannot be commanded, and deletion still works.
    assert.equal((await request(`/devices/${id}/unpair`, { confirm: true }, owner)).status, 200);
    assert.equal((await send({ action: "reboot", confirm: true })).status, 409);
    assert.equal((await request(`/devices/${id}/delete`, { confirm: true }, owner)).status, 200);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
    await admin.execute(`DROP SCHEMA ${schema} CASCADE`);
    await admin.close();
  }
});
