const CACHE_NAME = 'paynews-v13';

// v13: 不缓存任何资源；删除所有旧缓存；install 后立即激活并强制刷新页面
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => caches.delete(k)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => caches.delete(k)));
    await self.clients.claim();
    const cls = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of cls) {
      try { c.postMessage({ type: 'SW_ACTIVATED', cache: CACHE_NAME }); } catch (e) {}
      try { c.navigate(c.url); } catch (e) {}
    }
  })());
});

self.addEventListener('fetch', event => {
  event.respondWith(fetch(event.request, { cache: 'no-store' }));
});
