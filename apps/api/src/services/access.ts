import type { DeviceAccess, FarmRole } from "@beehave/shared";
import { type Request } from "express";
import type { DB, Queries } from "../database";
import { HttpError, type AccountRow, type DeviceRow } from "../types";
// view: monitoring data and basic device status. control: device commands, command history,
// network details, registering, pairing and disconnecting. members: managing farm access.
export type Permission = "view" | "control" | "members";
export type FarmScope = { farmId: string; farmName: string; role: FarmRole; demo: boolean };
function permit(role: FarmRole, need: Permission) {
  if (need !== "view" && role !== "owner")
    throw new HttpError(403, need === "members"
      ? "Only farm owners can manage farm members."
      : "Only farm owners can manage or control devices.");
}
// Older clients and the device label use the administrator/viewer wording.
export const deviceAccess = (role: FarmRole): DeviceAccess =>
  role === "owner" ? "administrator" : "viewer";
// SQL condition: the event row `alias` was observed while its device belonged to farm `param`.
// Records hold no farm of their own; this resolves it through the device's farm periods.
export const heldBy = (alias: string, param: string) =>
  `EXISTS (SELECT 1 FROM device_farm_assignments fa WHERE fa.device_id=${alias}.device_id AND fa.farm_id=${param}
    AND fa.assigned_at<=${alias}.observed_at AND (fa.ended_at IS NULL OR ${alias}.observed_at<fa.ended_at))`;
// A farm or device ID from the client only selects; access always comes from a membership.
// Anything the account cannot reach answers 404, so it never learns whether it exists.
export function createAccessService(db: DB) {
  function requestedFarm(req: Request) {
    const farm = req.query.farm;
    if (farm === undefined) return undefined;
    if (typeof farm !== "string" || !farm || farm.length > 100)
      throw new HttpError(404, "Farm not found.");
    return farm;
  }
  async function membership(account: AccountRow, farm: string, q: Queries = db) {
    const row = await q.one<{ id: string; name: string; demo: boolean; role: FarmRole }>(
      `SELECT f.id, f.name, f.demo, m.role FROM farm_members m JOIN farms f ON f.id=m.farm_id
      WHERE m.farm_id=$1 AND m.account_id=$2`,
      [farm, account.id],
    );
    if (!row) return undefined;
    // Sample farms stay read-only whatever a membership says.
    return { farmId: row.id, farmName: row.name, demo: !!row.demo, role: row.demo ? "viewer" : row.role } as FarmScope;
  }
  async function farmScope(account: AccountRow, farm: string | undefined, need: Permission, q: Queries = db) {
    const scope = farm ? await membership(account, farm, q) : undefined;
    if (!scope) throw new HttpError(404, "Farm not found.");
    permit(scope.role, need);
    return scope;
  }
  // The selected farm, or the account's default farm for clients that do not send one yet.
  async function farmAccess(req: Request, account: AccountRow, need: Permission, q: Queries = db) {
    return farmScope(account, requestedFarm(req) ?? (await memberships(account))[0]?.id, need, q);
  }
  // A device is reached through its own farm; a selected farm must be that farm.
  async function deviceScope(req: Request, account: AccountRow, id: string, need: Permission, q: Queries = db) {
    const device = await q.one<DeviceRow>("SELECT * FROM devices WHERE id=$1", [id]);
    const farm = requestedFarm(req);
    const scope =
      device && (farm === undefined || farm === device.farm_id)
        ? await membership(account, device.farm_id, q)
        : undefined;
    if (!device || !scope) throw new HttpError(404, "Device not found.");
    permit(scope.role, need);
    return { ...scope, device };
  }
  // One detection or recording, reached through the farm that held its device when it was
  // observed, so history stays with that farm after a transfer. A selected farm must be it.
  async function eventScope(req: Request, account: AccountRow, table: "detections" | "recordings", device: string, id: string) {
    const row = await db.one<{ farm_id: string }>(
      `SELECT fa.farm_id FROM ${table} e JOIN device_farm_assignments fa ON fa.device_id=e.device_id
        AND fa.assigned_at<=e.observed_at AND (fa.ended_at IS NULL OR e.observed_at<fa.ended_at)
      WHERE e.device_id=$1 AND e.id=$2`,
      [device, id],
    );
    const farm = requestedFarm(req);
    const scope = row && (farm === undefined || farm === row.farm_id) ? await membership(account, row.farm_id) : undefined;
    if (!scope) throw new HttpError(404, table === "detections" ? "Detection not found." : "Recording not found.");
    return scope;
  }
  // The account's own farm first, so clients without a selection keep opening it.
  async function memberships(account: AccountRow) {
    const rows = await db.many<{ id: string; name: string; demo: boolean; role: FarmRole }>(
      `SELECT f.id, f.name, f.demo, m.role FROM farm_members m JOIN farms f ON f.id=m.farm_id
      WHERE m.account_id=$1 ORDER BY f.id IS DISTINCT FROM $2, lower(f.name), f.id`,
      [account.id, account.farm_id],
    );
    return rows.map((row) => ({ id: row.id, name: row.name, demo: !!row.demo, role: (row.demo ? "viewer" : row.role) as FarmRole }));
  }
  return { farmScope, farmAccess, deviceScope, eventScope, memberships };
}
