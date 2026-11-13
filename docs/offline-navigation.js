'use strict';
window.NavigationGeometry=(()=>{
  const R=6371008.8,RAD=Math.PI/180;
  const distance=(a,b)=>{const x=(b[0]-a[0])*RAD,y=(b[1]-a[1])*RAD;const h=Math.sin(x/2)**2+Math.cos(a[0]*RAD)*Math.cos(b[0]*RAD)*Math.sin(y/2)**2;return 2*R*Math.asin(Math.sqrt(Math.min(1,h)));};
  const bearing=(a,b)=>{const y=Math.sin((b[1]-a[1])*RAD)*Math.cos(b[0]*RAD),x=Math.cos(a[0]*RAD)*Math.sin(b[0]*RAD)-Math.sin(a[0]*RAD)*Math.cos(b[0]*RAD)*Math.cos((b[1]-a[1])*RAD);return(Math.atan2(y,x)/RAD+360)%360;};
  const turn=(a,b)=>((b-a+540)%360)-180;
  function prepare(coordinates){
    const points=coordinates.filter((p,i)=>!i||distance(p,coordinates[i-1])>.05).map(p=>p.slice());
    const cumulative=[0];for(let i=1;i<points.length;i++)cumulative.push(cumulative.at(-1)+distance(points[i-1],points[i]));
    const total=cumulative.at(-1)||0,route={points,cumulative,total,maneuvers:[]};
    const candidates=[];
    for(let i=1;i<points.length-1;i++){
      const at=cumulative[i];if(at<20||total-at<20)continue;
      const before=pointAt(route,Math.max(0,at-35)),after=pointAt(route,Math.min(total,at+35));
      const angle=turn(bearing(before,points[i]),bearing(points[i],after));
      if(Math.abs(angle)>=34)candidates.push({along:at,angle,point:points[i]});
    }
    for(const c of candidates){const previous=route.maneuvers.at(-1);if(previous&&c.along-previous.along<65){if(Math.abs(c.angle)>Math.abs(previous.angle))route.maneuvers[route.maneuvers.length-1]=c;}else route.maneuvers.push(c);}
    route.maneuvers=route.maneuvers.map(m=>({...m,kind:Math.abs(m.angle)>150?'uturn':m.angle>0?'right':'left',instruction:Math.abs(m.angle)>150?'Развернитесь':Math.abs(m.angle)<50?(m.angle>0?'Держитесь правее':'Держитесь левее'):(m.angle>0?'Поверните направо':'Поверните налево')}));
    return route;
  }
  function pointAt(route,along){
    const {points,cumulative}=route;if(!points.length)return[0,0];if(along<=0)return points[0].slice();if(along>=route.total)return points.at(-1).slice();
    let i=1;while(cumulative[i]<along)i++;const t=(along-cumulative[i-1])/(cumulative[i]-cumulative[i-1]);return points[i-1].map((v,k)=>v+(points[i][k]-v)*t);
  }
  function project(route,position,range){
    const p=Array.isArray(position)?position:[position.lat,position.lng];let best=null;const cos=Math.cos(p[0]*RAD),sx=R*RAD*cos,sy=R*RAD;
    for(let i=1;i<route.points.length;i++){
      if(range&&(route.cumulative[i]<range[0]||route.cumulative[i-1]>range[1]))continue;
      const a=route.points[i-1],b=route.points[i],x=(b[1]-a[1])*sx,y=(b[0]-a[0])*sy,px=(p[1]-a[1])*sx,py=(p[0]-a[0])*sy;
      const t=Math.max(0,Math.min(1,(px*x+py*y)/(x*x+y*y||1))),point=[a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t];
      const d=distance(p,point),along=route.cumulative[i-1]+(route.cumulative[i]-route.cumulative[i-1])*t;
      if(!best||d<best.distance)best={point,distance:d,along,segment:i-1,bearing:bearing(a,b)};
    }return best;
  }
  function next(route,along){const m=route.maneuvers.find(m=>m.along>along+12);return m?{...m,distance:Math.max(0,m.along-along)}:{kind:'finish',instruction:'Продолжайте до точки назначения',along:route.total,distance:Math.max(0,route.total-along),point:route.points.at(-1)};}
  function createTracker(route){return{route,along:0,lastGoodAt:0,lastAt:0,offRouteSince:0,offRouteSamples:0,arrivalSince:0,arrived:false};}
  function update(tracker,position,at=Date.now()){
    const accuracy=Number(position.accuracy),good=Number.isFinite(accuracy)&&accuracy>0&&accuracy<=60;
    const dt=tracker.lastAt?Math.max(0,(at-tracker.lastAt)/1000):0;
    const range=tracker.lastGoodAt?[Math.max(0,tracker.along-60),Math.min(tracker.route.total,tracker.along+Math.max(160,dt*40))]:[0,Math.min(tracker.route.total,200)];
    let projection=project(tracker.route,position,range),globalProjection;
    if(projection&&projection.distance>Math.max(100,accuracy*2)){globalProjection=project(tracker.route,position);if(globalProjection.distance+30<projection.distance)projection=globalProjection;}
    if(!projection)return null;
    const onRoad=projection.distance<=Math.max(30,Math.min(85,accuracy*1.6));
    if(good&&onRoad){tracker.along=Math.max(0,Math.min(tracker.route.total,projection.along));tracker.lastGoodAt=at;}
    const offRoute=good&&accuracy<=50&&projection.distance>Math.max(45,accuracy*1.7);
    if(offRoute){if(!tracker.offRouteSince)tracker.offRouteSince=at;tracker.offRouteSamples++;}else{tracker.offRouteSince=0;tracker.offRouteSamples=0;}
    const remaining=Math.max(0,tracker.route.total-tracker.along),endDistance=distance([position.lat,position.lng],tracker.route.points.at(-1));
    const atEnd=good&&accuracy<=35&&remaining<=30&&endDistance<=Math.max(18,Math.min(30,accuracy*1.2));
    if(atEnd){if(!tracker.arrivalSince)tracker.arrivalSince=at;tracker.arrived=at-tracker.arrivalSince>=4000;}else{tracker.arrivalSince=0;tracker.arrived=false;}
    tracker.lastAt=at;
    return{along:tracker.along,remaining,projection,accuracy,good,onRoad,offRoute,arrived:tracker.arrived,next:next(tracker.route,tracker.along),shouldReroute:offRoute&&tracker.offRouteSamples>=3&&at-tracker.offRouteSince>=6000};
  }
  return{distance,bearing,prepare,pointAt,project,next,createTracker,update};
})();
window.OfflineNavigator=(()=>{
  let roads,network,router,loadPromise,vectorLayer,roadCasing,coverageLayer;
  let schemeNetwork,schemePromise,schemePickTarget,schemeRouter;
  let routeLayer,schemeRouteLayer,activeRoute,routeDestination,watchId,following=false,cameraFollow=false;
  let geometry,tracker,guidance,positionMarker,remainingLine,passedLine,signalTimer,lastFixAt=0,lastFixTimestamp=0;
  let navigationEpoch=0,rerouteEpoch=0,rerouteTimer,rerouteBusy=false,lastRerouteAt=0,voiceEnabled=false,lastSpoken='';
  const G=window.NavigationGeometry;
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
      geoMap.on('dragstart',()=>{if(following){cameraFollow=false;updateControls();}});
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
    if(activeRoute&&following&&cameraFollow&&guidance?.good){geoMap.setView(guidance.projection.point,Math.max(16,geoMap.getZoom()),{animate:false});return;}
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
    const epoch=++navigationEpoch;
    $('#modal').close();closeDrawer();setView('map');setLayer('geo');geoMap.closePopup();
    toast('Определяем местоположение…');
    try{
      await load();const start=await getPosition();if(epoch!==navigationEpoch)return;renderGeoMarkers();
      const result=router.route(start,destination,{allowPrivate:true,allowTrack:true,maxSnapMeters:500});
      if(result.error){showRouteError(result.error);return;}
      routeDestination={...destination,label};drawRoute(result,label,start,destination);toast('Маршрут рассчитан. Интернет не требуется.');
    }catch(e){if(epoch===navigationEpoch)showRouteError(e.message);}
  }
  function showRouteError(message){showModal('Маршрут не построен',`<p class="modal-copy">${esc(message)}</p><p class="form-help">Маршрут рассчитывается по дорогам сохранённой области. Вне этой области или на разрыве дорожной сети путь может быть недоступен.</p><button class="btn" data-action="close-modal">Понятно</button>`);}
  function clearRoute(invalidate=true){
    if(invalidate)navigationEpoch++;rerouteEpoch++;clearTimeout(rerouteTimer);rerouteTimer=null;rerouteBusy=false;
    stopFollowing();schemePickTarget=null;geoPickingTarget=null;if(fieldMap)fieldMap.off('click',onSchemeStart);routeLayer?.remove();routeLayer=null;schemeRouteLayer?.remove();schemeRouteLayer=null;activeRoute=null;routeDestination=null;geometry=null;tracker=null;guidance=null;lastRerouteAt=0;
    $('#route-card')?.remove();$('.map-panel').classList.remove('has-route');$('.app-shell').classList.remove('local-route-active');
  }
  function drawRoute(result,label,start,destination,keepFollowing=false){
    const resume=keepFollowing&&following,wasCamera=cameraFollow;
    if(keepFollowing){routeLayer?.remove();$('#route-card')?.remove();positionMarker=null;}else clearRoute(false);
    activeRoute=result;routeDestination={...destination,label};geometry=G.prepare(result.coordinates);tracker=G.createTracker(geometry);guidance=null;routeLayer=L.layerGroup().addTo(geoMap);
    L.polyline(result.coordinates,{color:'#fff',weight:9,opacity:.9,lineCap:'round',lineJoin:'round'}).addTo(routeLayer);
    passedLine=L.polyline([],{color:'#86a3aa',weight:5,opacity:.8,lineCap:'round'}).addTo(routeLayer);
    remainingLine=L.polyline(result.coordinates,{color:'#0c93a3',weight:5,opacity:1,lineCap:'round',lineJoin:'round'}).addTo(routeLayer);
    L.marker(result.coordinates[0],{icon:ownIcon('А')}).addTo(routeLayer);
    L.marker(result.coordinates.at(-1),{icon:ownIcon('Б','#b49559')}).addTo(routeLayer);
    if(result.snaps?.startMeters>10)L.polyline([[start.lat,start.lng],result.coordinates[0]],{color:'#6e959d',weight:2,dashArray:'4 6'}).addTo(routeLayer);
    if(result.snaps?.endMeters>10)L.polyline([result.coordinates.at(-1),[destination.lat,destination.lng]],{color:'#a08b5e',weight:2,dashArray:'4 6'}).addTo(routeLayer);
    $('#geo-help').classList.add('hidden');$('.map-panel').classList.add('has-route');$('.app-shell').classList.add('local-route-active');
    $('.map-panel').insertAdjacentHTML('beforeend',`<section id="route-card" class="local-route-card" aria-label="Ведение по маршруту"><div class="route-card-heading"><span>${icon('route')}МАРШРУТ БЕЗ СЕТИ</span><button class="icon-btn" data-local-action="clear" aria-label="Закрыть маршрут">${icon('cross')}</button></div><div class="route-maneuver" aria-live="polite" aria-atomic="true"><div id="maneuver-icon"></div><div><strong id="maneuver-distance"></strong><span id="maneuver-text"></span></div></div><div class="route-card-main"><div><strong id="route-remaining">${formatDistance(result.distanceMeters)}</strong><span>до ${esc(label)} · по дороге</span></div><button class="btn primary" data-local-action="follow">${icon('gps')}Начать ведение</button></div><div class="guidance-actions"><button class="btn" data-local-action="recenter" aria-label="Показывать моё положение">${icon('gps')}К позиции</button><button class="btn" data-local-action="voice" aria-pressed="false">Голос: выкл.</button><button class="btn" data-local-action="overview">Весь путь</button></div><p id="route-progress" role="status">${result.snaps?.startMeters>25||result.snaps?.endMeters>25?'Пунктир — соединение с ближайшей дорогой. ':''}${result.flags?.includes('private')?'На пути есть промысловые проезды.':'GPS определит продвижение по маршруту.'}</p></section>`);
    updateManeuver(G.next(geometry,0));updateControls();
    L.DomEvent.disableClickPropagation($('#route-card'));L.DomEvent.disableScrollPropagation($('#route-card'));
    if(resume){cameraFollow=wasCamera;following=true;processPosition({...start,accuracy:start.accuracy||20},Date.now());}
    else setTimeout(()=>{if(!activeRoute)return;fit();if(matchMedia('(max-width: 600px)').matches)$('.map-panel').scrollIntoView({behavior:'auto',block:'start'});},100);
  }
  function turnIcon(kind){return `<svg viewBox="0 0 40 40" fill="none" aria-hidden="true"><path d="${kind==='left'?'M27 33V18Q27 12 21 12H8M8 12L17 4M8 12L17 21':kind==='right'?'M13 33V18Q13 12 19 12H32M32 12L23 4M32 12L23 21':kind==='uturn'?'M29 32V14a9 9 0 0 0-18 0v10M11 24L4 17M11 24L18 17':kind==='finish'?'M12 34V6M13 7H31L26 14L31 21H13':'M20 34V6M20 6L10 17M20 6L30 17'}" stroke="currentColor" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;}
  function updateManeuver(next){
    if(!$('#maneuver-text'))return;
    const arrived=guidance?.arrived;$('#maneuver-icon').innerHTML=turnIcon(arrived?'finish':next.kind);
    $('#maneuver-distance').textContent=arrived?'Вы на месте':formatDistance(next.distance);
    $('#maneuver-text').textContent=arrived?'Точка подъезда по карте':next.instruction;
  }
  function updateControls(){
    const b=$('[data-local-action="follow"]');if(b)b.innerHTML=icon('gps')+(following?'Пауза':'Начать ведение');
    const c=$('[data-local-action="recenter"]');if(c){c.classList.toggle('is-active',cameraFollow);c.setAttribute('aria-pressed',String(cameraFollow));}
    const v=$('[data-local-action="voice"]');if(v){v.textContent=voiceEnabled?'Голос: вкл.':'Голос: выкл.';v.setAttribute('aria-pressed',String(voiceEnabled));}
  }
  function setProgress(text){const p=$('#route-progress');if(p)p.textContent=text;}
  function speak(text,key){
    if(!voiceEnabled||lastSpoken===key||!window.speechSynthesis)return;
    const voice=speechSynthesis.getVoices().find(v=>v.localService&&/^ru/i.test(v.lang));
    if(!voice)return;lastSpoken=key;const phrase=new SpeechSynthesisUtterance(text);phrase.lang='ru-RU';phrase.voice=voice;phrase.rate=1;speechSynthesis.cancel();speechSynthesis.speak(phrase);
  }
  function toggleVoice(){
    if(!voiceEnabled&&!window.speechSynthesis){toast('Голосовые подсказки не поддерживаются на этом телефоне.');return;}
    if(!voiceEnabled&&!speechSynthesis.getVoices().some(v=>v.localService&&/^ru/i.test(v.lang))){toast('Для голоса нужен русский голос, установленный на телефоне. Подсказки на экране доступны.');return;}
    voiceEnabled=!voiceEnabled;if(!voiceEnabled)speechSynthesis.cancel();lastSpoken='';updateControls();
  }
  function processPosition(position,at=Date.now()){
    if(!following||!tracker)return;
    const state=G.update(tracker,position,at);if(!state)return;guidance=state;lastFixAt=at;userPosition={...position};
    if(gpsMarker){gpsMarker.setLatLng([position.lat,position.lng]);gpsMarker.setStyle({opacity:0,fillOpacity:0});}else renderGeoMarkers();
    gpsAccuracy?.setLatLng([position.lat,position.lng]);if(Number.isFinite(position.accuracy))gpsAccuracy?.setRadius(position.accuracy);
    const snapped=state.good&&state.onRoad?state.projection.point:[position.lat,position.lng],heading=Number.isFinite(position.heading)&&position.speed>1?position.heading:state.projection.bearing;
    const pin=L.divIcon({className:'guidance-position',html:`<span style="transform:rotate(${heading}deg)"><svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 3L27 28L16 23L5 28Z"/></svg></span>`,iconSize:[36,36],iconAnchor:[18,18]});
    if(!positionMarker)positionMarker=L.marker(snapped,{icon:pin,zIndexOffset:1200,interactive:false}).addTo(routeLayer);else positionMarker.setLatLng(snapped).setIcon(pin);
    if(state.good&&state.onRoad){const i=state.projection.segment;passedLine.setLatLngs([...geometry.points.slice(0,i+1),state.projection.point]);remainingLine.setLatLngs([state.projection.point,...geometry.points.slice(i+1)]);}
    $('#route-remaining').textContent=formatDistance(state.remaining);updateManeuver(state.next);
    setProgress(state.arrived?'Вы достигли точки подъезда на сохранённой карте.':!state.good?`Низкая точность GPS: ±${Math.round(state.accuracy)||'—'} м. Ждём точный сигнал.`:rerouteBusy?'Перестраиваем маршрут по сохранённым дорогам…':state.offRoute?`Вы в стороне от маршрута · GPS ±${Math.round(state.accuracy)} м`:`GPS ±${Math.round(state.accuracy)} м · осталось по дороге ${formatDistance(state.remaining)}`);
    if(state.good&&cameraFollow)geoMap.setView(snapped,Math.max(geoMap.getZoom(),16),{animate:true,duration:.4});
    if(state.good&&!state.offRoute){const bucket=state.next.distance<45?'now':state.next.distance<180?'soon':'far';if(bucket!=='far')speak(`${bucket==='now'?'Сейчас':`Через ${Math.round(state.next.distance/10)*10} метров`}. ${state.next.instruction}`,`${state.next.along}:${bucket}`);if(state.arrived)speak('Вы достигли точки назначения.','arrived');}
    if(state.shouldReroute&&!state.arrived)scheduleReroute();else if(!state.offRoute){clearTimeout(rerouteTimer);rerouteTimer=null;}
  }
  function scheduleReroute(){
    if(rerouteTimer||rerouteBusy||Date.now()-lastRerouteAt<20000)return;
    const token=++rerouteEpoch,epoch=navigationEpoch;
    rerouteTimer=setTimeout(async()=>{
      rerouteTimer=null;if(token!==rerouteEpoch||epoch!==navigationEpoch||!following||!guidance?.shouldReroute||Date.now()-lastFixAt>10000)return;
      rerouteBusy=true;lastRerouteAt=Date.now();setProgress('Перестраиваем маршрут по сохранённым дорогам…');
      await new Promise(resolve=>setTimeout(resolve,0));
      if(token!==rerouteEpoch||epoch!==navigationEpoch||!following){rerouteBusy=false;return;}
      const destination={...routeDestination},start={...userPosition};
      try{
        const result=router.route(start,destination,{allowPrivate:true,allowTrack:true,maxSnapMeters:300});
        if(token!==rerouteEpoch||epoch!==navigationEpoch||!following)return;
        if(result.error){setProgress('Проезд до маршрута не найден. Продолжайте по доступной дороге и проверьте карту.');return;}
        drawRoute(result,destination.label,start,destination,true);speak('Маршрут перестроен.','reroute:'+token);
      }finally{rerouteBusy=false;}
    },600);
  }
  function startFollowing(){
    if(!activeRoute||following)return;
    if(!navigator.geolocation){toast('Геолокация недоступна на этом телефоне.');return;}
    following=true;cameraFollow=true;lastFixAt=Date.now();lastFixTimestamp=0;lastSpoken='';updateControls();setProgress('Ищем GPS. На открытом месте первый поиск может занять до минуты.');
    watchId=navigator.geolocation.watchPosition(p=>{
      if(!following)return;const time=Number(p.timestamp)||Date.now();if(time<=lastFixTimestamp||Date.now()-time>20000)return;lastFixTimestamp=time;
      processPosition({lat:p.coords.latitude,lng:p.coords.longitude,accuracy:p.coords.accuracy,heading:p.coords.heading,speed:p.coords.speed},Date.now());
    },e=>{if(e.code===1){stopFollowing();setProgress('Доступ к GPS запрещён. Разрешите местоположение в настройках телефона.');}else setProgress('Нет свежего сигнала GPS. Маршрут сохранён; ждём определения позиции.');},{enableHighAccuracy:true,maximumAge:2000,timeout:60000});
    signalTimer=setInterval(()=>{if(following&&Date.now()-lastFixAt>(lastFixTimestamp?20000:60000)){setProgress('Сигнал GPS потерян. Последняя позиция сохранена; ждём свежий сигнал.');clearTimeout(rerouteTimer);rerouteTimer=null;}},5000);
  }
  function stopFollowing(){
    if(watchId!==undefined)navigator.geolocation?.clearWatch(watchId);watchId=undefined;clearInterval(signalTimer);signalTimer=null;following=false;cameraFollow=false;rerouteEpoch++;clearTimeout(rerouteTimer);rerouteTimer=null;rerouteBusy=false;
    if(window.speechSynthesis)speechSynthesis.cancel();gpsMarker?.setStyle({opacity:1,fillOpacity:1});updateControls();
  }
  function recenter(){if(!activeRoute)return;cameraFollow=true;if(!following)startFollowing();else{const p=guidance?.projection?.point||(userPosition&&[userPosition.lat,userPosition.lng]);if(p)geoMap.setView(p,Math.max(16,geoMap.getZoom()),{animate:true});updateControls();}}
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
    const action=e.target.closest('[data-local-action]');if(action?.dataset.localAction==='clear')clearRoute();if(action?.dataset.localAction==='follow'){if(following){stopFollowing();setProgress('Ведение приостановлено. Нажмите «Начать ведение», чтобы продолжить.');}else startFollowing();}if(action?.dataset.localAction==='recenter')recenter();if(action?.dataset.localAction==='voice')toggleVoice();if(action?.dataset.localAction==='overview'){cameraFollow=false;updateControls();fit();}
  });
  window.addEventListener('atlas-theme-change',()=>{vectorLayer?.setStyle(f=>mapStyle(f));roadCasing?.setStyle(f=>mapStyle(f,true));});
  function pickSchemePosition(point){if(!schemePickTarget)return false;fieldMap.off('click',onSchemeStart);onSchemeStart({latlng:L.latLng(point)});return true;}
  function getNavigationState(){return{following,cameraFollow,rerouteBusy,lastFixAt,position:guidance?{...guidance}:null,totalMeters:geometry?.total,maneuvers:geometry?.maneuvers.map(m=>({...m}))||[]};}
  return{initMap,fit,routeToSelected,navigate,clearRoute,load,beginSchemeRoute,pickSchemePosition,recenter,stopFollowing,toggleFollow:()=>following?stopFollowing():startFollowing(),getNavigationState};
})();
