// BeeHave service worker: push notifications only. It caches nothing and never changes how the app
// loads. Each message carries a title, body, tag (the event ID) and target (screen, farm, device).
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// The web app's route for a target (see notificationPath in @beehave/shared).
function targetPath(target) {
  if (!target || typeof target.farmId !== "string") return "/";
  const farm = "farm=" + encodeURIComponent(target.farmId);
  if (target.screen === "farm-requests") return "/settings?" + farm + "&section=requests";
  return "/devices?" + farm + (target.deviceId ? "&device=" + encodeURIComponent(target.deviceId) : "");
}

self.addEventListener("push", (event) => {
  let message = {};
  try {
    message = event.data ? event.data.json() : {};
  } catch {
    return;
  }
  if (!message.title) return;
  event.waitUntil(
    self.registration.showNotification(message.title, {
      body: message.body,
      // The same event shown twice replaces itself instead of stacking.
      tag: message.tag,
      icon: "/favicon.png",
      badge: "/favicon.png",
      data: { path: targetPath(message.target) },
    }),
  );
});

// Opens BeeHave at the notification's screen, reusing an open BeeHave tab when there is one.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = (event.notification.data && event.notification.data.path) || "/";
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = windows.find((client) => new URL(client.url).origin === self.location.origin);
      if (open) {
        await open.focus();
        open.postMessage({ type: "beehave-navigate", path });
        return;
      }
      await self.clients.openWindow("/#" + path);
    })(),
  );
});

// The browser replaced the subscription (e.g. it expired): register the new one for the same
// signed-in session. Without a session the API refuses it and the old one simply stops.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      const options = event.oldSubscription && event.oldSubscription.options;
      if (!options || !options.applicationServerKey) return;
      const subscription = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: options.applicationServerKey,
      });
      await fetch("/api/notifications/destinations", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "web", subscription: subscription.toJSON() }),
      });
    })(),
  );
});
