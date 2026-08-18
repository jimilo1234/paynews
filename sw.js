const CACHE_NAME = 'paynews-v5';
const STATIC_ASSETS = [
  '/paynews/',
  '/paynews/index.html',
  '/paynews/manifest.json',
  '/paynews/icon-192.png',
  '/paynews/icon-512.png',
  '/paynews/vendor/supabase-js.esm.js',
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

// 安装：预缓存静态资源
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// 激活：清理旧缓存，并强制所有已打开页面用新 SW 重新加载（打破旧缓存死锁）
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)));
    await self.clients.claim();
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of clients) {
      try { await c.navigate(c.url); } catch (e) { /* ignore */ }
    }
  })());
});

// 请求拦截
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  // 跳过 Supabase API 请求（保持实时性）
  if (event.request.url.includes('supabase.co')) return;
  // 导航请求（HTML页面）永远走网络、不缓存，确保用户始终拿到最新 index.html
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
    return;
  }
  // 静态资源：网络优先，失败时回退缓存
  event.respondWith(
    fetch(event.request)
      .then(response => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

// 接收主页面消息并显示通知
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

// 点击通知回到 PWA
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then(clients => {
      if (clients.length > 0) {
        clients[0].focus();
      } else {
        clients.openWindow('/paynews/');
      }
    })
  );
});
