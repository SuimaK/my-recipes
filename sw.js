const cachePrefix = 'recipekeeper-' + self.registration.scope;
const cacheName = cachePrefix + '-v25';
const assets = ['./', './index.html', './app.js?v=15', './import.js?v=23', './backup.js?v=1', './pdf-import.js?v=1', './menu.js?v=10', './style.css?v=17', './manifest.webmanifest', './icon-192.png', './icon-512.png'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(cacheName).then(cache => cache.addAll(assets)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith(cachePrefix + '-') && key !== cacheName) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || !request.url.startsWith(self.registration.scope)) return;
  event.respondWith((async () => {
    const cache = await caches.open(cacheName);
    if (request.mode === 'navigate') {
      try { return await fetch(request); }
      catch { return await cache.match('./index.html'); }
    }
    const cached = await cache.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok && new URL(request.url).pathname.includes('/vendor/')) {
      try { await cache.put(request, response.clone()); } catch {}
    }
    return response;
  })());
});
