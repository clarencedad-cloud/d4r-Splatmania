// Splatmania service worker: keeps the editor usable offline once it has been
// opened. The precache list and version are written in at build time by
// service-worker.mjs.
//
// Strategy: network first for everything same-origin, so a running dev server
// or a new build is always picked up; the cache only answers when the network
// fails. Scene files (ply, splat, ...) are never cached, they can be huge.

/* global self, caches, fetch, Request, URL, __PRECACHE__ */

const VERSION = '__VERSION__';
const PRECACHE = __PRECACHE__;
const CACHE = `splatmania-${VERSION}`;

const SKIP = /\.(?:ply|splat|ksplat|sog|spz|ssproj|zip|npy|map)(?:\?|$)/i;

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE)
        // 'reload' skips the browser's http cache, which some hosts fill
        // with year-long max-age headers (it would precache the old build)
        .then(cache => cache.addAll(PRECACHE.map(url => new Request(url, { cache: 'reload' }))))
        .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
        .then(keys => Promise.all(keys
        .filter(key => key !== CACHE && (key.startsWith('splatmania-') || key.startsWith('superSplat-v')))
        .map(key => caches.delete(key))))
        .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const { request } = event;
    if (request.method !== 'GET' || request.headers.has('range')) return;

    const url = new URL(request.url);
    if (url.origin !== self.location.origin || SKIP.test(url.pathname)) return;

    event.respondWith((async () => {
        const cache = await caches.open(CACHE);
        try {
            // revalidate with the server instead of trusting a long max-age
            // in the http cache (cheap: unchanged files answer 304)
            const response = request.mode === 'navigate' ? await fetch(request) : await fetch(request, { cache: 'no-cache' });
            if (response.ok && response.type === 'basic') {
                cache.put(request, response.clone());
            }
            return response;
        } catch (err) {
            // ignoreSearch: '?load=…' launch urls and the '?v=' build ids in
            // index.html still find their cached files
            const cached = await cache.match(request, { ignoreSearch: true });
            if (cached) return cached;
            throw err;
        }
    })());
});
