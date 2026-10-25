import { withFarm } from "@beehave/shared";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createApp } from "./app";
import { hashCode, hashToken } from "./auth";
import { openDatabase } from "./database";
import { createNotificationService, type PushDestination, type PushMessage, type PushResult, type PushTransport } from "./services/notifications";

test("device-online and access-request notifications reach exactly the right destinations once", async () => {
  const schema = "beehave_test_" + randomUUID().replaceAll("-", "");
  const administrator = openDatabase();
  await administrator.execute(`CREATE SCHEMA ${schema}`);
  // A fake push service: records every send; chosen endpoints answer as expired or busy.
  const sent: { endpoint: string; message: PushMessage }[] = [];
  const answers = new Map<string, PushResult>();
  const receipts = new Map<string, { ok: boolean; gone?: boolean; error?: string }>();
  let tickets = 0;
  const push: PushTransport = {
    webPushKey: "test-public-key",
    async send(destination: PushDestination, message: PushMessage) {
      const answer = answers.get(destination.endpoint);
      if (answer) return answer;
      sent.push({ endpoint: destination.endpoint, message });
      return { ok: true, ticket: destination.kind === "expo" ? `ticket-${++tickets}` : undefined };
    },
    async receipts(tickets) {
      return Object.fromEntries(tickets.map((ticket) => [ticket, receipts.get(ticket) ?? { ok: true }]));
    },
  };
  const { app, db, notifications } = await createApp(schema, { push });
  await notifications.start(3600000);
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
  const register = async (name: string, farm?: string) => {
    const session = await (
      await request("/auth/register", { name, email: `${name.toLowerCase()}@example.com`, password: "strong-test-password", platform: "native", ...(farm ? { farm } : {}) })
    ).json();
    return { token: session.token as string, id: session.account.id as string, farm: session.account.farmId as string };
  };
  const destination = (token: string, body: unknown) => request("/notifications/destinations", body, token);
  const web = (endpoint: string) => ({ kind: "web", subscription: { endpoint, keys: { p256dh: "p256dh-key", auth: "auth-key" } } });
  const expo = (name: string, installationId: string) => ({ kind: "expo", token: `ExponentPushToken[${name}]`, installationId, platform: "ios" });
  const heartbeat = (key: string) => request("/edge/batch", { readings: [], recordings: [], detections: [] }, undefined, key);
  const settle = () => notifications.dispatchNotifications();
  const take = () => sent.splice(0).map((s) => s.endpoint).sort();
  const events = async (kind: string) => Number((await db.one<{ n: string }>("SELECT count(*) n FROM notification_events WHERE kind=$1", [kind]))!.n);
  try {
    const owner = await register("Ana", "Farm A");
    const viewer = await register("Vic");
    const outsider = await register("Oscar", "Farm O");
    const requester = await register("Rosa");
    assert.equal((await request(`/farms/${owner.farm}/members`, { email: "vic@example.com", role: "viewer" }, owner.token)).status, 201);

    // Notification settings need a signed-in account.
    assert.equal((await request("/notifications/config")).status, 401);
    assert.deepEqual(await (await request("/notifications/config", undefined, owner.token)).json(), { webPushKey: "test-public-key", expo: true });
    // Several destinations per account: a browser and a phone. Bad subscriptions are refused.
    assert.equal((await destination(owner.token, web("https://push.example/owner-browser"))).status, 201);
    assert.equal((await destination(owner.token, expo("owner-phone", "install-1"))).status, 201);
    assert.equal((await destination(viewer.token, expo("viewer-phone", "install-2"))).status, 201);
    assert.equal((await destination(outsider.token, web("https://push.example/outsider"))).status, 201);
    assert.equal((await destination(owner.token, web("http://push.example/plain-http"))).status, 400);
    assert.equal((await destination(owner.token, { kind: "expo", token: "not-a-token", installationId: "x", platform: "ios" })).status, 400);
    // Registering the same installation again with a rotated token replaces the old one.
    assert.equal((await destination(owner.token, expo("owner-phone-rotated", "install-1"))).status, 201);
    assert.deepEqual(
      (await db.many("SELECT endpoint FROM push_destinations WHERE account_id=$1 ORDER BY endpoint", [owner.id])).map((r) => r.endpoint),
      ["ExponentPushToken[owner-phone-rotated]", "https://push.example/owner-browser"],
    );

    // A provisioned device claimed into Farm A with the code on its label.
    const key = "device-key-" + randomUUID();
    const code = "ABCDE-23456";
    await db.execute("INSERT INTO device_registry (device_uid, key_hash, claim_code_hash) VALUES('pi-n1',$1,$2)", [hashToken(key), hashCode(code)]);
    assert.equal((await request(withFarm("/device-claims", owner.farm), { code, deviceUid: "pi-n1", name: "Hive North", location: "Row 3", confirm: true }, owner.token)).status, 201);

    // Unknown → Online: the first report notifies every member's destinations, and nobody else.
    assert.equal((await heartbeat(key)).status, 200);
    await settle();
    const first = sent.slice();
    assert.deepEqual(take(), ["ExponentPushToken[owner-phone-rotated]", "ExponentPushToken[viewer-phone]", "https://push.example/owner-browser"]);
    assert.equal(first[0].message.title, "BeeHave device connected");
    assert.equal(first[0].message.body, "Edge Device Hive North at Farm A is now online.");
    assert.deepEqual(first[0].message.target, { screen: "device", farmId: owner.farm, deviceId: "pi-n1" });

    // Repeated and concurrent heartbeats while Online: no new event, nothing sent.
    await Promise.all([heartbeat(key), heartbeat(key), heartbeat(key)]);
    await settle();
    assert.deepEqual(take(), []);
    assert.equal(await events("device_online"), 1);

    // Offline → Online again soon after (a flapping connection): announced at most once per window.
    await db.execute("UPDATE devices SET last_seen=NOW() - INTERVAL '10 minutes' WHERE id='pi-n1'");
    await heartbeat(key);
    await settle();
    assert.deepEqual(take(), []);
    // A genuine later reconnect is announced once more, even if the report is retried.
    await db.execute("UPDATE notification_events SET created_at=NOW() - INTERVAL '1 hour'");
    await db.execute("UPDATE notification_deliveries SET created_at=NOW() - INTERVAL '1 hour'");
    await db.execute("UPDATE devices SET last_seen=NOW() - INTERVAL '10 minutes' WHERE id='pi-n1'");
    await Promise.all([heartbeat(key), heartbeat(key)]);
    await settle();
    assert.equal(take().length, 3);
    assert.equal(await events("device_online"), 2);

    // An expired browser subscription is disabled and not used again.
    answers.set("https://push.example/owner-browser", { ok: false, gone: true, retry: false, error: "Web Push 410: Gone" });
    // A busy push service is retried later.
    answers.set("ExponentPushToken[viewer-phone]", { ok: false, gone: false, retry: true, error: "Expo 503" });
    await db.execute("UPDATE notification_events SET created_at=NOW() - INTERVAL '1 hour'");
    await db.execute("UPDATE notification_deliveries SET created_at=NOW() - INTERVAL '1 hour'");
    await db.execute("UPDATE devices SET last_seen=NOW() - INTERVAL '10 minutes' WHERE id='pi-n1'");
    await heartbeat(key);
    await settle();
    assert.deepEqual(take(), ["ExponentPushToken[owner-phone-rotated]"]);
    assert.ok((await db.one("SELECT disabled_at FROM push_destinations WHERE endpoint='https://push.example/owner-browser'"))?.disabled_at);
    const retry = await db.one<{ status: string; attempts: number }>(
      "SELECT d.status, d.attempts FROM notification_deliveries d JOIN push_destinations p ON p.id=d.destination_id WHERE p.endpoint='ExponentPushToken[viewer-phone]' AND d.status<>'sent'",
    );
    assert.deepEqual(retry, { status: "pending", attempts: 1 });
    answers.delete("ExponentPushToken[viewer-phone]");
    await db.execute("UPDATE notification_deliveries SET next_attempt_at=NOW() WHERE status='pending'");
    await settle();
    assert.deepEqual(take(), ["ExponentPushToken[viewer-phone]"]);
    // Registering the browser again (a fresh subscription from the same browser) re-enables it.
    assert.equal((await destination(owner.token, web("https://push.example/owner-browser"))).status, 201);
    answers.delete("https://push.example/owner-browser");

    // Expo's later receipt says the app was uninstalled: that token is disabled.
    const ticket = await db.one<{ ticket_id: string }>(
      "SELECT d.ticket_id FROM notification_deliveries d JOIN push_destinations p ON p.id=d.destination_id WHERE p.endpoint='ExponentPushToken[viewer-phone]' AND d.status='sent'",
    );
    receipts.set(ticket!.ticket_id, { ok: false, gone: true, error: "DeviceNotRegistered" });
    await db.execute("UPDATE notification_deliveries SET sent_at=NOW() - INTERVAL '20 minutes' WHERE status='sent'");
    await notifications.checkReceipts();
    assert.equal((await db.one("SELECT disabled_reason FROM push_destinations WHERE endpoint='ExponentPushToken[viewer-phone]'"))?.disabled_reason, "Expo receipt: DeviceNotRegistered");

    // Access requests: a claimed device's pairing code asks its farm's owners, and only them.
    const ask = (token: string, value = code) => request("/device-access-requests", { code: value }, token);
    assert.equal((await destination(viewer.token, expo("viewer-phone", "install-2"))).status, 201);
    assert.equal((await destination(requester.token, web("https://push.example/requester"))).status, 201);
    const unknown = await ask(requester.token, "ZZZZZ-99999");
    const asked = await ask(requester.token);
    assert.equal(unknown.status, 202);
    assert.equal(asked.status, 202);
    // The answer is the same either way, so a code reveals nothing.
    assert.deepEqual(await unknown.json(), await asked.json());
    await settle();
    const requestSends = sent.slice();
    assert.deepEqual(take(), ["ExponentPushToken[owner-phone-rotated]", "https://push.example/owner-browser"]);
    assert.equal(requestSends[0].message.title, "New device access request");
    assert.equal(requestSends[0].message.body, "Rosa is requesting access to Hive North at Farm A.");
    assert.deepEqual(requestSends[0].message.target, { screen: "farm-requests", farmId: owner.farm });
    // Asking again while pending, or as an existing member: no second notification.
    assert.equal((await ask(requester.token)).status, 202);
    assert.equal((await ask(viewer.token)).status, 202);
    await settle();
    assert.deepEqual(take(), []);
    assert.equal(await events("access_request"), 1);
    // Nothing is granted until an owner approves; the owner sees which device was used.
    assert.equal((await request(withFarm("/devices", owner.farm), undefined, requester.token)).status, 404);
    const profile = await (await request(`/farms/${owner.farm}`, undefined, owner.token)).json();
    assert.deepEqual(profile.requests.map((r: { name: string; deviceName: string }) => [r.name, r.deviceName]), [["Rosa", "Hive North"]]);
    assert.equal((await request(`/farms/${owner.farm}/requests/${requester.id}/approve`, {}, outsider.token)).status, 404);
    assert.equal((await request(`/farms/${owner.farm}/requests/${requester.id}/approve`, {}, owner.token)).status, 200);
    assert.equal((await request(withFarm("/devices", owner.farm), undefined, requester.token)).status, 200);

    // A signed-out phone receives nothing, and the account's other sessions keep receiving.
    assert.equal((await request("/auth/logout", {}, viewer.token)).status, 200);
    await db.execute("UPDATE notification_events SET created_at=NOW() - INTERVAL '1 hour'");
    await db.execute("UPDATE notification_deliveries SET created_at=NOW() - INTERVAL '1 hour'");
    await db.execute("UPDATE devices SET last_seen=NOW() - INTERVAL '10 minutes' WHERE id='pi-n1'");
    await heartbeat(key);
    await settle();
    assert.deepEqual(take(), ["ExponentPushToken[owner-phone-rotated]", "https://push.example/owner-browser", "https://push.example/requester"]);
    // Each delivery is recorded once per event and destination, for troubleshooting.
    const duplicates = await db.one<{ n: string }>(
      "SELECT count(*) n FROM (SELECT event_id, destination_id FROM notification_deliveries GROUP BY 1,2 HAVING count(*)>1) x",
    );
    assert.equal(Number(duplicates!.n), 0);

    // A device that was still Online when the API stopped is not announced after a restart.
    const restarted = createNotificationService(db, push);
    await db.execute("UPDATE api_heartbeats SET alive_at=NOW() - INTERVAL '1 minute'");
    await restarted.start(3600000);
    const now = Date.now();
    // Already offline before the API stopped (a minute ago): a genuine reconnect.
    assert.equal(restarted.cameOnline(new Date(now - 5 * 60000).toISOString(), now), true);
    // Still within the report window: not a transition at all.
    assert.equal(restarted.cameOnline(new Date(now - 90000).toISOString(), now), false);
    // Online when the API stopped; only the API's downtime made the report stale.
    assert.equal(restarted.cameOnline(new Date(now - 200000).toISOString(), now), false);
    assert.equal(restarted.cameOnline(new Date(now - 30 * 60000).toISOString(), now), true);
    assert.equal(restarted.cameOnline(null, now), true);
    await restarted.stop();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await notifications.stop();
    await db.close();
    await administrator.execute(`DROP SCHEMA ${schema} CASCADE`);
    await administrator.close();
  }
});
