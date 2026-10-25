import express from "express";
import { Readable } from "node:stream";
import { handleBrtcRequest, initializeBrtc } from "../brtc/server.mjs";

export function registerBrtcRoutes({ app }: { app: express.Express }) {
  const ready = initializeBrtc().then(() => true).catch((error: unknown) => {
    console.error("BRTC_INITIALIZATION_FAILED", error instanceof Error ? error.message : "unknown");
    return false;
  });
  app.use("/api/v2", express.raw({ type: () => true, limit: "9mb", inflate: false }), (req, res) => {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const incoming = Readable.from(body.length ? [body] : []) as Readable & {
      headers: typeof req.headers;
      rawHeaders: string[];
      method: string;
      url: string;
    };
    incoming.headers = req.headers;
    incoming.rawHeaders = req.rawHeaders;
    incoming.method = req.method;
    incoming.url = req.originalUrl;
    void ready.then((initialized) => {
      if (!initialized) {
        res.status(503).json({ error: "Recording transfer service is unavailable." });
        return;
      }
      return handleBrtcRequest(incoming, res);
    }).catch(() => {
      if (!res.headersSent) res.status(503).json({ error: "Recording transfer service is unavailable." });
      else res.destroy();
    });
  });
}
