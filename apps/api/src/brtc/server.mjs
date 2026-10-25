import {createMedia} from "./media.mjs";
import * as runtime from "./runtime.mjs";
import { createVerification } from "./verification.mjs";
const {
  readFile,
  open,
  mkdir,
  randomUUID,
  createHash,
  V,
  C,
  uuid,
  schemas,
  pool,
  root,
  sha,
  now,
  fail,
  equal,
  one,
  tx,
  touch,
  getUpload,
  reconcile,
  reserve,
  capacity,
  snapshot,
  sessionView,
  session,
  recording,
  ledger,
  remember,
  mutable,
  recoverUpload,
  jsonBody,
  send,
} = runtime;
const verification = createVerification(runtime);
const media = createMedia(runtime);
async function route(req, res) {
  // Canonical playback is exposed by BeeHave's account-authenticated recording route.
  if (req.headers["beehave-contract"] !== V)
    fail(400, "CONTRACT_VERSION_UNSUPPORTED");
  const deviceKey = req.headers["x-device-key"];
  if (typeof deviceKey !== "string") fail(401, "AUTH_REQUIRED");
  const device = await one(pool,
    "SELECT * FROM public.devices WHERE key_hash=$1 AND disconnected_at IS NULL",
    [sha(deviceKey)],
  );
  if (!device) fail(401, "AUTH_INVALID");
  await pool.query("INSERT INTO brtc.devices(id,farm_id,enabled) VALUES($1,$2,true) ON CONFLICT(id) DO UPDATE SET farm_id=EXCLUDED.farm_id,enabled=true", [device.id, device.farm_id]);
  if (req.headers["content-encoding"])
    fail(415, "CONTENT_ENCODING_UNSUPPORTED");
  const url = new URL(req.url, "http://localhost");
  if (url.search) fail(400, "MALFORMED_REQUEST");
  const path = url.pathname,
    method = req.method,
    parts = path.split("/").filter(Boolean);
  if (parts[0] !== "api" || parts[1] !== "v2") fail(404, "RESOURCE_NOT_FOUND");
  const name = parts[2],
    id = parts[3],
    action = parts[4];
  if (id && !uuid.safeParse(id).success) fail(422, "SCHEMA_INVALID");
  if (
    ["GET", "HEAD"].includes(method) &&
    (Number(req.headers["content-length"] || 0) > 0 ||
      req.headers["transfer-encoding"])
  )
    fail(400, "MALFORMED_REQUEST");
  const key = req.headers["idempotency-key"];
  if (method === "POST" && !uuid.safeParse(key).success)
    fail(422, "SCHEMA_INVALID");
  if (
    name === "acquisition-sessions" &&
    parts.length === 3 &&
    method === "POST"
  ) {
    const b = await jsonBody(req, schemas.session);
    const result = await tx(async (db) => {
      const l = await ledger(db, device.id, path, key, b);
      if (l)
        return {
          status: 200,
          body: sessionView(await session(db, l.resource_id, device.id)),
        };
      const old = await one(
        db,
        "SELECT * FROM sessions WHERE device_id=$1 AND source_key=$2",
        [device.id, b.source_session_key],
      );
      if (old && !equal(old.body, b)) fail(409, "IDENTITY_CONFLICT");
      const s =
        old ||
        (await one(
          db,
          "INSERT INTO sessions(id,device_id,source_key,body) VALUES($1,$2,$3,$4) RETURNING *",
          [randomUUID(), device.id, b.source_session_key, b],
        ));
      await remember(db, device.id, path, key, b, s.id);
      return { status: old ? 200 : 201, body: sessionView(s) };
    });
    return send(res, result.status, result.body);
  }
  if (name === "acquisition-sessions" && parts.length === 4 && method === "GET")
    return send(
      res,
      200,
      await tx(async (db) => sessionView(await session(db, id, device.id))),
    );
  if (name === "recordings" && parts.length === 3 && method === "POST") {
    const b = await jsonBody(req, schemas.recording);
    const result = await tx(async (db) => {
      const acquisition = await session(db, b.session_id, device.id);
      const l = await ledger(db, device.id, path, key, b);
      if (l)
        return {
          status: 200,
          body: await recording(db, l.resource_id, device.id),
        };
      const old = await one(
        db,
        "SELECT * FROM recordings WHERE session_id=$1 AND (part=$2 OR source_key=$3)",
        [b.session_id, b.source_part_number, b.source_recording_key],
      );
      if (old && !equal(old.body, b)) fail(409, "IDENTITY_CONFLICT");
      const rid = old?.id || randomUUID(),
        asset = old?.asset_id || randomUUID();
      const beehaveRecordingId = `pi_${sha(Buffer.from(`${device.id}\0${acquisition.source_key}\0${b.source_recording_key}`))}`;
      if (!old) {
        await db.query(
          "INSERT INTO recordings(id,session_id,part,source_key,asset_id,body) VALUES($1,$2,$3,$4,$5,$6)",
          [
            rid,
            b.session_id,
            b.source_part_number,
            b.source_recording_key,
            asset,
            b,
          ],
        );
        await db.query("INSERT INTO assets VALUES($1,$2,$3)", [
          asset,
          rid,
          b.expected,
        ]);
      }
      const link = await db.query(
        "INSERT INTO beehave_recording_links(device_id,beehave_recording_id,brtc_recording_id,asset_id,source_session_key,source_recording_key) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(device_id,beehave_recording_id) DO NOTHING RETURNING brtc_recording_id,asset_id,source_session_key,source_recording_key",
        [device.id, beehaveRecordingId, rid, asset, acquisition.source_key, b.source_recording_key],
      );
      if (!link.rows.length) {
        const existingLink = await one(db,
          "SELECT brtc_recording_id,asset_id,source_session_key,source_recording_key FROM beehave_recording_links WHERE device_id=$1 AND beehave_recording_id=$2",
          [device.id, beehaveRecordingId],
        );
        if (existingLink?.brtc_recording_id !== rid || existingLink?.asset_id !== asset || existingLink?.source_session_key !== acquisition.source_key || existingLink?.source_recording_key !== b.source_recording_key)
          fail(409, "IDENTITY_CONFLICT");
      }
      await remember(db, device.id, path, key, b, rid);
      return {
        status: old ? 200 : 201,
        body: await recording(db, rid, device.id),
      };
    });
    return send(res, result.status, result.body);
  }
  if (name === "recordings" && parts.length === 4 && method === "GET")
    return send(res, 200, await tx((db) => recording(db, id, device.id)));
  if (
    name === "recordings" &&
    parts.length === 5 &&
    action === "uploads" &&
    method === "POST"
  ) {
    const b = await jsonBody(req, schemas.upload);
    await tx((db) => recording(db, id, device.id));
    const result = await tx(async (db) => {
      const r = await recording(db, id, device.id);
      if (b.asset_id !== r.original_asset_id || !equal(b.expected, r.expected))
        fail(409, "MANIFEST_CONFLICT");
      const l = await ledger(db, device.id, path, key, b);
      if (l) {
        const u = await reconcile(
          db,
          await getUpload(db, l.resource_id, device.id),
          "upload-replay",
        );
        return { status: 200, body: await snapshot(db, u) };
      }
      let active = await one(
        db,
        "SELECT id FROM uploads WHERE asset_id=$1 AND active",
        [b.asset_id],
      );
      let u = active ? await getUpload(db, active.id) : null;
      if (u?.state === "AVAILABLE") fail(409, "ALREADY_AVAILABLE");
      if (b.mode === "RESUME_OR_CREATE") {
        if (b.previous_upload_id !== null) fail(422, "SCHEMA_INVALID");
        if (u) {
          await remember(db, device.id, path, key, b, u.id);
          return { status: 200, body: await snapshot(db, u) };
        }
      } else {
        if (!u || b.previous_upload_id !== u.id) fail(409, "STATE_CONFLICT");
        if (!["EXPIRED", "INVALID", "FAILED"].includes(u.state))
          fail(409, "STATE_CONFLICT");
      }
      // Capacity check occurs before supersession and does not discard predecessor evidence.
      await capacity(db, 2 * b.expected.byte_length, true);
      if (u) {
        const job = await one(
          db,
          "SELECT * FROM verification_jobs WHERE upload_id=$1",
          [u.id],
        );
        if (job?.state === "RUNNING" && new Date(job.lease_until) > new Date())
          fail(409, "STATE_CONFLICT");
        await db.query(
          "UPDATE verification_jobs SET generation=generation+1,owner=null,lease_until=null WHERE upload_id=$1",
          [u.id],
        );
        await touch(db, u.id, { active: false });
        await reserve(db, { ...u, active: false });
      }
      const uid = randomUUID();
      await db.query(
        "INSERT INTO uploads(id,asset_id,state,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '24 hours')",
        [uid, b.asset_id, "CREATED"],
      );
      u = await getUpload(db, uid);
      await reserve(db, u);
      await remember(db, device.id, path, key, b, uid);
      return { status: 201, body: await snapshot(db, u) };
    });
    return send(res, result.status, result.body);
  }
  if (name === "uploads" && parts.length === 4 && method === "GET")
    return send(res, 200, await recoverUpload(id, device.id, "status"));
  if (
    name === "uploads" &&
    parts.length === 5 &&
    action === "renew" &&
    method === "POST"
  ) {
    const b = await jsonBody(req, schemas.renew);
    await recoverUpload(id, device.id, "renew");
    const body = await tx(async (db) => {
      let u = await getUpload(db, id, device.id);
      if (!u.active) fail(409, "STATE_CONFLICT");
      if (u.frozen && u.state === "FAILED") {
        const j = await one(
          db,
          "SELECT error FROM verification_jobs WHERE upload_id=$1",
          [u.id],
        );
        fail(
          409,
          j?.error?.code === "UPLOAD_RESTART_REQUIRED"
            ? "UPLOAD_RESTART_REQUIRED"
            : "STATE_CONFLICT",
        );
      }
      if (["AVAILABLE", "INVALID"].includes(u.state))
        fail(409, "STATE_CONFLICT");
      if (b.asset_id !== u.asset_id || !equal(b.expected, u.expected))
        fail(409, "MANIFEST_CONFLICT");
      const l = await ledger(db, device.id, path, key, b);
      if (!l) {
        await capacity(db);
        const snap = await snapshot(db, u);
        let state = u.state;
        if (state === "EXPIRED") {
          const lost = await one(
            db,
            "SELECT count(*) AS n FROM commitments c WHERE c.asset_id=$1 AND NOT EXISTS(SELECT 1 FROM presence p WHERE p.upload_id=$2 AND p.idx=c.idx)",
            [u.asset_id, u.id],
          );
          state =
            Number(lost.n) > 0
              ? "INTERRUPTED"
              : snap.missing_chunks.length === 0
                ? "UPLOADED"
                : snap.committed_chunks.length
                  ? "UPLOADING"
                  : "CREATED";
        }
        await touch(db, id, {
          state,
          expires_at: new Date(Date.now() + 86400000),
        });
        await remember(db, device.id, path, key, b, id);
        u = await getUpload(db, id);
      }
      return snapshot(db, u);
    });
    return send(res, 200, body);
  }
  if (
    name === "uploads" &&
    parts.length === 6 &&
    action === "chunks" &&
    method === "PUT"
  )
    return putChunk(req, res, device.id, id, parts[5]);
  if (
    name === "uploads" &&
    parts.length === 5 &&
    action === "finalize" &&
    method === "POST"
  ) {
    const b = await jsonBody(req, schemas.renew);
    const result = await verification.finalize(id, device.id, path, key, b);
    return send(res, result.status, result.body);
  }
  if (name === "verification-jobs" && parts.length === 4 && method === "GET")
    return send(res, 200, await verification.jobGet(id, device.id));
  if (
    name === "recordings" &&
    parts.length === 5 &&
    action === "verification" &&
    method === "GET"
  )
    return send(res, 200, await verification.resultGet(id, device.id));
  if (
    name === "recordings" &&
    parts.length === 5 &&
    action === "original" &&
    ["GET", "HEAD"].includes(method)
  ) {
    await tx((db) => recording(db, id, device.id));
    fail(409, "RECORDING_NOT_AVAILABLE");
  }
  fail(404, "RESOURCE_NOT_FOUND");
}
async function putChunk(req, res, device, id, indexText) {
  await recoverUpload(id, device, "chunk-admission");
  if (!/^(0|[1-9]\d*)$/.test(indexText)) fail(422, "SCHEMA_INVALID");
  const index = Number(indexText);
  const initial = await tx(async (db) => {
    const u = await getUpload(db, id, device);
    mutable(u);
    const n = Math.ceil(u.expected.byte_length / C);
    if (!Number.isSafeInteger(index) || index >= n) fail(422, "SCHEMA_INVALID");
    await capacity(db);
    return u;
  });
  if (req.headers["content-type"] !== "application/octet-stream")
    fail(415, "MEDIA_TYPE_UNSUPPORTED");
  if (
    req.headers["transfer-encoding"] ||
    req.headers["content-length"] === undefined
  )
    fail(411, "CONTENT_LENGTH_REQUIRED");
  const length = Math.min(C, initial.expected.byte_length - index * C),
    given = Number(req.headers["content-length"]);
  if (given > C || given > length) fail(413, "REQUEST_TOO_LARGE");
  if (given !== length) fail(422, "CHUNK_LENGTH_MISMATCH");
  const digest = req.headers["x-chunk-sha256"];
  if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest))
    fail(422, "SCHEMA_INVALID");
  const requestReservation = randomUUID();
  await tx(async (db) => {
    const n = await one(
      db,
      "SELECT count(*) AS n FROM incoming_reservations WHERE device_id=$1",
      [device],
    );
    const total = await one(
      db,
      "SELECT count(*) AS n FROM incoming_reservations",
    );
    if (Number(n.n) >= 2 || Number(total.n) >= 4) fail(429, "RATE_LIMITED");
    await capacity(db, length);
    await db.query("INSERT INTO incoming_reservations VALUES($1,$2,$3)", [
      requestReservation,
      device,
      length,
    ]);
  });
  try {
    const generation = randomUUID(),
      file = await open(`${root}/${generation}`, "wx", 0o600);
    let bytes = 0;
    const h = createHash("sha256");
    try {
      for await (const b of req) {
        bytes += b.length;
        if (bytes > length) fail(413, "REQUEST_TOO_LARGE");
        h.update(b);
        let at = 0;
        while (at < b.length) {
          const { bytesWritten } = await file.write(b, at, b.length - at);
          at += bytesWritten;
        }
      }
      if (bytes !== length) fail(422, "CHUNK_LENGTH_MISMATCH");
      if (h.digest("hex") !== digest) fail(422, "CHUNK_CHECKSUM_MISMATCH");
      await file.sync();
    } catch (e) {
      await file.close();
      await tx(async (db) => {
        const u = await getUpload(db, id, device);
        if (u.active && ["CREATED", "UPLOADING"].includes(u.state))
          await touch(db, id, { state: "INTERRUPTED" });
      });
      throw e;
    }
    await file.close();
    const dir = await open(root, "r");
    await dir.sync();
    await dir.close();
    if (process.env.BRTC_TEST_MODE === "1") {
      try {
        const f = JSON.parse(
          await readFile(new URL("./faults.json", import.meta.url)),
        );
        if (f.crash_after_durable_index === index) process.exit(77);
      } catch {}
    }
    await recoverUpload(id, device, "chunk-commit");
    const ack = await tx(async (db) => {
      let u = await getUpload(db, id, device);
      mutable(u);
      await capacity(db);
      const c = await one(
        db,
        "SELECT * FROM commitments WHERE asset_id=$1 AND idx=$2",
        [u.asset_id, index],
      );
      if (c && (Number(c.byte_length) !== length || c.sha256 !== digest))
        fail(409, "CHUNK_CONFLICT");
      let p = await one(
        db,
        "SELECT * FROM presence WHERE upload_id=$1 AND idx=$2",
        [id, index],
      );
      let outcome = "ALREADY_COMMITTED";
      if (!p) {
        if (!["CREATED", "UPLOADING", "INTERRUPTED"].includes(u.state))
          fail(409, "STATE_CONFLICT");
        const date = now();
        if (!c)
          await db.query("INSERT INTO commitments VALUES($1,$2,$3,$4,$5,$6)", [
            u.asset_id,
            index,
            index * C,
            length,
            digest,
            date,
          ]);
        await db.query("INSERT INTO presence VALUES($1,$2,$3,$4,$5,$6)", [
          id,
          index,
          generation,
          length,
          digest,
          date,
        ]);
        const count = Number(
          (
            await one(
              db,
              "SELECT count(*) AS n FROM presence WHERE upload_id=$1",
              [id],
            )
          ).n,
        );
        await touch(db, id, {
          state:
            count === Math.ceil(u.expected.byte_length / C)
              ? "UPLOADED"
              : u.state === "INTERRUPTED"
                ? "INTERRUPTED"
                : "UPLOADING",
        });
        u = await getUpload(db, id);
        await reserve(db, u);
        outcome = "COMMITTED";
      }
      await db.query(
        "UPDATE uploads SET last_activity_at=clock_timestamp() WHERE id=$1",
        [id],
      );
      const s = await snapshot(db, u);
      return {
        contract: V,
        upload_id: id,
        recording_id: u.recording_id,
        asset_id: u.asset_id,
        chunk: s.committed_chunks.find((p) => p.index === index),
        outcome,
        progress_revision: s.progress_revision,
        committed_byte_length: s.committed_byte_length,
        contiguous_byte_offset: s.contiguous_byte_offset,
        state: s.state,
      };
    });
    if (process.env.BRTC_TEST_MODE === "1") {
      try {
        const f = JSON.parse(
          await readFile(new URL("./faults.json", import.meta.url)),
        );
        if (f.drop_ack_index === index) {
          res.destroy();
          return;
        }
      } catch {}
    }
    send(res, 200, ack);
  } finally {
    await tx((db) =>
      db.query("DELETE FROM incoming_reservations WHERE id=$1", [
        requestReservation,
      ]),
    );
  }
}
export async function handleBrtcRequest(req, res) {
  try {
    await route(req, res);
  } catch (e) {
    const status = e.status || 503,
      code = e.code && e.status ? e.code : "STORAGE_UNAVAILABLE";
    if (!e.status) console.error("BRTC_REQUEST_FAILURE");
    if (!res.destroyed)
      send(res, status, {
        contract: V,
        request_id: randomUUID(),
        error: {
          code,
          message: code,
          retryable: status >= 500 || status === 429,
          field_errors: e.fields || [],
          recording_id: null,
          upload_id: null,
        },
      });
  }
}
export async function initializeBrtc() {
  if (workerTimer) return;
  await mkdir(root, { recursive: true, mode: 0o700 });
  await mkdir(`${root}/candidates`, { recursive: true, mode: 0o700 });
  await mkdir(`${root}/canonical`, { recursive: true, mode: 0o700 });
  instanceLock = await pool.connect();
  const lock = await one(instanceLock, "SELECT pg_try_advisory_lock(20155443) AS held");
  if (!lock?.held) {
    instanceLock.release();
    instanceLock = undefined;
    throw new Error("Another BeeHave BRTC API instance is already running");
  }
  await pool.query("DELETE FROM incoming_reservations");
  for (const r of (await pool.query("SELECT id FROM uploads ORDER BY created_at")).rows)
    await recoverUpload(r.id, null, "startup");
  await media.initialize();
  const owner = randomUUID();
  workerTimer = setInterval(async () => {
    if (workerBusy) return;
    workerBusy = true;
    try {
      const job = await verification.claim(owner);
      if (job) await verification.run(job);
    } catch (error) {
      console.error("BRTC_VERIFICATION_WORKER_ERROR", error?.code || "UNKNOWN");
    } finally {
      workerBusy = false;
    }
  }, 500);
  workerTimer.unref();
}
let workerTimer;
let workerBusy = false;
let instanceLock;
export async function closeBrtc() {
  if (workerTimer) clearInterval(workerTimer);
  workerTimer = undefined;
  if (instanceLock) {
    await instanceLock.query("SELECT pg_advisory_unlock(20155443)");
    instanceLock.release();
    instanceLock = undefined;
  }
  await pool.end();
}
export { pool, root, verification };
