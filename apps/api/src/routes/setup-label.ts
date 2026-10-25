import type { SetupLabel } from "@beehave/shared";
import { z } from "zod";
import type { RouteContext } from "../context";
import { createSetupLabelSealer } from "../services/setup-labels";
import { HttpError } from "../types";
// The Pi's setup label in the app, so owners never need a terminal on the Pi to read it. The
// device reports it while online; owners can read the last copy even while the Pi is offline
// in setup mode, which is exactly when the hotspot password is needed.
export function registerSetupLabelRoutes(context: RouteContext, ephemeralKey: boolean) {
  const { app, db, edge, authenticate, deviceScope } = context;
  const sealer = createSetupLabelSealer(ephemeralKey);
  const text = z.string().min(1).max(64);
  app.put("/api/edge/setup-label", async (req, res) => {
    const device = await edge(req);
    const label = z.object({ hotspot: text, hotspotPassword: text, code: text }).strict().parse(req.body);
    await db.execute(
      `INSERT INTO device_setup_labels (device_id, sealed, updated_at) VALUES($1,$2,NOW())
      ON CONFLICT (device_id) DO UPDATE SET sealed=EXCLUDED.sealed, updated_at=NOW()`,
      [device.id, sealer.seal(device.id, label)],
    );
    res.json({ ok: true });
  });
  app.get("/api/devices/:id/setup-label", async (req, res) => {
    const account = await authenticate(req);
    const scope = await deviceScope(req, account, req.params.id, "control");
    const row = await db.one<{ sealed: string; updated_at: Date | string }>(
      "SELECT sealed, updated_at FROM device_setup_labels WHERE device_id=$1",
      [scope.device.id],
    );
    if (!row)
      throw new HttpError(
        404,
        "This device has not shared its setup label yet. It does so automatically once it is online with BeeHave agent 0.4.2 or later.",
      );
    const label: SetupLabel = { ...sealer.open(scope.device.id, row.sealed), updatedAt: new Date(row.updated_at).toISOString() };
    res.json(label);
  });
}
