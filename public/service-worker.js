// Basic PWA Service Worker
self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(clients.claim());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // ✅ Never intercept API requests
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Network-first so the app stays usable
  event.respondWith(
    fetch(event.request).catch(() => new Response("You are offline. Please reconnect."))
  );
});
