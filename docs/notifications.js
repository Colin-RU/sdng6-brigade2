'use strict';
(() => {
  const STORE='atlas.notifications.v1.';
  let items=[],nextCursor=null,loading=false,count=0,opened=false,pushBusy=false,pushMessage='',browserSubscriptionActive=false,authGeneration=0,countRequest=0;
  const openingIds=new Set();let pendingNotification=new URL(location.href).searchParams.get('notification');
  const html=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const api=(path,options)=>Community.api(path,options);
  const user=()=>window.Community?.getUser();
  const online=()=>navigator.onLine!==false;
  const host=()=>document.querySelector('#community-view');
  const visible=()=>opened&&host()?.isConnected&&host().dataset.communitySection==='notifications'&&host().getClientRects().length&&document.visibilityState==='visible';
  const format=value=>new Date(value).toLocaleString('ru-RU',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
  const key=()=>STORE+String(user()?.id||'guest');
  const native=()=>Boolean(window.SdngGps?.getNotificationState&&window.SdngGps?.configureNotifications);
  function setting(){try{return JSON.parse(localStorage.getItem(key())||'null')||{enabled:false};}catch{return {enabled:false};}}
  function saveSetting(value){try{localStorage.setItem(key(),JSON.stringify(value));}catch{}}
  function sourceCopy(){try{return JSON.parse(localStorage.getItem(key()+'.feed')||'null');}catch{return null;}}
  function saveFeed(){try{localStorage.setItem(key()+'.feed',JSON.stringify({items,nextCursor,at:new Date().toISOString()}));}catch{}}
  function setCount(value){countRequest++;count=Math.max(0,Number(value)||0);window.dispatchEvent(new CustomEvent('atlas-notifications-count',{detail:{count}}));document.querySelectorAll('[data-notifications-count]').forEach(node=>{node.textContent=count>99?'99+':String(count);node.hidden=!count;});}
  function nativeState(){try{return JSON.parse(SdngGps.getNotificationState());}catch{return {permission:'prompt',enabled:false,background:'periodic'};}}
  function permission(){return native()?nativeState().permission:window.Notification?.permission||'unsupported';}
  function enabled(){return native()?Boolean(nativeState().enabled&&nativeState().permission==='granted'):Boolean(setting().enabled&&browserSubscriptionActive&&window.Notification?.permission==='granted');}
  function pushHelp(){
    if(!user())return 'Войдите в профиль, чтобы получать ответы коллег.';
    if(permission()==='denied')return 'Уведомления запрещены. Разрешите их для приложения в настройках телефона или браузера, затем повторите.';
    if(native())return 'Android может задерживать фоновую доставку. Все ответы сохраняются в этом разделе.';
    if(!('Notification' in window)||!('PushManager' in window))return 'На iPhone добавьте атлас на экран «Домой» через Safari и откройте его с появившегося значка. Затем разрешите уведомления здесь.';
    return enabled()?'Ответы на ваши записи будут появляться на экране телефона.':'Разрешите уведомления, чтобы видеть ответы коллег, когда приложение закрыто.';
  }
  function pushMarkup(){return `<article class="community-card"><div class="community-notification-controls"><button type="button" class="btn ${enabled()?'':'primary'}" data-enable-notifications ${pushBusy||!user()||!online()?'disabled':''}>${pushBusy?'Настраиваем…':enabled()?'Выключить уведомления':'Разрешить уведомления'}</button><span class="status-chip">${enabled()?'Включены на этом устройстве':'Не включены на этом устройстве'}</span></div><p class="community-notification-state" role="status">${html(pushMessage||pushHelp())}</p></article>`;}
  function render({cachedAt,error=''}={}){
    const node=host();if(!node||node.dataset.communitySection!=='notifications')return;
    node.innerHTML=`<div class="community-page"><header class="community-section-head"><div><span class="community-kicker">ОТВЕТЫ КОЛЛЕГ</span><h2>Уведомления${count?` <span class="community-unread-badge">${count>99?'99+':count}</span>`:''}</h2></div>${user()?'<button type="button" class="btn" data-notifications-read-all>Прочитать все</button>':''}</header>${pushMarkup()}${cachedAt?`<p class="community-source" style="margin-top:15px">Сохранённая копия · ${html(format(cachedAt))}. Подключитесь к интернету для обновления.</p>`:''}${error?`<p class="community-form-error" role="status">${html(error)}</p>`:''}<section class="community-card community-notification-list" aria-label="Ответы на ваши записи">${!user()?'<p class="community-empty">Войдите, чтобы открыть ваши уведомления.</p><button type="button" class="btn primary" data-notifications-login>Войти в профиль</button>':items.length?items.map(item=>`<button type="button" class="community-notification-item ${!item.readAt?'unread':''}" data-open-notification="${html(item.id)}"><strong>${html(item.actor?.nickname||'Коллега')} ответил · ${html(item.objectLabel||'Объект')}</strong><p>${html(item.preview||'Новый ответ на вашу запись')}</p><time datetime="${html(item.createdAt)}">${html(format(item.createdAt))}</time></button>`).join(''):`<p class="community-empty">${loading?'Загружаем уведомления…':error?'Не удалось получить уведомления.':'Новых ответов пока нет.'}</p>`}${user()?`<div class="community-notification-controls"><button type="button" class="btn" data-notifications-refresh ${loading?'disabled':''}>Обновить</button>${nextCursor?'<button type="button" class="btn" data-notifications-older>Более ранние</button>':''}</div>`:''}</section></div>`;
    node.querySelector('[data-enable-notifications]')?.addEventListener('click',async()=>{if(pushBusy)return;const generation=authGeneration;pushBusy=true;pushMessage='';render();try{if(enabled())await disable();else await enable();}catch(e){if(generation===authGeneration)pushMessage=e.message;}finally{if(generation===authGeneration){pushBusy=false;render();}}});
    node.querySelector('[data-notifications-login]')?.addEventListener('click',()=>Community.auth());
    node.querySelector('[data-notifications-refresh]')?.addEventListener('click',()=>load());
    node.querySelector('[data-notifications-older]')?.addEventListener('click',()=>load(true));
    node.querySelector('[data-notifications-read-all]')?.addEventListener('click',async event=>{event.currentTarget.disabled=true;try{await api('/notifications/read-all',{method:'POST'});const now=new Date().toISOString();items=items.map(item=>({...item,readAt:item.readAt||now}));setCount(0);saveFeed();render();}catch(e){render({error:e.message});}});
    node.querySelectorAll('[data-open-notification]').forEach(button=>button.onclick=()=>openNotification(button.dataset.openNotification));
  }
  async function unread(){if(!user()||!online())return;const generation=authGeneration,request=++countRequest;try{const result=await api('/notifications/unread-count');if(generation===authGeneration&&request===countRequest)setCount(result.count);}catch{}}
  async function load(older=false){
    if(loading||!user())return;const generation=authGeneration;loading=true;if(!items.length)render();
    try{const result=await api('/notifications?limit=40'+(older&&nextCursor?'&before='+encodeURIComponent(nextCursor):''));
      if(generation!==authGeneration)return;const map=new Map((older?items:[]).map(item=>[String(item.id),item]));for(const item of result.items||[])map.set(String(item.id),item);
      items=[...map.values()].sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)||String(b.cursor).localeCompare(String(a.cursor)));nextCursor=result.nextCursor||null;saveFeed();render();await unread();
    }catch(error){if(generation!==authGeneration||error.code==='stale_session')return;const saved=sourceCopy();if(saved){items=saved.items||[];nextCursor=saved.nextCursor;render({cachedAt:saved.at,error:error.message});}else render({error:error.message});}
    finally{if(generation===authGeneration){loading=false;host()?.querySelector('[data-notifications-refresh]')?.removeAttribute('disabled');}}
  }
  function decodeKey(value){const normal=String(value).replace(/-/g,'+').replace(/_/g,'/');const binary=atob(normal);return Uint8Array.from(binary,c=>c.charCodeAt(0));}
  async function requestNativePermission(){
    const current=nativeState();if(current.permission==='granted')return current;
    if(current.permission==='denied')throw Error('Уведомления запрещены. Разрешите их для приложения в настройках телефона.');
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{window.removeEventListener('atlas-native-notification-state',changed);reject(Error('Проверьте разрешение уведомлений в настройках телефона.'));},90000);function changed(event){clearTimeout(timer);window.removeEventListener('atlas-native-notification-state',changed);resolve(typeof event.detail==='string'?JSON.parse(event.detail):event.detail);}window.addEventListener('atlas-native-notification-state',changed);try{SdngGps.requestNotificationPermission();}catch(e){clearTimeout(timer);window.removeEventListener('atlas-native-notification-state',changed);reject(e);}});
  }
  async function waitNative(expected){for(let attempt=0;attempt<20;attempt++){if(Boolean(nativeState().enabled)===expected)return;await new Promise(resolve=>setTimeout(resolve,100));}throw Error('Не удалось подтвердить изменение уведомлений. Проверьте разрешение и повторите.');}
  async function enable(){
    const generation=authGeneration;const check=()=>{if(generation!==authGeneration)throw Error('Вход изменился. Повторите включение уведомлений.');};
    if(!user())throw Error('Сначала войдите в профиль.');
    if(!online())throw Error('Для включения уведомлений нужно подключение к интернету.');
    if(native()){
      if(!Community.sessionRemembered())throw Error('Для фоновых уведомлений войдите с отметкой «Запомнить меня».');
      const state=await requestNativePermission();check();if(state.permission!=='granted')throw Error('Уведомления не разрешены. Разрешите их в настройках телефона.');
      Community.configureNativeNotifications(true);await waitNative(true);saveSetting({enabled:true});pushMessage='Уведомления включены. Android может задерживать фоновую доставку.';return;
    }
    if(!('Notification' in window)||!('PushManager' in window)||!navigator.serviceWorker)throw Error('Добавьте атлас на экран «Домой», откройте с его значка и разрешите уведомления здесь.');
    const allowed=await Notification.requestPermission();check();if(allowed!=='granted')throw Error(allowed==='denied'?'Уведомления запрещены. Разрешите их для приложения в настройках телефона или браузера.':'Разрешение не получено. Уведомления можно включить позже.');
    const [registration,result]=await Promise.all([Promise.race([navigator.serviceWorker.ready,new Promise((_,reject)=>setTimeout(()=>reject(Error('Откройте атлас с интернетом и повторите включение уведомлений.')),15000))]),api('/push/public-key')]);
    check();if(!result.publicKey)throw Error('Фоновая доставка пока не подключена. Все ответы доступны в этом разделе.');
    let subscription=await registration.pushManager.getSubscription();if(!subscription)subscription=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:decodeKey(result.publicKey)});
    check();await api('/push/subscriptions',{method:'POST',body:subscription.toJSON()});check();browserSubscriptionActive=true;saveSetting({enabled:true});pushMessage='Уведомления включены на этом устройстве.';
  }
  async function disable(){
    if(native()){Community.configureNativeNotifications(false);await waitNative(false);saveSetting({enabled:false});pushMessage='Уведомления на этом устройстве выключены.';return;}
    try{await unsubscribe(true);}finally{saveSetting({enabled:false});pushMessage='Уведомления на этом устройстве выключены.';}
  }
  async function unsubscribe(server=false){let subscription,registration;try{registration=await navigator.serviceWorker?.getRegistration();subscription=await registration?.pushManager?.getSubscription();if(subscription&&server&&user())await api('/push/subscriptions',{method:'DELETE',body:{endpoint:subscription.endpoint}});}finally{try{if(subscription)await subscription.unsubscribe();}finally{browserSubscriptionActive=false;try{const shown=await registration?.getNotifications?.();for(const notification of shown||[])notification.close();}catch{}}}}
  async function prepareLogout(){saveSetting({enabled:false});try{Community.configureNativeNotifications(false);}catch{}try{await unsubscribe(true);}catch{}}
  async function openNotification(id){
    id=String(id||'');if(!id||id.length>200||openingIds.has(id))return;const generation=authGeneration;openingIds.add(id);
    try{let item=items.find(value=>String(value.id)===String(id))||sourceCopy()?.items?.find(value=>String(value.id)===String(id));if(!item){const response=await api('/notifications/'+encodeURIComponent(id));item=response.item||response;}
      if(generation!==authGeneration)return;if(!item.objectKey||!item.noteId)throw Error('Запись уведомления пока недоступна.');
      if(!item.readAt&&online()){try{await api('/notifications/'+encodeURIComponent(item.id)+'/read',{method:'POST'});if(generation!==authGeneration)return;item.readAt=new Date().toISOString();setCount(count-1);saveFeed();}catch(error){if(error.status===401||error.status===403||error.code==='stale_session')throw error;}}
      if(generation!==authGeneration)return;if(pendingNotification===id){pendingNotification=null;const url=new URL(location.href);url.searchParams.delete('notification');history.replaceState(history.state,'',url);}
      opened=false;window.dispatchEvent(new CustomEvent('atlas-open-object',{detail:{key:item.objectKey,label:item.objectLabel,noteId:item.noteId,parentId:item.parentId,notificationId:item.id}}));
    }catch(error){if(generation!==authGeneration||error.code==='stale_session')return;if(error.status===404&&pendingNotification===id){pendingNotification=null;const url=new URL(location.href);url.searchParams.delete('notification');history.replaceState(history.state,'',url);}pushMessage=error.message;if(visible())render({error:error.message});else if(typeof toast==='function')toast(error.message);}
    finally{openingIds.delete(id);}
  }
  function openView(){opened=true;if(host())host().dataset.communitySection='notifications';render();if(user())load();return host()?.innerHTML||'';}
  window.AtlasNotifications=Object.freeze({openView,openNotification,enable,disable,prepareLogout,refresh:unread,getCount:()=>count});
  window.Notifications=window.AtlasNotifications;
  window.addEventListener('atlas-auth-change',()=>{authGeneration++;items=[];nextCursor=null;loading=false;pushBusy=false;pushMessage='';setCount(0);if(visible())render();if(!user())return;if(native()&&setting().enabled&&Community.sessionRemembered()){try{Community.configureNativeNotifications(true);}catch{}}unread();if(pendingNotification)openNotification(pendingNotification);if(visible())load();});
  window.addEventListener('atlas-native-notification-state',()=>{if(visible())render();});
  window.addEventListener('atlas-session-ended',()=>{saveSetting({enabled:false});unsubscribe(false).catch(()=>{});});
  window.addEventListener('atlas-notification-open',event=>{if(event.detail?.id)openNotification(event.detail.id);});
  navigator.serviceWorker?.addEventListener?.('message',event=>{if(event.data?.type==='ATLAS_NOTIFICATION_OPEN'&&typeof event.data.id==='string')openNotification(event.data.id);});
  window.addEventListener('online',()=>{unread();if(visible())load();});
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')unread();});
  setInterval(()=>{if(document.visibilityState==='visible'){unread();if(visible())load();}},30000);
  if(user()){unread();if(pendingNotification)setTimeout(()=>openNotification(pendingNotification),250);if(!native())navigator.serviceWorker?.getRegistration().then(registration=>registration?.pushManager?.getSubscription()).then(subscription=>{browserSubscriptionActive=Boolean(subscription);if(visible())render();}).catch(()=>{});}
  else{unsubscribe(false).catch(()=>{});try{Community.configureNativeNotifications(false);}catch{}}
})();
