// Service Worker: cache-first for PWA shell + audio segments.
// Version bump the name to invalidate caches on deploy.
const CACHE = "jp-running-v7";
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
      // cache: "reload" forces network and bypasses HTTP cache, ensuring
      // shell files are the freshest version at install time.
      Promise.all(SHELL.map((url) =>
        c.add(new Request(url, { cache: "reload" })).catch((err) =>
          console.warn("shell precache failed", url, err)
        )
      ))
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

// ----- Offline management messages from app.js -----
self.addEventListener("message", (e) => {
  const data = e.data || {};
  const port = e.ports && e.ports[0];

  if (data.type === "precache" && Array.isArray(data.urls)) {
    e.waitUntil(precacheUrls(data.urls, data.tag, port));
    return;
  }

  if (data.type === "query-cache-status" && Array.isArray(data.urls)) {
    e.waitUntil(queryCacheStatus(data.urls, data.tag, port));
    return;
  }

  if (data.type === "clear-audio-cache") {
    e.waitUntil(clearAudioCache(port));
    return;
  }
});

async function precacheUrls(urls, tag, port) {
  const cache = await caches.open(CACHE);
  let done = 0;
  let added = 0;
  for (const u of urls) {
    try {
      const existing = await cache.match(u);
      if (existing) {
        done++;
      } else {
        const res = await fetch(u);
        if (res.ok) {
          await cache.put(u, res);
          added++;
        }
        done++;
      }
    } catch (_) {
      done++;
    }
    if (port && (done % 5 === 0 || done === urls.length)) {
      port.postMessage({ type: "precache-progress", tag, done, total: urls.length, added });
    }
  }
  if (port) port.postMessage({ type: "precache-done", tag, done, total: urls.length, added });
}

async function queryCacheStatus(urls, tag, port) {
  const cache = await caches.open(CACHE);
  let cached = 0;
  for (const u of urls) {
    if (await cache.match(u)) cached++;
  }
  if (port) port.postMessage({ type: "cache-status", tag, cached, total: urls.length });
}

async function clearAudioCache(port) {
  const cache = await caches.open(CACHE);
  const keys = await cache.keys();
  let deleted = 0;
  for (const req of keys) {
    if (req.url.endsWith(".mp3")) {
      await cache.delete(req);
      deleted++;
    }
  }
  if (port) port.postMessage({ type: "cache-cleared", deleted });
}
