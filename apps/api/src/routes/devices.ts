import type { DeviceClaim } from "@beehave/shared";
import { randomUUID } from "node:crypto";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { hashCode, hashToken, newToken } from "../auth";
import type { RouteContext } from "../context";
import type { Queries } from "../database";
import { deviceAccess } from "../services/access";
import { HttpError } from "../types";
export function registerDevicesRoutes(context: RouteContext) {
  const { app, db, authenticate, deviceView, devices, ownedDevice, farmAccess, farmScope, deviceScope } = context;
  // Pairing codes are short, so trying many is limited.
  const claimLimit = rateLimit({
    windowMs: 15 * 60000,
    limit: 20,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many pairing code attempts. Try again in 15 minutes." },
  });
  const codeSchema = z.string().trim().min(6).max(40);
  // Unknown codes and devices another farm already claimed answer alike, so a code reveals nothing.
  const unclaimed = (tx: Queries, code: string, lock = false) =>
    tx.one<{ device_uid: string; key_hash: string }>(
      `SELECT device_uid, key_hash FROM device_registry WHERE claim_code_hash=$1 AND status='unclaimed'${lock ? " FOR UPDATE" : ""}`,
      [hashCode(code)],
    );
  const noClaim = () =>
    new HttpError(404, "No unclaimed BeeHave device uses this pairing code. Check the code on the device label.");

  // Only the selected farm's devices, never another farm's.
  app.get("/api/devices", async (req, res) => {
    const account = await authenticate(req);
    const farm = await farmAccess(req, account, "view");
    res.json(await devices(farm.farmId, deviceAccess(farm.role)));
  });
  app.post("/api/devices", async (req, res) => {
    const account = await authenticate(req);
    const farm = await farmAccess(req, account, "control");
    const input = z
      .object({
        name: z.string().trim().min(2).max(100),
        location: z.string().trim().min(2).max(100),
      })
      .parse(req.body);
    const id = randomUUID();
    const key = newToken();
    await db.execute(
      "INSERT INTO devices (id, farm_id, name, location, model, key_hash, last_seen, last_sync, health) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [
        id,
        farm.farmId,
        input.name,
        input.location,
        "Raspberry Pi",
        hashToken(key),
        null,
        null,
        null,
      ],
    );
    res.status(201).json({
      device: deviceView(await ownedDevice(id, farm.farmId), deviceAccess(farm.role)),
      key,
    });
  });
  // Shows which device a pairing code belongs to and the farm it would join, before anything is
  // linked. Only an owner of the selected farm can look up or claim devices.
  app.post("/api/device-claims/lookup", claimLimit, async (req, res) => {
    const account = await authenticate(req);
    const farm = await farmAccess(req, account, "control");
    const input = z.object({ code: codeSchema }).parse(req.body);
    const device = await unclaimed(db, input.code);
    if (!device) throw noClaim();
    const claim: DeviceClaim = { deviceUid: device.device_uid, farm: farm.farmName };
    res.json(claim);
  });
  // The confirmed claim: the device joins the selected farm and its key starts working.
  app.post("/api/device-claims", claimLimit, async (req, res) => {
    const account = await authenticate(req);
    const farm = await farmAccess(req, account, "control");
    const input = z
      .object({
        code: codeSchema,
        deviceUid: z.string().min(1).max(100),
        name: z.string().trim().min(2).max(100),
        location: z.string().trim().min(2).max(100),
        confirm: z.literal(true),
      })
      .parse(req.body);
    const id = await db.transaction(async (tx) => {
      const device = await unclaimed(tx, input.code, true);
      // The confirmation was for this device; a different one is never linked instead.
      if (!device || device.device_uid !== input.deviceUid) throw noClaim();
      await tx.execute(
        `INSERT INTO devices (id, farm_id, name, location, model, key_hash, last_seen, last_sync, health)
        VALUES($1,$2,$3,$4,'Raspberry Pi',$5,NULL,NULL,NULL)`,
        [device.device_uid, farm.farmId, input.name, input.location, device.key_hash],
      );
      await tx.execute(
        "UPDATE device_registry SET status='claimed', device_id=$1, claimed_by=$2, claimed_at=NOW() WHERE device_uid=$1",
        [device.device_uid, account.id],
      );
      return device.device_uid;
    });
    res.status(201).json(deviceView(await ownedDevice(id, farm.farmId), deviceAccess(farm.role)));
  });
  // Moves a device to another farm the account also administers. Only the current assignment
  // changes: records observed before now stay with the farm that held the device then.
  app.post("/api/devices/:id/transfer", async (req, res) => {
    const account = await authenticate(req);
    const scope = await deviceScope(req, account, req.params.id, "control");
    const input = z.object({ farm: z.string().min(1).max(100), confirm: z.literal(true) }).parse(req.body);
    const target = await farmScope(account, input.farm, "control");
    if (target.farmId === scope.farmId) throw new HttpError(409, "This device already belongs to that farm.");
    await db.transaction(async (tx) => {
      const device = await tx.one<{ id: string }>(
        "SELECT id FROM devices WHERE id=$1 AND farm_id=$2 FOR UPDATE",
        [scope.device.id, scope.farmId],
      );
      if (!device) throw new HttpError(404, "Device not found.");
      if (await tx.one("SELECT 1 FROM device_commands WHERE device_id=$1 AND status IN ('pending','sent','executing')", [device.id]))
        throw new HttpError(409, "A request is still in progress on this device. Transfer it after the request finishes.");
      // The trigger closes the current farm period and opens the new one.
      await tx.execute("UPDATE devices SET farm_id=$2 WHERE id=$1", [device.id, target.farmId]);
      await tx.execute(
        "UPDATE device_farm_assignments SET assigned_by=$2 WHERE device_id=$1 AND ended_at IS NULL",
        [device.id, account.id],
      );
      // A later nearby re-pair of this Pi belongs to its new farm.
      await tx.execute("UPDATE device_pairings SET farm_id=$2 WHERE device_id=$1", [device.id, target.farmId]);
    });
    res.json({ ok: true, farm: { id: target.farmId, name: target.farmName } });
  });
  // Both actions retain the ownership check and require an explicit UI confirmation.
  for (const action of ["unpair", "delete"] as const) {
    app.post(`/api/devices/:id/${action}`, async (req, res) => {
      const account = await authenticate(req);
      const scope = await deviceScope(req, account, req.params.id, "control");
      z.object({ confirm: z.literal(true) }).parse(req.body);
      await db.transaction(async (tx) => {
        const device = await tx.one(
          "SELECT * FROM devices WHERE id=$1 AND farm_id=$2 FOR UPDATE",
          [scope.device.id, scope.farmId],
        );
        if (!device) throw new HttpError(404, "Device not found.");
        if (action === "unpair") {
          if (!device.disconnected_at) {
            // An unmatchable sentinel revokes the old key without issuing a new credential.
            await tx.execute(
              "UPDATE devices SET disconnected_at=NOW(),key_hash=$2 WHERE id=$1",
              [device.id, "revoked:" + randomUUID()],
            );
            // Retain the revoked key hash solely to prevent its reuse during re-pairing.
            await tx.execute(
              "UPDATE device_pairings SET released=TRUE,completed=FALSE,expires=0,challenge=NULL,nonce=NULL,revoked_keys=array_append(revoked_keys,key_hash) WHERE device_id=$1",
              [device.id],
            );
          }
        } else {
          if (!device.disconnected_at)
            throw new HttpError(
              409,
              "Disconnect this device before deleting its registration.",
            );
          const history = await tx.one(
            `SELECT EXISTS(SELECT 1 FROM readings WHERE device_id=$1)
            OR EXISTS(SELECT 1 FROM recordings WHERE device_id=$1)
            OR EXISTS(SELECT 1 FROM detections WHERE device_id=$1) AS present`,
            [device.id],
          );
          if (history?.present)
            throw new HttpError(
              409,
              "This device has historical data and cannot be deleted. Its disconnected registration preserves access to that history.",
            );
          // The device row lock and existing foreign keys also protect concurrent inserts.
          await tx.execute("DELETE FROM devices WHERE id=$1", [device.id]);
        }
      });
      res.json({ ok: true });
    });
  }
}
