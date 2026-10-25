import {
  COMMAND_PICKUP_MINUTES,
  commandAckSchema,
  commandResultSchema,
  commandVerifyMinutes,
  deviceCommandActions,
  isSavedNetworkAction,
  savedNetworkRequestSchema,
  wifiRequestSchema,
  type DeviceCommand,
} from "@beehave/shared";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { RouteContext } from "../context";
import type { Queries } from "../database";
import { HttpError } from "../types";

type CommandRow = {
  id: string;
  action: DeviceCommand["action"];
  status: DeviceCommand["status"];
  message: string | null;
  created_at: string;
  updated_at: string;
  received_at: string | null;
  started_at: string | null;
  expires_at: string;
  verify_until: string | null;
  result: DeviceCommand["result"];
  target: string | null;
  params: { hidden?: boolean; open?: boolean; profile?: string; priority?: number } | null;
  credential: unknown;
};
const view = (row: CommandRow): DeviceCommand => ({
  id: row.id,
  action: row.action,
  status: row.status,
  message: row.message,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  receivedAt: row.received_at,
  startedAt: row.started_at,
  deadline: row.status === "pending" ? row.expires_at : row.verify_until,
  result: row.result ?? null,
  // The network name only; the sealed password and options never leave the API for clients.
  target: row.target,
});
const ACTIVE = "('pending','sent','executing')";
// Per-action verification window, from constants only.
const verifyMinutes = `CASE action ${deviceCommandActions
  .map((action) => `WHEN '${action}' THEN ${commandVerifyMinutes[action]}`)
  .join(" ")} ELSE 3 END`;
// No request waits forever. One the device never collected expires and can never run; one it
// collected but did not confirm in time times out with its outcome unknown. Rows from before
// the verified lifecycle have no verify_until and fall back to their pickup deadline.
const expire = async (q: Queries, device: string) => {
  await q.execute(
    "UPDATE device_commands SET status='expired',finished_at=NOW(),updated_at=NOW() WHERE device_id=$1 AND status='pending' AND expires_at<=NOW()",
    [device],
  );
  await q.execute(
    "UPDATE device_commands SET status='timed_out',finished_at=NOW(),updated_at=NOW() WHERE device_id=$1 AND status IN ('sent','executing') AND COALESCE(verify_until,expires_at)<=NOW()",
    [device],
  );
  // A sealed Wi-Fi password is kept only while the device may still collect it.
  await q.execute(
    "UPDATE device_commands SET credential=NULL WHERE device_id=$1 AND credential IS NOT NULL AND status NOT IN ('pending','sent')",
    [device],
  );
};
const requestSchema = z
  .object({
    action: z.enum(deviceCommandActions),
    confirm: z.literal(true),
    // Chosen by the client so a retried submission returns the same request instead of a new one.
    // A Wi-Fi request needs it up front: its sealed password is bound to this ID.
    id: z.string().uuid().optional(),
    wifi: wifiRequestSchema.optional(),
    network: savedNetworkRequestSchema.optional(),
  })
  .refine((input) => (input.action === "wifi_connect") === !!input.wifi, "Wi-Fi settings are required for a Wi-Fi change, and only for one.")
  .refine((input) => input.action !== "wifi_connect" || !!input.id, "A Wi-Fi change needs a request ID.")
  .refine((input) => isSavedNetworkAction(input.action) === !!input.network, "Choose the saved network to change, and only for a saved-network change.")
  .refine((input) => (input.action === "wifi_priority") === (input.network?.priority !== undefined), "A priority change needs a priority from 0 to 100.");
const power = (action: DeviceCommand["action"]) => action === "reboot" || action === "shutdown";

