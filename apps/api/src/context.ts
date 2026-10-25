import type { Express } from "express";
import type { DB } from "./database";
import type { createAccessService } from "./services/access";
import type { createDeviceService } from "./services/devices";
import type { createNotificationService } from "./services/notifications";
import type { createRecordService } from "./services/records";
import type { createSessionService } from "./services/sessions";
export type RouteContext = { app: Express; db: DB; brtcEnabled?: boolean } & ReturnType<
  typeof createSessionService
> &
  ReturnType<typeof createAccessService> &
  ReturnType<typeof createDeviceService> &
  ReturnType<typeof createRecordService> &
  ReturnType<typeof createNotificationService>;
