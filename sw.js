const CACHE_NAME = 'paynews-v19';

// 安装：预缓存核心文件（小体积）
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      await cache.addAll(['./index.html', './sw.js', './manifest.json']);
    } catch (e) { /* 忽略单个失败 */ }
    await self.skipWaiting();
  })());
});

// 激活：删旧版本缓存，不再强制重载页面
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

// 同源 GET：缓存优先 + 后台静默更新（stale-while-revalidate）
// 跨域（Supabase / RSS）：直连网络，不缓存
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req);

    // 后台静默刷新缓存（不阻塞返回）
    const fetchPromise = fetch(req, { cache: 'no-store' })
      .then(res => { if (res && res.ok) cache.put(req, res.clone()); return res; })
      .catch(() => cached);

    if (cached) return cached;          // 有缓存：秒开
    try { return await fetchPromise; }  // 无缓存：等网络
    catch (e) { return new Response('', { status: 504 }); }
  })());
});
