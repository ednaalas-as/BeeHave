import { FRESH_REPORT_MS, type NotificationConfig, type NotificationTarget } from "@beehave/shared";
import { createHash, randomUUID } from "node:crypto";
import webpush from "web-push";
import type { DB, Queries } from "../database";

// Push notifications as an outbox: an event row is written in the same transaction as the change
// it reports (so it exists exactly once, even across retries and restarts), then delivered after
// commit to every destination its recipients have. Recipients are resolved from farm_members when
// the event is delivered, never from anything a client sent.
export type NotificationKind = "device_online" | "access_request";
export type PushDestination = { id: string; kind: "web" | "expo"; endpoint: string; keys: { p256dh: string; auth: string } | null };
export type PushMessage = { eventId: string; title: string; body: string; target: NotificationTarget };
// gone: the push service says this subscription or token no longer exists; it is disabled.
export type PushResult =
  | { ok: true; ticket?: string }
  | { ok: false; gone: boolean; retry: boolean; error: string };
export type PushTransport = {
  webPushKey: string | null;
  send: (destination: PushDestination, message: PushMessage) => Promise<PushResult>;
  // Expo delivery receipts by ticket: "gone" (DeviceNotRegistered), another error, or ok.
  receipts: (tickets: string[]) => Promise<Record<string, { ok: boolean; gone?: boolean; error?: string }>>;
};

const MAX_ATTEMPTS = 5;
// An event not delivered by then is no longer news (e.g. the API was down); it is not sent late.
const STALE_EVENT_MINUTES = 30;
const FLAP_MINUTES = 15;
const EXPO_API = "https://exp.host/--/api/v2/push";

// Web Push (VAPID) and the Expo push service. Web Push is offered only when VAPID keys are set.
export function defaultPushTransport(env = process.env): PushTransport {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim() || null;
  const privateKey = env.VAPID_PRIVATE_KEY?.trim();
  const subject = env.VAPID_SUBJECT?.trim() || "mailto:support@beehave.local";
  const expoHeaders = {
    "Content-Type": "application/json",
    Accept: "application/json",
    ...(env.EXPO_ACCESS_TOKEN ? { Authorization: `Bearer ${env.EXPO_ACCESS_TOKEN}` } : {}),
  };
  return {
    webPushKey: publicKey && privateKey ? publicKey : null,
    async send(destination, message) {
      if (destination.kind === "web") {
        if (!publicKey || !privateKey || !destination.keys)
          return { ok: false, gone: false, retry: false, error: "Web Push is not configured on this server." };
        try {
          await webpush.sendNotification(
            { endpoint: destination.endpoint, keys: destination.keys },
            JSON.stringify({ title: message.title, body: message.body, tag: message.eventId, target: message.target }),
            {
              vapidDetails: { subject, publicKey, privateKey },
              TTL: 6 * 3600,
              // A push service replaces an undelivered message with the same topic.
              topic: createHash("sha256").update(message.eventId).digest("base64url").slice(0, 32),
            },
          );
          return { ok: true };
        } catch (error) {
          const status = (error as { statusCode?: number }).statusCode;
          return {
            ok: false,
            gone: status === 404 || status === 410,
            retry: !status || status === 429 || status >= 500,
            error: `Web Push ${status ?? "network error"}: ${String((error as Error).message).slice(0, 200)}`,
          };
        }
      }
      try {
        const response = await fetch(`${EXPO_API}/send`, {
          method: "POST",
          headers: expoHeaders,
          body: JSON.stringify([{
            to: destination.endpoint,
            title: message.title,
            body: message.body,
            data: { eventId: message.eventId, target: message.target },
            sound: "default",
            channelId: "default",
            ttl: 6 * 3600,
          }]),
        });
        if (!response.ok)
          return { ok: false, gone: false, retry: response.status === 429 || response.status >= 500, error: `Expo ${response.status}` };
        const ticket = ((await response.json()) as { data?: { status: string; id?: string; message?: string; details?: { error?: string } }[] }).data?.[0];
        if (ticket?.status === "ok") return { ok: true, ticket: ticket.id };
        return {
          ok: false,
          gone: ticket?.details?.error === "DeviceNotRegistered",
          retry: ticket?.details?.error === "MessageRateExceeded",
          error: `Expo: ${ticket?.details?.error ?? ticket?.message ?? "no ticket"}`,
        };
      } catch (error) {
        return { ok: false, gone: false, retry: true, error: `Expo network error: ${(error as Error).message}` };
      }
    },
    async receipts(tickets) {
      const response = await fetch(`${EXPO_API}/getReceipts`, {
        method: "POST",
        headers: expoHeaders,
        body: JSON.stringify({ ids: tickets }),
      });
      if (!response.ok) throw new Error(`Expo receipts ${response.status}`);
      const data = ((await response.json()) as { data?: Record<string, { status: string; message?: string; details?: { error?: string } }> }).data ?? {};
      return Object.fromEntries(Object.entries(data).map(([id, receipt]) => [id, receipt.status === "ok"
        ? { ok: true }
        : { ok: false, gone: receipt.details?.error === "DeviceNotRegistered", error: receipt.details?.error ?? receipt.message }]));
    },
  };
}

