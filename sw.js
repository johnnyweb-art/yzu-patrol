// 離線快取：網頁檔案優先從網路取得（確保更新），斷線時改用快取。資料庫請求不快取。
const CACHE = 'yzu-patrol-v4';
const SHELL = [
  './', './index.html', './admin.html', './manifest.webmanifest', './css/style.css',
  './js/config.js', './js/api.js', './js/backend-demo.js', './js/backend-supabase.js', './js/rules.js', './js/util.js',
  './js/idb.js', './js/camera.js', './js/biometric.js', './js/guard.js', './js/report.js', './js/webauthn.js', './vendor/simplewebauthn-browser.js',
  './supabase/functions/_shared/labels.js', './supabase/functions/_shared/report.js', './vendor/jsQR.js', './assets/icon.svg',
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => null)))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const cacheable = url.origin === location.origin || url.hostname === 'cdn.jsdelivr.net' || url.hostname.endsWith('gstatic.com') || url.hostname === 'fonts.googleapis.com';
  if (!cacheable) return;
  e.respondWith(
    fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }))
  );
});
