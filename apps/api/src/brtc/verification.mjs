import { open, readFile, link } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { parseWav, VerificationError } from "./wav.mjs";
export function createVerification(R) {
  const {
    V,
    C,
    pool,
    root,
    one,
    tx,
    touch,
    getUpload,
    snapshot,
    recording,
    reconcile,
    reserve,
    capacity,
    fail,
    equal,
    iso,
    ledger,
    remember,
    hooks,
  } = R;
  const error = (code, message, retryable = false) => ({
    code,
    message,
    retryable,
    field_errors: [],
    recording_id: null,
    upload_id: null,
  });
  const faults = async () => {
    if (process.env.BRTC_TEST_MODE !== "1") return {};
    try {
      return JSON.parse(
        await readFile(new URL("./faults.json", import.meta.url)),
      );
    } catch {
      return {};
    }
  };
  const audit = (db, j, event, detail = {}) =>
    db.query(
      "INSERT INTO verification_audit(job_id,generation,event,detail) VALUES($1,$2,$3,$4)",
      [j.id, j.generation, event, detail],
    );
  function view(j, u) {
    return {
      contract: V,
      job_id: j.id,
      upload_id: u.id,
      recording_id: u.recording_id,
      asset_id: u.asset_id,
      state: j.state,
      attempt_number: j.attempt_number,
      created_at: iso(j.created_at),
      started_at: j.started_at ? iso(j.started_at) : null,
      completed_at: j.completed_at ? iso(j.completed_at) : null,
      retryable: j.retryable,
      error: j.error,
      result_url: `/api/v2/recordings/${u.recording_id}/verification`,
    };
  }
  async function loss(db, u, bad, trigger) {
    const j = await one(
      db,
      "SELECT * FROM verification_jobs WHERE upload_id=$1",
      [u.id],
    );
    if (!j) fail(503, "STORAGE_INTEGRITY_FAILURE");
    for (const b of bad) {
      await db.query(
        "INSERT INTO incidents(id,upload_id,generation,idx,detail) VALUES($1,$2,$3,$4,$5) ON CONFLICT(generation) DO NOTHING",
        [
          randomUUID(),
          u.id,
          b.generation,
          b.index,
          {
            code: "UPLOAD_RESTART_REQUIRED",
            trigger,
            expected: { sha256: b.sha256, byte_length: b.byte_length },
            observed: b.observed,
            prior_state: u.state,
            new_state: "FAILED",
            revision: Number(u.revision) + 1,
            disposition: "FROZEN_INPUT_LOST",
            asset_id: u.asset_id,
            recording_id: u.recording_id,
          },
        ],
      );
      await db.query("DELETE FROM presence WHERE upload_id=$1 AND idx=$2", [
        u.id,
        b.index,
      ]);
    }
    if (
      j.error?.code !== "UPLOAD_RESTART_REQUIRED" ||
      bad.some((b) => b.newIncident)
    ) {
      await db.query(
        "UPDATE verification_jobs SET state='FAILED',generation=generation+1,owner=null,lease_until=null,completed_at=clock_timestamp(),retryable=false,error=$2 WHERE id=$1",
        [
          j.id,
          error(
            "UPLOAD_RESTART_REQUIRED",
            "Frozen required bytes missing or corrupt; create NEW_ATTEMPT",
          ),
        ],
      );
      await touch(db, u.id, { state: "FAILED" });
      await audit(db, j, "FROZEN_INPUT_LOSS", {
        indexes: bad.map((x) => x.index),
        trigger,
      });
    }
    u = await getUpload(db, u.id);
    await reserve(db, u);
    return u;
  }
  async function frozenCheck(db, u, trigger) {
    if (u.state === "AVAILABLE") return u;
    const f = await one(
      db,
      "SELECT * FROM frozen_manifests WHERE upload_id=$1",
      [u.id],
    );
    if (!f || !equal(f.expected, u.expected))
      fail(503, "STORAGE_INTEGRITY_FAILURE");
    const bad = [];
    for (const e of f.entries) {
      let observed;
      try {
        observed = await R.diskHash(e.generation);
      } catch (x) {
        if (x.code === "ENOENT") observed = { missing: true };
        else fail(503, "STORAGE_UNAVAILABLE");
      }
      if (
        observed.missing ||
        observed.sha256 !== e.sha256 ||
        observed.byte_length !== e.byte_length
      ) {
        const existing = await one(
          db,
          "SELECT id FROM incidents WHERE generation=$1",
          [e.generation],
        );
        bad.push({ ...e, observed, newIncident: !existing });
      }
    }
    if (bad.length) return loss(db, u, bad, trigger);
    return u;
  }
  hooks.reconcileFrozen = frozenCheck;
  async function finalize(id, device, path, key, body) {
    await R.recoverUpload(id, device, "finalize-preflight");
    const outcome = await tx(async (db) => {
      let u = await getUpload(db, id, device);
      if (!u.active) fail(409, "STATE_CONFLICT");
      if (body.asset_id !== u.asset_id || !equal(body.expected, u.expected))
        fail(409, "MANIFEST_CONFLICT");
      const l = await ledger(db, device, path, key, body);
      let j = await one(
        db,
        "SELECT * FROM verification_jobs WHERE upload_id=$1",
        [id],
      );
      if (j) {
        if (l)
          return {
            status: ["QUEUED", "RUNNING"].includes(j.state) ? 202 : 200,
            body: view(j, u),
          };
        if (j.error?.code === "UPLOAD_RESTART_REQUIRED")
          fail(409, "UPLOAD_RESTART_REQUIRED");
        if (j.state === "FAILED") {
          await db.query(
            "UPDATE verification_jobs SET state='QUEUED',cycle_attempts=0,not_before=clock_timestamp(),completed_at=null,error=null,retryable=false,generation=generation+1,owner=null,lease_until=null WHERE id=$1",
            [j.id],
          );
          await touch(db, id, { state: "VERIFYING" });
          j = await one(db, "SELECT * FROM verification_jobs WHERE id=$1", [
            j.id,
          ]);
        }
        await remember(db, device, path, key, body, j.id);
        return {
          status: ["QUEUED", "RUNNING"].includes(j.state) ? 202 : 200,
          body: view(j, u),
        };
      }
      if (new Date(u.expires_at) <= new Date()) fail(410, "UPLOAD_EXPIRED");
      u = await reconcile(db, u, "finalize-serialized");
      const s = await snapshot(db, u);
      if (
        u.state !== "UPLOADED" ||
        s.missing_chunks.length ||
        s.committed_byte_length !== u.expected.byte_length
      )
        return { failure: "UPLOAD_INCOMPLETE" };
      await capacity(db);
      const p = (
        await db.query(
          "SELECT * FROM presence WHERE upload_id=$1 ORDER BY idx",
          [id],
        )
      ).rows;
      const entries = [];
      for (const row of p) {
        const c = await one(
          db,
          "SELECT * FROM commitments WHERE asset_id=$1 AND idx=$2",
          [u.asset_id, row.idx],
        );
        const length = Math.min(C, u.expected.byte_length - row.idx * C);
        if (
          !c ||
          c.sha256 !== row.sha256 ||
          Number(c.byte_length) !== length ||
          Number(row.byte_length) !== length
        )
          fail(503, "STORAGE_INTEGRITY_FAILURE");
        entries.push({
          index: row.idx,
          offset: row.idx * C,
          byte_length: length,
          sha256: c.sha256,
          generation: row.generation,
        });
      }
      await db.query(
        "INSERT INTO frozen_manifests(upload_id,id,expected,entries) VALUES($1,$2,$3,$4)",
        [id, randomUUID(), u.expected, JSON.stringify(entries)],
      );
      await touch(db, id, { frozen: true, state: "VERIFYING" });
      j = await one(
        db,
        "INSERT INTO verification_jobs(id,upload_id,state) VALUES($1,$2,'QUEUED') RETURNING *",
        [randomUUID(), id],
      );
      await remember(db, device, path, key, body, j.id);
      await audit(db, j, "MANIFEST_FROZEN", {
        entries: entries.length,
        revision: Number(u.revision) + 1,
      });
      return { status: 202, body: view(j, u) };
    });
    if (outcome.failure) fail(409, outcome.failure);
    return outcome;
  }
  async function jobGet(id, device) {
    const j = await one(pool, "SELECT * FROM verification_jobs WHERE id=$1", [
      id,
    ]);
    if (!j) fail(404, "RESOURCE_NOT_FOUND");
    await R.recoverUpload(j.upload_id, device, "job-read");
    return tx(async (db) => {
      const u = await getUpload(db, j.upload_id, device);
      return view(
        await one(db, "SELECT * FROM verification_jobs WHERE id=$1", [id]),
        u,
      );
    });
  }
  async function resultGet(id, device) {
    return tx(async (db) => {
      const rec = await recording(db, id, device),
        u = await one(
          db,
          "SELECT id FROM uploads WHERE asset_id=$1 AND active",
          [rec.original_asset_id],
        );
      let job = null;
      if (u) {
        const upload = await getUpload(db, u.id, device),
          j = await one(
            db,
            "SELECT * FROM verification_jobs WHERE upload_id=$1",
            [u.id],
          );
        if (j) job = view(j, upload);
      }
      return {
        contract: V,
        recording: rec,
        upload_id: u?.id || null,
        job,
        availability: ["AVAILABLE", "INVALID", "FAILED"].includes(
          rec.storage_state,
        )
          ? rec.storage_state
          : "PENDING",
      };
    });
  }
  async function claim(owner) {
    return tx(async (db) => {
      const j = await one(
        db,
        "SELECT * FROM verification_jobs WHERE (state='QUEUED' AND not_before<=clock_timestamp()) OR (state='RUNNING' AND lease_until<=clock_timestamp()) ORDER BY created_at LIMIT 1",
      );
      if (!j) return null;
      const u = await getUpload(db, j.upload_id);
      if (!u.active) return null;
      if (j.cycle_attempts >= 3) {
        await db.query(
          "UPDATE verification_jobs SET state='FAILED',completed_at=clock_timestamp(),owner=null,lease_until=null,retryable=true,error=$2,generation=generation+1 WHERE id=$1",
          [
            j.id,
            error("STORAGE_UNAVAILABLE", "Worker retry budget exhausted", true),
          ],
        );
        await touch(db, u.id, { state: "FAILED" });
        await reserve(db, await getUpload(db, u.id));
        return null;
      }
      const updated = await one(
        db,
        "UPDATE verification_jobs SET state='RUNNING',owner=$2,generation=generation+1,lease_until=clock_timestamp()+interval '120 seconds',attempt_number=attempt_number+1,cycle_attempts=cycle_attempts+1,started_at=clock_timestamp(),completed_at=null,error=null,retryable=false WHERE id=$1 RETURNING *",
        [j.id, owner],
      );
      await audit(db, updated, "CLAIM");
      return updated;
    });
  }
  async function guard(db, j, renew = false) {
    const live = await one(
      db,
      "SELECT j.*,u.active,u.state AS upload_state,(j.lease_until>clock_timestamp()) AS lease_live FROM verification_jobs j JOIN uploads u ON u.id=j.upload_id WHERE j.id=$1",
      [j.id],
    );
    if (
      !live ||
      live.owner !== j.owner ||
      Number(live.generation) !== Number(j.generation) ||
      live.state !== "RUNNING" ||
      !live.active ||
      !live.lease_live
    )
      throw new VerificationError(
        "STALE_WORKER",
        "Lease/generation ownership lost",
      );
    if (renew)
      await db.query(
        "UPDATE verification_jobs SET lease_until=clock_timestamp()+interval '120 seconds' WHERE id=$1",
        [j.id],
      );
    return live;
  }
  async function wholeHash(path) {
    let n = 0;
    const h = createHash("sha256");
    for await (const b of createReadStream(path, { highWaterMark: 65536 })) {
      n += b.length;
      h.update(b);
    }
    return { byte_length: n, sha256: h.digest("hex") };
  }
  async function syncDir(path) {
    const d = await open(path, "r");
    try {
      await d.sync();
    } finally {
      await d.close();
    }
  }
  async function faultPoint(j, point) {
    const f = await faults();
    if (f.job_id && f.job_id !== j.id) return;
    if (f.pause_owner && f.pause_owner !== j.owner) return;
    if (f.crash_point === point) process.exit(79);
    if (f.pause_point === point) {
      await tx((db) => audit(db, j, "PAUSE_" + point));
      while (true) {
        await new Promise((r) => setTimeout(r, 50));
        const latest = await faults();
        if (
          latest.pause_point !== point ||
          (latest.job_id && latest.job_id !== j.id)
        )
          break;
      }
    }
  }
  async function run(j) {
    let renewTimer = setInterval(
      () => tx((db) => guard(db, j, true)).catch(() => {}),
      30000,
    );
    try {
      await faultPoint(j, "after_claim");
      let u = await tx(async (db) => {
        await guard(db, j);
        return frozenCheck(
          db,
          await getUpload(db, j.upload_id),
          "worker-preflight",
        );
      });
      if (u.state === "FAILED") return;
      await faultPoint(j, "after_preflight");
      const f = await one(
        pool,
        "SELECT * FROM frozen_manifests WHERE upload_id=$1",
        [u.id],
      );
      const candidate = `${root}/candidates/${j.id}-${j.generation}-${randomUUID()}`;
      await tx(async (db) => {
        await guard(db, j);
        await capacity(db);
      });
      const file = await open(candidate, "wx", 0o600);
      const full = createHash("sha256");
      let total = 0;
      try {
        for (const e of f.entries) {
          let count = 0;
          const ch = createHash("sha256");
          try {
            for await (const b of createReadStream(`${root}/${e.generation}`, {
              highWaterMark: 65536,
            })) {
              count += b.length;
              total += b.length;
              ch.update(b);
              full.update(b);
              let written = 0;
              while (written < b.length) {
                const n = await file.write(b, written, b.length - written);
                written += n.bytesWritten;
              }
            }
          } catch (x) {
            if (x.code === "ENOENT")
              throw Object.assign(
                new VerificationError(
                  "UPLOAD_RESTART_REQUIRED",
                  "Frozen chunk missing during read",
                ),
                {
                  lostChunk: {
                    ...e,
                    observed: { missing: true },
                    newIncident: true,
                  },
                },
              );
            throw x;
          }
          const chunkDigest = ch.digest("hex");
          if (count !== e.byte_length || chunkDigest !== e.sha256)
            throw Object.assign(
              new VerificationError(
                "UPLOAD_RESTART_REQUIRED",
                "Frozen chunk changed during read",
              ),
              {
                lostChunk: {
                  ...e,
                  observed: { byte_length: count, sha256: chunkDigest },
                  newIncident: true,
                },
              },
            );
          await tx(async (db) => {
            await guard(db, j);
            await capacity(db);
          });
        }
        await file.sync();
      } finally {
        await file.close();
      }
      await syncDir(root + "/candidates");
      const observed = { byte_length: total, sha256: full.digest("hex") };
      if (total !== f.expected.byte_length)
        throw new VerificationError(
          "WAV_INVALID",
          "Complete file byte length mismatch",
        );
      if (observed.sha256 !== f.expected.sha256)
        throw new VerificationError(
          "FILE_CHECKSUM_MISMATCH",
          "Whole-file SHA-256 mismatch",
        );
      const verified = { ...observed, ...(await parseWav(candidate, f.expected.format)) };
      await faultPoint(j, "after_candidate");
      await faultPoint(j, "before_publish");
      await tx(async (db) => {
        await guard(db, j, true);
        u = await frozenCheck(
          db,
          await getUpload(db, u.id),
          "publication-guard",
        );
        if (u.state === "FAILED") return;
        await guard(db, j);
        await capacity(db);
        const path = `${root}/canonical/${u.asset_id}.wav`;
        const fault = await faults();
        if (fault.publication_failure)
          throw new Error("Injected publication failure");
        try {
          await link(candidate, path);
          await syncDir(root + "/canonical");
          await audit(db, j, "CANONICAL_LINKED");
        } catch (e) {
          if (e.code !== "EEXIST") throw e;
          const existing = await wholeHash(path);
          if (!equal(existing, observed))
            throw new VerificationError(
              "STORAGE_INTEGRITY_FAILURE",
              "Existing canonical bytes conflict; never overwrite",
            );
          await parseWav(path, u.expected.format);
          await audit(db, j, "CANONICAL_ADOPTED");
        }
        // Re-read the canonical inode independently, even when this worker just linked it.
        const actual = await wholeHash(path);
        if (!equal(actual, observed))
          throw new VerificationError(
            "STORAGE_INTEGRITY_FAILURE",
            "Canonical checksum failed",
          );
        await parseWav(path, u.expected.format);
        await guard(db, j, true);
        await faultPoint(j, "after_canonical");
        const rec = await one(db, "SELECT body FROM recordings WHERE id=$1", [
            u.recording_id,
          ]),
          discrepancies = [];
        for (const field of [
          "duration_seconds",
          "sample_rate_hz",
          "channels",
          "bits_per_sample",
        ]) {
          const reported = rec.body.reported[field];
          if (reported !== null && reported !== verified[field])
            discrepancies.push({
              field,
              reported,
              verified: verified[field],
              code: "REPORTED_METADATA_DIFFERS",
            });
        }
        const inserted = await one(
          db,
          "INSERT INTO canonical_assets(asset_id,verified,discrepancies,storage_key,verified_at,finalized_at) VALUES($1,$2,$3,$4,clock_timestamp(),clock_timestamp()) ON CONFLICT DO NOTHING RETURNING *",
          [
            u.asset_id,
            verified,
            JSON.stringify(discrepancies),
            `canonical/${u.asset_id}.wav`,
          ],
        );
        if (!inserted) {
          const existing = await one(
            db,
            "SELECT * FROM canonical_assets WHERE asset_id=$1",
            [u.asset_id],
          );
          if (!equal(existing.verified, verified))
            throw new VerificationError(
              "STORAGE_INTEGRITY_FAILURE",
              "Canonical metadata conflict",
            );
        }
        await guard(db, j);
        await db.query(
          "UPDATE verification_jobs SET state='SUCCEEDED',completed_at=clock_timestamp(),owner=null,lease_until=null,error=null,retryable=false WHERE id=$1",
          [j.id],
        );
        await touch(db, u.id, { state: "AVAILABLE" });
        await reserve(db, await getUpload(db, u.id));
        await audit(db, j, "AVAILABLE_COMMITTED");
      });
    } catch (e) {
      if (e.code === "STALE_WORKER") {
        await tx((db) => audit(db, j, "STALE_WORKER_REJECTED"));
        return;
      }
      await tx(async (db) => {
        try {
          await guard(db, j);
        } catch {
          return;
        }
        const u = await getUpload(db, j.upload_id);
        if (e.code === "UPLOAD_RESTART_REQUIRED") {
          if (e.lostChunk)
            await loss(db, u, [e.lostChunk], "worker-read-failure");
          else await frozenCheck(db, u, "worker-read-failure");
          return;
        }
        const invalid = [
          "WAV_INVALID",
          "FORMAT_UNSUPPORTED",
          "FILE_CHECKSUM_MISMATCH",
          "DURATION_OUT_OF_POLICY",
        ].includes(e.code);
        const allowed = [
          "WAV_INVALID",
          "FORMAT_UNSUPPORTED",
          "FILE_CHECKSUM_MISMATCH",
          "DURATION_OUT_OF_POLICY",
          "STORAGE_UNAVAILABLE",
          "STORAGE_INTEGRITY_FAILURE",
          "CAPACITY_INSUFFICIENT",
          "DATABASE_UNAVAILABLE",
          "INTERNAL_ERROR",
        ];
        const code = allowed.includes(e.code) ? e.code : "STORAGE_UNAVAILABLE";
        const publicReason = allowed.includes(e.code)
          ? e.message
          : "Storage operation could not complete; see private diagnostics";
        const live = await one(
          db,
          "SELECT * FROM verification_jobs WHERE id=$1",
          [j.id],
        );
        const retry =
          !invalid &&
          code !== "STORAGE_INTEGRITY_FAILURE" &&
          live.cycle_attempts < 3;
        await db.query(
          "UPDATE verification_jobs SET state=$2,owner=null,lease_until=null,completed_at=CASE WHEN $2='QUEUED' THEN null ELSE clock_timestamp() END,error=$3,retryable=$4,not_before=clock_timestamp()+($5*interval '1 second') WHERE id=$1",
          [
            j.id,
            retry ? "QUEUED" : invalid ? "INVALID" : "FAILED",
            error(code, publicReason, !invalid),
            !invalid,
            live.cycle_attempts === 1 ? 30 : 120,
          ],
        );
        if (!retry) {
          await touch(db, u.id, { state: invalid ? "INVALID" : "FAILED" });
          await reserve(db, await getUpload(db, u.id));
        }
        await audit(
          db,
          j,
          retry ? "OPERATIONAL_RETRY" : invalid ? "INVALID" : "FAILED",
          { code, reason: e.message },
        );
      });
    } finally {
      clearInterval(renewTimer);
    }
  }
  return { finalize, jobGet, resultGet, claim, run, guard, faults, view };
}
