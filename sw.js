// Service worker with cache busting for PWA updates
const CACHE_VERSION = 'v4.3.3';

self.addEventListener('install', e => {
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Never cache the service worker itself
  if(url.pathname.endsWith('sw.js')) {
    e.respondWith(fetch(e.request));
    return;
  }
  // Network-first for everything else
  e.respondWith(
    fetch(e.request).then(res => {
      if(res.ok && e.request.method === 'GET') {
        const clone = res.clone();
        caches.open(CACHE_VERSION).then(c => c.put(e.request, clone));
      }
      return res;
    }).catch(() => caches.match(e.request))
  );
});
