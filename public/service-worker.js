// --- Basic PWA Service Worker ---
// Makes your website installable & app-like

self.addEventListener("install", event => {
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(clients.claim());
});

// Network-first fetch so the app works offline
self.addEventListener("fetch", event => {
  event.respondWith(
    fetch(event.request).catch(() =>
      new Response("You are offline. Please reconnect.")
    )
  );
});
