import { gcm } from "@noble/ciphers/aes";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

export type NearbyPi = { id: string; name: string; url: string };
export type PairingSession = {
  session: string;
  deviceId: string;
  challenge: string | null;
  expires: number;
  completed: boolean;
  farm?: string;
};
type Api = <T>(path: string, options?: RequestInit) => Promise<T>;
// Avoid relying on TextEncoder/TextDecoder availability in native runtimes.
const encode = (s: string) =>
  Uint8Array.from(unescape(encodeURIComponent(s)), (c) => c.charCodeAt(0));
const decode = (b: Uint8Array) =>
  decodeURIComponent(
    escape(Array.from(b, (n) => String.fromCharCode(n)).join("")),
  );
export function setupKey(code: string) {
  const normalized = code.replace(/[\s-]/g, "").toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(normalized))
    throw new Error(
      "Enter the 32-character setup code from this Pi’s setup label (in BeeHave: Edge Device → Advanced settings → Setup label).",
    );
  return sha256(encode(`beehave-local-v1\n${normalized}`));
}
export function sealSetup(
  key: Uint8Array,
  nonce: string,
  value: unknown,
  response = false,
) {
  return bytesToHex(
    gcm(
      key,
      hexToBytes(nonce).slice(response ? 12 : 0, response ? 24 : 12),
    ).encrypt(encode(JSON.stringify(value))),
  );
}
export function openSetup(
  key: Uint8Array,
  nonce: string,
  value: string,
  response = false,
) {
  return JSON.parse(
    decode(
      gcm(
        key,
        hexToBytes(nonce).slice(response ? 12 : 0, response ? 24 : 12),
      ).decrypt(hexToBytes(value)),
    ),
  );
}
export async function localRequest<T>(
  url: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const target = new URL(url);
  if (
    target.protocol !== "http:" ||
    target.port !== "8765" ||
    !/^[a-z0-9-]+\.local$/i.test(target.hostname)
  )
    throw new Error("Use the Pi’s .local setup address on port 8765.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(target.origin + path, {
      method: body ? "POST" : "GET",
      credentials: "omit",
      signal: controller.signal,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      // Supporting browsers explicitly gate local-network access with permission.
      ...({ targetAddressSpace: "local" } as object),
    });
    if (!response.ok)
      throw new Error(
        "Could not connect to this Pi. Check the setup code and nearby connection.",
      );
    return await response.json();
  } catch (error) {
    if (error instanceof TypeError || (error as Error).name === "AbortError")
      throw new Error(
        "Cannot reach the nearby Pi. Join its network and allow local-network access. If this browser blocks local setup, use the BeeHave mobile app.",
      );
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
export async function setupCommand<T>(
  url: string,
  code: string,
  command: unknown,
  random: (size: number) => Uint8Array = (size) =>
    crypto.getRandomValues(new Uint8Array(size)),
): Promise<T> {
  const rootKey = setupKey(code);
  const { nonce } = await localRequest<{ nonce: string }>(url, "/challenge");
  if (!/^[a-f0-9]{48}$/.test(nonce))
    throw new Error("Invalid Pi setup response.");
  // Client entropy prevents an unauthenticated challenge response from forcing nonce reuse.
  const clientNonce = random(32);
  const key = hkdf(sha256, rootKey, hexToBytes(nonce), clientNonce, 32);
  const reply = await localRequest<{ ciphertext: string }>(url, "/command", {
    nonce,
    clientNonce: bytesToHex(clientNonce),
    ciphertext: sealSetup(key, nonce, command),
  });
  let result;
  try {
    result = openSetup(key, nonce, reply.ciphertext, true);
  } catch {
    throw new Error("The Pi could not be verified. Check its setup code.");
  }
  if (result.error) throw new Error(result.error);
  return result;
}
export async function pairNearby(
  api: Api,
  pi: NearbyPi,
  code: string,
  name: string,
  location: string,
  random?: (size: number) => Uint8Array,
) {
  let { ticket } = await setupCommand<{ ticket: { keyHash: string } }>(
    pi.url,
    code,
    { action: "invite" },
    random,
  );
  let result = await api<PairingSession | { resetRequired: true }>(
    "/pairing/start",
    {
      method: "POST",
      body: JSON.stringify({ ticket, name, location }),
    },
  );
  if ("resetRequired" in result) {
    try {
      await setupCommand(
        pi.url,
        code,
        { action: "release", keyHash: ticket.keyHash },
        random,
      );
    } catch (error) {
      if ((error as Error).message === "Unsupported setup operation")
        throw new Error(
          "Update the Pi’s BeeHave setup service before pairing it again. Its previous credential remains revoked.",
        );
      throw error;
    }
    ({ ticket } = await setupCommand<{ ticket: { keyHash: string } }>(
      pi.url,
      code,
      { action: "invite" },
      random,
    ));
    result = await api<PairingSession | { resetRequired: true }>(
      "/pairing/start",
      {
        method: "POST",
        body: JSON.stringify({ ticket, name, location }),
      },
    );
    if ("resetRequired" in result)
      throw new Error(
        "The Pi could not prepare a fresh credential. Retry nearby pairing.",
      );
  }
  const session = result;
  if (!session.completed) {
    const proof = await setupCommand<{ signature: string }>(
      pi.url,
      code,
      { action: "confirm", ...session },
      random,
    );
    await api<PairingSession>("/pairing/complete", {
      method: "POST",
      body: JSON.stringify({
        session: session.session,
        signature: proof.signature,
      }),
    });
  }
  await setupCommand(
    pi.url,
    code,
    {
      action: "finished",
      session: session.session,
      deviceId: session.deviceId,
    },
    random,
  );
  return session.deviceId;
}