// SQL: delivery `d` may still be sent. Its destination is enabled and its session still signed in,
// the account is still a member of the event's farm (an owner, for access requests), the farm is
// not a sample farm, and the event still applies (the device is in that farm; the request pending).
const deliverable = `EXISTS (
  SELECT 1 FROM notification_events e
  JOIN push_destinations p ON p.id=d.destination_id AND p.disabled_at IS NULL AND p.account_id=d.account_id
  JOIN sessions s ON s.hash=p.session_hash AND s.account_id=p.account_id AND s.expires>$1
  JOIN farm_members m ON m.farm_id=e.farm_id AND m.account_id=d.account_id
  JOIN farms f ON f.id=e.farm_id AND NOT f.demo
  WHERE e.id=d.event_id
    AND (e.kind<>'access_request' OR (m.role='owner' AND EXISTS (
      SELECT 1 FROM farm_access_requests r WHERE r.farm_id=e.farm_id AND r.account_id=e.actor_account_id AND r.status='pending')))
    AND (e.kind<>'device_online' OR EXISTS (SELECT 1 FROM devices dv WHERE dv.id=e.device_id AND dv.farm_id=e.farm_id AND dv.disconnected_at IS NULL))
)`;

export function createNotificationService(db: DB, transport: PushTransport = defaultPushTransport()) {
  // The API's previous run: when it was last known alive. Set by start().
  let previousAliveAt: number | null = null;
  let startedAt = Date.now();
  let timer: NodeJS.Timeout | undefined;
  // One dispatch at a time in this process; SKIP LOCKED keeps several API processes apart.
  let running: Promise<void> = Promise.resolve();
  let queued = false;

  async function recordNotification(
    q: Queries,
    event: { kind: NotificationKind; dedupeKey: string; farmId: string; deviceId?: string; actorAccountId?: string; title: string; body: string; target: NotificationTarget },
  ) {
    const row = await q.one<{ id: string }>(
      `INSERT INTO notification_events (id, dedupe_key, kind, farm_id, device_id, actor_account_id, title, body, target)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
      [randomUUID(), event.dedupeKey, event.kind, event.farmId, event.deviceId ?? null, event.actorAccountId ?? null,
        event.title, event.body, JSON.stringify(event.target)],
    );
    return row?.id ?? null;
  }

  // Edge heartbeat: the device was not Online by BeeHave's rule (no report yet, or none within
  // FRESH_REPORT_MS) and now reports. A device that was still Online when the API itself stopped
  // only looked offline because the API was down, so its first report after a restart is not news.
  function cameOnline(previousLastSeen: string | null, now: number) {
    if (!previousLastSeen) return true;
    const seen = Date.parse(previousLastSeen);
    if (now - seen < FRESH_REPORT_MS) return false;
    const missedOnlyByRestart = seen < startedAt && previousAliveAt !== null && seen + FRESH_REPORT_MS > previousAliveAt;
    return !missedOnlyByRestart;
  }

  // Called from the heartbeat transaction, which holds the device row lock, so concurrent or
  // repeated reports serialize and only the first one sees the device as not yet Online. The
  // dedupe key names the offline period that ended, so a retried report cannot repeat it. A
  // device whose connection flaps is announced at most once per FLAP_MINUTES.
  async function deviceOnline(tx: Queries, device: { id: string; farm_id: string; name: string }, previousLastSeen: string | null, now: number) {
    if (!cameOnline(previousLastSeen, now)) return null;
    const recent = await tx.one(
      `SELECT 1 FROM notification_events WHERE kind='device_online' AND device_id=$1
      AND created_at > NOW() - make_interval(mins => ${FLAP_MINUTES})`,
      [device.id],
    );
    const farm = await tx.one<{ name: string; demo: boolean }>("SELECT name, demo FROM farms WHERE id=$1", [device.farm_id]);
    if (recent || !farm || farm.demo) return null;
    return recordNotification(tx, {
      kind: "device_online",
      dedupeKey: `device_online:${device.id}:${previousLastSeen ?? "first"}`,
      farmId: device.farm_id,
      deviceId: device.id,
      title: "BeeHave device connected",
      body: `Edge Device ${device.name} at ${farm.name} is now online.`,
      target: { screen: "device", farmId: device.farm_id, deviceId: device.id },
    });
  }

  // Resolve recipients once per event: every enabled destination of every eligible account.
  async function fanOut() {
    await db.transaction(async (tx) => {
      const events = await tx.many<{ id: string; created_at: string }>(
        "SELECT id, created_at FROM notification_events WHERE fanned_out_at IS NULL ORDER BY created_at LIMIT 50 FOR UPDATE SKIP LOCKED",
      );
      for (const event of events) {
        const stale = Date.now() - Date.parse(event.created_at) > STALE_EVENT_MINUTES * 60000;
        const inserted = stale ? [] : await tx.many(
          `INSERT INTO notification_deliveries (event_id, destination_id, account_id)
          SELECT e.id, p.id, p.account_id FROM notification_events e
          JOIN farm_members m ON m.farm_id=e.farm_id AND (e.kind<>'access_request' OR m.role='owner')
          JOIN push_destinations p ON p.account_id=m.account_id AND p.disabled_at IS NULL
          JOIN sessions s ON s.hash=p.session_hash AND s.account_id=p.account_id AND s.expires>$2
          WHERE e.id=$1 AND m.account_id IS DISTINCT FROM e.actor_account_id
          ON CONFLICT DO NOTHING RETURNING destination_id`,
          [event.id, Date.now()],
        );
        await tx.execute("UPDATE notification_events SET fanned_out_at=NOW(), recipients=$2 WHERE id=$1", [event.id, inserted.length]);
      }
    });
  }

  async function deliver() {
    const now = Date.now();
    // Nothing is sent to an account that lost access, signed out or whose event no longer applies.
    await db.execute(
      `UPDATE notification_deliveries d SET status='skipped', last_error='No longer eligible', updated_at=NOW()
      WHERE status='pending' AND NOT ${deliverable}`,
      [now],
    );
    await db.execute(
      `UPDATE notification_deliveries SET status='skipped', last_error='Too late to deliver', updated_at=NOW()
      WHERE status='pending' AND created_at < NOW() - make_interval(mins => ${STALE_EVENT_MINUTES})`,
    );
    // A send interrupted by a crash may have reached the device already: never sent twice.
    await db.execute(
      `UPDATE notification_deliveries SET status='failed', last_error='Interrupted; not resent to avoid a duplicate', updated_at=NOW()
      WHERE status='sending' AND updated_at < NOW() - INTERVAL '5 minutes'`,
    );
    const due = await db.many<{
      event_id: string; destination_id: string; attempts: number; kind: "web" | "expo"; endpoint: string;
      keys: PushDestination["keys"]; title: string; body: string; target: NotificationTarget;
    }>(
      `UPDATE notification_deliveries d SET status='sending', attempts=attempts+1, updated_at=NOW()
      FROM notification_events e, push_destinations p
      WHERE e.id=d.event_id AND p.id=d.destination_id AND (d.event_id, d.destination_id) IN (
        SELECT event_id, destination_id FROM notification_deliveries d
        WHERE status='pending' AND next_attempt_at<=NOW() AND ${deliverable}
        ORDER BY created_at LIMIT 100 FOR UPDATE SKIP LOCKED)
      RETURNING d.event_id, d.destination_id, d.attempts, p.kind, p.endpoint, p.keys, e.title, e.body, e.target`,
      [now],
    );
    for (const row of due) {
      const result = await transport.send(
        { id: row.destination_id, kind: row.kind, endpoint: row.endpoint, keys: row.keys },
        { eventId: row.event_id, title: row.title, body: row.body, target: row.target },
      );
      const key = [row.event_id, row.destination_id];
      if (result.ok) {
        await db.execute(
          "UPDATE notification_deliveries SET status='sent', sent_at=NOW(), ticket_id=$3, last_error=NULL, updated_at=NOW() WHERE event_id=$1 AND destination_id=$2",
          [...key, result.ticket ?? null],
        );
        await db.execute("UPDATE push_destinations SET last_success_at=NOW() WHERE id=$1", [row.destination_id]);
        continue;
      }
      if (result.gone) await disable(row.destination_id, result.error);
      const retry = result.retry && !result.gone && row.attempts < MAX_ATTEMPTS;
      await db.execute(
        `UPDATE notification_deliveries SET status=$3, last_error=$4, updated_at=NOW(),
          next_attempt_at=NOW() + make_interval(secs => $5::double precision) WHERE event_id=$1 AND destination_id=$2`,
        [...key, retry ? "pending" : "failed", result.error.slice(0, 500), 30 * 2 ** row.attempts],
      );
    }
  }

  const disable = (destination: string, reason: string) =>
    db.execute(
      "UPDATE push_destinations SET disabled_at=COALESCE(disabled_at,NOW()), disabled_reason=$2, updated_at=NOW() WHERE id=$1",
      [destination, reason.slice(0, 500)],
    );

  // Expo reports an uninstalled app or revoked token only in the receipt, about 15 minutes later.
  async function checkReceipts() {
    const rows = await db.many<{ event_id: string; destination_id: string; ticket_id: string }>(
      `SELECT d.event_id, d.destination_id, d.ticket_id FROM notification_deliveries d
      WHERE d.ticket_id IS NOT NULL AND d.receipt_checked_at IS NULL AND d.status='sent'
        AND d.sent_at < NOW() - INTERVAL '15 minutes' AND d.sent_at > NOW() - INTERVAL '1 day'
      ORDER BY d.sent_at LIMIT 300`,
    );
    if (!rows.length) return;
    const receipts = await transport.receipts(rows.map((row) => row.ticket_id));
    for (const row of rows) {
      const receipt = receipts[row.ticket_id];
      if (receipt && !receipt.ok) {
        await db.execute(
          "UPDATE notification_deliveries SET status='failed', last_error=$3, updated_at=NOW() WHERE event_id=$1 AND destination_id=$2",
          [row.event_id, row.destination_id, `Expo receipt: ${receipt.error ?? "error"}`],
        );
        if (receipt.gone) await disable(row.destination_id, `Expo receipt: ${receipt.error ?? "DeviceNotRegistered"}`);
      }
      await db.execute(
        "UPDATE notification_deliveries SET receipt_checked_at=NOW() WHERE event_id=$1 AND destination_id=$2",
        [row.event_id, row.destination_id],
      );
    }
  }

  // Runs after a change commits, and on a timer for retries and for anything a crash left behind.
  function dispatchNotifications() {
    if (queued) return running;
    queued = true;
    running = running.then(async () => {
      queued = false;
      try {
        await fanOut();
        await deliver();
      } catch (error) {
        console.error("Notification delivery failed:", (error as Error).message);
      }
    });
    return running;
  }

  async function tick() {
    await db.execute("UPDATE api_heartbeats SET alive_at=NOW() WHERE name='api'");
    await dispatchNotifications();
    await checkReceipts().catch((error) => console.error("Push receipt check failed:", (error as Error).message));
    // Kept 90 days for troubleshooting; destinations whose session ended are dropped.
    await db.execute("DELETE FROM notification_events WHERE created_at < NOW() - INTERVAL '90 days'");
    await db.execute(
      "DELETE FROM push_destinations p WHERE NOT EXISTS (SELECT 1 FROM sessions s WHERE s.hash=p.session_hash AND s.expires>$1)",
      [Date.now()],
    );
  }

  // Records this run and remembers when the previous one was last alive.
  async function start(intervalMs = 30000) {
    const row = await db.one<{ alive_at: string }>("SELECT alive_at FROM api_heartbeats WHERE name='api'");
    previousAliveAt = row ? Date.parse(row.alive_at) : null;
    startedAt = Date.now();
    await db.execute(
      `INSERT INTO api_heartbeats (name, started_at, alive_at) VALUES('api', NOW(), NOW())
      ON CONFLICT (name) DO UPDATE SET started_at=NOW(), alive_at=NOW()`,
    );
    timer = setInterval(() => void tick().catch((error) => console.error("Notification tick failed:", (error as Error).message)), intervalMs);
    timer.unref();
  }

  const stop = async () => {
    clearInterval(timer);
    await running;
  };

  const notificationConfig = (): NotificationConfig => ({ webPushKey: transport.webPushKey, expo: true });

  return { recordNotification, deviceOnline, cameOnline, dispatchNotifications, checkReceipts, start, stop, notificationConfig };
}
