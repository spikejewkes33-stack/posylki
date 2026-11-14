// Работа без интернета: все файлы приложения лежат в кэше телефона.
// Открывается из кэша сразу, а в фоне проверяется новая версия (появится при следующем запуске).
const CACHE = 'parcel-scanner-v2';
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
  'vendor/write-excel-file.min.js',
  'vendor/pdfmake.min.js',
  'vendor/Roboto-Regular.ttf',
  'vendor/Roboto-Medium.ttf',
  'src/app.js',
  'src/parse.js',
  'src/match.js',
  'src/scanfilter.js',
  'src/store.js',
  'src/report.js',
  'src/scanner.js',
  'src/feedback.js',
  'src/files.js',
];

self.addEventListener('install', (event) => {
  // no-cache: брать свежие файлы, а не из 10-минутного кэша браузера.
  const fresh = FILES.map((f) => new Request(f, { cache: 'no-cache' }));
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(fresh)).then(() => self.skipWaiting()));
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
