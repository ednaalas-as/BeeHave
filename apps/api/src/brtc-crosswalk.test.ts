import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Pool } from "pg";

test("BRTC legacy crosswalk upgrade, independent metadata order and startup replay", async () => {
  const name = "beehave_crosswalk_test_" + randomUUID().replaceAll("-", "");
  const config = { connectionString: process.env.DATABASE_URL,
    host: process.env.PGHOST ?? "localhost", database: process.env.PGDATABASE ?? "beehave" };
  const admin = new Pool(config);
  let pool: Pool | undefined;
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    const url = config.connectionString ? new URL(config.connectionString) : undefined;
    if (url) url.pathname = "/" + name;
    pool = new Pool({ ...config, database: name, connectionString: url?.toString() });
    const schema = await readFile(new URL("./database/schema.sql", import.meta.url), "utf8");
    const migration = await readFile(new URL("./database/migrations/001-brtc-crosswalk.sql", import.meta.url), "utf8");
    const run = async (sql: string) => {
      const c = await pool!.connect();
      try { await c.query("BEGIN"); await c.query(sql); await c.query("COMMIT"); }
      catch (e) { await c.query("ROLLBACK"); throw e; }
      finally { c.release(); }
    };
    await run(schema + migration); // New installation also satisfies the contract.
    await pool.query(`DROP TABLE brtc.beehave_recording_links;
      CREATE TABLE brtc.beehave_recording_links (
        device_id TEXT NOT NULL REFERENCES public.devices(id) ON DELETE RESTRICT,
        beehave_recording_id TEXT NOT NULL,
        brtc_recording_id UUID NOT NULL UNIQUE REFERENCES brtc.recordings(id) ON DELETE RESTRICT,
        asset_id UUID NOT NULL UNIQUE REFERENCES brtc.assets(id) ON DELETE RESTRICT,
        source_recording_key TEXT NOT NULL,
        PRIMARY KEY(device_id, beehave_recording_id),
        FOREIGN KEY(device_id, beehave_recording_id) REFERENCES public.recordings(device_id,id) ON DELETE RESTRICT
      )`);
    await run(migration);
    const indexes = (await pool.query("SELECT indexdef FROM pg_indexes WHERE schemaname='brtc' AND tablename='beehave_recording_links' ORDER BY indexdef")).rows;
    assert.equal(indexes.length, 4);
    await run(migration);
    assert.deepEqual((await pool.query("SELECT indexdef FROM pg_indexes WHERE schemaname='brtc' AND tablename='beehave_recording_links' ORDER BY indexdef")).rows, indexes);
    await pool.query(`INSERT INTO farms VALUES('farm','synthetic crosswalk test',false);
      INSERT INTO devices(id,farm_id,name,location,model,key_hash) VALUES('device','farm','test','test','test','not-a-credential');
      INSERT INTO brtc.devices VALUES('device','farm',true)`);
    const session = randomUUID(), source = randomUUID(), recording = randomUUID(), asset = randomUUID();
    await pool.query("INSERT INTO brtc.sessions(id,device_id,source_key,body) VALUES($1,'device',$2,'{}')", [session, source]);
    await pool.query("INSERT INTO brtc.recordings(id,session_id,part,source_key,asset_id,body) VALUES($1,$2,1,'part:0',$3,'{}')", [recording, session, asset]);
    await pool.query("INSERT INTO brtc.assets VALUES($1,$2,'{}')", [asset, recording]);
    const insert = "INSERT INTO brtc.beehave_recording_links VALUES('device','bee-recording',$1,$2,'part:0',$3)";
    await pool.query(insert, [recording, asset, source]);
    assert.equal((await pool.query("SELECT count(*)::int n FROM public.recordings")).rows[0].n, 0);
    await assert.rejects(pool.query(insert, [recording, asset, source]), { code: "23505" });
    await assert.rejects(pool.query("DELETE FROM brtc.assets WHERE id=$1", [asset]), { code: "23503" });
    await assert.rejects(pool.query("DELETE FROM brtc.recordings WHERE id=$1", [recording]), { code: "23503" });
    const before = (await pool.query("SELECT * FROM brtc.beehave_recording_links")).rows;
    await run(schema + migration); // Replay startup with populated valid state.
    await run(schema + migration);
    assert.deepEqual((await pool.query("SELECT * FROM brtc.beehave_recording_links")).rows, before);
    await pool.query("INSERT INTO public.recordings VALUES('bee-recording','device',now(),'{}',NULL)");
    assert.equal((await pool.query("SELECT count(*)::int n FROM brtc.beehave_recording_links")).rows[0].n, 1);
    // Unknown incompatible layouts are rejected transactionally.
    await pool.query("ALTER TABLE brtc.beehave_recording_links ADD COLUMN unexpected TEXT");
    await assert.rejects(run(migration), /columns do not match/);
  } finally {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.end();
  }
});
