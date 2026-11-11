// App shell cache. Same-origin GETs only; relay and Turso traffic is never touched.
const CACHE = 'yiji-v1';
const NAV_TIMEOUT_MS = 4000;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['./', 'manifest.webmanifest', 'icon.svg'])));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('yiji-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  const store = (res) => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
    }
    return res;
  };

  if (req.mode === 'navigate') {
    // Network first so a new deploy is picked up; a slow or dead network falls back to the cache.
    const net = fetch(req).then(store);
    const slow = new Promise((resolve) => setTimeout(resolve, NAV_TIMEOUT_MS, null));
    e.respondWith(
      Promise.race([net, slow])
        .catch(() => null)
        .then((res) => res || caches.match('./').then((hit) => hit || net)),
    );
    return;
  }

  if (url.pathname.includes('/assets/')) {
    // Hashed file names never change content, so cache first is safe.
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then(store)));
    return;
  }

  const refresh = fetch(req).then(store);
  e.waitUntil(refresh.catch(() => {}));
  e.respondWith(caches.match(req).then((hit) => hit || refresh));
});