export function registerCommandRoutes({
  app,
  db,
  authenticate,
  deviceScope,
  edge,
}: RouteContext) {
  // Command history names networks and carries scan results, so it is for owners only, and only
  // since the device joined their farm: a previous farm's requests stay out of view after a transfer.
  app.get("/api/devices/:id/commands", async (req, res) => {
    const account = await authenticate(req);
    const { device } = await deviceScope(req, account, req.params.id, "control");
    await expire(db, device.id);
    const rows = await db.many<CommandRow>(
      `SELECT * FROM device_commands WHERE device_id=$1
        AND created_at >= COALESCE((SELECT assigned_at FROM device_farm_assignments WHERE device_id=$1 AND ended_at IS NULL), '-infinity')
      ORDER BY created_at DESC LIMIT 10`,
      [device.id],
    );
    res.json(rows.map(view));
  });

  app.post("/api/devices/:id/commands", async (req, res) => {
    const account = await authenticate(req);
    const scope = await deviceScope(req, account, req.params.id, "control");
    const input = requestSchema.parse(req.body);
    const created = await db.transaction(async (tx) => {
      const device = await tx.one(
        "SELECT id,disconnected_at,last_seen > NOW() - INTERVAL '3 minutes' AS reachable FROM devices WHERE id=$1 AND farm_id=$2 FOR UPDATE",
        [scope.device.id, scope.farmId],
      );
      if (!device) throw new HttpError(404, "Device not found.");
      if (input.id) {
        const existing = await tx.one<CommandRow>(
          "SELECT * FROM device_commands WHERE id=$1 AND device_id=$2",
          [input.id, device.id],
        );
        if (existing) {
          if (existing.action !== input.action)
            throw new HttpError(409, "This request ID was already used for a different action.");
          return { row: existing, repeated: true };
        }
      }
      if (device.disconnected_at)
        throw new HttpError(409, "Disconnected devices cannot receive commands.");
      // Same 3-minute heartbeat window the apps use for Online.
      if (!device.reachable)
        throw new HttpError(409, "Device controls are unavailable because the Edge Device cannot currently be reached.");
      await expire(tx, device.id);
      const active = await tx.one(
        `SELECT id FROM device_commands WHERE device_id=$1 AND status IN ${ACTIVE}`,
        [device.id],
      );
      if (active)
        throw new HttpError(
          409,
          "Another request is still in progress on this device. Try again after it finishes.",
        );
      const wifi = input.wifi;
      const network = input.network;
      const row = await tx.one<CommandRow>(
        `INSERT INTO device_commands (id,device_id,requested_by,action,expires_at,target,params,credential)
        VALUES($1,$2,$3,$4,NOW() + make_interval(mins => $5),$6,$7,$8) RETURNING *`,
        [
          input.id ?? randomUUID(), device.id, account.id, input.action, COMMAND_PICKUP_MINUTES,
          wifi?.ssid ?? network?.ssid ?? null,
          wifi ? JSON.stringify({ hidden: wifi.hidden, open: wifi.open, ...(wifi.profile ? { profile: wifi.profile } : {}) })
            : network ? JSON.stringify({ profile: network.profile, ...(network.priority !== undefined ? { priority: network.priority } : {}) })
            : null,
          wifi?.credential ? JSON.stringify(wifi.credential) : null,
        ],
      );
      return { row: row!, repeated: false };
    });
    res.status(created.repeated ? 200 : 201).json(view(created.row));
  });

  // Withdraw a request the device has not collected yet; once collected it may already be running.
  app.post("/api/devices/:id/commands/:command/cancel", async (req, res) => {
    const account = await authenticate(req);
    const { device } = await deviceScope(req, account, req.params.id, "control");
    const row = await db.transaction(async (tx) => {
      await expire(tx, device.id);
      const command = await tx.one<CommandRow>(
        "SELECT * FROM device_commands WHERE id=$1 AND device_id=$2 FOR UPDATE",
        [req.params.command, device.id],
      );
      if (!command) throw new HttpError(404, "Request not found.");
      if (command.status === "sent" || command.status === "executing")
        throw new HttpError(
          409,
          "The device already received this request, so it can no longer be cancelled.",
        );
      if (command.status !== "pending")
        throw new HttpError(409, "This request has already finished.");
      return await tx.one<CommandRow>(
        "UPDATE device_commands SET status='cancelled',credential=NULL,finished_at=NOW(),updated_at=NOW() WHERE id=$1 RETURNING *",
        [command.id],
      );
    });
    res.json(view(row!));
  });

  // Device side: collect requests (pickup starts the verification window), claim each one
  // before acting, then report the verified outcome.
  app.get("/api/edge/commands", async (req, res) => {
    const device = await edge(req);
    const rows = await db.transaction(async (tx) => {
      await expire(tx, device.id);
      await tx.execute(
        `UPDATE device_commands SET status='sent',received_at=NOW(),updated_at=NOW(),
          verify_until=NOW() + make_interval(mins => ${verifyMinutes})
        WHERE device_id=$1 AND status='pending'`,
        [device.id],
      );
      // Collected requests are handed out again so an interrupted device can report them;
      // its journal keeps it from acting twice, and only a "sent" request can be claimed.
      return await tx.many<CommandRow & { remaining: number }>(
        `SELECT *, GREATEST(0, FLOOR(EXTRACT(EPOCH FROM COALESCE(verify_until,expires_at) - NOW())))::int AS remaining
        FROM device_commands WHERE device_id=$1 AND status IN ('sent','executing') ORDER BY created_at`,
        [device.id],
      );
    });
    // Wi-Fi details travel only to the device, and the sealed password only until it is claimed.
    res.json(
      rows.map(({ id, action, remaining, status, target, params, credential }) => ({
        id,
        action,
        expiresIn: remaining,
        ...(action === "wifi_connect"
          ? { target, params: params ?? {}, ...(status === "sent" && credential ? { credential } : {}) }
          : isSavedNetworkAction(action) ? { target, params: params ?? {} } : {}),
      })),
    );
  });

  app.post("/api/edge/commands/:id/ack", async (req, res) => {
    const device = await edge(req);
    const input = commandAckSchema.parse(req.body);
    const row = await db.transaction(async (tx) => {
      await expire(tx, device.id);
      return await tx.one(
        "UPDATE device_commands SET status='executing',started_at=NOW(),credential=NULL,message=COALESCE($3,message),updated_at=NOW() WHERE id=$1 AND device_id=$2 AND status='sent' RETURNING id",
        [req.params.id, device.id, input.message ?? null],
      );
    });
    // Refusal means: do not run it (expired, cancelled, timed out, or already claimed).
    if (!row) throw new HttpError(409, "This command is no longer active. Do not run it.");
    res.json({ ok: true });
  });

  app.post("/api/edge/commands/:id", async (req, res) => {
    const device = await edge(req);
    const result = commandResultSchema.parse(req.body);
    const outcome = await db.transaction(async (tx) => {
      await expire(tx, device.id);
      const command = await tx.one<CommandRow>(
        "SELECT * FROM device_commands WHERE id=$1 AND device_id=$2 FOR UPDATE",
        [req.params.id, device.id],
      );
      if (!command) return null;
      if (command.status === "sent" || command.status === "executing") {
        // "Restarting now" is a promise, not proof: the restart completes only when the device
        // reconnects after booting (see the heartbeat handler).
        if (command.action === "reboot" && result.status === "succeeded") {
          await tx.execute(
            "UPDATE device_commands SET status='executing',started_at=COALESCE(started_at,NOW()),message=$2,updated_at=NOW() WHERE id=$1",
            [command.id, result.message ?? null],
          );
          return { ok: true, verifying: true };
        }
        // A Wi-Fi change counts only if the device says it joined exactly the requested network.
        const joined =
          command.action !== "wifi_connect" ||
          (!!result.data && "result" in result.data && result.data.result === "connected" && result.data.ssid === command.target);
        const status = result.status === "succeeded" && !joined ? "failed" : result.status;
        const message = status === "failed" && result.status === "succeeded"
          ? `The device did not confirm it joined ${command.target}.`
          : result.message ?? null;
        await tx.execute(
          "UPDATE device_commands SET status=$2,message=$3,result=$4,credential=NULL,finished_at=NOW(),updated_at=NOW() WHERE id=$1",
          [command.id, status, message, result.data ? JSON.stringify(result.data) : null],
        );
        return { ok: true };
      }
      // A late report is kept as evidence but never turns a timed-out request into success,
      // and a late power action is refused so the device does not act on it.
      if (command.status === "timed_out" && command.received_at && !power(command.action)) {
        await tx.execute(
          "UPDATE device_commands SET message=$2,updated_at=NOW() WHERE id=$1",
          [command.id, `The device reported after the deadline: ${result.status === "succeeded" ? "succeeded" : "failed"}${result.message ? ` (${result.message})` : ""}.`],
        );
        return { ok: true, late: true };
      }
      return null;
    });
    if (!outcome) throw new HttpError(409, "This command is no longer active.");
    res.json(outcome);
  });
}
