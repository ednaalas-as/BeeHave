import express from "express";
import { openDatabase } from "./database";
import { registerAuthRoutes } from "./routes/auth";
import { registerDevicesRoutes } from "./routes/devices";
import { registerCommandRoutes } from "./routes/commands";
import { registerPairingRoutes } from "./routes/pairing";
import { registerEdgeRoutes } from "./routes/edge";
import { registerBrtcRoutes } from "./routes/brtc";
import { registerErrorHandlers } from "./routes/errors";
import { registerRecordsRoutes } from "./routes/records";
import { registerSummaryRoutes } from "./routes/summary";
import { registerFarmRoutes } from "./routes/farms";
import { registerSetupLabelRoutes } from "./routes/setup-label";
import { registerNotificationRoutes } from "./routes/notifications";
import { createAccessService } from "./services/access";
import { createDeviceService } from "./services/devices";
import { createNotificationService, type PushTransport } from "./services/notifications";
import { createRecordService } from "./services/records";
import { createSessionService } from "./services/sessions";
/** Build the API: connect storage, configure requests, then register each feature. */
// push: tests pass a fake push transport; by default Web Push (VAPID env) and Expo are used.
export async function createApp(schema?: string, options: { push?: PushTransport } = {}) {
  const db = openDatabase(schema);
  try {
    await db.initialize();
  } catch (error) {
    await db.close();
    throw error;
  }
  const app = express();
  app.disable("x-powered-by");
  // Behind an HTTPS reverse proxy, trust only that hop (e.g. "loopback") so
  // rate limits see each client's address. Unset: direct connections, as before.
  if (process.env.TRUST_PROXY) app.set("trust proxy", process.env.TRUST_PROXY);
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    const origin = req.headers.origin;
    const allowed = (
      process.env.WEB_ORIGIN ?? "http://localhost:5173,http://127.0.0.1:5173"
    ).split(",");
    if (origin && allowed.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Vary", "Origin");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization, X-Device-Key",
      );
      res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, PUT, OPTIONS");
    }
    if (
      origin &&
      !allowed.includes(origin) &&
      !["GET", "HEAD"].includes(req.method)
    )
      return res.status(403).json({ error: "Origin is not permitted." });
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });
  // Preserve isolated API test schemas: they must never connect the BRTC
  // runtime pool to the shared development database.
  if (!schema) registerBrtcRoutes({ app });
  app.use(express.json({ limit: "2mb" }));
  app.get("/api/health", async (_req, res) => {
    await db.one("SELECT 1");
    res.json({ status: "ok", database: "postgresql" });
  });
  const access = createAccessService(db);
  const sessions = createSessionService(db, access.memberships);
  const devices = createDeviceService(db);
  const records = createRecordService(db, devices.ownedDevice, !schema);
  const notifications = createNotificationService(db, options.push);
  const context = { app, db, brtcEnabled: !schema, ...sessions, ...access, ...devices, ...records, ...notifications };
  registerAuthRoutes(context);
  registerFarmRoutes(context);
  registerDevicesRoutes(context);
  registerCommandRoutes(context);
  registerPairingRoutes(context);
  registerRecordsRoutes(context);
  registerSummaryRoutes(context);
  registerEdgeRoutes(context);
  registerSetupLabelRoutes(context, !!schema);
  registerNotificationRoutes(context);
  registerErrorHandlers(app);
  return { app, db, notifications };
}
