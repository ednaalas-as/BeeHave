import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { newToken } from "../auth";
import type { RouteContext } from "../context";
import { HttpError } from "../types";

const hex = z.string().regex(/^[a-f0-9]{64}$/);
const ticketSchema = z.object({
  publicKey: z.string().regex(/^[a-f0-9]{88}$/),
  nonce: hex,
  keyHash: hex,
  expires: z.number().int(),
  signature: z.string().regex(/^[a-f0-9]{128}$/),
});
type Pairing = {
  id: string;
  setup_id: string;
  farm_id: string;
  device_id: string;
  public_key: string;
  key_hash: string;
  nonce: string;
  challenge: string | null;
  expires: string;
  completed: boolean;
  released: boolean;
  revoked_keys: string[];
  name: string;
  location: string;
};
function signed(publicKey: string, message: string, signature: string) {
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKey, "hex"),
      format: "der",
      type: "spki",
    });
    return (
      key.asymmetricKeyType === "ed25519" &&
      verify(null, Buffer.from(message), key, Buffer.from(signature, "hex"))
    );
  } catch {
    return false;
  }
}
const response = (row: Pairing) => ({
  session: row.id,
  deviceId: row.device_id,
  challenge: row.challenge,
  expires: Number(row.expires),
  completed: row.completed,
});

export function registerPairingRoutes({ app, db, authenticate, farmAccess }: RouteContext) {
  const limit = rateLimit({
    windowMs: 60_000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.post("/api/pairing/start", limit, async (req, res) => {
    const account = await authenticate(req);
    // The Pi joins the selected farm, and only an owner of that farm can add it.
    const farm = await farmAccess(req, account, "control");
    const input = z
      .object({
        ticket: ticketSchema,
        name: z.string().trim().min(2).max(100),
        location: z.string().trim().min(2).max(100),
      })
      .parse(req.body);
    const t = input.ticket;
    if (
      t.expires <= Date.now() ||
      t.expires > Date.now() + 11 * 60_000 ||
      !signed(
        t.publicKey,
        `beehave-pair-v1\n${t.nonce}\n${t.keyHash}\n${t.expires}`,
        t.signature,
      )
    ) {
      throw new HttpError(
        400,
        "The Pi’s pairing invitation is invalid or expired. Connect to it again.",
      );
    }
    const identity = createHash("sha256")
      .update(Buffer.from(t.publicKey, "hex"))
      .digest("hex");
    await db.execute(
      "DELETE FROM device_pairings WHERE completed=FALSE AND released=FALSE AND expires <= $1",
      [Date.now()],
    );
    const result = await db.transaction(async (tx) => {
      // Serializes retries and simultaneous claims for this Pi, across API instances.
      await tx.execute(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [identity],
      );
      const old = await tx.one<Pairing>(
        "SELECT * FROM device_pairings WHERE setup_id=$1 FOR UPDATE",
        [identity],
      );
      if (
        old?.released &&
        (old.key_hash === t.keyHash || old.revoked_keys.includes(t.keyHash))
      ) {
        return { resetRequired: true as const };
      }
      if (
        old &&
        !old.released &&
        (old.completed || Number(old.expires) > Date.now())
      ) {
        if (old.farm_id !== farm.farmId || old.key_hash !== t.keyHash)
          throw new HttpError(
            409,
            "This Pi is already paired or has an active pairing with another farm. No registration was changed.",
          );
        return old;
      }
      const row = {
        id: randomUUID(),
        setup_id: identity,
        farm_id: farm.farmId,
        device_id: randomUUID(),
        public_key: t.publicKey,
        key_hash: t.keyHash,
        nonce: t.nonce,
        challenge: newToken(),
        expires: String(t.expires),
        completed: false,
        released: false,
        revoked_keys: old?.revoked_keys ?? [],
        name: input.name,
        location: input.location,
      };
      await tx.execute(
        `INSERT INTO device_pairings (id,setup_id,farm_id,device_id,public_key,key_hash,nonce,challenge,expires,completed,name,location)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,FALSE,$10,$11)
        ON CONFLICT(setup_id) DO UPDATE SET id=EXCLUDED.id,farm_id=EXCLUDED.farm_id,device_id=EXCLUDED.device_id,
        public_key=EXCLUDED.public_key,key_hash=EXCLUDED.key_hash,nonce=EXCLUDED.nonce,challenge=EXCLUDED.challenge,
        expires=EXCLUDED.expires,completed=FALSE,released=FALSE,name=EXCLUDED.name,location=EXCLUDED.location`,
        [
          row.id,
          identity,
          row.farm_id,
          row.device_id,
          row.public_key,
          row.key_hash,
          row.nonce,
          row.challenge,
          row.expires,
          row.name,
          row.location,
        ],
      );
      return row;
    });
    if ("resetRequired" in result) {
      res.json(result);
      return;
    }
    res.json({ ...response(result), farm: farm.farmName });
  });
  app.post("/api/pairing/complete", limit, async (req, res) => {
    const account = await authenticate(req);
    const farm = await farmAccess(req, account, "control");
    const input = z
      .object({
        session: z.string().uuid(),
        signature: z.string().regex(/^[a-f0-9]{128}$/),
      })
      .parse(req.body);
    const result = await db.transaction(async (tx) => {
      const row = await tx.one<Pairing>(
        "SELECT * FROM device_pairings WHERE id=$1 AND farm_id=$2 FOR UPDATE",
        [input.session, farm.farmId],
      );
      if (!row)
        throw new HttpError(404, "Pairing session not found for this farm.");
      if (row.released)
        throw new HttpError(
          410,
          "This device was disconnected. Start a new nearby pairing.",
        );
      if (row.completed) return response(row);
      if (Number(row.expires) <= Date.now())
        throw new HttpError(410, "Pairing expired. Connect to the Pi again.");
      if (
        !signed(
          row.public_key,
          `beehave-confirm-v1\n${row.id}\n${row.challenge}\n${row.device_id}\n${row.key_hash}`,
          input.signature,
        )
      )
        throw new HttpError(
          400,
          "The Pi did not confirm its credential. Retry the nearby connection.",
        );
      await tx.execute(
        `INSERT INTO devices (id,farm_id,name,location,model,key_hash,last_seen,last_sync,health)
        VALUES($1,$2,$3,$4,'Raspberry Pi', $5,NULL,NULL,NULL)`,
        [row.device_id, row.farm_id, row.name, row.location, row.key_hash],
      );
      await tx.execute(
        "UPDATE device_pairings SET completed=TRUE,challenge=NULL,nonce=NULL WHERE id=$1",
        [row.id],
      );
      return response({ ...row, completed: true, challenge: null });
    });
    res.json(result);
  });
}
