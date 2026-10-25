import { readFile, open, statfs, stat, mkdir } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import pg from "pg";
import { V, C, uuid, schemas, canonical, strictJSON } from "./validation.mjs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const config = { origin: process.env.WEB_ORIGIN ?? "http://localhost:5173" };
process.umask(0o077);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 8,
  host: process.env.PGHOST ?? "localhost", database: process.env.PGDATABASE ?? "beehave",
  options: "-c search_path=brtc,public" }),
  root = resolve(process.env.BEEHAVE_RECORDING_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../data/brtc"));
const sha = (b) => createHash("sha256").update(b).digest("hex"),
  now = () => new Date().toISOString(),
  iso = (d) => new Date(d).toISOString();
const analysis = { state: "NOT_ANALYZED", classifier_runs: 0, detections: 0 };
class ApiError extends Error {
  constructor(status, code, fields = []) {
    super(code);
    Object.assign(this, { status, code, fields });
  }
}
const fail = (status, code, fields) => {
  throw new ApiError(status, code, fields);
};
const equal = (a, b) => canonical(a) === canonical(b);
const one = async (db, q, p = []) => (await db.query(q, p)).rows[0];
async function tx(fn) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SET LOCAL synchronous_commit=on");
    await db.query("SELECT pg_advisory_xact_lock(10155443)");
    const result = await fn(db);
    await db.query("COMMIT");
    return result;
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
  }
}
async function touch(db, id, changes = {}) {
  const fields = Object.entries(changes),
    sets = fields.map(([k], i) => `${k}=$${i + 2}`);
  await db.query(
    `UPDATE uploads SET revision=revision+1,updated_at=clock_timestamp()${sets.length ? "," + sets.join(",") : ""} WHERE id=$1`,
    [id, ...fields.map((x) => x[1])],
  );
}
async function getUpload(db, id, device) {
  const u = await one(
    db,
    `SELECT u.*,a.expected,a.recording_id,r.session_id,s.device_id,j.error AS verification_error FROM uploads u JOIN assets a ON a.id=u.asset_id JOIN recordings r ON r.id=a.recording_id JOIN sessions s ON s.id=r.session_id LEFT JOIN verification_jobs j ON j.upload_id=u.id WHERE u.id=$1`,
    [id],
  );
  if (!u || (device && u.device_id !== device)) fail(404, "RESOURCE_NOT_FOUND");
  return u;
}
async function diskHash(generation) {
  let size = 0;
  const h = createHash("sha256");
  for await (const b of createReadStream(`${root}/${generation}`, {
    highWaterMark: 65536,
  })) {
    size += b.length;
    h.update(b);
  }
  return { byte_length: size, sha256: h.digest("hex") };
}
async function reconcile(db, u, trigger) {
  if (u.frozen) return hooks.reconcileFrozen(db, u, trigger);
  const rows = (
    await db.query("SELECT * FROM presence WHERE upload_id=$1 ORDER BY idx", [
      u.id,
    ])
  ).rows;
  let changed = false;
  for (const p of rows) {
    const c = await one(
      db,
      "SELECT * FROM commitments WHERE asset_id=$1 AND idx=$2",
      [u.asset_id, p.idx],
    );
    if (
      !c ||
      Number(c.byte_length) !== Number(p.byte_length) ||
      c.sha256 !== p.sha256
    )
      fail(503, "STORAGE_INTEGRITY_FAILURE");
    let observed;
    try {
      observed = await diskHash(p.generation);
    } catch (e) {
      if (e.code === "ENOENT") observed = { missing: true };
      else fail(503, "STORAGE_UNAVAILABLE");
    }
    if (
      observed.missing ||
      observed.sha256 !== c.sha256 ||
      observed.byte_length !== Number(c.byte_length)
    ) {
      await db.query(
        "INSERT INTO incidents(id,upload_id,generation,idx,detail) VALUES($1,$2,$3,$4,$5) ON CONFLICT(generation) DO NOTHING",
        [
          randomUUID(),
          u.id,
          p.generation,
          p.idx,
          {
            code: "STORAGE_INTEGRITY_FAILURE",
            trigger,
            expected: { byte_length: Number(c.byte_length), sha256: c.sha256 },
            observed,
            prior_state: u.state,
            new_state: u.state === "EXPIRED" ? "EXPIRED" : "INTERRUPTED",
            revision: Number(u.revision) + 1,
            recording_id: u.recording_id,
            asset_id: u.asset_id,
            session_id: u.session_id,
            device_id: u.device_id,
            disposition: "QUARANTINED_REFERENCE_RETAINED_BYTES",
          },
        ],
      );
      await db.query("DELETE FROM presence WHERE upload_id=$1 AND idx=$2", [
        u.id,
        p.idx,
      ]);
      changed = true;
    }
  }
  if (changed) {
    await touch(db, u.id, {
      state: u.state === "EXPIRED" ? "EXPIRED" : "INTERRUPTED",
    });
    u = await getUpload(db, u.id);
  }
  if (
    u.active &&
    ["CREATED", "UPLOADING", "INTERRUPTED"].includes(u.state) &&
    new Date(u.expires_at) <= new Date()
  ) {
    await touch(db, u.id, { state: "EXPIRED" });
    u = await getUpload(db, u.id);
  } else if (
    u.active &&
    u.state === "UPLOADING" &&
    Date.now() - new Date(u.last_activity_at) > 900000
  ) {
    await touch(db, u.id, { state: "INTERRUPTED" });
    u = await getUpload(db, u.id);
  }
  await reserve(db, u);
  return u;
}
async function reserve(db, u) {
  const p = await one(
    db,
    "SELECT coalesce(sum(byte_length),0) AS n FROM presence WHERE upload_id=$1",
    [u.id],
  );
  const remaining =
    u.active && !["AVAILABLE", "INVALID", "FAILED"].includes(u.state)
      ? 2 * u.expected.byte_length - Number(p.n)
      : 0;
  await db.query(
    "INSERT INTO capacity_reservations VALUES($1,$2) ON CONFLICT(upload_id) DO UPDATE SET remaining_bytes=EXCLUDED.remaining_bytes",
    [u.id, remaining],
  );
}
async function capacity(db, extra = 0, admission = false) {
  const disk = await statfs(root);
  const free = disk.bavail * disk.bsize;
  const row = await one(
    db,
    "SELECT (SELECT coalesce(sum(remaining_bytes),0) FROM capacity_reservations)+(SELECT coalesce(sum(byte_length),0) FROM incoming_reservations) AS n",
  );
  if (
    (admission && free < 10 * 2 ** 30) ||
    free - Number(row.n) - extra < 5 * 2 ** 30
  )
    fail(503, "CAPACITY_INSUFFICIENT");
  return free;
}
async function snapshot(db, u) {
  const rows = (
    await db.query("SELECT * FROM presence WHERE upload_id=$1 ORDER BY idx", [
      u.id,
    ])
  ).rows;
  const committed = rows.map((p) => ({
    index: p.idx,
    offset: p.idx * C,
    byte_length: Number(p.byte_length),
    sha256: p.sha256,
    acknowledged_at: iso(p.ack),
  }));
  const count = Math.ceil(u.expected.byte_length / C),
    set = new Set(rows.map((p) => p.idx));
  const missing = [];
  for (let i = 0; i < count; i++)
    if (!set.has(i)) {
      const start = i;
      while (i + 1 < count && !set.has(i + 1)) i++;
      missing.push({ first_index: start, last_index: i });
    }
  let offset = 0;
  for (const p of committed) {
    if (p.offset !== offset) break;
    offset += p.byte_length;
  }
  return {
    contract: V,
    upload_id: u.id,
    recording_id: u.recording_id,
    asset_id: u.asset_id,
    session_id: u.session_id,
    device_id: u.device_id,
    expected: u.expected,
    state: u.state,
    chunk_size_bytes: C,
    chunk_count: count,
    committed_chunks: committed,
    missing_chunks: missing,
    committed_byte_length: committed.reduce((s, p) => s + p.byte_length, 0),
    contiguous_byte_offset: offset,
    progress_revision: Number(u.revision),
    expires_at: iso(u.expires_at),
    created_at: iso(u.created_at),
    updated_at: iso(u.updated_at),
    job_id:
      (
        await one(db, "SELECT id FROM verification_jobs WHERE upload_id=$1", [
          u.id,
        ])
      )?.id || null,
    renewal_required: new Date(u.expires_at) <= new Date(),
  };
}
function sessionView(s) {
  return {
    ...s.body,
    contract: V,
    session_id: s.id,
    device_id: s.device_id,
    created_at: iso(s.created_at),
  };
}
async function session(db, id, device) {
  const s = await one(db, "SELECT * FROM sessions WHERE id=$1", [id]);
  if (!s || s.device_id !== device) fail(404, "RESOURCE_NOT_FOUND");
  return s;
}
async function recording(db, id, device) {
  const r = await one(db, "SELECT * FROM recordings WHERE id=$1", [id]);
  if (!r) fail(404, "RESOURCE_NOT_FOUND");
  const s = await session(db, r.session_id, device);
  let u = await one(db, "SELECT id FROM uploads WHERE asset_id=$1 AND active", [
    r.asset_id,
  ]);
  let state = "CREATED";
  if (u) {
    u = await reconcile(
      db,
      await getUpload(db, u.id, device),
      "recording-read",
    );
    state = u.state;
  }
  const verifiedAsset = await one(
    db,
    "SELECT * FROM canonical_assets WHERE asset_id=$1",
    [r.asset_id],
  );
  return {
    contract: V,
    recording_id: r.id,
    session_id: r.session_id,
    device_id: s.device_id,
    source_part_number: Number(r.part),
    source_recording_key: r.source_key,
    original_asset_id: r.asset_id,
    expected: r.body.expected,
    reported: r.body.reported,
    provenance: r.body.provenance,
    storage_state: state,
    validation_state:
      {
        AVAILABLE: "VALID",
        VERIFYING: "VERIFYING",
        INVALID: "INVALID",
        FAILED: "ERROR",
      }[state] || "NOT_VERIFIED",
    analysis,
    verified: verifiedAsset?.verified || null,
    discrepancies: verifiedAsset?.discrepancies || [],
    created_at: iso(r.created_at),
    verified_at: verifiedAsset ? iso(verifiedAsset.verified_at) : null,
    finalized_at: verifiedAsset ? iso(verifiedAsset.finalized_at) : null,
    original_url: verifiedAsset ? `/api/v2/recordings/${r.id}/original` : null,
  };
}
async function ledger(db, device, route, key, body) {
  const old = await one(
    db,
    "SELECT * FROM idempotency WHERE device_id=$1 AND route=$2 AND key=$3",
    [device, route, key],
  );
  if (old && old.body_hash !== sha(canonical(body)))
    fail(409, "IDEMPOTENCY_CONFLICT");
  return old;
}
async function remember(db, device, route, key, body, id) {
  await db.query(
    "INSERT INTO idempotency VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
    [device, route, key, sha(canonical(body)), id],
  );
}
function mutable(u) {
  if (!u.active) fail(409, "STATE_CONFLICT");
  if (u.frozen && u.verification_error?.code === "UPLOAD_RESTART_REQUIRED")
    fail(409, "UPLOAD_RESTART_REQUIRED");
  if (new Date(u.expires_at) <= new Date()) fail(410, "UPLOAD_EXPIRED");
}
async function recoverUpload(id, device, trigger) {
  return tx(async (db) => {
    let u = await getUpload(db, id, device);
    u = await reconcile(db, u, trigger);
    return snapshot(db, u);
  });
}
async function jsonBody(req, schema) {
  if ((req.headers["content-type"] || "").split(";")[0] !== "application/json")
    fail(415, "MEDIA_TYPE_UNSUPPORTED");
  let n = 0;
  const chunks = [];
  for await (const b of req) {
    n += b.length;
    if (n > 65536) fail(413, "REQUEST_TOO_LARGE");
    chunks.push(b);
  }
  let b;
  try {
    b = strictJSON(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
  } catch {
    fail(400, "MALFORMED_REQUEST");
  }
  const parsed = schema.safeParse(b);
  if (!parsed.success)
    fail(
      422,
      parsed.error.issues.some((i) => i.message === "TIME_INCONSISTENT")
        ? "TIME_INCONSISTENT"
        : "SCHEMA_INVALID",
      parsed.error.issues.map((i) => ({
        path: "/" + i.path.join("/"),
        code: "SCHEMA_INVALID",
        message: i.message,
      })),
    );
  return parsed.data;
}
function send(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "BeeHave-Contract": V,
    "Cache-Control": "no-store",
    ...(status === 503 || status === 429 ? { "Retry-After": "2" } : {}),
  });
  res.end(JSON.stringify(body));
}

const hooks = {};
export {
  hooks,
  readFile,
  open,
  statfs,
  stat,
  mkdir,
  createReadStream,
  randomUUID,
  createHash,
  V,
  C,
  uuid,
  schemas,
  canonical,
  strictJSON,
  config,
  pool,
  root,
  sha,
  now,
  iso,
  analysis,
  ApiError,
  fail,
  equal,
  one,
  tx,
  touch,
  getUpload,
  diskHash,
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
};
