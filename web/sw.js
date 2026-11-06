// Keeps the app shell and the route database on the phone. Live arrivals and AI
// calls always go to the network.
// The deploy script stamps every ?v=dev, so a new release can never mix with cached files.
const VERSION = 'hktransport-v=dev';
const SHELL = [
  './', 'index.html', 'styles.css?v=dev', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png',
  'vendor/leaflet.js', 'vendor/leaflet.css', 'vendor/maplibre-gl.js', 'vendor/maplibre-gl.css', 'vendor/leaflet-maplibre-gl.js',
  'js/app.js?v=dev', 'js/transit.js?v=dev', 'js/eta.js?v=dev', 'js/ai.js?v=dev', 'js/places.js?v=dev', 'js/planner.worker.js?v=dev',
];
const DATABASE = 'routeFareList.min.json';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.pathname.includes('/api/')) return;
  if (url.pathname.endsWith(DATABASE)) {
    // Show the saved copy at once and refresh it for next time.
    event.respondWith(caches.open(VERSION).then(async (cache) => {
      const saved = await cache.match(event.request);
      const fresh = fetch(event.request).then((response) => {
        if (response.ok) cache.put(event.request, response.clone());
        return response;
      });
      if (saved) {
        event.waitUntil(fresh.catch(() => {}));
        return saved;
      }
      return fresh;
    }));
  } else if (url.origin === self.location.origin) {
    // Network first, so a new version shows up as soon as it is online.
    event.respondWith(fetch(event.request, { cache: 'no-cache' }).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        event.waitUntil(caches.open(VERSION).then((cache) => cache.put(event.request, copy)));
      }
      return response;
    }).catch(() => caches.match(event.request)));
  }
});
