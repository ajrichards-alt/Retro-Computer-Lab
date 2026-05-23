// ============================================================
//  RETRO COMPUTER LAB — Service Worker (sw.js)
//  Pre-caches core assets for offline ChromeOS Kiosk boot.
// ============================================================

const CACHE_NAME = 'retrolab-cache-v1';

// The files required for the app to boot without Wi-Fi
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json'
];

// ── 1. INSTALL PHASE ─────────────────────────────────────────
// Triggers the first time the student loads the page.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[RetroLab SW] Pre-caching offline assets');
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  // Force the waiting service worker to become the active service worker.
  self.skipWaiting();
});

// ── 2. ACTIVATE PHASE ────────────────────────────────────────
// Cleans up any old caches if we update the CACHE_NAME version.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache !== CACHE_NAME) {
            console.log('[RetroLab SW] Clearing old cache:', cache);
            return caches.delete(cache);
          }
        })
      );
    })
  );
  // Ensure the service worker takes control of all clients immediately.
  self.clients.claim();
});

// ── 3. FETCH PHASE ───────────────────────────────────────────
// Intercepts network requests and serves from cache if available.
self.addEventListener('fetch', (event) => {
  const requestUrl = new URL(event.request.url);

  // EXCEPTION: Never cache POST requests or GAS telemetry traffic.
  // We need the heartbeat sync to hit the live network.
  if (event.request.method !== 'GET' || requestUrl.hostname === 'script.google.com') {
    return;
  }

  // Cache-First Strategy for static assets
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      // Return the cached version if found, otherwise fetch from the network.
      return cachedResponse || fetch(event.request).catch(() => {
         console.warn('[RetroLab SW] Offline and asset not in cache:', event.request.url);
      });
    })
  );
});