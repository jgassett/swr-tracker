/* Southern Wildlife Tracker service worker — cache-first for the app shell. */
const CACHE = 'swr-tracker-v20';
const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './logo.png',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        const copy = res.clone();
        const isAppShellOrigin = url.origin === self.location.origin;
        const isGoogleFonts = /fonts\.(googleapis|gstatic)\.com/.test(url.host);
        const isFirebaseSdk = url.host === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/');
        const isLeaflet = url.host === 'unpkg.com' && url.pathname.startsWith('/leaflet@');
        const isEmailJsCdn = url.host === 'cdn.jsdelivr.net' && url.pathname.includes('@emailjs/browser');
        const isTesseract = url.host === 'cdn.jsdelivr.net' && url.pathname.includes('tesseract');
        if (res.ok && (isAppShellOrigin || isGoogleFonts || isFirebaseSdk || isLeaflet || isEmailJsCdn || isTesseract)) {
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      }).catch(() => {
        if (req.mode === 'navigate') return caches.match('./index.html');
        return new Response('', { status: 504, statusText: 'Offline' });
      });
    })
  );
});
