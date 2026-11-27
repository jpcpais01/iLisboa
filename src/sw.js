// iLisboa service worker. Emitted at build time by the `sw` plugin in vite.config.js, which fills in
// VERSION and SHELL (every hashed bundle file). Caches only the app shell: the page, its JS/CSS and icons.
// Tiles (/tiles and the landmark detail /lm, already versioned and HTTP-cached for a year), live feeds (/api) and network data (/live)
// never touch this worker, so streaming and live layers behave exactly as in a browser tab.
const VERSION = '__VERSION__';
const SHELL = __SHELL__;
const CACHE = `ilisboa-shell-${VERSION}`;
const BYPASS = /^\/(tiles|api|live|lm|transit|water)\//;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/', ...SHELL])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('ilisboa-shell-') && k !== CACHE) await caches.delete(k);
    if (self.registration.navigationPreload) await self.registration.navigationPreload.enable();
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || BYPASS.test(url.pathname)) return;

  // the page: always the latest deploy when online, the cached shell when not
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const res = (await e.preloadResponse) || (await fetch(req));
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put('/', copy)); }
        return res;
      } catch {
        return (await caches.match('/', { cacheName: CACHE, ignoreSearch: true, ignoreVary: true })) || Response.error();
      }
    })());
    return;
  }

  // hashed bundles, icons and fonts never change under the same URL: cache first
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/') || url.pathname.startsWith('/fonts/') || url.pathname === '/manifest.webmanifest') {
    e.respondWith((async () => {
      const hit = await caches.match(req, { ignoreSearch: true, ignoreVary: true });
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    })());
  }
});
