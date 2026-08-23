const CACHE_NAME = 'paynews-v28';

// 安装：预缓存核心文件（小体积），字体/图片在首次 fetch 时自动进缓存
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      await cache.addAll(['./', './index.html', './sw.js', './manifest.json']);
    } catch (e) { /* 忽略单个失败 */ }
    await self.skipWaiting();
  })());
});

// 激活：只删旧版本缓存，不再强制重载页面
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;            // 只处理 GET
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 跨域（Supabase / RSS）直接走网络

  const path = url.pathname;
  const isStatic = /\.(woff2?|png|jpe?g|gif|webp|svg|js|css|json|ico)$/i.test(path);

  if (isStatic) {
    // 静态资源：缓存优先，命中即返回，否则网络拉取并写入缓存
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(req);
      if (cached) return cached;
      try {
        const res = await fetch(req);
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      } catch (e) {
        return cached || new Response('', { status: 504 });
      }
    })());
  } else {
    // HTML / 其他：网络优先，失败回退缓存
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        const res = await fetch(req);
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      } catch (e) {
        return (await cache.match(req)) || (await cache.match('./')) || new Response('离线', { status: 503 });
      }
    })());
  }
});
