'use strict';

// Bump this value with every release that changes the app shell or its data.
const VERSION = '2026-11-12-v7';
const CACHE_PREFIX = 'sdng6-brigade2-';
const CACHE_NAME = CACHE_PREFIX + VERSION;
const APP_MARKER = '<meta name="sdng6-app-shell" content="brigade-2">';
const ROOT = new URL('./', self.registration.scope);
const ASSETS = [
  ['index.html', 'html', true],
  ['app.css', 'css', true],
  ['app.js', 'js', true],
  ['preferences.js', 'js', true],
  ['offline.js', 'js', true],
  ['offline-navigation.js', 'js', true],
  ['local-router.js', 'js', true],
  ['local-navigation.css', 'css', true],
  ['logo-mask.css', 'css', true],
  ['feedback.css', 'css', true],
  ['map-view.js', 'js', true],
  ['geo-roads.json', 'json', true],
  ['geo-network.json', 'json', true],
  ['scheme-network.json', 'json', true],
  ['visuals.js', 'js', true],
  ['ui.css', 'css', true],
  ['navigation.css', 'css', true],
  ['offline.css', 'css', true],
  ['visuals.css', 'css', true],
  ['theme.css', 'css', true],
  ['vendor/leaflet.markercluster.js', 'js', true],
  ['vendor/MarkerCluster.css', 'css', true],
  ['data.json', 'json', true],
  ['map-points.json', 'json', true],
  ['gps-points.json', 'json', true],
  ['field-map.webp', 'image', true],
  ['logo.png', 'image', true],
  ['vendor/leaflet.css', 'css', true],
  ['vendor/leaflet.js', 'js', true],
  ['field-map-clean.svg', 'svg', false],
  ['manifest.webmanifest', 'json', false],
  ['icon-192.png', 'image', false],
  ['icon-512.png', 'image', false],
  ['apple-touch-icon.png', 'image', false]
].map(([path, kind, required]) => ({
  url: new URL(path, ROOT).href,
  kind,
  required
}));
const RESOURCE_BY_URL = new Map(ASSETS.map(asset => [asset.url, asset]));
const INDEX_URL = new URL('index.html', ROOT).href;

async function isSafeResponse(response, asset) {
  if (!response || response.status !== 200 || response.redirected ||
      response.type === 'opaque' || response.type === 'opaqueredirect') return false;
  const responseURL = new URL(response.url || asset.url);
  if (responseURL.origin !== ROOT.origin || responseURL.href !== asset.url) return false;
  const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (asset.kind === 'html') {
    if (mime !== 'text/html') return false;
    // Private hosting can return a login page at the requested URL. Never cache it.
    return (await response.clone().text()).includes(APP_MARKER);
  }
  if (asset.kind === 'json') {
    if (!['application/json', 'application/manifest+json'].includes(mime)) return false;
    try { await response.clone().json(); return true; } catch { return false; }
  }
  if (asset.kind === 'js') return /^(application|text)\/(javascript|ecmascript)$/.test(mime);
  if (asset.kind === 'css') return mime === 'text/css';
  if (asset.kind === 'svg') return mime === 'image/svg+xml';
  return mime.startsWith('image/');
}

async function cacheAsset(cache, asset) {
  const response = await fetch(asset.url, {
    credentials: 'same-origin', cache: 'reload', redirect: 'error'
  });
  if (!await isSafeResponse(response, asset)) throw new Error('Invalid app asset: ' + new URL(asset.url).pathname);
  await cache.put(asset.url, response);
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      // Validate each asset separately. An absent optional map never aborts installation.
      await Promise.all(ASSETS.filter(asset => asset.required).map(asset => cacheAsset(cache, asset)));
      await Promise.allSettled(ASSETS.filter(asset => !asset.required).map(asset => cacheAsset(cache, asset)));
    } catch (error) {
      await caches.delete(CACHE_NAME);
      throw error;
    }
    // An update waits until the app explicitly requests SKIP_WAITING or old tabs close.
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    await Promise.all((await caches.keys())
      .filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type === 'CHECK_OFFLINE_STATUS' || event.data?.type === 'PREPARE_OFFLINE') {
    event.waitUntil((async () => {
      const cache = await caches.open(CACHE_NAME);
      if (event.data.type === 'PREPARE_OFFLINE') {
        await Promise.allSettled(ASSETS.map(asset => cacheAsset(cache, asset)));
      }
      const checks = await Promise.all(ASSETS.filter(asset => asset.required || asset.kind === 'svg').map(async asset => Boolean(await cache.match(asset.url))));
      event.ports[0]?.postMessage({ready: checks.every(Boolean)});
    })());
  }
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data?.type === 'CLEAR_OFFLINE_CACHE') {
    event.waitUntil((async () => {
      await Promise.all((await caches.keys())
        .filter(name => name.startsWith(CACHE_PREFIX))
        .map(name => caches.delete(name)));
      event.ports[0]?.postMessage({ type: 'OFFLINE_CACHE_CLEARED' });
    })());
  }
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // No interception of sign-in, API calls, foreign maps, or URLs carrying query tokens.
  if (url.origin !== ROOT.origin || url.search) return;
  const isHomeNavigation = request.mode === 'navigate' &&
    (url.href === ROOT.href || url.href === INDEX_URL);
  if (isHomeNavigation) {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        const asset = { url: request.url, kind: 'html' };
        if (await isSafeResponse(response, asset)) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(INDEX_URL, response.clone());
        }
        // An online login/401/403 response is passed through; it never falls back to saved HTML.
        return response;
      } catch {
        const saved = await caches.match(INDEX_URL, { cacheName: CACHE_NAME });
        return saved || new Response('Первое открытие приложения требует подключения к интернету.', {
          status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
      }
    })());
    return;
  }
  const asset = RESOURCE_BY_URL.get(url.href);
  if (!asset || asset.kind === 'html') return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const saved = await cache.match(asset.url);
    if (saved) return saved;
    const response = await fetch(request);
    if (await isSafeResponse(response, asset)) await cache.put(asset.url, response.clone());
    return response;
  })());
});
