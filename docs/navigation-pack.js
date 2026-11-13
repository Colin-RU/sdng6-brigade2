'use strict';
window.MapPacks=(()=>{
  const BASE=new URL('./',document.currentScript?.src||location.href),INDEX='atlas-map-pack-index-v1',MANIFEST=new URL('__atlas_map_pack__',BASE).href;
  const FILES=[['geo-roads.json','roads'],['geo-network.json','network'],['gps-points.json','gps'],['data.json','registry'],['map-points.json','points'],['scheme-network.json','scheme'],['field-map-clean.svg','svg'],['field-map.webp','webp']].map(([path,kind])=>({path,kind,url:new URL(path,BASE).href}));
  const listeners=new Set();let running,controller,inspection,revision=0;
  let state={status:'checking',ready:false,busy:false,bytes:0,filesDone:0,filesTotal:FILES.length,fraction:0,message:'Проверяем сохранённую карту…',metadata:null,error:null};
  const native=()=>Boolean(window.isNativeAtlas);
  const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const size=bytes=>bytes>=1048576?(bytes/1048576).toLocaleString('ru-RU',{maximumFractionDigits:1})+' МБ':Math.ceil(bytes/1024)+' КБ';
  const snapshot=()=>({...state,metadata:state.metadata?{...state.metadata}:null});
  function notify(){for(const listener of listeners)try{listener(snapshot());}catch{}window.dispatchEvent(new CustomEvent('atlas-map-pack-change',{detail:snapshot()}));}
  function set(patch){Object.assign(state,patch);notify();}
  const failure=message=>new Error(message);
  async function activeManifest(){if(!('caches' in window))return null;const response=await(await caches.open(INDEX)).match(MANIFEST);if(!response)return null;try{return await response.json();}catch{return null;}}
  async function readResponse(path){const record=await activeManifest();return record?.cacheName?(await caches.open(record.cacheName)).match(new URL(path,BASE).href):undefined;}
  function validate(bytes,file,mime){
    const text=()=>new TextDecoder().decode(bytes);let value;
    if(file.kind==='svg'){const t=text();if(!t.includes('<svg')||/<html/i.test(t))throw failure('Файл схемы повреждён.');return null;}
    if(file.kind==='webp'){if(bytes.length<16||String.fromCharCode(...bytes.slice(0,4))!=='RIFF'||String.fromCharCode(...bytes.slice(8,12))!=='WEBP')throw failure('Фото схемы повреждено.');return null;}
    if(mime&&!/json/i.test(mime))throw failure('Вместо карты получен другой файл. Повторите загрузку.');
    try{value=JSON.parse(text());}catch{throw failure('Не удалось проверить данные карты. Повторите загрузку.');}
    const coord=(p)=>p&&Number.isFinite(p.lat)&&Number.isFinite(p.lng)&&Math.abs(p.lat)<=90&&Math.abs(p.lng)<=180;
    if(file.kind==='roads'&&!(value.type==='FeatureCollection'&&Array.isArray(value.features)&&value.features.length>100&&value.features.every(f=>f.geometry&&Array.isArray(f.geometry.coordinates))))throw failure('Дороги сохранены не полностью.');
    if(file.kind==='network'){
      if(!Array.isArray(value.nodes)||value.nodes.length<100||!Array.isArray(value.edges)||value.edges.length<100)throw failure('Сеть маршрутов сохранена не полностью.');
      const ids=new Set(value.nodes.map(n=>String(Array.isArray(n)?n[0]:n.id)));
      if(ids.size!==value.nodes.length||value.nodes.some(n=>!Array.isArray(n)||!coord({lat:n[1],lng:n[2]}))||value.edges.some(e=>!ids.has(String(e.from))||!ids.has(String(e.to))||!Array.isArray(e.coordinates)||e.coordinates.some(p=>!coord({lat:p[0],lng:p[1]}))))throw failure('В дорожной сети обнаружен разрыв данных.');
    }
    if(file.kind==='gps'&&(!Array.isArray(value.locations)||value.locations.length<1||value.locations.some(p=>!coord(p))||new Set(value.locations.map(p=>p.id)).size!==value.locations.length))throw failure('Не удалось проверить точки кустов.');
    if(file.kind==='registry'&&(!Array.isArray(value.pads)||!value.pads.length||value.pads.some(p=>!p.id||!Array.isArray(p.wells))))throw failure('Реестр сохранён не полностью.');
    if(file.kind==='points'&&(!value.width||!value.height||!Array.isArray(value.points)))throw failure('Точки схемы сохранены не полностью.');
    if(file.kind==='scheme'&&(!Array.isArray(value.nodes)||!Array.isArray(value.edges)||!value.anchors))throw failure('Дороги схемы сохранены не полностью.');
    return value;
  }
  function metadata(parsed,bytes,downloadedAt){
    const registry=parsed['registry'],gps=parsed['gps'],net=parsed['network'];
    return{title:'Фёдоровское · бригада №2',region:'Фёдоровское месторождение',date:gps?.updatedAt||null,downloadedAt,bytes,pads:registry?.pads.filter(p=>p.id!=='ОД').length||0,wells:registry?.pads.reduce((n,p)=>n+p.wells.length,0)||0,gpsPoints:gps?.locations.length||0,roadNodes:net?.nodes.length||0,roadEdges:net?.edges.length||0,bounds:net?.metadata?.coveredBounds||null};
  }
  async function shellReady(){
    if(native())return true;if(!navigator.serviceWorker)return false;
    try{
      const registration=await navigator.serviceWorker.getRegistration(BASE.href),worker=registration?.active;if(!worker)return false;
      return await new Promise(resolve=>{const channel=new MessageChannel(),timer=setTimeout(()=>{channel.port1.close();resolve(false);},10000);channel.port1.onmessage=e=>{clearTimeout(timer);channel.port1.close();resolve(e.data?.ready===true);};worker.postMessage({type:'CHECK_OFFLINE_STATUS'},[channel.port2]);});
    }catch{return false;}
  }
  async function inspect(){
    if(state.busy)return snapshot();if(inspection)return inspection;
    const checkRevision=revision;
    inspection=(async()=>{
      const previousReady=state.ready;set({status:'checking',message:'Проверяем сохранённую карту…',error:null});
      try{
        const record=native()?null:await activeManifest(),names=(!native()&&'caches' in window)?await caches.keys():[],candidates=[...(record?.cacheName?[record.cacheName]:[]),...names.filter(n=>n.startsWith('sdng6-brigade2-')).reverse()];
        const parsed={};let bytes=0;
        for(const file of FILES){
          let response;
          if(native())response=await fetch(file.url);else for(const name of candidates){response=await(await caches.open(name)).match(file.url);if(response)break;}
          if(!response||(!response.ok&&!(native()&&response.status===0)))throw failure('Карта ещё не сохранена целиком.');
          const body=new Uint8Array(await response.arrayBuffer());if(checkRevision!==revision)return snapshot();const value=validate(body,file,response.headers.get('content-type'));if(value)parsed[file.kind]=value;bytes+=body.byteLength;
        }
        const ready=await shellReady(),info=metadata(parsed,bytes,record?.downloadedAt||null);
        if(checkRevision!==revision)return snapshot();set({status:ready?'ready':'partial',ready,bytes,metadata:info,filesDone:FILES.length,fraction:1,message:ready?(native()?'Карта уже в приложении · доступна без интернета':'Карта сохранена · доступна без интернета'):'Карта сохранена. Подождите, пока приложение завершит подготовку без сети.'});
      }catch(e){if(checkRevision===revision)set({status:previousReady?'error':'missing',ready:false,message:navigator.onLine?'Скачайте карту перед выездом на смену.':'Нет полной карты на этом устройстве. Для загрузки подключитесь к интернету.',error:null,filesDone:0,fraction:0});}
      return snapshot();
    })().finally(()=>{inspection=null;});return inspection;
  }
  async function download(){
    if(running)return running;
    revision++;controller=new AbortController();const signal=controller.signal;
    running=(async()=>{
      const oldReady=state.ready,oldMetadata=state.metadata,cacheName='atlas-map-pack-fedor-'+Date.now()+'-'+Math.random().toString(36).slice(2,7);let stage;
      set({status:'downloading',busy:true,error:null,bytes:0,filesDone:0,fraction:0,message:native()?'Проверяем карту в приложении…':'Загружаем карту на телефон…'});
      try{
        if(!native()&&!('caches' in window))throw failure('Этот браузер не сохраняет карты. Откройте приложение в Safari или Chrome.');
        if(!native())stage=await caches.open(cacheName);
        const parsed={};let bytes=0;
        for(let i=0;i<FILES.length;i++){
          if(signal.aborted)throw new DOMException('Отменено','AbortError');
          const file=FILES[i],url=new URL(file.url);if(!native())url.searchParams.set('atlas-pack',Date.now().toString());
          const response=await fetch(url.href,{credentials:'same-origin',cache:'reload',redirect:'error',signal});
          if(!response.ok&&!(native()&&response.status===0))throw failure('Не удалось загрузить карту. Проверьте соединение и повторите.');
          if(response.redirected||response.type==='opaque')throw failure('Не удалось подтвердить файл карты.');
          const declared=Number(response.headers.get('content-length'))||0,chunks=[];let received=0;
          if(response.body?.getReader){const reader=response.body.getReader();try{while(true){const part=await reader.read();if(part.done)break;if(signal.aborted)throw new DOMException('Отменено','AbortError');chunks.push(part.value);received+=part.value.byteLength;set({bytes:bytes+received,filesDone:i,fraction:(i+(declared?Math.min(.99,received/declared):0))/FILES.length,message:`Получено ${size(bytes+received)} · файл ${i+1} из ${FILES.length}`});}}finally{reader.releaseLock();}}
          else{const body=new Uint8Array(await response.arrayBuffer());chunks.push(body);received=body.byteLength;}
          const body=new Uint8Array(received);let offset=0;for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.byteLength;}
          const value=validate(body,file,response.headers.get('content-type'));if(value)parsed[file.kind]=value;
          if(signal.aborted)throw new DOMException('Отменено','AbortError');
          if(stage)await stage.put(file.url,new Response(body,{status:200,headers:{'Content-Type':response.headers.get('content-type')||'application/octet-stream'}}));
          bytes+=received;set({bytes,filesDone:i+1,fraction:(i+1)/FILES.length,message:`Сохранено ${size(bytes)} · ${i+1} из ${FILES.length}`});
        }
        if(signal.aborted)throw new DOMException('Отменено','AbortError');
        const downloadedAt=new Date().toISOString(),info=metadata(parsed,bytes,downloadedAt);
        if(stage){const index=await caches.open(INDEX);await index.put(MANIFEST,new Response(JSON.stringify({cacheName,downloadedAt,metadata:info,files:FILES.map(f=>f.path)}),{headers:{'Content-Type':'application/json'}}));}
        const ready=await shellReady();
        set({status:ready?'ready':'partial',busy:false,ready,metadata:info,error:null,message:ready?'Карта готова. Маршруты и поиск доступны без интернета.':'Карта скачана. Дождитесь подготовки приложения для работы без сети.'});
        if(stage)await Promise.allSettled((await caches.keys()).filter(n=>n.startsWith('atlas-map-pack-fedor-')&&n!==cacheName).map(n=>caches.delete(n)));
        if(navigator.storage?.persist)navigator.storage.persist().catch(()=>{});
      }catch(e){if(stage)await caches.delete(cacheName);set({status:e.name==='AbortError'?'cancelled':'error',busy:false,ready:oldReady,metadata:oldMetadata,error:e.name==='AbortError'?null:e.message,message:e.name==='AbortError'?'Загрузка остановлена. Ранее сохранённая карта осталась на телефоне.':(e.message||'Не удалось сохранить карту. Повторите загрузку.')});}
      finally{controller=null;running=null;}
      return snapshot();
    })();return running;
  }
  function cancel(){controller?.abort();}
  function render(container){
    if(typeof container==='string')container=document.querySelector(container);if(!container)return;
    container.innerHTML=`<section class="map-pack-card" aria-label="Карта без интернета"><div class="map-pack-heading"><span class="map-pack-symbol" aria-hidden="true">↧</span><div><small>КАРТА БЕЗ ИНТЕРНЕТА</small><h3>Фёдоровское · бригада №2</h3></div><span class="map-pack-check" aria-hidden="true"></span></div><p class="map-pack-description">Дороги промысла, кусты, отдельные скважины и схема. Введите номер — маршрут начнётся от вашей позиции GPS.</p><div class="map-pack-meta"></div><div class="map-pack-progress"><progress max="1"></progress><span></span></div><p class="map-pack-status" role="status" aria-live="polite"></p><div class="map-pack-actions"><button class="btn primary" data-map-pack="download">Скачать карту</button><button class="btn" data-map-pack="cancel" hidden>Отменить</button><button class="btn" data-map-pack="check">Проверить</button></div><p class="map-pack-footnote">GPS работает без мобильной сети. Включите геолокацию телефона и разрешите доступ к позиции.</p></section>`;
    const card=container.querySelector('.map-pack-card');
    const paint=s=>{
      if(!container.isConnected){listeners.delete(paint);return;}card.dataset.state=s.status;card.querySelector('.map-pack-check').textContent=s.ready?'✓':'';
      const m=s.metadata,date=m?.date?new Date(m.date+'T00:00:00').toLocaleDateString('ru-RU'):null;
      card.querySelector('.map-pack-meta').innerHTML=m?`<span>${m.pads} куста · ${m.gpsPoints} GPS-точки</span><span>${size(m.bytes)}${date?' · данные от '+escape(date):''}</span>`:'<span>Фёдоровское месторождение</span><span>Размер карты появится после проверки</span>';
      card.querySelector('.map-pack-status').textContent=s.message;
      const progress=card.querySelector('.map-pack-progress');progress.hidden=!s.busy;progress.querySelector('progress').value=s.fraction;progress.querySelector('span').textContent=`${size(s.bytes)} · ${s.filesDone}/${s.filesTotal}`;
      const button=card.querySelector('[data-map-pack="download"]');button.disabled=s.busy;button.textContent=s.busy?'Загрузка…':native()?'Проверить карту':s.ready?'Обновить карту':'Скачать карту';
      card.querySelector('[data-map-pack="cancel"]').hidden=!s.busy;card.querySelector('[data-map-pack="check"]').disabled=s.busy;
    };
    listeners.add(paint);paint(snapshot());container.addEventListener('click',event=>{const action=event.target.closest('[data-map-pack]')?.dataset.mapPack;if(action==='download')download();if(action==='cancel')cancel();if(action==='check')inspect();});inspect();
  }
  const subscribe=listener=>{listeners.add(listener);listener(snapshot());return()=>listeners.delete(listener);};
  return{render,download,cancel,inspect,subscribe,getState:snapshot,readResponse,files:FILES.map(f=>f.path)};
})();
