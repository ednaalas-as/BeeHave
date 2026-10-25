import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
// Setup labels are sealed with AES-256-GCM and bound to their device ID. The key comes from
// SETUP_LABEL_KEY (64 hex characters) or a key file created once next to the API's data
// (data/setup-label.key, owner-only). Test schemas use a key that lives only in memory.
type Label = { hotspot: string; hotspotPassword: string; code: string };
const KEY_FILE = resolve("data/setup-label.key");
function loadKey(): Buffer {
  const configured = process.env.SETUP_LABEL_KEY;
  if (configured) {
    if (!/^[0-9a-f]{64}$/i.test(configured)) throw new Error("SETUP_LABEL_KEY must be 64 hex characters.");
    return Buffer.from(configured, "hex");
  }
  try {
    return Buffer.from(readFileSync(KEY_FILE, "utf8").trim(), "hex");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const key = randomBytes(32);
    mkdirSync(dirname(KEY_FILE), { recursive: true });
    writeFileSync(KEY_FILE, key.toString("hex") + "\n", { mode: 0o600, flag: "wx" });
    return key;
  }
}
export function createSetupLabelSealer(ephemeral: boolean) {
  let key: Buffer | undefined = ephemeral ? randomBytes(32) : undefined;
  const current = () => (key ??= loadKey());
  return {
    seal(deviceId: string, label: Label) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", current(), nonce).setAAD(Buffer.from(deviceId));
      const body = Buffer.concat([cipher.update(JSON.stringify(label)), cipher.final()]);
      return ["v1", nonce, body, cipher.getAuthTag()].map((part) => (typeof part === "string" ? part : part.toString("base64"))).join(".");
    },
    open(deviceId: string, sealed: string): Label {
      const [version, nonce, body, tag] = sealed.split(".");
      if (version !== "v1") throw new Error("Unsupported setup label");
      const decipher = createDecipheriv("aes-256-gcm", current(), Buffer.from(nonce, "base64"))
        .setAAD(Buffer.from(deviceId))
        .setAuthTag(Buffer.from(tag, "base64"));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString());
    },
  };
}
