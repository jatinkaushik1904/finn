// FINN's service worker: receives Web Push (so alerts arrive with the app closed), shows the
// notification, and opens or focuses the app on tap. No caching, no background fetches.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: "FINN", body: e.data ? e.data.text() : "" }; }
  e.waitUntil(
    self.registration.showNotification(d.title || "FINN", {
      body: d.body || "Something material changed in your portfolio.",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: d.tag || "finn-brief",
      renotify: true,
      data: { url: d.url || "/#brief" },
    }),
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "/#brief";
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => {
      const open = cs.find((c) => "focus" in c);
      if (open) { open.navigate?.(url); return open.focus(); }
      return self.clients.openWindow(url);
    }),
  );
});
