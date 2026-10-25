import { commandFeedback, deviceOverview, monitoringStatus, type Device, type DeviceCommand } from "@beehave/shared";
import assert from "node:assert/strict";
import { test } from "node:test";

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const health = (monitoringService?: string) => ({
  collecting: monitoringService === "active",
  cpu: 5, ram: 12, cpuTemperature: 49, storageUsed: 15, storageTotal: 58,
  queued: 0, microphone: true, sensor: true, softwareVersion: "agent test",
  ...(monitoringService ? { monitoringService } : {}),
});
const device = (lastSeenMsAgo: number | null, service?: string | null): Device => ({
  id: "pi", name: "Beehave 01", location: "Hive", model: "Raspberry Pi",
  lastSeen: lastSeenMsAgo === null ? null : ago(lastSeenMsAgo),
  lastSync: null,
  health: service === null ? null : health(service),
});
const fresh = 20_000, stale = 2 * 3600_000;
const card = (d: Device) => {
  const o = deviceOverview(d);
  return { connection: o.items.find((i) => i.key === "connection")!.value, monitoring: o.monitoring };
};

test("1. fresh heartbeat + active service → Online / Active", () => {
  const d = device(fresh, "active");
  assert.equal(monitoringStatus(d).current, "active");
  assert.deepEqual([card(d).connection, card(d).monitoring.value], ["Online", "Monitoring"]);
});

test("2. fresh heartbeat + stopped service → Online / Stopped", () => {
  const d = device(fresh, "inactive");
  assert.equal(monitoringStatus(d).current, "stopped");
  assert.deepEqual([card(d).connection, card(d).monitoring.value], ["Online", "Paused"]);
});

test("3. fresh heartbeat + failed service → Online / Error", () => {
  const d = device(fresh, "failed");
  assert.equal(monitoringStatus(d).current, "error");
  assert.deepEqual([card(d).connection, card(d).monitoring.value], ["Online", "Not running"]);
});

test("4. stale heartbeat that reported Active → Offline / Unknown, last reported Active", () => {
  const d = device(stale, "active");
  const status = monitoringStatus(d);
  assert.equal(status.current, "unknown");
  assert.equal(status.lastReported, "active");
  assert.equal(status.reportedAt, d.lastSeen);
  const view = card(d);
  assert.deepEqual([view.connection, view.monitoring.value, view.monitoring.tone], ["Offline", "Unknown", "neutral"]);
  assert.match(view.monitoring.detail!, /Last reported: Monitoring · 2 hr ago/);
  // The stored heartbeat itself is untouched.
  assert.equal(d.health!.monitoringService, "active");
});

test("5. stale heartbeat that reported Stopped → Offline / Unknown, last reported Stopped", () => {
  const d = device(stale, "inactive");
  assert.equal(monitoringStatus(d).current, "unknown");
  assert.equal(monitoringStatus(d).lastReported, "stopped");
  assert.equal(card(d).monitoring.value, "Unknown");
  assert.match(card(d).monitoring.detail!, /Last reported: Paused/);
});

test("6. no monitoring report ever received → Unknown, online or not", () => {
  for (const d of [device(fresh, null), device(stale, null), device(null, null)]) {
    const status = monitoringStatus(d);
    assert.equal(status.current, "unknown");
    assert.equal(status.lastReported, undefined);
    assert.equal(card(d).monitoring.value, "Unknown");
  }
});

test("7. device comes back online → the new live report is used immediately", () => {
  const offline = device(stale, "inactive");
  assert.equal(monitoringStatus(offline).current, "unknown");
  const back = { ...offline, lastSeen: ago(1000), health: health("active") };
  assert.equal(monitoringStatus(back).current, "active");
  assert.equal(card(back).monitoring.value, "Monitoring");
});

test("an older stale-but-confirmed request never revives a current state offline", () => {
  const d = device(stale, "inactive");
  const latest = {
    id: "c", action: "monitoring_start" as const, status: "succeeded" as const,
    message: null, createdAt: ago(1000), updatedAt: ago(500),
  };
  assert.equal(monitoringStatus(d, latest).current, "unknown");
  // Online, a request confirmed after the last heartbeat is newer evidence.
  assert.equal(monitoringStatus({ ...d, lastSeen: ago(fresh) }, latest).current, "active");
});

test("connectivity and monitoring are summarised separately", () => {
  assert.equal(deviceOverview(device(fresh, "active")).summary, "Online · Monitoring");
  assert.equal(deviceOverview(device(fresh, "inactive")).summary, "Online · Paused");
  assert.equal(deviceOverview(device(stale, "active")).summary, "Offline · Monitoring status unknown");
});

test("only a verified confirmation completes a request", () => {
  const command = (status: DeviceCommand["status"]) => ({
    id: "c", action: "monitoring_stop" as const, status, message: null, createdAt: ago(1000), updatedAt: ago(500),
  });
  assert.deepEqual(
    (["pending", "sent", "executing"] as const).map((s) => commandFeedback(command(s)).active),
    [true, true, true],
  );
  assert.equal(commandFeedback(command("succeeded")).stage, "completed");
  assert.match(commandFeedback(command("expired")).text, /expired before the device received it/);
  assert.match(commandFeedback(command("timed_out")).text, /Pause timed out/);
  assert.match(commandFeedback(command("executing"), false).text, /result is unknown/);
});

test("offline or stale health never shows a component as working or failed", () => {
  // Offline device whose last report said the microphone failed: Unknown, not Attention Needed.
  const failedMic = { ...device(stale, "active"), health: { ...health("active"), microphone: false } };
  const offline = deviceOverview(failedMic);
  const item = (o: ReturnType<typeof deviceOverview>, key: string) => o.items.find((i) => i.key === key)!;
  assert.equal(item(offline, "microphone").value, "Unknown");
  assert.match(item(offline, "microphone").detail!, /cannot currently be reached. Last reported: Attention needed · 2 hr ago/);
  assert.equal(item(offline, "environment").value, "Unknown");
  assert.equal(item(offline, "storage").value, "Unknown");
  assert.match(item(offline, "storage").detail!, /Last reported: 43.0 GB free/);
  assert.equal(offline.overall.value, "Offline");
  // Online through data uploads, but the health itself is old: still Unknown.
  const staleHealth = { ...failedMic, lastSeen: ago(fresh), healthAt: ago(stale) };
  const o = deviceOverview(staleHealth);
  assert.equal(o.online, true);
  assert.equal(o.fresh, false);
  assert.equal(o.overall.value, "Online");
  assert.equal(item(o, "microphone").value, "Unknown");
  assert.match(item(o, "microphone").detail!, /Waiting for a recent report/);
  assert.equal(monitoringStatus(staleHealth).current, "unknown");
  assert.equal(monitoringStatus(staleHealth).reportedAt, staleHealth.healthAt);
  assert.equal(o.summary, "Online · Monitoring status unknown");
  // A fresh report restores confirmed states, including a confirmed failure.
  const back = deviceOverview({ ...staleHealth, healthAt: ago(1000) });
  assert.equal(item(back, "microphone").value, "Attention Needed");
  assert.equal(back.overall.value, "Attention Needed");
});
