'use strict';
(() => {
  const STORE='atlas.notifications.v1.';
  let items=[],nextCursor=null,loading=false,count=0,opened=false,pushBusy=false,pushMessage='',browserSubscriptionActive=false,authGeneration=0,countRequest=0,feedGeneration=0,filter='all';
  const openingIds=new Set();let pendingNotification=new URL(location.href).searchParams.get('notification');
  const html=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const api=(path,options)=>Community.api(path,options);
  const user=()=>window.Community?.getUser();
  const online=()=>navigator.onLine!==false;
  const host=()=>document.querySelector('#community-view');
  const visible=()=>opened&&host()?.isConnected&&host().dataset.communitySection==='notifications'&&host().getClientRects().length&&document.visibilityState==='visible';
  const format=value=>new Date(value).toLocaleString('ru-RU',{timeZone:'Asia/Yekaterinburg',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
  const key=()=>STORE+String(user()?.id||'guest');
  const native=()=>Boolean(window.SdngGps?.getNotificationState&&window.SdngGps?.configureNotifications);
  let browserEndpoint='',visibilityDocumentId=null,visibilitySequence=0,browserPageActive=true;
  function documentId(){
    if(visibilityDocumentId)return visibilityDocumentId;const crypto=window.crypto;if(crypto?.randomUUID)return visibilityDocumentId=crypto.randomUUID();if(!crypto?.getRandomValues)return null;
    const bytes=crypto.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;const hex=[...bytes].map(value=>value.toString(16).padStart(2,'0')).join('');return visibilityDocumentId=hex.slice(0,8)+'-'+hex.slice(8,12)+'-'+hex.slice(12,16)+'-'+hex.slice(16,20)+'-'+hex.slice(20);
  }
  async function sendBrowserVisibility(isVisible){
    if(native()||!browserEndpoint||!user()||!online())return;const id=documentId();if(!id)return;
    const endpoint=browserEndpoint,visible=Boolean(isVisible&&browserPageActive&&document.visibilityState==='visible'&&enabled());
    try{await api('/push/visibility',{method:'POST',body:{endpoint,visible,documentId:id,sequence:++visibilitySequence},keepalive:true,timeout:4000});}catch{}
  }
  async function restoreBrowserSubscription(){
    if(native()||!user())return;const generation=authGeneration,owner=user()?.id;
    try{const registration=await navigator.serviceWorker?.getRegistration(),subscription=await registration?.pushManager?.getSubscription();if(generation!==authGeneration||owner!==user()?.id||native())return;browserEndpoint=subscription?.endpoint||'';browserSubscriptionActive=Boolean(subscription);await sendBrowserVisibility(true);if(generation===authGeneration&&visible())render();}catch{}
  }
  function setting(){try{return JSON.parse(localStorage.getItem(key())||'null')||{enabled:false};}catch{return {enabled:false};}}
  function saveSetting(value){try{localStorage.setItem(key(),JSON.stringify(value));}catch{}}
  function sourceCopy(){try{return JSON.parse(localStorage.getItem(key()+'.feed.'+filter)||(filter==='all'?localStorage.getItem(key()+'.feed'):null)||'null');}catch{return null;}}
  function saveFeed(){try{localStorage.setItem(key()+'.feed.'+filter,JSON.stringify({items,nextCursor,at:new Date().toISOString()}));}catch{}}
  function setCount(value){countRequest++;count=Math.max(0,Number(value)||0);window.dispatchEvent(new CustomEvent('atlas-notifications-count',{detail:{count}}));document.querySelectorAll('[data-notifications-count]').forEach(node=>{node.textContent=count>99?'99+':String(count);node.hidden=!count;});}
  function nativeState(){try{return JSON.parse(SdngGps.getNotificationState());}catch{return {permission:'prompt',enabled:false,background:'periodic'};}}
  function permission(){return native()?nativeState().permission:window.Notification?.permission||'unsupported';}
  function enabled(){return native()?Boolean(nativeState().enabled&&nativeState().permission==='granted'):Boolean(setting().enabled&&browserSubscriptionActive&&window.Notification?.permission==='granted');}
  function deliveryState(){
    if(!native())return {native:false,enabled:enabled(),registered:false,validated:false,mode:'browser',label:enabled()?'Включены на этом устройстве':'Не включены на этом устройстве'};
    const state=nativeState(),on=Boolean(user()&&state.enabled&&state.permission==='granted'),registered=on&&state.pushRegistered===true,validated=registered&&state.pushValidated===true,status=String(state.pushStatus||'not_configured'),interval=Number(state.intervalMinutes)>0?Number(state.intervalMinutes):15;
    const fallback=`Пока сообщения проверяются в фоне примерно каждые ${interval} минут. Android может задерживать проверку. Все сообщения сохраняются в этом разделе.`;
    let label='Не включены на этом устройстве',message='Включите уведомления о сообщениях чата и ответах по объектам.';
    if(!user())message='Войдите в профиль, чтобы получать сообщения чата и ответы коллег.';
    else if(state.permission==='denied'){label='Запрещены на телефоне';message='Уведомления запрещены. Разрешите их для приложения в настройках телефона, затем повторите.';}
    else if(on&&registered){label='Уведомления подключены';message=validated?'Телефон получил уведомление. Сообщения и ответы также сохраняются в этом разделе.':'Подключение готово. Подтверждение доставки появится после первого полученного уведомления.';}
    else if(on){
      const copy={
        pending:['Подключаем уведомления…','Ожидаем подтверждение подключения телефона.'],
        registered:['Проверяем подключение…','Подключение телефона ещё не подтверждено.'],
        not_configured:['Быстрая доставка пока не подключена','Быстрая доставка пока недоступна в этой версии приложения.'],
        server_not_configured:['Быстрая доставка пока не подключена','Подключение уведомлений ещё настраивается.'],
        play_services_unavailable:['Быстрая доставка недоступна','Для быстрых уведомлений нужны сервисы Google Play. Проверьте, что они установлены и обновлены.'],
        registration_unavailable:['Подключение не завершено','Телефон пока не завершил подключение уведомлений. Проверьте интернет и повторите подключение.'],
        binding_conflict:['Нужно повторить подключение','Не удалось связать уведомления с текущим профилем. Повторите подключение.'],
        connection_unavailable:['Нет связи с уведомлениями','Не удалось завершить подключение. Проверьте интернет и повторите.']
      };
      const phase=copy[status]||['Фоновая проверка включена','Быстрая доставка ещё не подтверждена.'];label=phase[0];message=phase[1]+' '+fallback;
    }
    const lastPushAt=Number(state.lastPushAt),last=validated&&Number.isFinite(lastPushAt)&&lastPushAt>0&&lastPushAt<8.64e15?lastPushAt:null;
    return {native:true,enabled:on,registered,validated,mode:on?(registered?'fcm':'periodic'):'disabled',label,message,status,permission:state.permission,lastPushAt:last,intervalMinutes:on&&!registered?interval:0,pushAvailable:state.pushAvailable===true};
  }
  function pushHelp(){
    if(native())return deliveryState().message;
    if(!user())return 'Войдите в профиль, чтобы получать сообщения чата и ответы коллег.';
    if(permission()==='denied')return 'Уведомления запрещены. Разрешите их для приложения в настройках телефона или браузера, затем повторите.';
    if(!('Notification' in window)||!('PushManager' in window))return 'На iPhone добавьте атлас на экран «Домой» через Safari и откройте его с появившегося значка. Затем разрешите уведомления здесь.';
    return enabled()?'Сообщения чата и ответы по объектам будут появляться на экране телефона.':'Разрешите уведомления о сообщениях чата и ответах по объектам, когда приложение закрыто.';
  }
  function pushMarkup(){
    const state=deliveryState(),retry=state.native&&state.enabled&&!state.registered&&state.status!=='not_configured'&&typeof window.SdngGps?.retryPushRegistration==='function';
    return `<article class="community-card" data-notification-delivery="${html(state.mode)}" data-push-status="${html(state.status||'browser')}"><div class="community-notification-controls"><button type="button" class="btn ${enabled()?'':'primary'}" data-enable-notifications ${pushBusy||!user()||!online()?'disabled':''}>${pushBusy?'Настраиваем…':enabled()?'Выключить уведомления':'Разрешить уведомления'}</button><span class="status-chip" data-notification-device-status>${html(state.label)}</span>${retry?`<button type="button" class="btn" data-retry-native-push ${pushBusy||!online()||state.status==='pending'?'disabled':''}>Повторить подключение</button>`:''}</div><p class="community-notification-state" role="status" data-notification-delivery-state>${html(pushMessage||pushHelp())}</p>${state.validated?`<p class="community-notification-state" data-push-delivery-confirmed>Доставка подтверждена${state.lastPushAt?' · '+html(format(state.lastPushAt)):''}.</p>`:''}</article>`;
  }
  async function retryNativePush(){
    if(!native()||typeof SdngGps.retryPushRegistration!=='function')throw Error('Повторное подключение недоступно. Обновите приложение.');
    if(!user()||!Community.sessionRemembered())throw Error('Для фоновых уведомлений войдите с отметкой «Запомнить меня».');
    if(!online())throw Error('Проверьте подключение к интернету и повторите.');
    if(!enabled())throw Error('Сначала разрешите и включите уведомления.');
    SdngGps.retryPushRegistration();pushMessage='';
  }
  function notificationMarkup(item){
    const sampling=item.type==='sampling-round',chat=item.type==='chat',mention=chat&&item.isMention===true,kind=sampling?'ОТБОР ПРОБ':mention?'ВАС УПОМЯНУЛИ':chat?'ЧАТ БРИГАДЫ':'ПО ОБЪЕКТУ',title=sampling?'Начался новый круг отбора':`${item.actor?.nickname||'Коллега'} ${mention?'упомянул вас':chat?'написал в чат':'ответил'} · ${item.objectLabel||'Объект'}`;
    return `<button type="button" class="community-notification-item notification-${chat?'chat':'work'} ${mention?'notification-mention':''} ${!item.readAt?'unread':''}" data-open-notification="${html(item.id)}"><span class="notification-kind">${kind}</span><strong>${html(title)}</strong><p>${html(item.preview||(sampling?'Откройте отбор проб, чтобы увидеть даты и отметки нового круга.':'Новый ответ на вашу запись'))}</p><time datetime="${html(item.createdAt)}">${html(format(item.createdAt))}</time></button>`;
  }
  function render({cachedAt,error=''}={}){
    const node=host();if(!node||node.dataset.communitySection!=='notifications')return;
    node.innerHTML=`<div class="community-page"><header class="community-section-head"><div><span class="community-kicker">СООБЩЕНИЯ И ОТВЕТЫ</span><h2>Уведомления${count?` <span class="community-unread-badge">${count>99?'99+':count}</span>`:''}</h2></div>${user()?'<button type="button" class="btn" data-notifications-read-all>Прочитать все</button>':''}</header>${pushMarkup()}<nav class="notification-type-tabs" aria-label="Тип уведомлений">${[['all','Все'],['chat','Чат'],['work','Рабочие']].map(([type,label])=>`<button type="button" data-notification-filter="${type}" aria-pressed="${filter===type}">${label}</button>`).join('')}</nav>${cachedAt?`<p class="community-source" style="margin-top:15px">Сохранённая копия · ${html(format(cachedAt))}. Подключитесь к интернету для обновления.</p>`:''}${error?`<p class="community-form-error" role="status">${html(error)}</p>`:''}<section class="community-card community-notification-list" aria-label="Ответы на ваши записи">${!user()?'<p class="community-empty">Войдите, чтобы открыть ваши уведомления.</p><button type="button" class="btn primary" data-notifications-login>Войти в профиль</button>':items.length?items.map(notificationMarkup).join(''):`<p class="community-empty">${loading?'Загружаем уведомления…':error?'Не удалось получить уведомления.':'Новых уведомлений пока нет.'}</p>`}${user()?`<div class="community-notification-controls"><button type="button" class="btn" data-notifications-refresh ${loading?'disabled':''}>Обновить</button>${nextCursor?'<button type="button" class="btn" data-notifications-older>Более ранние</button>':''}</div>`:''}</section></div>`;
    node.querySelector('[data-enable-notifications]')?.addEventListener('click',async()=>{if(pushBusy)return;const generation=authGeneration;pushBusy=true;pushMessage='';render();try{if(enabled())await disable();else await enable();}catch(e){if(generation===authGeneration)pushMessage=e.message;}finally{if(generation===authGeneration){pushBusy=false;render();}}});
    node.querySelector('[data-retry-native-push]')?.addEventListener('click',async()=>{if(pushBusy)return;const generation=authGeneration;pushBusy=true;pushMessage='';render();try{await retryNativePush();}catch(error){if(generation===authGeneration)pushMessage=error.message;}finally{if(generation===authGeneration){pushBusy=false;render();}}});
    node.querySelector('[data-notifications-login]')?.addEventListener('click',()=>Community.auth());
    node.querySelector('[data-notifications-refresh]')?.addEventListener('click',()=>load());
    node.querySelector('[data-notifications-older]')?.addEventListener('click',()=>load(true));
    node.querySelectorAll('[data-notification-filter]').forEach(button=>button.onclick=()=>selectFilter(button.dataset.notificationFilter));
    node.querySelector('[data-notifications-read-all]')?.addEventListener('click',async event=>{const scope=filter,generation=authGeneration;event.currentTarget.disabled=true;try{await api('/notifications/read-all'+(scope==='all'?'':'?type='+scope),{method:'POST'});if(generation!==authGeneration)return;if(scope===filter){const now=new Date().toISOString();items=items.map(item=>({...item,readAt:item.readAt||now}));saveFeed();render();}await unread();}catch(e){if(generation===authGeneration&&scope===filter)render({error:e.message});}});
    node.querySelectorAll('[data-open-notification]').forEach(button=>button.onclick=()=>openNotification(button.dataset.openNotification));
  }
  function selectFilter(next){if(!['all','chat','work'].includes(next)||filter===next)return;filter=next;feedGeneration++;loading=false;items=[];nextCursor=null;render();if(user())return load();}
  async function unread(){if(!user()||!online())return;const generation=authGeneration,request=++countRequest;try{const result=await api('/notifications/unread-count');if(generation===authGeneration&&request===countRequest)setCount(result.count);}catch{}}
  async function load(older=false){
    if(loading||!user())return;const generation=authGeneration,scope=filter,request=++feedGeneration;loading=true;if(!items.length)render();
    const current=()=>generation===authGeneration&&scope===filter&&request===feedGeneration;
    try{
      const result=await api('/notifications?limit=40'+(scope==='all'?'':'&type='+scope)+(older&&nextCursor?'&before='+encodeURIComponent(nextCursor):''));
      if(!current())return;const previous=JSON.stringify(items),map=new Map((older?items:[]).map(item=>[String(item.id),item]));for(const item of result.items||[])map.set(String(item.id),item);
      items=[...map.values()].sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)||Number(b.cursor)-Number(a.cursor));nextCursor=result.nextCursor||null;loading=false;saveFeed();
      if(previous!==JSON.stringify(items)||!items.length||!host()?.querySelector('[data-open-notification]')&&items.length)render();await unread();
    }catch(error){if(!current()||error.code==='stale_session')return;loading=false;const saved=sourceCopy();if(saved){items=saved.items||[];nextCursor=saved.nextCursor;render({cachedAt:saved.at,error:error.message});}else render({error:error.message});}
    finally{if(current()){loading=false;host()?.querySelector('[data-notifications-refresh]')?.removeAttribute('disabled');}}
  }
  function decodeKey(value){const normal=String(value).replace(/-/g,'+').replace(/_/g,'/');const binary=atob(normal);return Uint8Array.from(binary,c=>c.charCodeAt(0));}
  async function requestNativePermission(){
    const current=nativeState();if(current.permission==='granted')return current;
    if(current.permission==='denied')throw Error('Уведомления запрещены. Разрешите их для приложения в настройках телефона.');
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{window.removeEventListener('atlas-native-notification-state',changed);reject(Error('Проверьте разрешение уведомлений в настройках телефона.'));},90000);function changed(event){let state;try{state=typeof event.detail==='string'?JSON.parse(event.detail):event.detail;}catch{return;}if(!['granted','denied'].includes(state?.permission))return;clearTimeout(timer);window.removeEventListener('atlas-native-notification-state',changed);resolve(state);}window.addEventListener('atlas-native-notification-state',changed);try{SdngGps.requestNotificationPermission();}catch(e){clearTimeout(timer);window.removeEventListener('atlas-native-notification-state',changed);reject(e);}});
  }
  async function waitNative(expected){for(let attempt=0;attempt<20;attempt++){if(Boolean(nativeState().enabled)===expected)return;await new Promise(resolve=>setTimeout(resolve,100));}throw Error('Не удалось подтвердить изменение уведомлений. Проверьте разрешение и повторите.');}
  async function requestPermission(){
    const state=native()?await requestNativePermission():{permission:'Notification' in window?await Notification.requestPermission():'unsupported'};
    if(state.permission!=='granted')throw Error(state.permission==='denied'?'Уведомления запрещены. Разрешите их в настройках телефона или браузера.':'Добавьте атлас на экран «Домой» и разрешите уведомления с его значка.');
    return state;
  }
  async function enable(){
    const generation=authGeneration;const check=()=>{if(generation!==authGeneration)throw Error('Вход изменился. Повторите включение уведомлений.');};
    if(!user())throw Error('Сначала войдите в профиль.');
    if(!online())throw Error('Для включения уведомлений нужно подключение к интернету.');
    if(native()){
      if(!Community.sessionRemembered())throw Error('Для фоновых уведомлений войдите с отметкой «Запомнить меня».');
      const state=await requestNativePermission();check();if(state.permission!=='granted')throw Error('Уведомления не разрешены. Разрешите их в настройках телефона.');
      Community.configureNativeNotifications(true);await waitNative(true);check();saveSetting({enabled:true});pushMessage='';return;
    }
    if(!('Notification' in window)||!('PushManager' in window)||!navigator.serviceWorker)throw Error('Добавьте атлас на экран «Домой», откройте с его значка и разрешите уведомления здесь.');
    const allowed=await Notification.requestPermission();check();if(allowed!=='granted')throw Error(allowed==='denied'?'Уведомления запрещены. Разрешите их для приложения в настройках телефона или браузера.':'Разрешение не получено. Уведомления можно включить позже.');
    const [registration,result]=await Promise.all([Promise.race([navigator.serviceWorker.ready,new Promise((_,reject)=>setTimeout(()=>reject(Error('Откройте атлас с интернетом и повторите включение уведомлений.')),15000))]),api('/push/public-key')]);
    check();if(!result.publicKey)throw Error('Фоновая доставка пока не подключена. Все ответы доступны в этом разделе.');
    let subscription=await registration.pushManager.getSubscription();if(!subscription)subscription=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:decodeKey(result.publicKey)});
    check();await api('/push/subscriptions',{method:'POST',body:subscription.toJSON()});check();browserEndpoint=subscription.endpoint;browserSubscriptionActive=true;saveSetting({enabled:true});await sendBrowserVisibility(true);check();pushMessage='Уведомления включены на этом устройстве.';
  }
  async function disable(){
    const generation=authGeneration,owner=user()?.id||null,current=()=>generation===authGeneration&&owner===(user()?.id||null);
    if(native()){Community.configureNativeNotifications(false);await waitNative(false);if(current()){saveSetting({enabled:false});pushMessage='Уведомления на этом устройстве выключены.';}return;}
    try{await unsubscribe(true);}finally{if(current()){saveSetting({enabled:false});pushMessage='Уведомления на этом устройстве выключены.';}}
  }
  async function unsubscribe(server=false){
    if(native())return;const generation=authGeneration,owner=user()?.id||null,current=()=>generation===authGeneration&&owner===(user()?.id||null),safeLocal=()=>current()||!user();let subscription,registration;
    try{
      registration=await navigator.serviceWorker?.getRegistration();if(!safeLocal())return;subscription=await registration?.pushManager?.getSubscription();if(!safeLocal())return;
      if(subscription&&server&&user()&&current()){browserEndpoint=subscription.endpoint;await sendBrowserVisibility(false);if(!current())return;await api('/push/subscriptions',{method:'DELETE',body:{endpoint:subscription.endpoint}});}
    }finally{
      if(safeLocal()){try{if(subscription)await subscription.unsubscribe();}finally{if(safeLocal()){browserSubscriptionActive=false;browserEndpoint='';try{const shown=await registration?.getNotifications?.();if(safeLocal())for(const notification of shown||[])notification.close();}catch{}}}}
    }
  }
  async function prepareLogout(){saveSetting({enabled:false});try{Community.configureNativeNotifications(false);}catch{}try{await unsubscribe(true);}catch{}}
  async function openNotification(id){
    id=String(id||'');if(!id||id.length>200||openingIds.has(id))return;const generation=authGeneration;openingIds.add(id);
    try{let item=items.find(value=>String(value.id)===String(id))||sourceCopy()?.items?.find(value=>String(value.id)===String(id));if(!item){const response=await api('/notifications/'+encodeURIComponent(id));item=response.item||response;}
      if(generation!==authGeneration)return;if(item.type!=='sampling-round'&&(!item.objectKey||!item.noteId))throw Error('Запись уведомления пока недоступна.');
      if(!item.readAt&&online()){try{await api('/notifications/'+encodeURIComponent(item.id)+'/read',{method:'POST'});if(generation!==authGeneration)return;item.readAt=new Date().toISOString();setCount(count-1);saveFeed();}catch(error){if(error.status===401||error.status===403||error.code==='stale_session')throw error;}}
      if(generation!==authGeneration)return;if(pendingNotification===id){pendingNotification=null;const url=new URL(location.href);url.searchParams.delete('notification');history.replaceState(history.state,'',url);}
      opened=false;if(item.type==='sampling-round'){if(window.WorkShell?.openView)WorkShell.openView('samples');else window.dispatchEvent(new CustomEvent('atlas-open-sampling',{detail:{periodKey:item.periodKey||item.period?.key}}));}else if(item.type==='chat'||item.objectKey==='chat'){window.WorkShell?.openView('chat');await Community.focusChatMessage?.(item.noteId);}else window.dispatchEvent(new CustomEvent('atlas-open-object',{detail:{key:item.objectKey,label:item.objectLabel,noteId:item.noteId,parentId:item.parentId,notificationId:item.id}}));
    }catch(error){if(generation!==authGeneration||error.code==='stale_session')return;if(error.status===404&&pendingNotification===id){pendingNotification=null;const url=new URL(location.href);url.searchParams.delete('notification');history.replaceState(history.state,'',url);}pushMessage=error.message;if(visible())render({error:error.message});else if(typeof toast==='function')toast(error.message);}
    finally{openingIds.delete(id);}
  }
  function openView(){opened=true;if(host())host().dataset.communitySection='notifications';render();if(user())load();return host()?.innerHTML||'';}
  window.AtlasNotifications=Object.freeze({openView,openNotification,enable,disable,prepareLogout,requestPermission,isEnabled:enabled,getDeliveryState:deliveryState,retryPushRegistration:retryNativePush,refresh:unread,getCount:()=>count});
  window.Notifications=window.AtlasNotifications;
  window.addEventListener('atlas-auth-change',()=>{authGeneration++;browserEndpoint='';browserSubscriptionActive=false;feedGeneration++;filter='all';items=[];nextCursor=null;loading=false;pushBusy=false;pushMessage='';setCount(0);if(visible())render();if(!user())return;if(native()&&setting().enabled&&Community.sessionRemembered()){try{Community.configureNativeNotifications(true);}catch{}}if(!native())restoreBrowserSubscription();unread();if(pendingNotification)openNotification(pendingNotification);if(visible())load();});
  window.addEventListener('atlas-native-notification-state',()=>{pushMessage='';if(visible())render();});
  window.addEventListener('atlas-session-ended',()=>{saveSetting({enabled:false});unsubscribe(false).catch(()=>{});});
  window.addEventListener('atlas-notification-open',event=>{if(event.detail?.id)openNotification(event.detail.id);});
  navigator.serviceWorker?.addEventListener?.('message',event=>{if(event.data?.type==='ATLAS_NOTIFICATION_OPEN'&&typeof event.data.id==='string')openNotification(event.data.id);});
  window.addEventListener('online',()=>{if(browserEndpoint)sendBrowserVisibility(true);else restoreBrowserSubscription();unread();if(visible())load();});
  document.addEventListener('visibilitychange',()=>{sendBrowserVisibility(document.visibilityState==='visible');if(document.visibilityState==='visible')unread();});
  window.addEventListener('pagehide',()=>{browserPageActive=false;sendBrowserVisibility(false);});
  window.addEventListener('pageshow',()=>{browserPageActive=true;if(browserEndpoint)sendBrowserVisibility(true);else restoreBrowserSubscription();});
  setInterval(()=>{if(!native()&&browserPageActive&&document.visibilityState==='visible'&&enabled())sendBrowserVisibility(true);},8000);
  setInterval(()=>{if(document.visibilityState==='visible'){unread();if(visible())load();}},3000);
  if(user()){unread();if(pendingNotification)setTimeout(()=>openNotification(pendingNotification),250);if(!native())restoreBrowserSubscription();}
  else{unsubscribe(false).catch(()=>{});try{Community.configureNativeNotifications(false);}catch{}}
})();
