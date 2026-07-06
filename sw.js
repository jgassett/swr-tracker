/* Southern Wildlife Tracker service worker.
 * Network-first for the HTML shell so deploys propagate automatically.
 * Cache-first for static assets, fonts, and third-party SDK bundles. */
const CACHE = 'swr-tracker-v39';
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

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  /* Network-first for HTML navigations so new deploys reach clients fast. */
  const accept = req.headers.get('accept') || '';
  const isNav = req.mode === 'navigate' || accept.includes('text/html');
  if (isNav) {
    event.respondWith(
      fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put('./index.html', copy));
        }
        return res;
      }).catch(() => caches.match('./index.html'))
    );
    return;
  }

  /* Cache-first for everything else. */
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
      }).catch(() => new Response('', { status: 504, statusText: 'Offline' }));
    })
  );
});
