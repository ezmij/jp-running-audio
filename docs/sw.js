// Service Worker: hybrid cache strategy.
//   - Navigation (HTML)         → network-first  (latest deploy always visible)
//   - Code shell (JS/CSS/index) → stale-while-revalidate (instant load, background refresh)
//   - Audio segments + per-sheet JSON → cache-first (offline-friendly)
//
// CACHE_VERSION is auto-bumped by scripts/bump_sw_version.py before every
// deploy. Different CACHE_VERSION → install runs → activate purges old cache.
const CACHE_VERSION = "20260515000356";
const CACHE = `jp-running-${CACHE_VERSION}`;

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

// Files served stale-while-revalidate: instant cache hit, network refresh in background.
const SWR_PATHS = new Set([
  "/app.js",
  "/style.css",
  "/manifest.webmanifest",
  "/data/index.json",
]);

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) =>
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
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // HTML navigation: network-first, fallback to cached index.html offline.
  if (req.mode === "navigate" || req.destination === "document") {
    e.respondWith(networkFirst(req));
    return;
  }

  // Match SWR_PATHS against the path (handles GitHub Pages subpath prefix).
  const isSwr = [...SWR_PATHS].some((p) => url.pathname.endsWith(p));
  if (isSwr) {
    e.respondWith(staleWhileRevalidate(req));
    return;
  }

  // MP3 + other JSON (per-sheet manifests): cache-first for offline.
  if (url.pathname.endsWith(".mp3") || url.pathname.endsWith(".json")) {
    e.respondWith(cacheFirst(req, true));
    return;
  }

  // Default (icons, fonts, etc.): cache-first.
  e.respondWith(cacheFirst(req, false));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    const cached = await cache.match(req) || await cache.match("index.html") || await cache.match("./");
    return cached || Response.error();
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req);
  const networkPromise = fetch(req).then((res) => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => null);
  return cached || (await networkPromise) || Response.error();
}

async function cacheFirst(req, storeOnMiss) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res.ok && storeOnMiss) cache.put(req, res.clone());
    return res;
  } catch {
    return Response.error();
  }
}

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
