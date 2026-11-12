'use strict';
// Android-only adapter. The ordinary browser build keeps its own Geolocation API.
(() => {
  if (!window.SdngGps || location.origin !== 'https://appassets.androidplatform.net') return;
  window.isNativeAtlas = true;
  const requests = new Map();
  let nextId = 1, lastPosition;
  const asyncCall = fn => setTimeout(fn, 0);
  const syncReceiver = () => requests.size ? SdngGps.start() : SdngGps.stop();
  const errorValue = (code, message) => ({code, message, PERMISSION_DENIED:1, POSITION_UNAVAILABLE:2, TIMEOUT:3});
  function remove(id) {
    const request = requests.get(id);
    if (request) clearTimeout(request.timer);
    requests.delete(id);
    syncReceiver();
  }
  function arm(id) {
    const request = requests.get(id);
    if (!request) return;
    clearTimeout(request.timer);
    if (Number.isFinite(request.timeout)) request.timer = setTimeout(() => {
      if (!requests.has(id)) return;
      if (!request.watch) remove(id);
      if (request.error) asyncCall(() => request.error(errorValue(3, 'Не удалось получить GPS. Выйдите на открытое место и повторите.')));
    }, request.timeout);
  }
  function add(success, error, options, watch) {
    if (typeof success !== 'function') throw new TypeError('A position callback is required');
    options ||= {};
    const id = nextId++;
    const request = {success, error:typeof error === 'function' ? error : null, watch,
      timeout:options.timeout == null ? Infinity : Math.max(0, Number(options.timeout)), timer:null};
    const maximumAge = Math.max(0, Number(options.maximumAge) || 0);
    if (lastPosition && maximumAge > 0 && Date.now() - lastPosition.timestamp <= maximumAge) {
      const cachedPosition = lastPosition;
      asyncCall(() => { if (!watch || requests.has(id)) success(cachedPosition); });
      if (!watch) return id;
    }
    requests.set(id, request); arm(id); syncReceiver();
    return id;
  }
  window.addEventListener('sdng:gps', event => {
    const p = event.detail;
    if (!p || !Number.isFinite(p.latitude) || !Number.isFinite(p.longitude)) return;
    lastPosition = {coords:{latitude:p.latitude, longitude:p.longitude, accuracy:p.accuracy,
      altitude:p.altitude ?? null, altitudeAccuracy:p.altitudeAccuracy ?? null,
      heading:p.heading ?? null, speed:p.speed ?? null}, timestamp:p.timestamp || Date.now()};
    const deliveredPosition = lastPosition;
    for (const [id, request] of [...requests]) {
      if (!request.watch) remove(id); else arm(id);
      asyncCall(() => { if (!request.watch || requests.has(id)) request.success(deliveredPosition); });
    }
  });
  window.addEventListener('sdng:gps-error', event => {
    const e = event.detail || {};
    for (const [id, request] of [...requests]) {
      if (!request.watch || e.code === 1) remove(id);
      if (request.error) asyncCall(() => request.error(errorValue(e.code || 2, e.message || 'GPS пока недоступен.')));
    }
  });
  const api = Object.freeze({
    getCurrentPosition(success, error, options) { add(success, error, options, false); },
    watchPosition(success, error, options) { return add(success, error, options, true); },
    clearWatch(id) { remove(id); }
  });
  Object.defineProperty(navigator, 'geolocation', {value:api, configurable:false});
  window.addEventListener('pagehide', () => { for (const id of [...requests.keys()]) remove(id); });
})();
