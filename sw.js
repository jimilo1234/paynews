const CACHE_NAME = 'paynews-v1';
const STATIC_ASSETS = [
  '/paynews/',
  '/paynews/index.html',
  '/paynews/manifest.json',
  '/paynews/icon-192.png',
  '/paynews/icon-512.png'
];

// 安装：预缓存静态资源
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// 激活：清理旧缓存
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      );
    })
  );
  self.clients.claim();
});

// 请求拦截：网络优先，失败时回退缓存
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  // 跳过 Supabase API 请求（保持实时性）
  if (event.request.url.includes('supabase.co')) return;
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
