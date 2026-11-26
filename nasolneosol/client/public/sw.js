// 서비스 워커: 버전별 정적 파일 캐시. API·사진·게임 연결은 캐시하지 않는다.
const VERSION = 'nsns-proto-0.9.16';
const ASSETS = ['/', '/index.html', '/style.css', '/app.js', '/scene.js', '/audio.js', '/manifest.webmanifest',
  '/icons/icon-192.png', '/icons/icon-512.png', '/vendor/three/three.module.js', '/vendor/three/three.core.js',
  '/vendor/three-addons/loaders/GLTFLoader.js', '/vendor/three-addons/utils/BufferGeometryUtils.js', '/vendor/three-addons/utils/SkeletonUtils.js'];

self.addEventListener('install', (e) => {
  // 브라우저 HTTP 캐시를 거치지 않고 새 파일을 받는다 (옛 파일이 새 버전 캐시에 섞이지 않게)
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' })))));
  // 자동 skipWaiting 은 하지 않는다. 페이지가 게임 중이 아닐 때만 아래 메시지로 교체한다.
});

self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/photos/') || url.pathname.startsWith('/models/') || url.pathname === '/ws') return; // 모델 파일은 교체될 수 있어 캐시하지 않음
  if (e.request.mode === 'navigate') {
    // 화면 문서는 네트워크 우선, 오프라인이면 캐시
    e.respondWith(fetch(e.request).catch(() => caches.match('/index.html')));
    return;
  }
  // 앱 코드는 네트워크 우선(항상 최신), 안 되면 캐시. 큰 라이브러리(three)만 캐시 우선
  if (url.pathname.startsWith('/vendor/')) {
    e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
    return;
  }
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
