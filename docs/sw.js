// Bump VERSION whenever a shipped app file changes. Each release is cached
// together; new workers wait for Update now or for old app tabs to close.
const VERSION = '1.5.0';
const SCOPE = new URL('./', self.location.href).href;
const CACHE_PREFIX = `plainlet:${SCOPE}:`;
const CACHE_NAME = `${CACHE_PREFIX}${VERSION}`;
const FILES = [
  './', './index.html', './styles.css', './app.js', './text-buffer.js', './paste-history.js',
  './sw-register.js', './share-link.js', './manifest.webmanifest', './icons/icon.svg',
  './icons/icon-192.png', './icons/icon-512.png',
  './icons/icon-maskable-512.png', './icons/apple-touch-icon.png',
];
const APP_URLS = new Set(FILES.map((path) => new URL(path, SCOPE).href));

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(FILES.map(async (file) => {
      const canonical = new URL(file, SCOPE);
      const download = new URL(canonical);
      download.searchParams.set('release', VERSION);
      const response = await fetch(download, { cache: 'reload' });
      if (!response.ok) throw new Error(`Could not download ${file}: ${response.status}`);
      await cache.put(canonical.href, response);
    }));
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  // Cache only this app's known files, never clipboard text or arbitrary URLs.
  url.search = '';
  url.hash = '';
  if (!APP_URLS.has(url.href)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    return (await cache.match(url.href)) || fetch(event.request);
  })());
});
