// Service worker with cache busting for PWA updates
const CACHE_VERSION = 'v5.7.4';

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

// ===== PUSH NOTIFICATIONS =====
self.addEventListener('push', e => {
  let data = {title: '⚡ Done!', body: 'You have a reminder.'};
  if(e.data){
    try{ data = e.data.json(); }catch(err){ data.body = e.data.text(); }
  }
  e.waitUntil(
    self.registration.showNotification(data.title || '⚡ Done!', {
      body: data.body || '',
      icon: 'icon.png',
      badge: 'icon.png',
      tag: data.tag || 'pt-reminder'
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({type: 'window', includeUncontrolled: true}).then(clients => {
      for(const client of clients){
        if('focus' in client) return client.focus();
      }
      if(self.clients.openWindow) return self.clients.openWindow('./');
    })
  );
});
