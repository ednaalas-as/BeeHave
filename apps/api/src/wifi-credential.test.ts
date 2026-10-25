import { sealWifiPassword, wifiCredentialAad, wifiCredentialSchema, WIFI_CREDENTIAL_INFO } from "@beehave/shared/wifi-credential";
import { gcm } from "@noble/ciphers/aes";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

const random = (n: number) => new Uint8Array(randomBytes(n));
// The device side, as the Pi's setup service does it.
function open(privateKey: Uint8Array, envelope: { epk: string; nonce: string; ct: string }, commandId: string, ssid: string) {
  const devicePublic = x25519.getPublicKey(privateKey);
  const epk = hexToBytes(envelope.epk);
  const key = hkdf(sha256, x25519.getSharedSecret(privateKey, epk), new Uint8Array([...epk, ...devicePublic]), utf8ToBytes(WIFI_CREDENTIAL_INFO), 32);
  return new TextDecoder().decode(gcm(key, hexToBytes(envelope.nonce), wifiCredentialAad(commandId, ssid)).decrypt(hexToBytes(envelope.ct)));
}

test("a sealed Wi-Fi password opens only with the device key, for that request and network", () => {
  const devicePrivate = random(32);
  const devicePublic = bytesToHex(x25519.getPublicKey(devicePrivate));
  const sealed = sealWifiPassword(devicePublic, "synthetic pass 123", "cmd-1", "Farm WiFi", random);
  assert.ok(wifiCredentialSchema.safeParse(sealed).success);
  assert.doesNotMatch(JSON.stringify(sealed), /synthetic/);
  assert.equal(open(devicePrivate, sealed, "cmd-1", "Farm WiFi"), "synthetic pass 123");
  assert.throws(() => open(devicePrivate, sealed, "cmd-2", "Farm WiFi"));
  assert.throws(() => open(devicePrivate, sealed, "cmd-1", "Other WiFi"));
  assert.throws(() => open(random(32), sealed, "cmd-1", "Farm WiFi"));
  // Every seal uses a fresh key and nonce.
  const again = sealWifiPassword(devicePublic, "synthetic pass 123", "cmd-1", "Farm WiFi", random);
  assert.notEqual(again.epk, sealed.epk);
  assert.notEqual(again.ct, sealed.ct);
  // The longest WPA passphrase fits the schema.
  assert.ok(wifiCredentialSchema.safeParse(sealWifiPassword(devicePublic, "x".repeat(63), "cmd-1", "Farm WiFi", random)).success);
});
