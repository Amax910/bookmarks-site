// Makes the site open instantly and work offline. Only the site's own files
// are cached; GitHub API calls always go to the network.

const CACHE = 'bookmarks-site-v5';
const SHELL = [
  './',
  'index.html',
  'app.css',
  'app.js',
  'sync-core.js',
  'manifest.webmanifest',
  'icons/icon-48.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network first, so updates show up straight away; the cached copy is only
// used when the phone is offline (or the network takes over 4 s).
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const network = fetch(e.request, { cache: 'no-cache' }).then((res) => {
        if (res.ok) cache.put(e.request, res.clone());
        return res;
      });
      const timeout = new Promise((resolve) => setTimeout(resolve, 4000));
      try {
        const res = await Promise.race([network, timeout]);
        if (res) return res;
      } catch {}
      const cached = await cache.match(e.request, { ignoreSearch: true });
      return cached || network;
    })
  );
});
