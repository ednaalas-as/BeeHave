import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createApp } from "./app";
import { openDatabase } from "./database";

// Behind Caddy on the same host, only the loopback hop is trusted for client addresses.
test("TRUST_PROXY trusts only the configured hop; unset keeps direct connections", async () => {
  const schema = "beehave_test_" + randomUUID().replaceAll("-", "");
  const administrator = openDatabase();
  await administrator.execute(`CREATE SCHEMA ${schema}`);
  const previous = process.env.TRUST_PROXY;
  try {
    delete process.env.TRUST_PROXY;
    const direct = await createApp(schema);
    const directTrust = direct.app.get("trust proxy fn") as (address: string, hop: number) => boolean;
    assert.equal(directTrust("127.0.0.1", 0), false);
    await direct.db.close();

    process.env.TRUST_PROXY = "loopback";
    const proxied = await createApp(schema);
    const trust = proxied.app.get("trust proxy fn") as (address: string, hop: number) => boolean;
    assert.equal(trust("127.0.0.1", 0), true);
    assert.equal(trust("203.0.113.9", 0), false);
    await proxied.db.close();
  } finally {
    if (previous === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = previous;
    await administrator.execute(`DROP SCHEMA ${schema} CASCADE`);
    await administrator.close();
  }
});
