/* Minimal service worker: caches the app shell so the app opens fast
 * and works offline for the UI itself (scanning/matching still needs
 * network for Google Sheets, but the app will at least load). */

const CACHE_NAME = "ean-scanner-v2";
const APP_SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Only handle same-origin GET requests with the cache; let everything
  // else (Google APIs, the qr library CDN, auth calls) go straight to
  // the network untouched.
  if (event.request.method !== "GET" || url.origin !== self.location.origin) {
    return;
  }

  // Network-first: always try to get the latest version when online (this
  // app needs network for Google Sheets anyway), and only fall back to the
  // cached copy when the network request fails (offline). This way a new
  // deploy shows up on the very next reload instead of one reload behind.
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res && res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
