'use strict';
(() => {
 if(window.isNativeAtlas||!navigator.serviceWorker)return;
 const entryURL=new URL(location.href);if(entryURL.searchParams.has('v')){entryURL.searchParams.delete('v');history.replaceState(history.state,'',entryURL);}
 let registration=null,banner=null,interacted=false,applying=false,reloadReady=false,timer=null,autoTimer=null,fallbackProfileDirty=false,fallbackProfileInput=null,profileOwner=window.Community?.getUser?.()?.id;
 const legacyCalendar=new Map();
 const hadController=Boolean(navigator.serviceWorker.controller);
 const inputActive=()=>document.activeElement?.matches?.('input,textarea,select,[contenteditable="true"]');
 function shiftSignature(form){return JSON.stringify(['shift-kind','shift-start','shift-end','shift-note'].map(id=>form.querySelector('#'+id)?.value||''));}
 function captureLegacyShift(event){
  if(window.WorkCalendar?.getUpdateState)return;
  const form=event.target?.closest?.('#shift-form');if(!form)return;
  const key=form.dataset.shiftUser+':'+form.dataset.shiftDate,signature=shiftSignature(form);
  if(event.type==='focusin'){if(!form._updateBaseline)form._updateBaseline=signature;return;}
  const previous=legacyCalendar.get(key)||{};
  if(event.type!=='submit'&&form._updateBaseline===signature){legacyCalendar.delete(key);return;}
  legacyCalendar.set(key,{form,submitted:event.type==='submit'?signature:previous.submitted});
 }
 function legacyShiftDirty(){for(const [key,value] of legacyCalendar){if(value.form.dataset.shiftSaved==='true'&&value.submitted===shiftSignature(value.form))legacyCalendar.delete(key);}return legacyCalendar.size>0;}
 function state(){
  const modern=typeof window.Community?.getUpdateState==='function',value=window.Community?.getUpdateState?.()||{},calendar=window.WorkCalendar?.getUpdateState?.()||{};
  if(!modern&&fallbackProfileInput?.value===window.Community?.getUser?.()?.nickname)fallbackProfileDirty=false;
  return {busy:Boolean(value.busy||calendar.busy||document.querySelector('form[data-sending="true"],form[data-saving="true"]')),hasFiles:Boolean(value.hasFiles||document.querySelector('.community-draft-photo,[data-avatar-editor]:not([hidden])')),hasTransientDraft:Boolean(value.hasTransientDraft||!modern&&fallbackProfileDirty||[...document.querySelectorAll('[data-community-auth] input:not([type=checkbox])')].some(node=>node.getClientRects?.().length&&node.value.trim())||!window.WorkCalendar?.getUpdateState&&legacyShiftDirty()),hasDraft:Boolean(value.hasDraft||calendar.hasDraft||[...document.querySelectorAll('textarea')].some(node=>node.value.trim()))};
 }
 function storedDraft(){try{for(let i=0;i<localStorage.length;i++){const key=localStorage.key(i);if(key?.startsWith('atlas.community.v1.')&&key.includes('draft')){const value=JSON.parse(localStorage.getItem(key)||'null');if(value?.body?.trim())return true;}}}catch{}return false;}
 function reason(){const current=state();return current.busy?'Дождитесь завершения отправки или сохранения.':current.hasFiles?'Сначала отправьте, сохраните или отмените выбранные фотографии.':current.hasTransientDraft?'Сначала сохраните изменения формы или завершите вход.':'';}
 function show(message='Новая версия приложения готова.'){
  if(!banner){banner=document.createElement('aside');banner.className='app-update-notice';banner.setAttribute('aria-label','Обновление приложения');banner.innerHTML='<span class="app-update-symbol" aria-hidden="true">↻</span><div><strong>Доступно обновление</strong><p data-update-copy></p></div><button type="button" class="btn primary" data-app-update>Обновить</button>';document.body.append(banner);banner.querySelector('[data-app-update]').onclick=()=>apply(false);}
  banner.querySelector('[data-update-copy]').textContent=message;banner.querySelector('[data-app-update]').disabled=applying;
 }
 function reload(){
  if(reason()){applying=false;show(reason());return;}
  window.dispatchEvent(new Event('atlas-before-update'));
  const url=new URL(location.href);if(url.searchParams.has('v')){url.searchParams.delete('v');history.replaceState(history.state,'',url);}
  location.reload();
 }
 function safeAuto(){const current=state();return !interacted&&!current.busy&&!current.hasFiles&&!current.hasTransientDraft&&!current.hasDraft&&!storedDraft()&&!inputActive()&&document.visibilityState==='visible'&&!document.querySelector('dialog[open]');}
 function apply(automatic=false){
  if(applying||automatic&&!safeAuto())return;
  const blocked=reason();if(blocked){show(blocked);return;}
  if(reloadReady){reload();return;}
  const worker=registration?.waiting||(typeof swRegistration==='object'?swRegistration?.waiting:null);if(!worker)return;
  applying=true;show('Открываем обновлённое приложение…');
  const changed=()=>{clearTimeout(timer);reloadReady=true;applying=false;if(automatic&&!safeAuto()){show('Обновление установлено. Нажмите, чтобы открыть новую версию.');return;}reload();};
  navigator.serviceWorker.addEventListener('controllerchange',changed,{once:true});
  timer=setTimeout(()=>{navigator.serviceWorker.removeEventListener('controllerchange',changed);applying=false;show('Повторите обновление, когда будет связь.');},15000);
  worker.postMessage({type:'SKIP_WAITING'});
 }
 function available(){if(!registration?.waiting)return;show();clearTimeout(autoTimer);autoTimer=setTimeout(()=>apply(true),1200);}
 function observe(worker){if(!worker)return;worker.addEventListener('statechange',()=>{if(worker.state==='installed')setTimeout(available,0);});}
 for(const name of ['pointerdown','keydown','input'])document.addEventListener(name,()=>{interacted=true;},{capture:true,passive:true});
 window.AppUpdate=Object.freeze({apply:()=>apply(false)});
 document.addEventListener('click',event=>{if(event.target?.closest?.('[data-action="update"]')){event.preventDefault();event.stopImmediatePropagation();apply(false);}},{capture:true});
 document.addEventListener('input',event=>{if(event.target?.matches?.('[data-profile-form] [name="nickname"]')){fallbackProfileDirty=true;fallbackProfileInput=event.target;}},{capture:true});
 window.addEventListener('atlas-community-change',event=>{if(event.detail?.type==='profile')fallbackProfileDirty=false;});
 window.addEventListener('atlas-auth-change',()=>{const next=window.Community?.getUser?.()?.id;if(next!==profileOwner){profileOwner=next;fallbackProfileDirty=false;fallbackProfileInput=null;legacyCalendar.clear();}});
 for(const name of ['focusin','input','change','submit'])document.addEventListener(name,captureLegacyShift,{capture:true});
 navigator.serviceWorker.addEventListener('controllerchange',()=>{if(hadController&&!applying){reloadReady=true;show('Обновление установлено. Откройте новую версию.');}});
 (async()=>{try{
  registration=await navigator.serviceWorker.register('./sw.js',{scope:'./',updateViaCache:'none'});observe(registration.installing);
  registration.addEventListener('updatefound',()=>observe(registration.installing));available();
  if(navigator.onLine!==false)registration.update().catch(()=>{});
 }catch{}})();
})();
