// App shell cache. Same-origin GETs only; relay and Turso traffic is never touched.
const CACHE = 'yiji-v1';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['./', 'manifest.webmanifest', 'icon.svg'])));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  const store = (res) => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
    }
    return res;
  };
  if (req.mode === 'navigate') {
    // Network first so a new deploy is picked up; the cache serves offline starts.
    e.respondWith(fetch(req).then(store).catch(() => caches.match('./')));
    return;
  }
  // Built assets have hashed names, so cache first is safe.
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then(store)));
});
