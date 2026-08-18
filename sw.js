const CACHE_NAME = 'paynews-v7';

// v7: 彻底放弃缓存应用壳，只做透传 + 通知事件。
// 过去 v1~v6 的缓存死锁已导致多次旧 index.html 无法更新；v7 不再缓存任何导航/静态请求。
self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    // 删除所有历史缓存，包括 v1~v6 及任何意外缓存
    const keys = await caches.keys();
    await Promise.all(keys.map(k => caches.delete(k)));
    await self.clients.claim();
    // 强制所有已打开页面重新加载，确保用上最新 index.html
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of clients) {
      try { await c.navigate(c.url); } catch (e) { /* ignore */ }
    }
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  // 非 GET、Supabase 实时接口：完全放行
  if (req.method !== 'GET' || req.url.includes('supabase.co')) return;

  // 导航请求：强制 bypass 任何缓存，永远从网络取最新 HTML
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req, { cache: 'no-cache' })
        .catch(() => new Response('网络离线，请连接网络后刷新', { status: 503, headers: { 'Content-Type': 'text/plain;charset=utf-8' } }))
    );
    return;
  }

  // 其余静态资源：网络优先，失败时回退缓存（仅做离线兜底，不再主动缓存）
  event.respondWith(
    fetch(req, { cache: 'no-cache' })
      .catch(() => caches.match(req))
  );
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'NEW_MESSAGE_NOTIFY') {
    const { title, body } = event.data;
    self.registration.showNotification(title, {
      body: body,
      icon: '/paynews/icon-192.png',
      badge: '/paynews/icon-192.png',
      vibrate: [200, 100, 200],
      tag: 'paynews-new-msg',
      requireInteraction: false
    });
  }
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then(clients => {
      if (clients.length > 0) clients[0].focus();
      else clients.openWindow('/paynews/');
    })
  );
});
