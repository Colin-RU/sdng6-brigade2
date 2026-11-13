'use strict';

// Bump this value with every release that changes the app shell or its data.
const VERSION = '2026-11-13-v12';
const CACHE_PREFIX = 'sdng6-brigade2-';
const CACHE_NAME = CACHE_PREFIX + VERSION;
const APP_MARKER = '<meta name="sdng6-app-shell" content="brigade-2">';
const ROOT = new URL('./', self.registration.scope);
const ASSETS = [
  ['index.html', 'html', true],
  ['config.js', 'js', true],
  ['community.js', 'js', true],
  ['notifications.js', 'js', true],
  ['notification-start.js', 'js', true],
  ['notification-start.css', 'css', true],
  ['app-update.js', 'js', true],
  ['app-update.css', 'css', true],
  ['community.css', 'css', true],
  ['calendar.js', 'js', true],
  ['calendar.css', 'css', true],
  ['work-shell.js', 'js', true],
  ['work-shell.css', 'css', true],
  ['navigation-pack.js', 'js', true],
  ['navigation-pack.css', 'css', true],
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
  if (url.origin !== ROOT.origin) return;
  const notification=url.searchParams.get('notification');
  const notificationNavigation=request.mode==='navigate'&&notification&&/^[A-Za-z0-9-]{1,64}$/.test(notification)&&[...url.searchParams.keys()].every(key=>key==='notification');
  if(url.search&&!notificationNavigation)return;
  const isHomeNavigation = request.mode === 'navigate' &&
    (url.pathname === ROOT.pathname || url.pathname === new URL(INDEX_URL).pathname);
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
  if(request.cache==='reload'||request.cache==='no-store')return;
  const asset = RESOURCE_BY_URL.get(url.href);
  if (!asset || asset.kind === 'html') return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const saved = await cache.match(asset.url);
    if (saved) return saved;
    const pack=await savedMapAsset(asset.url);if(pack)return pack;
    const response = await fetch(request);
    if (await isSafeResponse(response, asset)) await cache.put(asset.url, response.clone());
    return response;
  })());
});

async function savedMapAsset(url){
 try{const index=await caches.open('atlas-map-pack-index-v1'),record=await index.match(new URL('__atlas_map_pack__',ROOT).href);if(!record)return null;const pointer=await record.json();if(typeof pointer.cacheName!=='string'||!pointer.cacheName.startsWith('atlas-map-pack-'))return null;const cache=await caches.open(pointer.cacheName);return await cache.match(url)||null;}catch{return null;}
}
self.addEventListener('push',event=>{
 event.waitUntil((async()=>{let payload={};try{payload=event.data?.json()||{};}catch{}const id=String(payload.notificationId||'');if(!/^[A-Za-z0-9-]{1,64}$/.test(id))return;const kind=payload.type==='chat'?'chat':'work',prefix=kind==='chat'?'Чат бригады':'Кусты и скважины',heading=String(payload.title||prefix),title=heading.startsWith(prefix)?heading:prefix+' · '+heading;await self.registration.showNotification(title.slice(0,160),{body:String(payload.body||'Откройте приложение, чтобы прочитать комментарий.').slice(0,500),icon:new URL('icon-192.png',ROOT).href,badge:new URL('icon-192.png',ROOT).href,tag:'brigade-'+kind+'-'+id,data:{notificationId:id},renotify:false});})());
});
self.addEventListener('notificationclick',event=>{
 event.notification.close();const id=String(event.notification.data?.notificationId||'');if(!/^[A-Za-z0-9-]{1,64}$/.test(id))return;
 event.waitUntil((async()=>{const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});const found=windows.find(client=>client.url.startsWith(ROOT.href));if(found){await found.focus();found.postMessage({type:'ATLAS_NOTIFICATION_OPEN',id});return;}const target=new URL(ROOT.href);target.searchParams.set('notification',id);await self.clients.openWindow(target.href);})());
});
