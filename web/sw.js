/*
 * Simba PWA service worker.
 *
 * Goal: make the web app installable and resilient — NOT to cache dynamic data.
 * - Never touches /api (always live; caching chat/SSO would be wrong and unsafe).
 * - App shell (the page + JS bundle + icons) uses network-first with a cache
 *   fallback, so users always get the latest deploy when online and a working
 *   shell when briefly offline.
 */
const CACHE = "simba-shell-v1";
const SHELL = ["/", "/taskpane.js", "/assets/icon-192.png", "/assets/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  // Only handle same-origin GETs; never intercept the API or other origins.
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  event.respondWith(
    fetch(request)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(request).then((hit) => hit || caches.match("/")))
  );
});
