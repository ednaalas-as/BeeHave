import { randomUUID } from "node:crypto";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { hashToken } from "../auth";
import type { RouteContext } from "../context";
import { requestToken } from "../services/sessions";
import { HttpError } from "../types";
// A browser's Web Push subscription (as PushSubscription.toJSON() gives it) or an Expo push token.
const destinationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("web"),
    subscription: z.object({
      endpoint: z.string().url().max(2000).refine((url) => url.startsWith("https://"), "A push endpoint must use HTTPS."),
      keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
    }),
    installationId: z.string().min(1).max(100).optional(),
  }),
  z.object({
    kind: z.literal("expo"),
    token: z.string().max(200).regex(/^Expo(nent)?PushToken\[[^\]]+\]$/, "Not an Expo push token."),
    installationId: z.string().min(1).max(100),
    platform: z.enum(["ios", "android"]),
  }),
]);
export function registerNotificationRoutes({ app, db, authenticate, notificationConfig }: RouteContext) {
  const limit = rateLimit({
    windowMs: 15 * 60000,
    limit: 60,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many notification changes. Try again in 15 minutes." },
  });
  app.get("/api/notifications/config", async (req, res) => {
    await authenticate(req);
    res.json(notificationConfig());
  });
  // Registers (or refreshes) this browser or phone for the signed-in account and session. An
  // endpoint belongs to one account at a time: signing in as someone else on the same device
  // moves it, so the previous account stops receiving there.
  app.post("/api/notifications/destinations", limit, async (req, res) => {
    const account = await authenticate(req);
    if (account.demo) throw new HttpError(403, "The sample account does not receive notifications.");
    const input = destinationSchema.parse(req.body);
    const session = hashToken(requestToken(req) ?? "");
    const endpoint = input.kind === "web" ? input.subscription.endpoint : input.token;
    const id = await db.transaction(async (tx) => {
      // A rotated token replaces the one this installation registered before.
      if (input.installationId)
        await tx.execute(
          "DELETE FROM push_destinations WHERE account_id=$1 AND installation_id=$2 AND endpoint<>$3",
          [account.id, input.installationId, endpoint],
        );
      const row = await tx.one<{ id: string }>(
        `INSERT INTO push_destinations (id, account_id, session_hash, kind, endpoint, keys, installation_id, platform)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (endpoint) DO UPDATE SET account_id=EXCLUDED.account_id, session_hash=EXCLUDED.session_hash,
          kind=EXCLUDED.kind, keys=EXCLUDED.keys, installation_id=EXCLUDED.installation_id, platform=EXCLUDED.platform,
          disabled_at=NULL, disabled_reason=NULL, updated_at=NOW()
        RETURNING id`,
        [
          randomUUID(), account.id, session, input.kind, endpoint,
          input.kind === "web" ? JSON.stringify(input.subscription.keys) : null,
          input.installationId ?? null, input.kind === "expo" ? input.platform : "web",
        ],
      );
      return row!.id;
    });
    res.status(201).json({ id });
  });
  // Stops notifications to this browser or phone. Only the account's own destinations are touched.
  app.post("/api/notifications/destinations/remove", limit, async (req, res) => {
    const account = await authenticate(req);
    const input = z.object({ endpoint: z.string().min(1).max(2000) }).parse(req.body);
    await db.execute("DELETE FROM push_destinations WHERE account_id=$1 AND endpoint=$2", [account.id, input.endpoint]);
    res.json({ ok: true });
  });
}
