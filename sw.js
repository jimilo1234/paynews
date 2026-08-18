const CACHE_NAME = 'paynews-v6';

// 只预缓存确实存在的静态资源；任何一项失败都不影响 SW 安装（用 .catch 兜底）
const STATIC_ASSETS = [
  '/paynews/vendor/supabase-js.umd.js',
  '/paynews/pet-assets/cat_work.png',
  '/paynews/pet-assets/cat_study.png',
  '/paynews/pet-assets/cat_eat.png',
  '/paynews/pet-assets/cat_exercise.png',
  '/paynews/pet-assets/cat_sleep.png',
  '/paynews/pet-assets/cat_listen.png',
  '/paynews/pet-assets/mood_calm.png',
  '/paynews/pet-assets/mood_happy.png',
  '/paynews/pet-assets/mood_sad.png',
  '/paynews/pet-assets/mood_angry.png',
  '/paynews/pet-assets/mood_surprised.png',
  '/paynews/pet-assets/mood_sleepy.png',
  '/paynews/pet-assets/mood_excited.png',
  '/paynews/pet-assets/mood_love.png',
  '/paynews/pet-assets/mood_cry.png',
  '/paynews/pet-assets/mood_daze.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_ASSETS).catch(err => {
        console.warn('预缓存部分资源失败（已忽略，不影响安装）:', err);
      }))
  );
  self.skipWaiting(); // 立即激活，不等旧页面关闭
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    // 删除所有旧缓存（v1~v5），彻底清掉可能残留的旧 index.html
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)));
    await self.clients.claim();
    // 强制所有已打开页面用新 SW 重新加载，打破旧缓存死锁
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of clients) {
      try { await c.navigate(c.url); } catch (e) { /* ignore */ }
    }
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;                 // 非 GET（含登录 POST）直接放行
  if (req.url.includes('supabase.co')) return;       // Supabase API 实时，不缓存
  // 导航请求（HTML 页面）永远走网络、不缓存，确保始终拿到最新 index.html
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match('/paynews/index.html')));
    return;
  }
  // 静态资源：网络优先，成功则写入缓存；失败时回退缓存
  event.respondWith(
    fetch(req)
      .then(response => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
        }
        return response;
      })
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
