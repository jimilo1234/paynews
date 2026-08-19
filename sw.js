const CACHE_NAME = 'paynews-v10';

// v10: 不缓存任何应用资源；配合 _headers 全局 no-cache，彻底杜绝 HTTP/SW 缓存（v9 起宠物图为外置文件，SW 网络优先保证每次取最新），永远从网络取最新，彻底杜绝旧 index.html 死锁。
self.addEventListener('install', event => { event.waitUntil(self.skipWaiting()); });

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => caches.delete(k)));
    await self.clients.claim();
    const cls = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of cls) { try { await c.navigate(c.url); } catch (e) {} }
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || req.url.includes('supabase.co')) return;
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req, { cache: 'no-cache' })
        .catch(() => new Response('网络离线，请连接网络后刷新', { status: 503, headers: { 'Content-Type': 'text/plain;charset=utf-8' } }))
    );
    return;
  }
  event.respondWith(fetch(req, { cache: 'no-cache' }).catch(() => caches.match(req)));
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'NEW_MESSAGE_NOTIFY') {
    const { title, body } = event.data;
    self.registration.showNotification(title, { body, icon: '/paynews/icon-192.png', badge: '/paynews/icon-192.png', vibrate: [200,100,200], tag: 'paynews-new-msg' });
  }
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(clients.matchAll({ type: 'window' }).then(cls => {
    if (cls.length) cls[0].focus(); else cls.openWindow('/paynews/');
  }));
});
