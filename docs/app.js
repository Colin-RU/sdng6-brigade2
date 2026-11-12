'use strict';
const $ = (s, root=document) => root.querySelector(s);
const $$ = (s, root=document) => [...root.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const TYPES = {
  production:{label:'Добывающие',single:'Добывающая',color:'#ef8a3e',ink:'#24170c',short:'ЭЦН'},
  injection:{label:'ППД',single:'ППД',color:'#157a60',ink:'#ffffff',short:'ППД'},
  piezometric:{label:'Пьезометрические',single:'Пьезометрическая',color:'#216fb6',ink:'#ffffff',short:'Пьезо'},
  conserved:{label:'Законсервированные',single:'Законсервирована',color:'#f5d84c',ink:'#29250e',short:'Конс.'},
  abandoned:{label:'Ликвидированные',single:'Ликвидирована',color:'#667686',ink:'#ffffff',short:'Ликв.'},
  unknown:{label:'Тип не указан',single:'Тип не указан',color:'#d8dde4',ink:'#24313f',short:'Не указан'}
};
const STORAGE = 'sdng6.brigade2.v1';
let local = {favoritePads:[],favoriteWells:[],notes:{},coordinates:{}};
let storageAvailable=true;
try { const saved=JSON.parse(localStorage.getItem(STORAGE)||'null'); if(saved && typeof saved==='object') local={...local,...saved}; } catch { storageAvailable=false; }
for(const k of ['favoritePads','favoriteWells']) if(!Array.isArray(local[k])) local[k]=[];
for(const k of ['notes','coordinates']) if(!local[k] || typeof local[k]!=='object' || Array.isArray(local[k])) local[k]={};
let publishedCoordinates={};
let data, points, fieldMap, geoMap, baseLayer, geoMarkers, gpsMarker, gpsAccuracy, userPosition, clusterGroup, geoWellMarkers;
let markers=new Map(), extraMarkers=[], currentView='map', currentLayer='clean', selectedPad, selectedWell, lastFocus;
let favoriteOnly=false, deferredInstall, swRegistration, toastTimer, pendingGPS;
const MAP_W=1800, MAP_H=1273;
const fieldOverview={lat:61.60719,lng:73.91378,url:'https://www.openstreetmap.org/way/421599395'};
const normalize = s => String(s).toUpperCase().replace(/КУСТ|СКВАЖИНА|СКВАЖИНЫ|СКВ\.?|№|\s/g,'').replace(/[ВБB]/g,'B').replace(/[РP]/g,'P');
const wellKey = (pad,id) => `${pad}:${id}`;
function coordinateTarget(pad=selectedPad,wellId=selectedWell){
  if(!pad)return null;
  if(pad.id==='ОД'){
    const well=pad.wells.find(w=>w.id===wellId);
    return well?{key:wellKey(pad.id,well.id),padId:pad.id,wellId:well.id,label:`Скважина ${well.id}`} : null;
  }
  return {key:pad.id,padId:pad.id,wellId:null,label:`Куст ${pad.id}`};
}
function targetFromCoordinateKey(key){
  if(typeof key!=='string')return null;
  if(key.startsWith('ОД:'))return coordinateTarget(data.pads.find(p=>p.id==='ОД'),key.slice(3));
  const pad=data.pads.find(p=>p.id===key&&p.id!=='ОД');
  return pad?coordinateTarget(pad):null;
}
function requestCoordinateTarget(){
  const target=coordinateTarget();
  if(target)return target;
  if(selectedPad?.id==='ОД')showModal('Выберите отдельную скважину',`<p class="modal-copy">У каждой скважины ОД собственные координаты и маршрут. Выберите номер, затем добавьте GPS-точку или постройте маршрут.</p><div class="form-actions">${selectedPad.wells.map(w=>`<button class="btn" data-goto-pad="ОД" data-goto-well="${esc(w.id)}">Скв. ${esc(w.id)}</button>`).join('')}</div>`);
  return null;
}

const isPadFav = pad => local.favoritePads.includes(pad.id) || pad.wells.some(w=>local.favoriteWells.includes(wellKey(pad.id,w.id)));
function persist(){try{localStorage.setItem(STORAGE,JSON.stringify(local));return true;}catch{storageAvailable=false;toast('Доступно только в текущем сеансе. Экспортируйте данные.');return false;}}
function toast(message){clearTimeout(toastTimer);$('#toast').textContent=message;$('#toast').classList.add('show');toastTimer=setTimeout(()=>$('#toast').classList.remove('show'),4500);}
function countTypes(wells){return wells.reduce((a,w)=>(a[w.type]=(a[w.type]||0)+1,a),{});}
function drillingBadge(pad){return pad.status?.code==='drilling'?'<span class="drilling-badge">В бурении</span>':'';}
function drillingNote(pad){return pad.status?.code==='drilling'?`<div class="drilling-note">${drillingBadge(pad)}<p>${esc(pad.registryNote)}</p></div>`:'';}
function exactNavigationTarget(value){const q=normalize(value);if(!q)return null;const pad=data.pads.find(p=>p.id!=='ОД'&&normalize(p.id)===q);if(pad)return coordinateTarget(pad,null);const od=data.pads.find(p=>p.id==='ОД'),well=od?.wells.find(w=>normalize(w.id)===q||normalize(w.id).replace(/P$/,'')===q);return well?coordinateTarget(od,well.id):null;}
function matchesType(w,type){return type==='all'||(type==='fountain'?w.method==='fountain':w.type===type);}
function filterWells(pad){const q=normalize($('#search').value),type=$('#type-filter').value; const padMatch=normalize(pad.id).includes(q);return pad.wells.filter(w=>matchesType(w,type)&&(padMatch||normalize(w.id).includes(q)));}
function visiblePads(){const q=normalize($('#search').value),exact=q&&data.pads.find(p=>normalize(p.id)===q);return data.pads.filter(p=>(!exact||p.id===exact.id)&&(!(favoriteOnly||currentView==='favorites')||isPadFav(p))&&filterWells(p).length);}
function breakdown(wells){const counts=countTypes(wells);return `<div class="breakdown" aria-hidden="true">${Object.entries(TYPES).filter(([t])=>counts[t]).map(([t,v])=>`<i style="--n:${counts[t]};--c:${v.color}"></i>`).join('')}</div>`;}
function renderList(){
  const pads=visiblePads(),q=normalize($('#search').value),type=$('#type-filter').value;
  $('#workspace').classList.toggle('is-searching',Boolean(q)||type!=='all');
  const exact=exactNavigationTarget(q);
  $('#quick-route').innerHTML=exact?`<button class="quick-route-button" data-route-key="${esc(exact.key)}">${icon('route')}<span>Маршрут · ${esc(exact.label)}<small>От вашего текущего местоположения</small></span>${icon('arrow')}</button>`:'';
  $('#result-count').textContent=`${pads.length} / ${data.pads.length}`;
  $('#pad-list').innerHTML=pads.length?pads.map(p=>{
    const wells=filterWells(p),filtered=q||type!=='all';
    return `<button class="pad-card ${selectedPad?.id===p.id?'selected':''}" data-pad="${esc(p.id)}"><div class="pad-number"><small>${p.id==='ОД'?'ГРУППА':'КУСТ'}</small>${esc(p.id)}</div><div class="pad-card-info"><div class="pad-card-count"><strong>${p.wells.length}</strong> ${p.id==='ОД'?'отдельных скважин':'скважин'}${p.status?.code==='drilling'?' в реестре':''}${filtered?` · найдено ${wells.length}`:''}</div>${drillingBadge(p)}${breakdown(p.wells)}${q&&!normalize(p.id).includes(q)?`<span class="match-list">Скв. ${wells.slice(0,5).map(w=>esc(w.id)).join(', ')}${wells.length>5?'…':''}</span>`:''}</div>${isPadFav(p)?'<span class="card-fav">★</span>':''}${icon('chevron')}</button>`;
  }).join(''):`<div class="empty-state">${icon(currentView==='favorites'?'star':'search')}<div>${currentView==='favorites'&&!$('#search').value?'Здесь будут ваши избранные кусты и скважины. Отметьте их звездой в карточке.':'Ничего не найдено. Проверьте номер или измените фильтр.'}</div><button class="btn" data-action="reset-filters">Сбросить фильтры</button></div>`;
  const visible=new Set(pads.map(p=>p.id));
  syncSchemeMarkers(visible);
  markers.forEach((m,id)=>{const el=m.getElement();if(el){$('.pad-pin',el)?.classList.toggle('dim',!visible.has(id));}});
  extraMarkers.forEach(m=>{const el=m.getElement();if(el)$('.pad-pin',el)?.classList.toggle('dim',!visible.has('ОД'));});
  $('#favorite-filter').classList.toggle('active',favoriteOnly);$('#favorite-filter').setAttribute('aria-pressed',String(favoriteOnly));
  renderGeoMarkers();
}
function syncSchemeMarkers(visible){
  if(!clusterGroup)return;
  markers.forEach((m,id)=>{if(visible.has(id)){if(!clusterGroup.hasLayer(m))clusterGroup.addLayer(m);}else if(clusterGroup.hasLayer(m))clusterGroup.removeLayer(m);});
  const od=data.pads.find(p=>p.id==='ОД');
  extraMarkers.forEach((m,i)=>{const id=points.extraWells[i].id;const show=visible.has('ОД')&&filterWells(od).some(w=>w.id===id)&&(!(favoriteOnly||currentView==='favorites')||local.favoritePads.includes('ОД')||local.favoriteWells.includes(wellKey('ОД',id)));if(show){if(!clusterGroup.hasLayer(m))clusterGroup.addLayer(m);}else if(clusterGroup.hasLayer(m))clusterGroup.removeLayer(m);});
}
function toMapPoint(p){return [MAP_H*(1-p.y),MAP_W*p.x];}
function markerIcon(pad,od=false,label){const selected=selectedPad?.id===pad.id&&(!od||selectedWell===label);return L.divIcon({className:'atlas-marker',html:`<div class="pad-pin ${od?'od':''} ${selected?'selected':''}">${od?'Скв. ':''}${esc(label||pad.id)}${!od?`<span>${pad.wells.length}</span>${pad.status?.code==='drilling'?'<em class="map-drilling-label">Бурение</em>':''}`:''}</div>`,iconSize:[0,0],iconAnchor:[0,0]});}
function initMap(){
  fieldMap=L.map('field-map',{crs:L.CRS.Simple,minZoom:-2,maxZoom:3,zoomSnap:.25,zoomDelta:.5,zoomControl:false,attributionControl:false,maxBounds:[[-MAP_H*.25,-MAP_W*.25],[MAP_H*1.25,MAP_W*1.25]],maxBoundsViscosity:.8});
  L.control.zoom({position:'bottomright'}).addTo(fieldMap);
  clusterGroup=L.markerClusterGroup({maxClusterRadius:36,disableClusteringAtZoom:2,showCoverageOnHover:false,spiderfyOnMaxZoom:true,spiderfyDistanceMultiplier:1.6,animate:preferences.motion!=='reduced'&&!matchMedia('(prefers-reduced-motion: reduce)').matches,iconCreateFunction:c=>L.divIcon({className:'atlas-cluster',html:`<div>${c.getChildCount()}<small>${c.getChildCount()%10>=2&&c.getChildCount()%10<=4&&!(c.getChildCount()%100>=12&&c.getChildCount()%100<=14)?'ОБЪЕКТА':'ОБЪЕКТОВ'}</small></div>`,iconSize:[42,42]})}).addTo(fieldMap);
  setSchemeLayer('clean');
  points.points.forEach(p=>{const pad=data.pads.find(x=>x.id===p.id);if(!pad)return;const m=L.marker(toMapPoint(p),{icon:markerIcon(pad),title:`Куст ${pad.id} · ${pad.wells.length} скважин`,keyboard:true}).addTo(clusterGroup).on('click',()=>{if(OfflineNavigator.pickSchemePosition(toMapPoint(p)))return;openPad(pad.id);});m.bindTooltip(`Куст ${pad.id} · ${pad.wells.length} скважин`,{direction:'top',offset:[0,-18]});markers.set(pad.id,m);});
  points.extraWells.forEach(p=>{const pad=data.pads.find(x=>x.id==='ОД');const m=L.marker(toMapPoint(p),{icon:markerIcon(pad,true,p.id),title:`Отдельная скважина ${p.id}`}).addTo(clusterGroup).on('click',()=>{if(OfflineNavigator.pickSchemePosition(toMapPoint(p)))return;openPad('ОД',p.id);});extraMarkers.push(m);});
  fitMap();
  new ResizeObserver(()=>{fieldMap.invalidateSize();geoMap?.invalidateSize();}).observe($('.map-panel'));
}
function fitMap(){if(currentLayer==='geo'){if(window.OfflineNavigator){OfflineNavigator.fit();return;}if(!geoMap)return;const coords=validCoordinates();if(coords.length)geoMap.fitBounds(coords.map(([,c])=>[c.lat,c.lng]),{padding:[60,60],maxZoom:14});else if(userPosition)geoMap.setView([userPosition.lat,userPosition.lng],14);else geoMap.setView([fieldOverview.lat,fieldOverview.lng],10);return;} const ps=points.points.map(toMapPoint);fieldMap.fitBounds(L.latLngBounds(ps),{paddingTopLeft:[38,68],paddingBottomRight:[46,110],animate:false});}
function setSchemeLayer(layer){if(baseLayer)fieldMap.removeLayer(baseLayer);baseLayer=L.imageOverlay(layer==='original'?'field-map.webp':'field-map-clean.svg',[[0,0],[MAP_H,MAP_W]],{interactive:false}).addTo(fieldMap);baseLayer.on('error',()=>{if(layer==='clean'){toast('Показываем исходную схему');setLayer('original');}});baseLayer.bringToBack();}
function setLayer(layer){
  currentLayer=layer;
  $('.map-panel').dataset.layer=layer;
  $$('button[data-layer]').forEach(b=>b.classList.toggle('active',b.dataset.layer===layer));
  $('#field-map').classList.toggle('hidden',layer==='geo');$('#geo-map').classList.toggle('hidden',layer!=='geo');
  $('#map-title').textContent=layer==='geo'?'GPS-карта':'Схема проезда';
  $('#map-hint').textContent=layer==='geo'?`GPS-точек: ${validCoordinates().length}`:'Нажмите на куст · группы раскрываются нажатием';
  $('#geo-help').classList.toggle('hidden',layer!=='geo'||validCoordinates().length>0);
  $('.map-caption').firstChild.textContent=layer==='geo'?'Сохранённая карта дорог · маршруты без сети':'Схема проезда · без GPS-привязки ';
  if(layer==='geo'){initGeoMap();setTimeout(()=>geoMap.invalidateSize(),50);}else{setSchemeLayer(layer);setTimeout(()=>fieldMap.invalidateSize(),50);}
}

function isValidCoordinate(c){return c&&Number.isFinite(c.lat)&&Number.isFinite(c.lng)&&Math.abs(c.lat)<=90&&Math.abs(c.lng)<=180;}
function coordinateFor(key){const custom=local.coordinates[key],catalog=publishedCoordinates[key];return custom?.useForRoutes===true||!catalog?custom||catalog:catalog;}
function validCoordinates(){return [...new Set([...Object.keys(publishedCoordinates),...Object.keys(local.coordinates)])].map(key=>[key,coordinateFor(key)]).filter(([key,c])=>targetFromCoordinateKey(key)&&isValidCoordinate(c));}
function initGeoMap(){OfflineNavigator.initMap();}

function renderGeoMarkers(){
  if(!geoMarkers)return;
  geoMarkers.clearLayers();geoWellMarkers?.clearLayers();
  const visible=new Set(visiblePads().map(p=>p.id));
  for(const [key,c] of validCoordinates()){
    const target=targetFromCoordinateKey(key),pad=data.pads.find(p=>p.id===target.padId);
    if(!visible.has(pad.id))continue;
    if(target.wellId&&!filterWells(pad).some(w=>w.id===target.wellId))continue;
    if(target.wellId&&(favoriteOnly||currentView==='favorites')&&!local.favoritePads.includes(pad.id)&&!local.favoriteWells.includes(wellKey(pad.id,target.wellId)))continue;
    const group=target.wellId?geoWellMarkers:geoMarkers;
    L.marker([c.lat,c.lng],{icon:markerIcon(pad,Boolean(target.wellId),target.wellId),title:`${target.label} · GPS-точка объекта`,zIndexOffset:target.wellId?500:0}).addTo(group).bindTooltip(`${esc(target.label)} · GPS-точка`).on('click',()=>openPad(target.padId,target.wellId));
  }
  if(userPosition){gpsMarker?.remove();gpsAccuracy?.remove();gpsMarker=L.circleMarker([userPosition.lat,userPosition.lng],{radius:7,color:'#fff',weight:3,fillColor:'#268ed0',fillOpacity:1}).addTo(geoMap).bindTooltip('Вы здесь');gpsAccuracy=L.circle([userPosition.lat,userPosition.lng],{radius:userPosition.accuracy,color:'#268ed0',weight:1,fillOpacity:.07}).addTo(geoMap);}
}
function setView(view){
  if(!['map','list','favorites','info','settings'].includes(view))return;
  currentView=view;const separate=view==='info'||view==='settings';
  $('#atlas-view').classList.toggle('hidden',separate);$('#info-view').classList.toggle('hidden',view!=='info');$('#settings-view').classList.toggle('hidden',view!=='settings');
  $('#workspace').classList.toggle('list-mode',view==='list'||view==='favorites');
  $$('.nav-item').forEach(b=>{b.classList.toggle('active',b.dataset.view===view);if(b.dataset.view===view)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});
  $('#page-title').innerHTML=({map:'Кусты и скважины',list:'Все кусты бригады',favorites:'Избранное',info:'Бригада в цифрах',settings:'Ваши настройки'})[view]+'<span class="title-dot">.</span>';
  $('#page-subtitle').textContent=({map:'Найдите куст, откройте скважину, постройте маршрут.',list:'Поиск по номеру куста или скважины.',favorites:'Быстрый доступ к важным объектам.',info:'Состав бригады и обозначения скважин.',settings:'Оформление и удобство на вашем телефоне.'})[view];
  if(view==='info')renderInfo();else if(view==='settings')renderSettings();else{renderList();if(view==='map')setTimeout(()=>{fieldMap.invalidateSize();geoMap?.invalidateSize();},50);}
  if(matchMedia('(max-width: 600px)').matches)window.scrollTo({top:0,behavior:preferences.motion==='reduced'?'auto':'smooth'});
}

function openPad(id,wellId){
  const pad=data.pads.find(p=>p.id===id);if(!pad)return;
  selectedPad=pad;selectedWell=wellId||null;
  lastFocus=document.activeElement;
  renderDrawer();$('#drawer').classList.remove('hidden');$('#drawer-backdrop').classList.remove('hidden');$('.app-shell').inert=true;$('.topbar').inert=true;$('#drawer').focus();renderList();
  markers.forEach((m,mid)=>{const el=m.getElement();if(el)$('.pad-pin',el)?.classList.toggle('selected',mid===id);m.setZIndexOffset(mid===id?1000:0);});
  const p=points.points.find(p=>p.id===id);if(p&&currentView==='map'&&currentLayer!=='geo')fieldMap.panTo(toMapPoint(p),{animate:true});
  if(wellId)setTimeout(()=>$('#well-detail')?.scrollIntoView({behavior:'smooth',block:'nearest'}),100);
}
function closeDrawer(){if($('#drawer').classList.contains('hidden'))return;$('#drawer').classList.add('hidden');$('#drawer-backdrop').classList.add('hidden');$('.app-shell').inert=false;$('.topbar').inert=false;lastFocus?.focus?.();}
function renderDrawer(){
  const p=selectedPad,counts=countTypes(p.wells),target=coordinateTarget(),hasGPS=target&&isValidCoordinate(coordinateFor(target.key));
  $('#drawer').innerHTML=`<div class="drawer-head"><button class="icon-btn drawer-close" data-action="close-drawer" aria-label="Закрыть карточку">${icon('cross')}</button><div class="drawer-eyebrow">ФЁДОРОВСКОЕ · ЦДНГ-6 · БРИГАДА №2</div><div class="drawer-heading-row"><h2>${p.id==='ОД'?'Отдельные скважины':`Куст ${esc(p.id)}`}</h2><button class="icon-btn ${local.favoritePads.includes(p.id)?'active':''}" data-action="favorite-pad" aria-label="${local.favoritePads.includes(p.id)?'Убрать куст из избранного':'Добавить куст в избранное'}">${icon('star')}</button></div><p class="drawer-subtitle">${p.wells.length} скважин в реестре${hasGPS?' · GPS добавлен':''}</p><div class="drawer-actions"><button class="btn primary" data-action="route">${icon('route')}Маршрут</button><button class="btn" data-action="show-on-map">${icon('pin')}На схеме</button></div></div><div class="drawer-body">${drillingNote(p)}<p class="small-label">${p.id==='ОД'?'СОСТАВ ГРУППЫ':'СОСТАВ КУСТА'}</p>${typeof atlasDonut==='function'?atlasDonut(p.wells,{label:'скважин',size:150}):''}<div class="type-summary">${Object.entries(TYPES).filter(([t])=>counts[t]).map(([t,v])=>`<div class="type-stat"><i style="--c:${v.color}"></i>${v.label}<strong>${counts[t]}</strong></div>`).join('')}</div><div class="well-controls"><span>Скважины · ${p.wells.length}</span><select id="well-type-filter" aria-label="Фильтр скважин в кусте"><option value="all">Все типы</option>${Object.entries(TYPES).filter(([t])=>counts[t]).map(([t,v])=>`<option value="${t}">${v.label}</option>`).join('')}<option value="fountain">Фонтан</option></select></div><div id="well-grid" class="well-grid"></div><div id="well-detail"></div><section class="gps-summary" id="gps-summary"></section><div class="source-note">${p.layoutCorrectedAt?'Порядок 2656 → 2655 уточнён 12.11.2026.<br>':''}Данные реестра от 21.10.2026.<br><a href="${esc(data.source.pdfUrl)}" target="_blank" rel="noopener">Открыть исходный реестр ↗</a></div></div>`;
  renderWellGrid();if(selectedWell)renderWellDetail(selectedWell);renderCoordinateSummary();
}
function renderWellGrid(){
  const type=$('#well-type-filter')?.value||'all';
  const wells=selectedPad.wells.filter(w=>matchesType(w,type));
  $('#well-grid').innerHTML=wells.length?wells.map(w=>{
    const definition=TYPES[w.type]||TYPES.unknown;
    const status=w.method==='fountain'?'Фонтан':w.type==='production'&&w.method!=='esp'?'Добыча':definition.short;
    const description=`Скважина ${w.id}, ${definition.single}${w.method==='fountain'?', фонтан':w.method==='esp'?', ЭЦН':''}`;
    const key=wellKey(selectedPad.id,w.id);
    return `<button class="well-cell ${selectedWell===w.id?'selected':''} ${local.notes[key]?'noted':''} ${local.favoriteWells.includes(key)?'fav':''}" style="--c:${definition.color};--well-ink:${definition.ink}" data-well="${esc(w.id)}" data-well-type="${esc(w.type)}" aria-label="${esc(description)}" title="${esc(description)}" aria-pressed="${selectedWell===w.id}"><span class="well-number">${esc(w.id)}</span><small class="well-status">${esc(status)}</small></button>`;
  }).join(''):'<div class="empty-state">Нет скважин этого типа</div>';
}
function renderWellDetail(id){selectedWell=id;const w=selectedPad.wells.find(w=>w.id===id);if(!w)return;const key=wellKey(selectedPad.id,id);$('#well-detail').innerHTML=`<article class="well-detail"><div class="well-detail-head"><h3>Скважина ${esc(id)}</h3><button class="icon-btn ${local.favoriteWells.includes(key)?'active':''}" data-action="favorite-well" aria-label="В избранное">${icon('star')}</button></div><div class="well-detail-body"><div class="well-attributes"><span class="type-badge"><i class="type-dot" style="--c:${TYPES[w.type].color}"></i>${TYPES[w.type].single}</span>${w.method!=='unknown'?`<span class="type-badge">${w.method==='esp'?'ЭЦН':'Фонтан'}</span>`:''}</div>${id==='16724'?'<p class="warning-note">В исходном реестре номер 16724 указан в двух кустах: 1122 и 1128. Принадлежность требует уточнения.</p>':''}<label class="note-label" for="well-note">Моя заметка</label><textarea id="well-note" rows="3" maxlength="5000" placeholder="Что важно помнить об этой скважине…">${esc(local.notes[key]||'')}</textarea><div class="note-help">Заметки доступны на этом устройстве. Сохранить копию можно в настройках.</div><button class="btn primary note-save" data-action="save-note">Сохранить заметку</button></div></article>`;renderWellGrid();renderCoordinateSummary();}
function renderCoordinateSummary(){
  const el=$('#gps-summary');if(!el||!selectedPad)return;
  const target=coordinateTarget();
  if(!target){el.innerHTML=`<p class="small-label">GPS ОТДЕЛЬНЫХ СКВАЖИН</p><p>У группы ОД нет общей точки. Выберите скважину выше, чтобы добавить её координаты и построить маршрут.</p><button class="btn" data-action="coordinate">Выбрать скважину</button>`;return;}
  const c=coordinateFor(target.key),hasGPS=isValidCoordinate(c);
  el.innerHTML=`<p class="small-label">${target.wellId?'GPS · '+esc(target.label).toUpperCase():'ГЕОГРАФИЧЕСКАЯ ТОЧКА'}</p>${hasGPS?`<div class="gps-value">${c.lat.toFixed(6)}, ${c.lng.toFixed(6)}</div><p>${c.source==='mapped'?'Координаты въезда · сверка по картам':c.source==='device'?'Сохранено по GPS':'Введено на устройстве'} · ${esc(new Date(c.recordedAt).toLocaleDateString('ru-RU'))}${c.accuracy?` · точность ±${Math.round(c.accuracy)} м`:''}</p><button class="btn" data-action="coordinate">Уточнить мою точку</button>`:`<p>GPS-точка для объекта «${esc(target.label)}» ещё не подтверждена. Сохраните местоположение на месте или введите проверенные координаты.</p><button class="btn" data-action="coordinate">${icon('gps')}Добавить GPS-точку</button>`}`;
}
function coordinateModal(){const target=requestCoordinateTarget();if(!target)return;const c=coordinateFor(target.key);showModal(`GPS · ${esc(target.label)}`,`<p class="modal-copy">Сохраните точку, находясь на объекте «${esc(target.label)}», или введите проверенные координаты WGS84 в десятичных градусах.</p><button class="btn gold" data-action="capture-gps" data-coordinate-key="${esc(target.key)}">${icon('gps')}Сохранить GPS здесь</button><form id="coordinate-form" data-coordinate-key="${esc(target.key)}"><label class="form-field"><span>Широта (−90…90)</span><input id="latitude" name="latitude" inputmode="decimal" required placeholder="Например, 61.123456" value="${isValidCoordinate(c)?c.lat:''}"></label><label class="form-field"><span>Долгота (−180…180)</span><input id="longitude" name="longitude" inputmode="decimal" required placeholder="Например, 73.123456" value="${isValidCoordinate(c)?c.lng:''}"></label><p class="form-help">Ручная точка будет помечена «Введено на устройстве». Числа в примере — формат ввода, не координаты объекта.</p><div id="coordinate-error" class="error-text" role="alert"></div><div class="form-actions"><button class="btn primary" type="submit">Сохранить точку</button>${isValidCoordinate(local.coordinates[target.key])?`<button class="btn" type="button" data-action="remove-coordinate" data-coordinate-key="${esc(target.key)}">Удалить точку</button>`:''}</div></form>`);}
function saveCoordinate(c,target=coordinateTarget()){if(!target||!targetFromCoordinateKey(target.key)||!isValidCoordinate(c)){toast('Выберите объект и введите корректные координаты');return;}local.coordinates[target.key]={...c,useForRoutes:true,recordedAt:new Date().toISOString()};const saved=persist();$('#modal').close();renderDrawer();renderGeoMarkers();if(currentLayer==='geo')setLayer('geo');if(saved)toast(`GPS-точка «${target.label}» сохранена на устройстве`);}
function getPosition(){return new Promise((resolve,reject)=>{if(!navigator.geolocation)return reject(new Error('Геолокация недоступна в этом браузере.'));navigator.geolocation.getCurrentPosition(p=>{userPosition={lat:p.coords.latitude,lng:p.coords.longitude,accuracy:p.coords.accuracy};resolve(userPosition);},e=>reject(new Error(({1:'Доступ к местоположению запрещён. Разрешите его в настройках браузера.',2:'Местоположение пока недоступно. Проверьте GPS телефона.',3:'Не удалось получить GPS за 20 секунд. Попробуйте на открытом месте.'})[e.code]||'Не удалось определить местоположение.')),{enableHighAccuracy:true,timeout:20000,maximumAge:15000});});}
async function locate(){toast('Определяем местоположение…');try{await getPosition();if(currentView!=='map')setView('map');setLayer('geo');geoMap.setView([userPosition.lat,userPosition.lng],15);renderGeoMarkers();const nearest=validCoordinates().map(([key,c])=>({target:targetFromCoordinateKey(key),distance:haversine(userPosition,c)})).sort((a,b)=>a.distance-b.distance).slice(0,4);showModal('Моё местоположение',`<div class="gps-result"><strong>${userPosition.lat.toFixed(6)}, ${userPosition.lng.toFixed(6)}</strong><br>Точность GPS: ±${Math.round(userPosition.accuracy)} м</div><p class="modal-copy">${nearest.length?'Ближайшие объекты с сохранёнными GPS-точками. Расстояния указаны по прямой.':'Объекты появятся на этой карте после добавления GPS-точек в их карточках.'}</p>${nearest.map(n=>`<div class="nearest-row"><span>${esc(n.target.label)} · ${formatDistance(n.distance)}</span><button data-goto-pad="${esc(n.target.padId)}" ${n.target.wellId?`data-goto-well="${esc(n.target.wellId)}"`:''}>Открыть →</button></div>`).join('')}`);}catch(e){toast(e.message);}}
function haversine(a,b){const rad=n=>n*Math.PI/180,dlat=rad(b.lat-a.lat),dlng=rad(b.lng-a.lng),s=Math.sin(dlat/2)**2+Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(dlng/2)**2;return 6371000*2*Math.atan2(Math.sqrt(s),Math.sqrt(1-s));}
function formatDistance(m){return m<1000?`${Math.round(m)} м`:`${(m/1000).toFixed(1)} км`;}
function route(){return OfflineNavigator.routeToSelected();}

function showModal(title,body){$('#modal-content').innerHTML=`<div class="modal-heading"><h2>${title}</h2><button class="icon-btn" data-action="close-modal" aria-label="Закрыть">${icon('cross')}</button></div>${body}`;if(!$('#modal').open)$('#modal').showModal();}
async function install(){if(deferredInstall){const event=deferredInstall;deferredInstall=null;await event.prompt();const choice=await event.userChoice;if(choice.outcome==='accepted'){toast('Приложение добавляется на устройство');return;}}showModal('Атлас на вашем телефоне',`<div class="modal-copy"><p>Открывайте атлас с главного экрана как отдельное приложение.</p><h3>Android · Chrome</h3><ol><li>Откройте ссылку в Chrome и войдите в свой аккаунт, если потребуется.</li><li>В меню ⋮ выберите «Установить приложение» или «Добавить на главный экран».</li></ol><h3>iPhone · Safari</h3><ol><li>Откройте ссылку в Safari.</li><li>Нажмите «Поделиться» → «На экран Домой». Если доступно, включите «Открывать как веб-приложение».</li></ol><h3>Когда нет сети</h3><p>Один раз откройте атлас с интернетом и дождитесь отметки «Доступен без сети». Реестр, схема и заметки сохранятся на этом устройстве. Сохранённые дороги и расчёт маршрута доступны без сети. Разрешите доступ к GPS, чтобы видеть своё положение.</p><p><a href="https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/ios" target="_blank" rel="noopener">Инструкция Apple ↗</a></p></div>`);}
function downloadJSON(object,name){const blob=new Blob([JSON.stringify(object,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),5000);}
function exportLocal(){downloadJSON({format:'sdng6-brigade2-local-v1',exportedAt:new Date().toISOString(),field:'Фёдоровское',...local},'brigade2-personal-data.json');toast('Экспорт сохранён в загрузках');}
function importModal(){showModal('Загрузить мою копию',`<p class="modal-copy">Восстановите избранное, заметки и координаты из сохранённой копии. Новые записи добавятся, совпадающие будут заменены из файла.</p><label class="form-field"><span>Файл сохранённой копии (до 2 МБ)</span><input id="import-file" type="file" accept="application/json,.json"></label><div class="error-text" id="import-error" role="alert"></div><p class="form-help">Заметки и GPS-точки будут доступны на этом устройстве.</p>`);}
async function importLocal(file){try{if(!file)return;if(file.size>2*1024*1024)throw Error('Файл больше 2 МБ');const obj=JSON.parse(await file.text());if(obj.format!=='sdng6-brigade2-local-v1')throw Error('Это не файл экспорта атласа');const padIds=new Set(data.pads.map(p=>p.id)),keys=new Set(data.pads.flatMap(p=>p.wells.map(w=>wellKey(p.id,w.id))));const next={favoritePads:[...local.favoritePads],favoriteWells:[...local.favoriteWells],notes:{...local.notes},coordinates:{...local.coordinates}};for(const id of obj.favoritePads||[])if(typeof id==='string'&&padIds.has(id)&&!next.favoritePads.includes(id))next.favoritePads.push(id);for(const id of obj.favoriteWells||[])if(typeof id==='string'&&keys.has(id)&&!next.favoriteWells.includes(id))next.favoriteWells.push(id);for(const [key,value] of Object.entries(obj.notes||{}))if(keys.has(key)&&typeof value==='string')next.notes[key]=value.slice(0,5000);for(const [id,c] of Object.entries(obj.coordinates||{})){if(id==='ОД')throw Error('У группы ОД не может быть общей GPS-точки. Укажите отдельные скважины.');if(!targetFromCoordinateKey(id))continue;if(!isValidCoordinate(c))throw Error('В файле есть некорректные координаты');next.coordinates[id]={lat:c.lat,lng:c.lng,useForRoutes:c.useForRoutes===true,source:c.source==='device'?'device':'manual',accuracy:Number.isFinite(c.accuracy)&&c.accuracy>0?c.accuracy:undefined,recordedAt:!isNaN(Date.parse(c.recordedAt))?c.recordedAt:new Date().toISOString()};}local=next;const saved=persist();renderList();renderGeoMarkers();if(currentView==='info')renderInfo();$('#modal').close();if(saved)toast('Избранное, заметки и GPS-точки импортированы');}catch(e){$('#import-error').textContent='Импорт не выполнен: '+e.message;}}
function renderInfo(){
  const all=data.pads.flatMap(p=>p.wells),counts=countTypes(all);
  $('#info-view').innerHTML=`<div class="info-grid"><article class="info-card"><div class="eyebrow">ЦДНГ-6 · ФЁДОРОВСКОЕ</div><h2>Вторая бригада</h2><div class="data-total"><div><strong>32</strong><span>куста</span></div><div><strong>${all.length}</strong><span>записей скважин</span></div><div><strong>5</strong><span>отдельных скважин</span></div></div>${typeof atlasDonut==='function'?atlasDonut(all,{label:'записей',size:210}):''}<p>Добывающие: <b>195 ЭЦН</b> и <b>6 фонтанных</b>. Всего в реестре ${new Set(all.map(w=>w.id)).size} уникальных номеров.</p></article><article class="info-card"><h2>Обозначения скважин</h2>${Object.entries(TYPES).map(([t,v])=>`<div class="legend-row"><i class="type-dot" style="--c:${v.color}"></i>${v.label}<b>${counts[t]||0}</b></div>`).join('')}<p>Заливка и короткая подпись в каждой ячейке показывают тип скважины. «ЭЦН» и «Фонтан» обозначают способ добычи. На кустах 1129 и 1158 стоит отметка «В бурении» — состав скважин пополняется.</p><p>Звезда — объект в избранном. Маленькая точка на номере скважины — сохранена ваша заметка.</p></article><article class="info-card"><h2>Как найти нужный объект</h2><ol><li>Введите номер куста или скважины в строку поиска.</li><li>Нажмите на найденный куст или его точку на схеме.</li><li>Выберите скважину, чтобы увидеть тип и оставить заметку.</li></ol><p>На карте близкие объекты объединены в группы с числом. Нажмите на группу, чтобы приблизить её.</p><p>Введите номер куста и нажмите «Маршрут» или клавишу перехода на клавиатуре. Приложение определит ваше положение и построит путь без интернета. Для просмотра доступны схема и карта местности.</p></article><article class="info-card materials"><h2>Материалы бригады</h2><p>Данные от 21.10.2026. Откройте полную схему или реестр, если нужно сверить сведения.</p><a class="btn" href="${esc(data.source.pdfUrl)}" target="_blank" rel="noopener">${icon('list')}Реестр скважин ↗</a><a class="btn" href="${esc(points.source.url)}" target="_blank" rel="noopener">${icon('map')}Схема проезда ↗</a><p>Все 32 куста и рабочие одиночные скважины 4205Р и 4286Р сопоставлены с площадками и подъездами на карте. Проверка по картам — 12.11.2026. Координаты указывают подъезд к кусту; состояние дорог и шлагбаумов в реальном времени не отслеживается.</p><span class="status-chip">GPS-точек сохранено: ${validCoordinates().length}</span></article><article class="info-card info-span"><h2>Сведения для уточнения</h2><div class="info-issues">Скважина 16724 указана в двух кустах: 1122 и 1128. У 12 скважин тип не указан. Отдельная скважина 136Р отсутствует на схеме проезда. Уточняйте эти сведения по рабочему реестру.</div></article></div>`;
}

async function setupOffline(){const el=$('#offline-state');if(!('serviceWorker' in navigator)){el.textContent='Режим без сети недоступен в браузере';return;}try{swRegistration=await navigator.serviceWorker.register('./sw.js',{scope:'./',updateViaCache:'none'});const setReady=()=>{el.textContent='Доступен без сети';};if(swRegistration.active)setReady();else{el.textContent='Сохраняем для работы без сети…';navigator.serviceWorker.ready.then(setReady);}const watch=worker=>{if(!worker)return;worker.addEventListener('statechange',()=>{if(worker.state==='installed'&&navigator.serviceWorker.controller){el.innerHTML='<button class="update-link" data-action="update">Обновить атлас ↻</button>';}if(worker.state==='redundant'&&!swRegistration.active)el.textContent='Не удалось подготовить режим без сети';});};watch(swRegistration.installing);swRegistration.addEventListener('updatefound',()=>watch(swRegistration.installing));if(swRegistration.waiting)el.innerHTML='<button class="update-link" data-action="update">Обновить атлас ↻</button>';}catch{el.textContent='Режим без сети пока не готов';}}
function bindEvents(){
  document.addEventListener('click',async e=>{
    const nav=e.target.closest('[data-view]');if(nav){setView(nav.dataset.view);return;}
    const quick=e.target.closest('[data-route-key]');if(quick){const target=targetFromCoordinateKey(quick.dataset.routeKey);if(target){selectedPad=data.pads.find(p=>p.id===target.padId);selectedWell=target.wellId;route();}return;}
    const pad=e.target.closest('[data-pad]');if(pad){const p=data.pads.find(p=>p.id===pad.dataset.pad),q=normalize($('#search').value);const match=q&&!normalize(p.id).includes(q)?filterWells(p)[0]?.id:null;openPad(p.id,match);return;}
    const goto=e.target.closest('[data-goto-pad]');if(goto){$('#modal').close();openPad(goto.dataset.gotoPad,goto.dataset.gotoWell);return;}
    const well=e.target.closest('[data-well]');if(well){renderWellDetail(well.dataset.well);$('#well-detail').scrollIntoView({behavior:'smooth',block:'nearest'});return;}
    const layer=e.target.closest('button[data-layer]');if(layer){setLayer(layer.dataset.layer);return;}
    const a=e.target.closest('[data-action]');if(!a)return;
    switch(a.dataset.action){
      case 'close-drawer':closeDrawer();break;
      case 'close-modal':$('#modal').close();break;
      case 'install':await install();break;
      case 'fit':fitMap();break;
      case 'info':setView('info');break;
      case 'reset-filters':$('#search').value='';$('#type-filter').value='all';favoriteOnly=false;renderList();break;
      case 'favorite-pad':{const id=selectedPad.id;local.favoritePads=local.favoritePads.includes(id)?local.favoritePads.filter(x=>x!==id):[...local.favoritePads,id];persist();renderDrawer();renderList();break;}
      case 'favorite-well':{const key=wellKey(selectedPad.id,selectedWell);local.favoriteWells=local.favoriteWells.includes(key)?local.favoriteWells.filter(x=>x!==key):[...local.favoriteWells,key];persist();renderWellDetail(selectedWell);renderList();break;}
      case 'save-note':{const key=wellKey(selectedPad.id,selectedWell);local.notes[key]=$('#well-note').value.trim();if(!local.notes[key])delete local.notes[key];const saved=persist();renderWellGrid();if(saved)toast('Заметка сохранена на устройстве');break;}
      case 'show-on-map':{if($('#modal').open)$('#modal').close();const id=selectedPad.id,wellId=selectedWell;const p=id==='ОД'&&wellId?points.extraWells.find(p=>p.id===wellId):points.points.find(p=>p.id===id);if(id==='ОД'&&wellId&&!p){toast(`Скважина ${wellId} не найдена на исходной схеме проезда`);break;}closeDrawer();setView('map');setLayer('clean');setTimeout(()=>{if(p)fieldMap.setView(toMapPoint(p),Math.max(fieldMap.getZoom(),.5));else if(id==='ОД'&&points.extraWells.length)fieldMap.fitBounds(L.latLngBounds(points.extraWells.map(toMapPoint)),{padding:[60,90]});},80);break;}
      case 'coordinate':coordinateModal();break;
      case 'remove-coordinate':{const target=targetFromCoordinateKey(a.dataset.coordinateKey)||coordinateTarget();if(!target){requestCoordinateTarget();break;}delete local.coordinates[target.key];const saved=persist();$('#modal').close();renderDrawer();renderGeoMarkers();if(currentLayer==='geo')setLayer('geo');if(saved)toast(`GPS-точка «${target.label}» удалена`);break;}
      case 'capture-gps':{const target=targetFromCoordinateKey(a.dataset.coordinateKey)||requestCoordinateTarget();if(!target)break;pendingGPS=null;a.disabled=true;a.textContent='Определяем GPS…';try{const c=await getPosition();pendingGPS={target,position:{...c}};showModal(`GPS · ${esc(target.label)}`,`<div class="gps-result"><strong>${c.lat.toFixed(6)}, ${c.lng.toFixed(6)}</strong><br>Точность ±${Math.round(c.accuracy)} м</div><p class="modal-copy">Подтвердите, что сейчас находитесь на объекте «${esc(target.label)}». Именно эта точка будет использоваться для маршрута.</p><button class="btn primary" data-action="confirm-gps">Сохранить для «${esc(target.label)}»</button>`);}catch(err){toast(err.message);a.disabled=false;a.innerHTML=icon('gps')+'Сохранить GPS здесь';}break;}
      case 'confirm-gps':if(pendingGPS){const pending=pendingGPS;pendingGPS=null;saveCoordinate({...pending.position,source:'device'},pending.target);}break;
      case 'gps':await locate();break;
      case 'route':route();break;
      case 'export':exportLocal();break;
      case 'export-registry':downloadJSON(data,'brigade2-registry.json');break;
      case 'import':importModal();break;
      case 'update':if(swRegistration?.waiting){swRegistration.waiting.postMessage({type:'SKIP_WAITING'});navigator.serviceWorker.addEventListener('controllerchange',()=>location.reload(),{once:true});}break;
    }
  });
  $('#search').addEventListener('input',renderList);$('#search').addEventListener('keydown',e=>{if(e.key==='Enter'){const exact=exactNavigationTarget(e.target.value);if(exact){e.preventDefault();selectedPad=data.pads.find(p=>p.id===exact.padId);selectedWell=exact.wellId;route();}}});$('#type-filter').addEventListener('change',renderList);$('#favorite-filter').addEventListener('click',()=>{favoriteOnly=!favoriteOnly;renderList();});$('#drawer-backdrop').addEventListener('click',closeDrawer);
  document.addEventListener('change',e=>{if(e.target.id==='well-type-filter')renderWellGrid();if(e.target.id==='import-file')importLocal(e.target.files[0]);});
  document.addEventListener('submit',e=>{if(e.target.id!=='coordinate-form')return;e.preventDefault();const lat=Number($('#latitude').value.trim().replace(',','.')),lng=Number($('#longitude').value.trim().replace(',','.'));if(!$('#latitude').value.trim()||!$('#longitude').value.trim()||!isValidCoordinate({lat,lng})){ $('#coordinate-error').textContent='Введите широту от −90 до 90 и долготу от −180 до 180 в десятичных градусах.';return;}const target=targetFromCoordinateKey(e.target.dataset.coordinateKey);if(!target){$('#coordinate-error').textContent='Сначала выберите куст или отдельную скважину.';return;}saveCoordinate({lat,lng,source:'manual'},target);});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('#modal').open)closeDrawer();if(e.key==='/'&&!['INPUT','TEXTAREA'].includes(document.activeElement.tagName)&&$('#drawer').classList.contains('hidden')&&!$('#modal').open){e.preventDefault();if(currentView==='info'||currentView==='settings')setView('map');$('#search').focus();}if(e.key==='Tab'&&!$('#drawer').classList.contains('hidden')&&!$('#modal').open){const focusable=$$('button,a,input,select,textarea',[...document.querySelectorAll('#drawer')][0]).filter(el=>!el.disabled&&!el.closest('.hidden'));const first=focusable[0],last=focusable.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&(document.activeElement===last||document.activeElement===$('#drawer'))){e.preventDefault();first.focus();}}});
  window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredInstall=e;});
  window.addEventListener('appinstalled',()=>{deferredInstall=null;toast('Атлас установлен');});
  const connection=()=>{const online=navigator.onLine;$('#connection').classList.toggle('offline',!online);$('#connection').innerHTML=`<i></i>${online?'Есть сеть':'Без сети'}`;};window.addEventListener('online',connection);window.addEventListener('offline',connection);connection();
}
async function start(){try{const responses=await Promise.all(['data.json','map-points.json','gps-points.json'].map(u=>fetch(u)));for(const r of responses)if(!r.ok)throw Error('Не удалось загрузить данные');const loaded=await Promise.all(responses.map(r=>r.json()));[data,points]=loaded;for(const c of loaded[2].locations||[]){if(targetFromCoordinateKey(c.id)&&isValidCoordinate(c))publishedCoordinates[c.id]={...c,source:'mapped',recordedAt:c.recordedAt||loaded[2].updatedAt};}$('#pad-total').textContent=data.pads.filter(p=>p.id!=='ОД').length;$('#well-total').textContent=data.pads.reduce((n,p)=>n+p.wells.length,0);if(!window.L)throw Error('Не удалось открыть карту. Повторите загрузку');initMap();bindEvents();renderList();setLayer(['clean','original','geo'].includes(preferences.mapLayer)?preferences.mapLayer:'clean');setupOffline();if(!storageAvailable)toast('Хранилище браузера недоступно. Экспортируйте заметки перед закрытием.');}catch(e){$('#pad-list').innerHTML=`<div class="empty-state">${esc(e.message)}<br><button class="btn" onclick="location.reload()">Повторить загрузку</button></div>`;$('#offline-state').textContent='Загрузка не завершена';}}
start();
