// Splatmania service worker: keeps the editor usable offline once it has been
// opened. The precache list and version are written in at build time by
// service-worker.mjs.
//
// Strategy: network first for everything same-origin, so a running dev server
// or a new build is always picked up; the cache only answers when the network
// fails. Scene files (ply, splat, ...) are never cached, they can be huge.

/* global self, caches, fetch, URL, __PRECACHE__ */

const VERSION = '__VERSION__';
const PRECACHE = __PRECACHE__;
const CACHE = `splatmania-${VERSION}`;

const SKIP = /\.(?:ply|splat|ksplat|sog|spz|ssproj|zip|npy|map)(?:\?|$)/i;

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE)
        .then(cache => cache.addAll(PRECACHE))
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
            const response = await fetch(request);
            if (response.ok && response.type === 'basic') {
                cache.put(request, response.clone());
            }
            return response;
        } catch (err) {
            // ignoreSearch: '?load=…' style launch urls still find index.html
            const cached = await cache.match(request, { ignoreSearch: request.mode === 'navigate' });
            if (cached) return cached;
            throw err;
        }
    })());
});
