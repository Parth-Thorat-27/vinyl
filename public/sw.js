// Caches the app shell so Vinyl opens instantly (music itself always streams from YouTube).
const CACHE = 'vinyl-v5';
const SHELL = ['./', 'index.html', 'style.css', 'spotify.js', 'room.js', 'deck.js', 'crate.js', 'app.js', 'manifest.webmanifest',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Network first, so edits show up straight away; fall back to the cache when offline.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.endsWith('/lan.json')) return;
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return r;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('index.html'))),
  );
});
