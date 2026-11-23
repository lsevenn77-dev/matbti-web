// 서비스 워커: 버전별 정적 파일 캐시. API·사진·게임 연결은 캐시하지 않는다.
const VERSION = 'nsns-proto-0.2.0';
const ASSETS = ['/', '/index.html', '/style.css', '/app.js', '/scene.js', '/manifest.webmanifest',
  '/icons/icon-192.png', '/icons/icon-512.png', '/vendor/three/three.module.js', '/vendor/three/three.core.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS)));
  // skipWaiting 하지 않는다: 진행 중인 게임을 새 버전으로 강제 교체하지 않기 위해
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/photos/') || url.pathname === '/ws') return;
  if (e.request.mode === 'navigate') {
    // 화면 문서는 네트워크 우선, 오프라인이면 캐시
    e.respondWith(fetch(e.request).catch(() => caches.match('/index.html')));
    return;
  }
  e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
});
