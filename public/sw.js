// Service Worker: makes the Home Screen app installable, and keeps the page openable while this engine is down ("The page while its engine is down"
// in docs/design/failover-and-one-login.md).
//
// - A visit of the page (a navigation to exactly / or /h5) goes to the network as always, and its answer is passed on as it is (the page, a redirect
//   to the login, an error page). Only when nothing answered, or a proxy in front of the engine answered 502, 503 or 504, the visit gets
//   /offline.html from this worker's cache: a small page that says which engine is down and offers "Continue on <engine>".
// - The cache holds the offline page and the few files it loads (by their plain URLs), nothing else: no API answer and no page of the engine is ever
//   kept or shown from it, so nothing stale can pass for live data. Those files go to the network first too and come from the cache only when it fails.
// - The server writes the hash of the offline files into OFFLINE_VERSION when it sends this file (server.js), so any change of them installs a new
//   worker and a new cache.
// It shows no notifications: T-Agent has no system (browser / OS) notifications; reminders come from the page and the server's notifiers (Telegram).
const OFFLINE_VERSION = '__OFFLINE_VERSION__';
const CACHE = `t-agent-offline-${OFFLINE_VERSION}`;
const OFFLINE_PAGE = '/offline.html';
const OFFLINE_FILES = ['/offline.html', '/css/offline.css', '/js/offline.js', '/js/local-keys.js', '/js/i18n.js', '/js/i18n-zh-ui.js', '/favicon.svg'];
const PAGES = new Set(['/', '/h5']);
const DOWN = new Set([502, 503, 504]);

// Each file on its own: one that cannot be fetched (a logged-out visit gets a redirect) leaves the others and the install goes on.
async function fill() {
  const cache = await caches.open(CACHE);
  await Promise.all(OFFLINE_FILES.map(async file => {
    try {
      const response = await fetch(file, { cache: 'reload', credentials: 'same-origin', redirect: 'error' });
      if (response.ok) await cache.put(file, response);
    } catch { /* kept from before, or missing until the next install */ }
  }));
}

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(fill());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name.startsWith('t-agent-offline-') && name !== CACHE) await caches.delete(name);
    await self.clients.claim();
  })());
});

async function offlinePage() {
  const cached = await caches.match(OFFLINE_PAGE, { cacheName: CACHE });
  return cached || new Response('This engine cannot be reached.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

async function visit(request) {
  try {
    const response = await fetch(request);
    return DOWN.has(response.status) ? offlinePage() : response;
  } catch {
    return offlinePage();
  }
}

// A proxy's 502 / 503 / 504 is the engine being down here too: the cached copy is used then.
async function offlineFile(request, path) {
  let response = null;
  try { response = await fetch(request); } catch { response = null; }
  if (response && !DOWN.has(response.status)) return response;
  const cached = await caches.match(path, { cacheName: CACHE });
  if (cached) return cached;
  if (response) return response;
  throw new TypeError('offline');
}

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === 'navigate' && PAGES.has(url.pathname)) { event.respondWith(visit(request)); return; }
  if (!url.search && OFFLINE_FILES.includes(url.pathname) && url.pathname !== OFFLINE_PAGE) event.respondWith(offlineFile(request, url.pathname));
});
