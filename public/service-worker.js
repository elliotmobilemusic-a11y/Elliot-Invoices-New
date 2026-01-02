// --- Basic PWA Service Worker ---
// Makes your website installable & app-like

self.addEventListener("install", event => {
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(clients.claim());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // ✅ Always bypass the service worker for API requests
  if (url.pathname.startsWith("/api/")) {
    return;
  }

  // ...your existing service worker logic below...
});

// Network-first fetch so the app works offline
self.addEventListener("fetch", event => {
  event.respondWith(
    fetch(event.request).catch(() =>
      new Response("You are offline. Please reconnect.")
    )
  );
});
