import { randomUUID } from "node:crypto";
import { hashCode, hashToken, newCode, newToken } from "./auth";
import { openDatabase } from "./database";
// Provisions an unclaimed Edge Device: no farm, and a key that only starts working once a farm
// owner claims the device with its pairing code (Edge devices → Register Device → pairing code).
// Install the key on the Pi as you would a manually registered device key; put the device ID
// and pairing code on the device's label.
const db = openDatabase();
await db.initialize();
const uid = process.argv[2] ?? randomUUID();
if (!/^[A-Za-z0-9._-]{4,100}$/.test(uid)) {
  console.error("Use a device ID of 4–100 letters, digits, dots, dashes or underscores, or leave it out.");
  process.exit(1);
}
const key = newToken();
const code = newCode();
const added = await db.one(
  `INSERT INTO device_registry (device_uid, key_hash, claim_code_hash)
  SELECT $1,$2,$3 WHERE NOT EXISTS (SELECT 1 FROM devices WHERE id=$1)
  ON CONFLICT DO NOTHING RETURNING device_uid`,
  [uid, hashToken(key), hashCode(code)],
);
await db.close();
if (!added) {
  console.error("A device with this ID already exists.");
  process.exit(1);
}
console.log(`Device ID:    ${uid}\nStatus:       unclaimed (no farm)\nPairing code: ${code}\nDevice key:   ${key}`);
console.log("The key is shown once. Store it on the Pi only; the pairing code goes on the device label.");
