import { monitoringStatus, type Device, type DeviceAccess, type Health } from "@beehave/shared";
import { type Request } from "express";
import { hashToken } from "../auth";
import type { DB } from "../database";
import { HttpError,type DeviceRow } from "../types";
// Viewers see monitoring and basic status, never how the device is networked.
const viewerHealth = (health: Health | null) => {
  if (!health) return null;
  const { ipAddress: _ip, wifiNetwork: _wifi, network: _network, ...status } = health;
  return status;
};
export function createDeviceService(db: DB) {
  // The stored heartbeat is never rewritten; current vs last-reported monitoring is derived per response.
  // Without an access level the view is an owner's; viewers get the redacted status.
  const deviceView = (device: DeviceRow, access?: DeviceAccess): Device => withMonitoring({
    ...(access ? { access } : {}),
    id: device.id,
    disconnectedAt: device.disconnected_at,
    setupId: access === "viewer" ? null : device.setup_id ?? null,
    name: device.name,
    location: device.location,
    model: device.model,
    lastSeen: device.last_seen,
    lastSync: device.last_sync,
    health: access === "viewer" ? viewerHealth(device.health) : device.health ? device.health : null,
    healthAt: device.health_at ?? null,
  });
  const withMonitoring = (device: Device): Device => ({ ...device, monitoring: monitoringStatus(device) });
  const devices = async (farm: string, access?: DeviceAccess) =>
    (
      (await db.many(
        `SELECT d.*, p.setup_id FROM devices d
        LEFT JOIN device_pairings p ON p.device_id=d.id AND p.completed AND NOT p.released
        WHERE d.farm_id=$1 ORDER BY d.name, d.id`,
        [farm],
      )) as DeviceRow[]
    ).map((device) => deviceView(device, access));
  async function ownedDevice(id: string, farm: string) {
    const device = (await db.one(
      "SELECT * FROM devices WHERE id=$1 AND farm_id=$2",
      [id, farm],
    )) as DeviceRow | undefined;
    if (!device) throw new HttpError(404, "Device not found.");
    return device;
  }
  async function edge(req: Request) {
    const key = req.headers["x-device-key"];
    if (typeof key !== "string")
      throw new HttpError(401, "A device key is required.");
    const device = (await db.one("SELECT * FROM devices WHERE key_hash=$1 AND disconnected_at IS NULL", [
      hashToken(key),
    ])) as DeviceRow | undefined;
    if (!device) throw new HttpError(401, "Invalid device key.");
    return device;
  }
  return { deviceView, devices, ownedDevice, edge };
}
