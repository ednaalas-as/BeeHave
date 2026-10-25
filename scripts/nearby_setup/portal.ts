import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { openSetup, sealSetup, setupKey } from "../../packages/shared/src/nearby";

type Network = { ssid: string; signal: number; security: string };
type WifiStatus = { state?: string; stage?: string; ssid?: string; message?: string };

const form = document.querySelector<HTMLFormElement>("form")!;
const status = document.querySelector<HTMLElement>("[role=status]")!;
const list = document.querySelector<HTMLElement>("#networks")!;
const next = document.querySelector<HTMLElement>("#next")!;
const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
const buttons = () => Array.from(document.querySelectorAll<HTMLButtonElement>("button"));

// Same-origin requests to this Pi, so the page works at http://192.168.77.1:8765 as
// well as the .local name. Every command is encrypted with the label's setup code.
async function post<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: body ? "POST" : "GET",
    credentials: "omit",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new Error("The Pi rejected the request. Check the setup code and try again.");
  return response.json();
}
async function command<T>(value: unknown): Promise<T> {
  const rootKey = setupKey(field("code").value);
  const { nonce } = await post<{ nonce: string }>("/challenge");
  const clientNonce = crypto.getRandomValues(new Uint8Array(32));
  const key = hkdf(sha256, rootKey, hexToBytes(nonce), clientNonce, 32);
  const reply = await post<{ ciphertext: string }>("/command", {
    nonce, clientNonce: bytesToHex(clientNonce), ciphertext: sealSetup(key, nonce, value),
  });
  let result;
  try { result = openSetup(key, nonce, reply.ciphertext, true); }
  catch { throw new Error("The Pi could not be verified. Check its setup code."); }
  if (result.error) throw new Error(result.error);
  return result as T;
}
async function busy(message: string, work: () => Promise<void>) {
  buttons().forEach(b => (b.disabled = true));
  status.textContent = message;
  try { await work(); }
  catch (error) { status.textContent = (error as Error).message; }
  finally { buttons().forEach(b => (b.disabled = false)); }
}

const strength = (signal: number) => (signal >= 67 ? "Strong" : signal >= 34 ? "Medium" : "Weak");
const describe = (security: string) =>
  security === "open" ? "Open" : security === "enterprise" ? "Enterprise (not supported)" : "Secured";
function choose(network: Network) {
  field("ssid").value = network.ssid;
  field("open").checked = network.security === "open";
  field("hidden").checked = false;
  syncOpen();
  (network.security === "open" ? field("priority") : field("password")).focus();
}
function syncOpen() {
  const open = field("open").checked;
  field("password").disabled = open;
  field("password").required = !open;
  if (open) field("password").value = "";
}
field("open").addEventListener("change", syncOpen);

document.querySelector<HTMLButtonElement>("#scan")!.addEventListener("click", () =>
  void busy("Looking for Wi-Fi networks…", async () => {
    const result = await command<{ networks: Network[]; scannedAt: number; cached: boolean }>({ action: "scan" });
    list.replaceChildren(...result.networks.map(network => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "network";
      item.disabled = network.security === "enterprise";
      const name = document.createElement("strong");
      name.textContent = network.ssid;
      const detail = document.createElement("span");
      detail.textContent = `${strength(network.signal)} · ${describe(network.security)}`;
      item.append(name, detail);
      item.addEventListener("click", () => choose(network));
      return item;
    }));
    const when = result.scannedAt ? new Date(result.scannedAt * 1000).toLocaleTimeString() : "";
    status.textContent = !result.networks.length
      ? "No networks found yet. Type the network name below (tick Hidden network if it does not broadcast its name)."
      : result.cached ? `Networks seen at ${when}, before setup mode started. Choose one or type a name.` : "Choose a network.";
  }));

// The last attempt in plain words: after the hotspot returns, this is where its reason shows.
function describeStatus(wifi: WifiStatus) {
  if (wifi.state === "failed") return `Could not connect to ${wifi.ssid}. ${wifi.message ?? ""} Nothing was changed; check the details and try again.`;
  if (wifi.state === "connected") return `Last attempt: ${wifi.message}`;
  if (wifi.state === "connecting") return wifi.message ?? "The Pi is still trying to connect.";
  if (wifi.state === "interrupted") return "The last Wi-Fi change was interrupted (the Pi restarted). Try again.";
  return "No Wi-Fi change has been made from this page yet.";
}
const checkStatus = () =>
  busy("Checking…", async () => {
    const result = await command<{ wifi: WifiStatus }>({ action: "status" });
    status.textContent = describeStatus(result.wifi);
  });
document.querySelector<HTMLButtonElement>("#check")!.addEventListener("click", () => void checkStatus());
// Back on the hotspot after a failed attempt: entering the setup code shows why straight away.
field("code").addEventListener("change", () => {
  if (field("code").value.replace(/[\s-]/g, "").length === 32) void checkStatus();
});

form.addEventListener("submit", event => {
  event.preventDefault();
  void busy("Sending to the Pi…", async () => {
    const priority = field("priority").value.trim();
    const result = await command<{ message: string }>({
      action: "wifi",
      ssid: field("ssid").value,
      password: field("open").checked ? "" : field("password").value,
      ...(field("open").checked ? { open: true } : {}),
      ...(field("hidden").checked ? { hidden: true } : {}),
      ...(priority ? { priority: Number(priority) } : {}),
    });
    field("password").value = "";
    status.textContent = result.message;
    document.querySelector<HTMLElement>("#next-ssid")!.textContent = field("ssid").value;
    next.hidden = false;
    next.scrollIntoView({ behavior: "smooth", block: "start" });
  });
});
