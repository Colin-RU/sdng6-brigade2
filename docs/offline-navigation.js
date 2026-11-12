'use strict';
window.OfflineNavigator=(()=>{
  let roads,network,router,loadPromise,vectorLayer,roadCasing,coverageLayer;
  let schemeNetwork,schemePromise,schemePickTarget,schemeRouter;
  let routeLayer,schemeRouteLayer,activeRoute,routeDestination,watchId,following=false;
  let geoPickingTarget=null;
  const ownIcon=(label,color='#167c8a')=>L.divIcon({className:'route-endpoint',html:`<span style="--endpoint-color:${color}">${esc(label)}</span>`,iconSize:[28,28],iconAnchor:[14,14]});
  function mapStyle(feature,casing=false){
    const dark=document.documentElement.dataset.theme==='dark',p=feature.properties?.tags||feature.properties||{};
    if(feature.geometry.type.includes('Polygon'))return{color:dark?'#45615d':'#bdcbbd',weight:1,fillColor:dark?'#27443f':'#d6e1cf',fillOpacity:.65};
    const major=['trunk','primary','secondary','tertiary'].includes(p.highway);
    return {color:casing?(dark?'#0b1b24':'#fff'):(major?(dark?'#79a8b8':'#5b8592'):(dark?'#4a747d':'#9bb1b1')),weight:casing?(major?8:6):(major?3.5:2.1),opacity:1,dashArray:p.highway==='track'&&!casing?'6 5':null,lineCap:'round',lineJoin:'round'};
  }
  async function load(){
    if(!loadPromise)loadPromise=Promise.all(['geo-roads.json','geo-network.json'].map(async f=>{const r=await fetch(f);if(!r.ok)throw Error('Не удалось открыть сохранённые дороги.');return r.json();})).then(([r,n])=>{roads=r;network=n;router=new LocalRouter(n);return{roads,network};}).catch(e=>{loadPromise=null;throw e;});
    return loadPromise;
  }
  function initMap(){
    if(!geoMap){
      geoMap=L.map('geo-map',{zoomControl:false,minZoom:8,maxZoom:20,attributionControl:true}).setView([fieldOverview.lat,fieldOverview.lng],11);
      L.control.zoom({position:'bottomright'}).addTo(geoMap);geoMap.attributionControl.setPrefix(false);geoMap.attributionControl.addAttribution('Данные © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>');
      geoMarkers=L.markerClusterGroup({maxClusterRadius:36,disableClusteringAtZoom:15,showCoverageOnHover:false,spiderfyOnMaxZoom:true,iconCreateFunction:c=>L.divIcon({className:'atlas-cluster',html:`<div>${c.getChildCount()}<small>КУСТОВ</small></div>`,iconSize:[42,42]})}).addTo(geoMap);
      geoMap.on('click',e=>{if(geoPickingTarget){confirmMapCoordinate(e.latlng);return;}showPointPopup(e.latlng);});
    }
    if(!geoWellMarkers)geoWellMarkers=L.layerGroup().addTo(geoMap);
    renderGeoMarkers();
    load().then(()=>{
      if(!vectorLayer){
        const lines={type:'FeatureCollection',features:roads.features.filter(f=>!f.geometry.type.includes('Polygon'))};
        roadCasing=L.geoJSON(lines,{style:f=>mapStyle(f,true),interactive:false}).addTo(geoMap);
        vectorLayer=L.geoJSON(roads,{style:f=>mapStyle(f),interactive:false}).addTo(geoMap);
        vectorLayer.bringToBack();roadCasing.bringToBack();
        fit();
      }
    }).catch(e=>toast(e.message));
  }
  function fit(){
    if(!geoMap)return;
    if(activeRoute){geoMap.fitBounds(L.latLngBounds(activeRoute.coordinates),{paddingTopLeft:[45,70],paddingBottomRight:[45,165],maxZoom:17,animate:false});return;}
    if(userPosition){geoMap.setView([userPosition.lat,userPosition.lng],14);return;}
    const coords=validCoordinates();if(coords.length){geoMap.fitBounds(coords.map(([,c])=>[c.lat,c.lng]),{padding:[60,80],maxZoom:14});return;}
    if(vectorLayer?.getBounds().isValid())geoMap.fitBounds(vectorLayer.getBounds(),{padding:[30,45],maxZoom:12});
  }
  function showPointPopup(latlng){
    $('#geo-help').classList.add('hidden');
    L.popup({closeButton:true,offset:[0,-4]}).setLatLng(latlng).setContent(`<div class="point-popup"><b>Точка на карте</b><span>${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}</span><button class="btn primary" data-local-destination="${latlng.lat},${latlng.lng}">${icon('route')}Маршрут сюда</button></div>`).openOn(geoMap);
  }
  function setHelp(message){$('#geo-help').classList.remove('hidden');$('#geo-help').innerHTML=`<b>${esc(message)}</b><span>Для автоматической навигации к номерному кусту нужна его точка на карте. Дороги и схема сохранены для работы без связи.</span>`;}
  async function routeToSelected(){
    const target=requestCoordinateTarget();if(!target)return;
    const c=coordinateFor(target.key);
    if(isValidCoordinate(c)){await window.OfflineNavigator.navigate(c,target.label);return;}
    const schemePoint=points.points.find(p=>p.id===target.padId)||(target.wellId&&points.extraWells.find(p=>p.id===target.wellId));
    showModal('Нужна привязка куста',`<p class="modal-copy">Точное положение объекта «${esc(target.label)}» ещё не подтверждено. Можно проложить путь по схеме, указав на ней своё место.</p><div class="form-actions">${schemePoint?`<button class="btn primary" data-scheme-route="${esc(target.key)}">${icon('map')}Маршрут по схеме</button>`:''}<button class="btn" data-map-coordinate="${esc(target.key)}">Отметить на карте</button></div><p class="form-help">После привязки точки для маршрута будет достаточно номера куста. Ваше положение определится автоматически.</p>`);
  }
  async function navigate(destination,label='Выбранная точка'){
    $('#modal').close();closeDrawer();setView('map');setLayer('geo');geoMap.closePopup();
    toast('Определяем местоположение…');
    try{
      await load();const start=await getPosition();renderGeoMarkers();
      const result=router.route(start,destination,{allowPrivate:true,allowTrack:true,maxSnapMeters:500});
      if(result.error){showRouteError(result.error);return;}
      routeDestination={...destination,label};drawRoute(result,label,start,destination);toast('Маршрут рассчитан. Интернет не требуется.');
    }catch(e){showRouteError(e.message);}
  }
  function showRouteError(message){showModal('Маршрут не построен',`<p class="modal-copy">${esc(message)}</p><p class="form-help">Маршрут рассчитывается по дорогам сохранённой области. Вне этой области или на разрыве дорожной сети путь может быть недоступен.</p><button class="btn" data-action="close-modal">Понятно</button>`);}
  function clearRoute(){
    stopFollowing();schemePickTarget=null;geoPickingTarget=null;if(fieldMap)fieldMap.off('click',onSchemeStart);routeLayer?.remove();routeLayer=null;schemeRouteLayer?.remove();schemeRouteLayer=null;activeRoute=null;routeDestination=null;
    $('#route-card')?.remove();$('.map-panel').classList.remove('has-route');$('.app-shell').classList.remove('local-route-active');
  }
  function drawRoute(result,label,start,destination){
    clearRoute();activeRoute=result;routeDestination={...destination,label};routeLayer=L.layerGroup().addTo(geoMap);
    L.polyline(result.coordinates,{color:'#fff',weight:9,opacity:.9,lineCap:'round',lineJoin:'round'}).addTo(routeLayer);
    L.polyline(result.coordinates,{color:'#0c93a3',weight:5,opacity:1,lineCap:'round',lineJoin:'round'}).addTo(routeLayer);
    L.marker(result.coordinates[0],{icon:ownIcon('А')}).addTo(routeLayer);
    L.marker(result.coordinates.at(-1),{icon:ownIcon('Б','#b49559')}).addTo(routeLayer);
    if(result.snaps?.startMeters>10)L.polyline([[start.lat,start.lng],result.coordinates[0]],{color:'#6e959d',weight:2,dashArray:'4 6'}).addTo(routeLayer);
    if(result.snaps?.endMeters>10)L.polyline([result.coordinates.at(-1),[destination.lat,destination.lng]],{color:'#a08b5e',weight:2,dashArray:'4 6'}).addTo(routeLayer);
    $('#geo-help').classList.add('hidden');$('.map-panel').classList.add('has-route');$('.app-shell').classList.add('local-route-active');
    $('.map-panel').insertAdjacentHTML('beforeend',`<section id="route-card" class="local-route-card" aria-live="polite"><div class="route-card-heading"><span>${icon('route')}МАРШРУТ БЕЗ СЕТИ</span><button class="icon-btn" data-local-action="clear" aria-label="Закрыть маршрут">${icon('cross')}</button></div><div class="route-card-main"><div><strong>${formatDistance(result.distanceMeters)}</strong><span>до ${esc(label)}</span></div><button class="btn primary" data-local-action="follow">${icon('gps')}Начать</button></div><p id="route-progress">${result.snaps?.startMeters>25||result.snaps?.endMeters>25?'Пунктир — соединение точки с ближайшей дорогой. ':''}${result.flags?.includes('private')?'На пути есть промысловые проезды.':'По сохранённой сети дорог.'}</p></section>`);
    L.DomEvent.disableClickPropagation($('#route-card'));L.DomEvent.disableScrollPropagation($('#route-card'));setTimeout(()=>{fit();if(matchMedia('(max-width: 600px)').matches)$('.map-panel').scrollIntoView({behavior:'auto',block:'start'});},100);
  }
  function startFollowing(){
    if(!activeRoute||following)return;following=true;
    const button=$('[data-local-action="follow"]');if(button)button.textContent='Остановить';
    watchId=navigator.geolocation.watchPosition(p=>{
      userPosition={lat:p.coords.latitude,lng:p.coords.longitude,accuracy:p.coords.accuracy};renderGeoMarkers();
      const remaining=routeDestination?haversine(userPosition,routeDestination):0;
      let distanceToRoad=Infinity;
      const cos=Math.cos(userPosition.lat*Math.PI/180);
      for(let i=1;i<activeRoute.coordinates.length;i++){
        const a=activeRoute.coordinates[i-1],b=activeRoute.coordinates[i],vx=(b[1]-a[1])*cos,vy=b[0]-a[0],wx=(userPosition.lng-a[1])*cos,wy=userPosition.lat-a[0];
        const t=Math.max(0,Math.min(1,(wx*vx+wy*vy)/(vx*vx+vy*vy||1)));
        distanceToRoad=Math.min(distanceToRoad,haversine(userPosition,{lat:a[0]+t*(b[0]-a[0]),lng:a[1]+t*(b[1]-a[1])}));
      }
      const progress=$('#route-progress');if(progress)progress.textContent=remaining<40?'Вы рядом с конечной точкой.':`До конечной точки по прямой: ${formatDistance(remaining)} · GPS ±${Math.round(userPosition.accuracy)} м${distanceToRoad>Math.max(90,userPosition.accuracy*2)?' · вы в стороне от линии маршрута':''}`;
      geoMap.panTo([userPosition.lat,userPosition.lng],{animate:true});
    },e=>{toast(e.code===1?'Разрешите доступ к GPS в настройках телефона.':'GPS пока недоступен.');stopFollowing();},{enableHighAccuracy:true,maximumAge:3000,timeout:20000});
  }
  function stopFollowing(){if(watchId!==undefined)navigator.geolocation?.clearWatch(watchId);watchId=undefined;following=false;const b=$('[data-local-action="follow"]');if(b)b.innerHTML=icon('gps')+'Начать';}
  async function loadScheme(){if(!schemePromise)schemePromise=fetch('scheme-network.json').then(r=>{if(!r.ok)throw Error('Не удалось открыть дороги схемы.');return r.json();}).then(n=>(schemeNetwork=n,schemeRouter=new LocalRouter(n),n));return schemePromise;}
  async function beginSchemeRoute(key){
    $('#modal').close();closeDrawer();setView('map');setLayer('clean');clearRoute();
    try{await loadScheme();if(!schemeNetwork.anchors[key]){toast('Объект не найден на схеме.');return;}
      schemePickTarget=key;setHelp('Нажмите на дорогу там, где вы сейчас');$('#geo-help').classList.remove('hidden');
      fieldMap.once('click',onSchemeStart);
    }catch(e){toast(e.message);}
  }
  function onSchemeStart(event){
    if(!schemePickTarget)return;const key=schemePickTarget;schemePickTarget=null;
    const x=event.latlng.lng,y=1273-event.latlng.lat;
    const result=schemeRouter.route({x,y},schemeNetwork.anchors[key],{maxSnapDistance:80});
    $('#geo-help').classList.add('hidden');
    if(result.error){toast(result.error);return;}
    const coords=result.coordinates;
    const route=coords.map(([px,py])=>[1273-py,px]);schemeRouteLayer=L.layerGroup().addTo(fieldMap);
    L.polyline(route,{color:'#fff',weight:10,opacity:.9}).addTo(schemeRouteLayer);L.polyline(route,{color:'#0d92a2',weight:5,lineCap:'round'}).addTo(schemeRouteLayer);
    L.marker(route[0],{icon:ownIcon('А')}).addTo(schemeRouteLayer);L.marker(route.at(-1),{icon:ownIcon('Б','#b49559')}).addTo(schemeRouteLayer);
    $('.map-panel').classList.add('has-route');$('.app-shell').classList.add('local-route-active');
    const target=targetFromCoordinateKey(key);
    $('.map-panel').insertAdjacentHTML('beforeend',`<section id="route-card" class="local-route-card"><div class="route-card-heading"><span>${icon('route')}ПУТЬ ПО СХЕМЕ</span><button class="icon-btn" data-local-action="clear" aria-label="Закрыть маршрут">${icon('cross')}</button></div><div class="route-card-main"><div><strong>${esc(target?.label||key)}</strong><span>от выбранного вами места</span></div></div><p>Схема без масштаба и GPS-привязки. Расстояние в километрах не рассчитывается.</p></section>`);
    L.DomEvent.disableClickPropagation($('#route-card'));setTimeout(()=>{fieldMap.fitBounds(L.latLngBounds(route),{paddingTopLeft:[35,65],paddingBottomRight:[45,170],maxZoom:1.5,animate:false});if(matchMedia('(max-width: 600px)').matches)$('.map-panel').scrollIntoView({behavior:'auto',block:'start'});},100);
  }
  function pickCoordinate(key){
    const target=targetFromCoordinateKey(key);if(!target)return;$('#modal').close();closeDrawer();setView('map');setLayer('geo');geoPickingTarget=target;setHelp(`Отметьте на карте: ${target.label}`);
  }
  function confirmMapCoordinate(latlng){
    const target=geoPickingTarget;geoPickingTarget=null;
    showModal(`Это ${esc(target.label)}?`,`<p class="modal-copy">Подтвердите расположение объекта. Эта точка будет использоваться для навигации на вашем телефоне.</p><div class="gps-result">${latlng.lat.toFixed(6)}, ${latlng.lng.toFixed(6)}</div><div class="form-actions"><button class="btn primary" data-confirm-map-coordinate="${esc(target.key)}" data-lat="${latlng.lat}" data-lng="${latlng.lng}">Сохранить точку</button><button class="btn" data-action="close-modal">Отмена</button></div>`);
  }
  document.addEventListener('click',e=>{
    const dest=e.target.closest('[data-local-destination]');if(dest){const [lat,lng]=dest.dataset.localDestination.split(',').map(Number);navigate({lat,lng},'выбранной точки');return;}
    const scheme=e.target.closest('[data-scheme-route]');if(scheme){beginSchemeRoute(scheme.dataset.schemeRoute);return;}
    const pick=e.target.closest('[data-map-coordinate]');if(pick){pickCoordinate(pick.dataset.mapCoordinate);return;}
    const confirm=e.target.closest('[data-confirm-map-coordinate]');if(confirm){const target=targetFromCoordinateKey(confirm.dataset.confirmMapCoordinate);local.coordinates[target.key]={lat:Number(confirm.dataset.lat),lng:Number(confirm.dataset.lng),source:'manual',useForRoutes:true,recordedAt:new Date().toISOString()};const saved=persist();$('#modal').close();renderGeoMarkers();$('#geo-help').classList.add('hidden');if(saved)toast(`${target.label}: точка сохранена`);return;}
    const action=e.target.closest('[data-local-action]');if(action?.dataset.localAction==='clear')clearRoute();if(action?.dataset.localAction==='follow'){if(following)stopFollowing();else startFollowing();}
  });
  window.addEventListener('atlas-theme-change',()=>{vectorLayer?.setStyle(f=>mapStyle(f));roadCasing?.setStyle(f=>mapStyle(f,true));});
  function pickSchemePosition(point){if(!schemePickTarget)return false;fieldMap.off('click',onSchemeStart);onSchemeStart({latlng:L.latLng(point)});return true;}
  return{initMap,fit,routeToSelected,navigate,clearRoute,load,beginSchemeRoute,pickSchemePosition};
})();
