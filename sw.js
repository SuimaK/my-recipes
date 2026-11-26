// Версия приложения. При каждом выпуске меняется только это число:
// браузер увидит новый sw.js, заново скачает файлы приложения и удалит старый кэш.
const VERSION = 29;

const cachePrefix = 'recipekeeper-' + self.registration.scope;
const appCache = cachePrefix + '-v' + VERSION;
// Библиотеки распознавания и PDF (около 12 МБ) хранятся отдельно и не удаляются при обновлении
// приложения. Номер меняется, только когда обновляются сами файлы в vendor/.
const vendorCache = cachePrefix + '-vendor-v1';
const assets = ['./', './index.html', './app.js', './import.js', './pdf-import.js', './collection-import.js',
  './menu.js', './backup.js', './style.css', './manifest.webmanifest', './icon-192.png', './icon-512.png'];

self.addEventListener('install', event => {
  // cache: 'reload' — берём файлы с сервера, а не из HTTP-кэша браузера, чтобы не сохранить старую версию.
  event.waitUntil(caches.open(appCache)
    .then(cache => cache.addAll(assets.map(url => new Request(url, {cache: 'reload'}))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith(cachePrefix + '-') && key !== appCache && key !== vendorCache) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || !request.url.startsWith(self.registration.scope)) return;
  const url = new URL(request.url);
  event.respondWith((async () => {
    if (url.pathname.includes('/vendor/')) {
      const cache = await caches.open(vendorCache);
      const cached = await cache.match(request, {ignoreSearch: true});
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok) {
        try { await cache.put(request, response.clone()); } catch { /* нет места — просто не кэшируем */ }
      }
      return response;
    }
    const cache = await caches.open(appCache);
    // Страница и файлы приложения берутся из кэша той же версии, поэтому всегда совпадают друг с другом
    // и открываются сразу, даже при плохой связи. Новая версия подхватывается при следующем запуске.
    const cached = request.mode === 'navigate'
      ? await cache.match('./index.html')
      : await cache.match(request, {ignoreSearch: true});
    return cached || fetch(request);
  })());
});
