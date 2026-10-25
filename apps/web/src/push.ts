import type { NotificationConfig } from "@beehave/shared";
import { api } from "./api";

// Web Push for this browser. Permission is asked only when someone turns notifications on in
// Settings, never on page load. Turning it on is remembered per account, so another account
// signing in on the same browser does not start receiving the first account's notifications.
export type PushState =
  | "unsupported" // no service worker / Push API
  | "insecure" // plain HTTP: browsers allow Web Push only on HTTPS or localhost
  | "unconfigured" // the API has no VAPID keys
  | "denied" // blocked in the browser's site settings
  | "off"
  | "on";

const optInKey = (account: string) => `beehave.push.${account}`;
function optedIn(account: string) {
  try {
    return localStorage.getItem(optInKey(account)) === "on";
  } catch {
    return false;
  }
}
function remember(account: string, on: boolean) {
  try {
    if (on) localStorage.setItem(optInKey(account), "on");
    else localStorage.removeItem(optInKey(account));
  } catch {
    // Still applies for this visit; the server keeps the subscription either way.
  }
}

const supported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

// The VAPID public key arrives base64url-encoded; the Push API wants its bytes.
function keyBytes(key: string) {
  const base64 = (key + "=".repeat((4 - (key.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

async function currentSubscription() {
  const registration = await navigator.serviceWorker.getRegistration("/");
  return registration ? registration.pushManager.getSubscription() : null;
}

export async function pushState(account: string): Promise<PushState> {
  if (!window.isSecureContext) return "insecure";
  if (!supported()) return "unsupported";
  const config = await api<NotificationConfig>("/notifications/config");
  if (!config.webPushKey) return "unconfigured";
  if (Notification.permission === "denied") return "denied";
  return Notification.permission === "granted" && optedIn(account) && (await currentSubscription()) ? "on" : "off";
}

const register = (subscription: PushSubscription) =>
  api("/notifications/destinations", {
    method: "POST",
    body: JSON.stringify({ kind: "web", subscription: subscription.toJSON() }),
  });

export async function enablePush(account: string) {
  const config = await api<NotificationConfig>("/notifications/config");
  if (!config.webPushKey) throw new Error("Notifications are not set up on this BeeHave server yet.");
  if ((await Notification.requestPermission()) !== "granted")
    throw new Error("Notifications are blocked for this site. Allow them in your browser's site settings, then try again.");
  const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;
  const key = keyBytes(config.webPushKey);
  let subscription = await registration.pushManager.getSubscription();
  // A subscription made for another server key cannot receive from this one.
  const existing = subscription?.options.applicationServerKey;
  if (subscription && existing && new Uint8Array(existing).toString() !== key.toString()) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await register(subscription);
  remember(account, true);
}

export async function disablePush(account: string) {
  remember(account, false);
  const subscription = await currentSubscription();
  if (!subscription) return;
  await api("/notifications/destinations/remove", { method: "POST", body: JSON.stringify({ endpoint: subscription.endpoint }) });
  await subscription.unsubscribe();
}

// On each visit: link this browser's subscription to the current session, so it keeps receiving
// after the account signs in again. Only for an account that turned notifications on here.
export async function resyncPush(account: string) {
  if (!window.isSecureContext || !supported() || Notification.permission !== "granted" || !optedIn(account)) return;
  const subscription = await currentSubscription();
  if (subscription) await register(subscription);
}

// Before signing out: this browser stops receiving for the account being signed out.
export async function releasePush() {
  if (!window.isSecureContext || !supported()) return;
  const subscription = await currentSubscription().catch(() => null);
  if (subscription)
    await api("/notifications/destinations/remove", { method: "POST", body: JSON.stringify({ endpoint: subscription.endpoint }) }).catch(() => {});
}
