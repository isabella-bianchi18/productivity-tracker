// Service worker with cache busting for PWA updates
const CACHE_VERSION = 'v3.3.4';

self.addEventListener('install', e => {
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  // Delete old caches when a new version activates
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // Always go to network first, fall back to cache
  e.respondWith(
    fetch(e.request).then(res => {
      // Cache a copy for offline fallback
      if(res.ok && e.request.method === 'GET') {
        const clone = res.clone();
        caches.open(CACHE_VERSION).then(c => c.put(e.request, clone));
      }
      return res;
    }).catch(() => caches.match(e.request))
  );
});
