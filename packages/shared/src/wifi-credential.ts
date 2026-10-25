import { gcm } from "@noble/ciphers/aes";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { z } from "zod";

/**
 * A Wi-Fi password sealed to one Pi. The browser or phone encrypts it to the public key the
 * Pi's setup service publishes; only that service holds the private key. BeeHave's API and
 * database only ever see this envelope, and it is wiped once the device claims the request.
 *
 * X25519 (fresh key per password) → HKDF-SHA256 → AES-256-GCM. The associated data binds the
 * envelope to one request and one network name, so it cannot be replayed into another request.
 * Pure JavaScript, so it also works on plain-HTTP pages and in React Native.
 */
export const WIFI_CREDENTIAL_INFO = "beehave-wifi-credential-v1";
export const wifiCredentialSchema = z.object({
  v: z.literal(1),
  epk: z.string().regex(/^[0-9a-f]{64}$/),
  nonce: z.string().regex(/^[0-9a-f]{24}$/),
  // A 63-byte WPA passphrase plus the 16-byte tag, hex encoded.
  ct: z.string().regex(/^[0-9a-f]{34,158}$/),
});
export type WifiCredential = z.infer<typeof wifiCredentialSchema>;

export const wifiCredentialAad = (commandId: string, ssid: string) =>
  utf8ToBytes(`beehave-wifi-v1\n${commandId}\n${ssid}`);

export function sealWifiPassword(
  devicePublicKeyHex: string,
  password: string,
  commandId: string,
  ssid: string,
  // Caller's secure random source: crypto.getRandomValues on the web, expo-crypto on mobile.
  randomBytes: (length: number) => Uint8Array,
): WifiCredential {
  const devicePublic = hexToBytes(devicePublicKeyHex);
  const ephemeralPrivate = randomBytes(32);
  const ephemeralPublic = x25519.getPublicKey(ephemeralPrivate);
  const shared = x25519.getSharedSecret(ephemeralPrivate, devicePublic);
  const salt = new Uint8Array([...ephemeralPublic, ...devicePublic]);
  const key = hkdf(sha256, shared, salt, utf8ToBytes(WIFI_CREDENTIAL_INFO), 32);
  const nonce = randomBytes(12);
  const ct = gcm(key, nonce, wifiCredentialAad(commandId, ssid)).encrypt(utf8ToBytes(password));
  ephemeralPrivate.fill(0);
  key.fill(0);
  return { v: 1, epk: bytesToHex(ephemeralPublic), nonce: bytesToHex(nonce), ct: bytesToHex(ct) };
}
