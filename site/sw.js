// Работа без интернета: все файлы приложения лежат в кэше телефона.
// Открывается из кэша сразу, а в фоне проверяется новая версия (появится при следующем запуске).
const CACHE = 'parcel-scanner-v1';
const FILES = [
  './',
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'vendor/zxing-reader.js',
  'vendor/zxing_reader.wasm',
  'src/app.js',
  'src/parse.js',
  'src/match.js',
  'src/scanfilter.js',
  'src/store.js',
  'src/report.js',
  'src/scanner.js',
  'src/feedback.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== location.origin) return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(event.request, { ignoreSearch: true });
      // no-cache: сверяться с сервером, а не с 10-минутным кэшем GitHub Pages.
      const network = fetch(event.request.url, { cache: 'no-cache' })
        .then((res) => {
          if (res.ok) cache.put(event.request, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
