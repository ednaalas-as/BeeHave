import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";
import { test } from "node:test";
import { createApp } from "./app";
import { openDatabase } from "./database";

test("nearby pairing: signature, farm isolation, expiry, recovery, and no monitoring writes", async () => {
  const schema = "beehave_test_" + randomUUID().replaceAll("-", "");
  const admin = openDatabase();
  await admin.execute(`CREATE SCHEMA ${schema}`);
  const { app, db } = await createApp(schema);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/api`;
  const post = (path: string, body: unknown, token?: string) =>
    fetch(base + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: "Bearer " + token } : {}),
      },
      body: JSON.stringify(body),
    });
  const user = async (email: string) =>
    (
      await (
        await post("/auth/register", {
          name: "Test owner",
          farm: email,
          email,
          password: "strong-test-password",
          platform: "native",
        })
      ).json()
    ).token as string;
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const key = randomBytes(32).toString("hex");
  const keyHash = createHash("sha256").update(key).digest("hex");
  const ticket = (expires = Date.now() + 600000) => {
    const nonce = randomBytes(32).toString("hex");
    return {
      publicKey: publicKey
        .export({ format: "der", type: "spki" })
        .toString("hex"),
      nonce,
      keyHash,
      expires,
      signature: sign(
        null,
        Buffer.from(`beehave-pair-v1\n${nonce}\n${keyHash}\n${expires}`),
        privateKey,
      ).toString("hex"),
    };
  };
  try {
    const owner = await user("owner@example.com");
    const other = await user("other@example.com");
    const input = {
      name: "Nearby station",
      location: "Hive 1",
      ticket: ticket(),
    };
    assert.equal((await post("/pairing/start", input)).status, 401);
    assert.equal(
      (
        await post(
          "/pairing/start",
          { ...input, ticket: { ...input.ticket, signature: "0".repeat(128) } },
          owner,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await post(
          "/pairing/start",
          { ...input, ticket: ticket(Date.now() - 1) },
          owner,
        )
      ).status,
      400,
    );
    const start = await post("/pairing/start", input, owner);
    assert.equal(start.status, 200);
    const session = await start.json();
    const retry = await (
      await post("/pairing/start", { ...input, ticket: ticket() }, owner)
    ).json();
    assert.equal(session.session, retry.session);
    assert.equal((await post("/pairing/start", input, other)).status, 409);
    assert.equal((await db.many("SELECT * FROM devices")).length, 0);
    const proof = {
      session: session.session,
      signature: sign(
        null,
        Buffer.from(
          `beehave-confirm-v1\n${session.session}\n${session.challenge}\n${session.deviceId}\n${keyHash}`,
        ),
        privateKey,
      ).toString("hex"),
    };
    assert.equal((await post("/pairing/complete", proof, other)).status, 404);
    assert.equal(
      (
        await post(
          "/pairing/complete",
          { ...proof, signature: "0".repeat(128) },
          owner,
        )
      ).status,
      400,
    );
    const completed = await Promise.all([
      post("/pairing/complete", proof, owner),
      post("/pairing/complete", proof, owner),
    ]);
    assert.deepEqual(
      completed.map((r) => r.status),
      [200, 200],
    );
    const devices = await db.many("SELECT * FROM devices");
    assert.equal(devices.length, 1);
    assert.equal(devices[0].key_hash, keyHash);
    assert.equal(devices[0].last_seen, null);
    const recovered = await (
      await post("/pairing/start", { ...input, ticket: ticket() }, owner)
    ).json();
    assert.equal(recovered.completed, true);
    const stored = await db.one("SELECT * FROM device_pairings");
    assert.equal(stored?.challenge, null);
    assert.equal(stored?.nonce, null);
    assert(!JSON.stringify(stored).includes(key));
    for (const table of ["readings", "recordings", "detections"])
      assert.equal((await db.many(`SELECT * FROM ${table}`)).length, 0);
    // Disconnect ends claims, rejects old proofs, and forces a fresh Pi credential.
    assert.equal(
      (
        await post(
          `/devices/${session.deviceId}/unpair`,
          { confirm: true },
          owner,
        )
      ).status,
      200,
    );
    assert.equal((await post("/pairing/complete", proof, owner)).status, 410);
    assert.equal(
      (
        await (
          await post("/pairing/start", { ...input, ticket: ticket() }, other)
        ).json()
      ).resetRequired,
      true,
    );
    assert.equal(
      (
        await post(
          `/devices/${session.deviceId}/delete`,
          { confirm: true },
          owner,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await (
          await post("/pairing/start", { ...input, ticket: ticket() }, other)
        ).json()
      ).resetRequired,
      true,
    );
    const freshHash = createHash("sha256")
      .update(randomBytes(32))
      .digest("hex");
    const freshTicket = ticket();
    freshTicket.keyHash = freshHash;
    freshTicket.signature = sign(
      null,
      Buffer.from(
        `beehave-pair-v1\n${freshTicket.nonce}\n${freshHash}\n${freshTicket.expires}`,
      ),
      privateKey,
    ).toString("hex");
    const next = await (
      await post("/pairing/start", { ...input, ticket: freshTicket }, other)
    ).json();
    assert.notEqual(next.deviceId, session.deviceId);
    const nextProof = {
      session: next.session,
      signature: sign(
        null,
        Buffer.from(
          `beehave-confirm-v1\n${next.session}\n${next.challenge}\n${next.deviceId}\n${freshHash}`,
        ),
        privateKey,
      ).toString("hex"),
    };
    assert.equal(
      (await post("/pairing/complete", nextProof, other)).status,
      200,
    );
    assert.equal(
      (await post("/pairing/start", { ...input, ticket: ticket() }, owner))
        .status,
      409,
    );
    // Legacy registration behavior remains available and returns a key once.
    const legacy = await post(
      "/devices",
      { name: "Legacy station", location: "Hive 2" },
      owner,
    );
    assert.equal(legacy.status, 201);
    assert((await legacy.json()).key);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await db.close();
    await admin.execute(`DROP SCHEMA ${schema} CASCADE`);
    await admin.close();
  }
});
