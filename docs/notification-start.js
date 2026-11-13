'use strict';
(() => {
 const KEY='atlas.notification-invitation.v1';
 let busy=false,pending=false,card=null;
 const service=()=>window.AtlasNotifications;
 const native=()=>Boolean(window.SdngGps?.getNotificationState);
 const user=()=>window.Community?.getUser();
 const read=()=>{try{return JSON.parse(localStorage.getItem(KEY)||'null')||{};}catch{return {};}};
 const save=patch=>{try{localStorage.setItem(KEY,JSON.stringify({...read(),...patch}));}catch{}};
 const editing=()=>Boolean(document.activeElement?.matches('input,textarea,select,[contenteditable="true"]'));
 function remove(){card?.remove();card=null;}
 function visibility(){if(card)card.hidden=editing()||['chat','profile','equipment','calendar'].includes(document.documentElement.dataset.activeView)||document.visibilityState!=='visible'||Boolean(document.querySelector('#modal:not(dialog):not(.hidden),dialog[open]'));}
 function message(text){if(card)card.querySelector('[data-invite-message]').textContent=text;}
 function show(force=false){
  if(!service()||card||service().isEnabled())return;
  const state=read();if(!force&&(state.accepted||state.snoozeUntil>Date.now()))return;
  card=document.createElement('aside');card.className='notification-invitation';card.setAttribute('aria-label','Уведомления бригады');
  card.innerHTML='<div class="notification-invitation-symbol" aria-hidden="true"><svg viewBox="0 0 24 24"><use href="#i-bell"/></svg></div><div class="notification-invitation-copy"><strong>Не пропускайте ответы коллег</strong><p data-invite-message>Разрешите уведомления, чтобы узнавать об ответах, когда приложение закрыто.</p><div class="notification-invitation-actions"><button type="button" class="btn primary" data-invite-enable>Включить уведомления</button><button type="button" class="btn subtle" data-invite-later>Позже</button></div></div>';
  document.body.append(card);visibility();
  card.querySelector('[data-invite-later]').onclick=()=>{pending=false;save({pending:false,snoozeUntil:Date.now()+86400000});remove();};
  card.querySelector('[data-invite-enable]').onclick=async()=>{
   if(busy)return;busy=true;const button=card.querySelector('[data-invite-enable]');button.disabled=true;
   try{
    if(!native()&&(!('Notification' in window)||!('PushManager' in window))){
     message('На iPhone: Safari → «Поделиться» → «На экран Домой». Откройте атлас с этого значка и включите уведомления.');
     button.textContent='Понятно';button.onclick=()=>{save({snoozeUntil:Date.now()+86400000});remove();};return;
    }
    if(user()&&(!native()||Community.sessionRemembered())){await service().enable();save({accepted:true,pending:false});remove();}
    else{
     await service().requestPermission();save({accepted:true,pending:true});pending=true;
     message(user()?'Разрешение получено. Войдите с отметкой «Запомнить меня», чтобы получать сообщения после закрытия приложения.':'Разрешение получено. Войдите или создайте профиль, чтобы получать сообщения и ответы коллег.');
     button.textContent='Войти или создать профиль';button.onclick=()=>{remove();Community.auth();};
    }
   }catch(error){message(error.message||'Не удалось включить уведомления. Повторите в разделе «Уведомления».');}
   finally{busy=false;if(button.isConnected)button.disabled=false;}
  };
 }
 async function finish(){
  if(busy||!user()||!(pending||read().pending))return;
  busy=true;try{await service().enable();pending=false;save({accepted:true,pending:false});remove();}
  catch(error){show(true);message(error.message||'Откройте раздел «Уведомления» и повторите включение.');}
  finally{busy=false;}
 }
 window.addEventListener('atlas-auth-change',()=>{if(user())finish();else if(!read().pending)pending=false;});
 window.addEventListener('atlas-session-ended',()=>{pending=false;save({pending:false});});
 window.addEventListener('online',finish);
 window.addEventListener('atlas-native-notification-state',()=>{if(service()?.isEnabled()){save({accepted:true,pending:false});remove();}});
 document.addEventListener('focusin',visibility);document.addEventListener('focusout',()=>setTimeout(visibility,0));
 document.addEventListener('visibilitychange',()=>{visibility();if(document.visibilityState==='visible')finish();});
 document.addEventListener('atlas-view-change',visibility);
 setTimeout(()=>{pending=Boolean(read().pending);if(user()&&pending)finish();else show();},500);
})();
