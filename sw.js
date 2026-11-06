/* Offline shell. The app itself never needs the network; only the Open Food
   Facts lookup and the fallback decoder do, and both fail softly. */
const CACHE = 'freshtrack-v1';
const ASSETS = [
  './', './index.html', './css/styles.css',
  './js/app.js', './js/gs1.js', './js/store.js', './js/off.js', './js/scanner.js',
  './js/shelflife.js', './js/receipt.js', './js/ocr.js',
  './manifest.webmanifest', './icons/icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;   // never cache API calls
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match('./index.html')))
  );
});
