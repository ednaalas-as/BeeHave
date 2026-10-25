import { createApp } from "./app";
import { closeBrtc } from "./brtc/server.mjs";
const { app, db, notifications } = await createApp();
// Delivery retries, Expo receipts, and the restart record that keeps a restart from looking like
// every device coming back online.
await notifications.start();
const server = app.listen(
  Number(process.env.PORT ?? 3001),
  process.env.HOST ?? "127.0.0.1",
  () =>
    console.log("BeeHave API listening on port " + (process.env.PORT ?? 3001)),
);
process.on("SIGTERM", () =>
  server.close(async () => {
    await notifications.stop();
    await db.close();
    await closeBrtc();
    process.exit(0);
  }),
);
