// Service Worker: cache-first for PWA shell + audio segments.
// Version bump the name to invalidate caches on deploy.
const CACHE = "jp-running-v3";
const SHELL = [
  "./",
  "index.html",
  "app.js",
  "style.css",
  "manifest.webmanifest",
  "icon-192.png",
  "icon-512.png",
  "data/index.json",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) =>
      c.addAll(SHELL).catch((err) => console.warn("shell cache partial", err))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  e.respondWith(
    caches.match(e.request).then((cached) => {
      if (cached) return cached;
      return fetch(e.request).then((res) => {
        // Cache MP3s and JSON for offline
        if (res.ok && (url.pathname.endsWith(".mp3") || url.pathname.endsWith(".json"))) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      }).catch(() => cached || Response.error());
    })
  );
});

// Explicit precache when user opens a sheet (fires from app.js)
self.addEventListener("message", (e) => {
  if (e.data?.type === "precache" && Array.isArray(e.data.urls)) {
    e.waitUntil(
      caches.open(CACHE).then(async (c) => {
        for (const u of e.data.urls) {
          try {
            const res = await fetch(u);
            if (res.ok) await c.put(u, res);
          } catch (_) { /* ignore */ }
        }
      })
    );
  }
});
