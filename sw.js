// 앱 파일을 기기에 저장해 두고 오프라인에서도 연다.
// 인터넷이 되면 늘 새 파일을 먼저 받고(그래서 고친 내용이 바로 보인다), 안 되면 저장본을 쓴다.
const VERSION = 'v33';
const FILES = ['./', 'index.html', 'app.js', 'analyze.js', 'icons.js', 'sync.js', 'manifest.webmanifest',
  'vendor/pdf.min.mjs', 'vendor/SUIT-Variable.woff2', 'vendor/pdf.worker.min.mjs', 'vendor/firebase-app.js', 'vendor/firebase-auth.js', 'vendor/firebase-firestore-lite.js', 'icon-180.png', 'icon-192.png', 'icon-512.png', 'icon-round-192.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION)
    .then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const c = await caches.open(VERSION);
    try {
      // 합주실처럼 인터넷이 느리면 3초 뒤 저장본으로
      const r = await Promise.race([
        fetch(e.request, { cache: 'no-cache' }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000))
      ]);
      if (r.ok) c.put(e.request, r.clone());
      return r;
    } catch {
      const hit = await c.match(e.request, { ignoreSearch: true });
      if (hit) return hit;
      throw new Error('offline');
    }
  })());
});
