// Adds the cross-origin isolation headers needed by Emscripten pthreads on
// static hosts such as GitHub Pages. The first visit reloads once after this
// worker takes control; normal servers should still send these headers
// directly, which avoids the reload.
'use strict';
// Replaced by the build: all assets in this worker's scope use one release key.
const RELEASE = '__QEMU_RELEASE__';
const BUILD_CACHE = 'qemu-build-cache-' + RELEASE;

self.addEventListener('install', event => {
    event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        await self.clients.claim();
        try {
            const keys = await caches.keys();
            await Promise.all(keys.filter(k => k.startsWith('qemu-build-cache-') && k !== BUILD_CACHE).map(k => caches.delete(k)));
        } catch (_) {}
    })());
});

self.addEventListener('fetch', event => {
    const requestUrl = new URL(event.request.url);
    if (requestUrl.origin !== self.location.origin) return;

    event.respondWith((async () => {
        let request = event.request;
        const scope = new URL(self.registration.scope);
        const isUnderScope = request.method === 'GET' && requestUrl.pathname.startsWith(scope.pathname);

        const cacheableCore = isUnderScope && requestUrl.pathname.includes('/cores/') &&
            !requestUrl.pathname.endsWith('.build.json') &&
            !['no-store', 'reload'].includes(event.request.cache);

        if (isUnderScope) {
            // Check build cache for versioned cores
            if (cacheableCore) {
                try {
                    const cache = await caches.open(BUILD_CACHE);
                    const matched = await cache.match(event.request);
                    if (matched) return matched;
                } catch (_) {}
            }

            requestUrl.searchParams.set('qemu-release', RELEASE);
            // Navigation requests cannot be cloned with a new URL and mode=navigate.
            request = new Request(requestUrl, {headers: request.headers,
                credentials: request.credentials, mode: 'same-origin', redirect: 'follow'});
        }

        // Revalidate HTTP cache while OPFS storage remains separate.
        const response = await fetch(request, {cache: 'no-cache'});
        if (response.type === 'opaque') return response;

        const headers = new Headers(response.headers);
        headers.set('Cross-Origin-Opener-Policy', 'same-origin');
        headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
        headers.set('Cross-Origin-Resource-Policy', 'same-origin');
        const finalResponse = new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
        });

        // Cache successful core and wasm downloads for fast offline starts
        if (response.ok && cacheableCore) {
            try {
                const cache = await caches.open(BUILD_CACHE);
                await cache.put(event.request, finalResponse.clone());
            } catch (_) {}
        }

        return finalResponse;
    })());
});
