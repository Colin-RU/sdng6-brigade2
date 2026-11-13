'use strict';
(() => {
  const PREFIX='atlas.community.v1.';
  const SESSION=PREFIX+'session';
  const LIMIT=30;
  const STATUS={unknown:'Не указан',ok:'Работает',attention:'Нужно внимание',stopped:'Остановлен',absent:'Отсутствует'};
  const statusesFor=key=>Object.entries(STATUS).filter(([status])=>status!=='absent'||String(key).startsWith('equipment:'));
  const hosts=new Map(),photoPromises=new Map(),viewShells=new Map(),profileStates=new Map(),composerStates=new Set();
  let session=null,view=null,authMode='login',authNotice='',profilePending=false,expiryTimer,sessionEpoch=0,authPending=0,apiWrites=0;
  let chat={items:[],before:null,hasOlder:false,pending:false,loading:false,error:'',cacheAt:null,cached:false,unread:0};
  const html=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const uuid=()=>crypto.randomUUID?crypto.randomUUID():`${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  const online=()=>navigator.onLine!==false;
  const time=value=>{const date=new Date(value);return Number.isFinite(date.getTime())?date.toLocaleString('ru-RU',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}):'Время не указано';};
  const recordedTime=value=>{const date=new Date(value);return Number.isFinite(date.getTime())?date.toLocaleString('ru-RU',{timeZone:'Asia/Yekaterinburg',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}):'Время не указано';};
  const visible=node=>Boolean(node?.isConnected&&document.visibilityState==='visible'&&node.getClientRects().length);
  const expiry=value=>typeof value==='number'?(value<1e12?value*1000:value):Date.parse(value);
  const authenticated=()=>Boolean(session?.token&&session.user&&expiry(session.expiresAt)>Date.now());
  const getUser=()=>authenticated()?session.user:null;
  const own=id=>String(getUser()?.id)===String(id);
  const storage={get(key,area=localStorage){try{return JSON.parse(area.getItem(key)||'null');}catch{return null;}},set(key,value,area=localStorage){try{area.setItem(key,JSON.stringify(value));return true;}catch{return false;}},remove(key,area=localStorage){try{area.removeItem(key);}catch{}}};
  function restore(){
    session=storage.get(SESSION,sessionStorage)||storage.get(SESSION);
    if(session&&(!session.token||!session.user||!Number.isFinite(expiry(session.expiresAt))||expiry(session.expiresAt)<=Date.now()))clearSession('Время входа истекло. Войдите ещё раз.');
  }
  function notify(message){if(typeof toast==='function')toast(message);else document.dispatchEvent(new CustomEvent('atlas-community-notice',{detail:{message}}));}
  function authChanged(){window.dispatchEvent(new CustomEvent('atlas-auth-change',{detail:{user:getUser()}}));}
  function saveSession(result,remember){
    if(!result?.token||!result?.user||!result.expiresAt)throw new Error('Не удалось завершить вход. Повторите попытку.');
    if(session?.token!==result.token||String(session?.user?.id)!==String(result.user.id))sessionEpoch++;
    session={token:result.token,user:result.user,expiresAt:result.expiresAt,remember:Boolean(remember)};
    storage.remove(SESSION);storage.remove(SESSION,sessionStorage);
    if(!storage.set(SESSION,session,remember?localStorage:sessionStorage)){storage.set(SESSION,session,sessionStorage);notify('Вход сохранён только в текущем сеансе.');}
    authNotice='';scheduleExpiry();authChanged();
  }
  function clearSession(message=''){
    sessionEpoch++;
    clearTimeout(expiryTimer);
    window.dispatchEvent(new Event('atlas-session-ended'));
    try{window.SdngGps?.configureNotifications?.('','',false);}catch{}
    session=null;storage.remove(SESSION);storage.remove(SESSION,sessionStorage);authNotice=message;
    for(const promise of photoPromises.values())promise.then(url=>URL.revokeObjectURL(url)).catch(()=>{});
    photoPromises.clear();disposeDraftViews();chat={items:[],before:null,hasOlder:false,pending:false,loading:false,error:'',cacheAt:null,cached:false,unread:0};authChanged();
  }
  function scheduleExpiry(){clearTimeout(expiryTimer);if(!session)return;const delay=expiry(session.expiresAt)-Date.now();if(delay<=0){clearSession('Время входа истекло. Войдите ещё раз.');refreshVisible();return;}expiryTimer=setTimeout(scheduleExpiry,Math.min(delay,2147480000));}
  class ApiError extends Error{constructor(message,status=0,code='network',details=null){super(message);this.status=status;this.code=code;this.details=details;}}
  async function api(path='',options={}){
    const base=String(window.ATLAS_API_BASE||'/api/v1').replace(/\/$/,'');
    if(!/^\//.test(path))path='/'+path;
    const method=options.method||'GET';
    if(!online())throw new ApiError('Нет связи. Общие данные можно изменить после подключения.','0','offline');
    const auth=options.auth!==false;
    if(auth&&!authenticated())throw new ApiError('Войдите в профиль, чтобы открыть общие данные.',401,'login_required');
    const requestEpoch=sessionEpoch,requestToken=auth?session.token:null;
    const assertSession=()=>{if(auth&&(sessionEpoch!==requestEpoch||session?.token!==requestToken))throw new ApiError('Вход изменился. Обновите открытый раздел.',0,'stale_session');};
    const headers=new Headers(options.headers||{});
    if(auth)headers.set('Authorization','Bearer '+session.token);
    headers.set('Accept',options.response==='blob'?'image/*':'application/json');
    let body=options.body;
    if(body!=null&&!(body instanceof FormData)&&!(body instanceof Blob)&&typeof body!=='string'){headers.set('Content-Type','application/json');body=JSON.stringify(body);}
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),options.timeout||18000);
    const onAbort=()=>controller.abort();options.signal?.addEventListener('abort',onAbort,{once:true});
    const isWrite=!['GET','HEAD','OPTIONS'].includes(method.toUpperCase());if(isWrite)apiWrites++;
    try{
      const response=await fetch(base+path,{method,headers,body,signal:controller.signal,cache:'no-store',credentials:'omit'});
      assertSession();
      if(response.status===204)return null;
      if(!response.ok){
        let result;try{result=await response.json();}catch{}
        assertSession();
        if(response.status===401&&auth){clearSession('Время входа истекло. Войдите ещё раз.');refreshVisible();}
        const fallback=({400:'Проверьте заполненные поля.',401:'Неверный логин или пароль.',403:'Это действие недоступно.',404:'Запись не найдена.',409:'Данные уже изменились. Обновите их и повторите.',413:'Фото слишком большое.',429:'Слишком много попыток. Подождите немного.'})[response.status]||'Не удалось сохранить данные. Повторите позже.';
        throw new ApiError(String(result?.error?.message||fallback).slice(0,300),response.status,result?.error?.code||'request_failed',result?.error?.details||null);
      }
      if(options.response==='blob'){const value=await response.blob();assertSession();return value;}
      const value=await response.json();assertSession();return value;
    }catch(error){
      if(error instanceof ApiError)throw error;
      assertSession();
      throw new ApiError(error.name==='AbortError'?'Сервер не ответил вовремя. Черновик сохранён, можно повторить.':'Нет соединения с общими данными. Проверьте связь и повторите.');
    }finally{if(isWrite)apiWrites--;clearTimeout(timeout);options.signal?.removeEventListener('abort',onAbort);}
  }
  const userKey=()=>String(session?.user?.id||'guest');
  const cacheKey=path=>PREFIX+'cache.'+userKey()+'.'+path;
  function cached(path){return storage.get(cacheKey(path));}
  async function read(path){
    const key=cacheKey(path),epoch=sessionEpoch;
    try{const data=await api(path);if(epoch!==sessionEpoch)throw new ApiError('Вход изменился.',0,'stale_session');const result={data,at:new Date().toISOString(),cached:false};storage.set(key,result);return result;}
    catch(error){if(epoch!==sessionEpoch||error.code==='stale_session')throw error;const copy=storage.get(key);if(copy&&error.status!==401&&error.status!==403)return {...copy,cached:true,error:error.message};throw error;}
  }
  const draftKey=scope=>PREFIX+'draft.'+userKey()+'.'+scope;
  const getDraft=scope=>storage.get(draftKey(scope))||{body:'',clientId:uuid()};
  const saveDraft=(scope,body,clientId,parentId,attempt)=>storage.set(draftKey(scope),{body,clientId,parentId:parentId||null,attempt:attempt===undefined?storage.get(draftKey(scope))?.attempt||null:attempt,at:new Date().toISOString()});
  const clearDraft=scope=>storage.remove(draftKey(scope));
  function sourceNotice(result){return result?.cached?`<p class="community-source" role="status">Сохранённая копия · ${html(time(result.at))}. ${online()?'Не удалось обновить.':'Сейчас нет связи.'} Сохранённые сведения доступны для чтения.</p>`:'';}
  const loginGate=()=>`<div class="community-login-gate"><p>Войдите, чтобы видеть общие записи и фотографии бригады.</p><button type="button" class="btn primary" data-community-login>Войти в профиль</button></div>`;
  const positionLabel=user=>user?.position==='master'?'Мастер':`Оператор${user?.grade?' · '+user.grade+' разряд':''}`;
  const initials=name=>String(name||'?').trim().split(/\s+/).slice(0,2).map(x=>x[0]).join('').toLocaleUpperCase('ru-RU');
  const avatar=(user,size='')=>`<span class="community-avatar ${size}" aria-hidden="true"><span>${html(initials(user?.nickname))}</span>${user?.avatarMediaId?`<img data-private-media="${html(user.avatarMediaId)}" alt="" hidden>`:''}</span>`;
  const author=user=>`<span class="community-author">${avatar(user)}<span><b>${html(user?.nickname||'Участник')}</b><small>${html(positionLabel(user))}</small></span></span>`;
  function openDialog(title,body){
    if(typeof showModal==='function'){showModal(title,body);return document.querySelector('#modal-content');}
    let dialog=document.querySelector('#community-dialog');
    if(!dialog){dialog=document.createElement('dialog');dialog.id='community-dialog';document.body.append(dialog);}
    dialog.innerHTML=`<div class="community-dialog-title"><h2>${html(title)}</h2><button type="button" class="icon-btn" aria-label="Закрыть">×</button></div>${body}`;
    dialog.querySelector('.icon-btn').onclick=()=>dialog.close();dialog.showModal();return dialog;
  }
  function closeDialog(node){node.closest('dialog')?.close();}
  function imageDatabase(){return new Promise((resolve,reject)=>{if(!window.indexedDB)return reject(Error('No storage'));const request=indexedDB.open('atlas-community-private-v1',1);request.onupgradeneeded=()=>request.result.createObjectStore('photos');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});}
  async function storedPhoto(key,value){
    let db;try{db=await imageDatabase();return await new Promise((resolve,reject)=>{const transaction=db.transaction('photos',value?'readwrite':'readonly');const request=value?transaction.objectStore('photos').put(value,key):transaction.objectStore('photos').get(key);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});}catch{return null;}finally{db?.close();}
  }
  async function privatePhoto(id){
    const owner=userKey(),epoch=sessionEpoch,key=owner+':'+id;
    const assertOwner=()=>{if(epoch!==sessionEpoch||owner!==userKey())throw new ApiError('Вход изменился.',0,'stale_session');};
    if(photoPromises.has(key))return photoPromises.get(key);
    const promise=(async()=>{
      let blob;
      try{blob=await api('/media/'+encodeURIComponent(id),{response:'blob'});if(!blob.type.startsWith('image/'))throw Error('Not image');storedPhoto(key,{blob,at:Date.now()});}
      catch(error){if(error.code==='stale_session')throw error;assertOwner();const copy=await storedPhoto(key);assertOwner();if(copy?.blob&&error.status!==401&&error.status!==403)blob=copy.blob;else throw error;}
      assertOwner();
      return URL.createObjectURL(blob);
    })();
    photoPromises.set(key,promise);promise.catch(()=>photoPromises.delete(key));return promise;
  }
  function hydrateMedia(node){
    node.querySelectorAll('img[data-private-media]').forEach(image=>{
      const id=image.dataset.privateMedia;image.removeAttribute('data-private-media');
      privatePhoto(id).then(url=>{if(image.isConnected){image.src=url;image.hidden=false;image.closest('.community-photo')?.classList.add('loaded');}}).catch(()=>{if(image.isConnected){image.closest('.community-photo')?.classList.add('unavailable');image.alt='Фото недоступно без связи';}});
    });
  }

  function bytesOf(blob){if(blob.arrayBuffer)return blob.arrayBuffer();return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(Error('Не удалось прочитать фото. Выберите его ещё раз.'));reader.readAsArrayBuffer(blob);});}
  function photoMime(bytes){
    const text=String.fromCharCode(...bytes);
    if(bytes[0]===255&&bytes[1]===216)return 'image/jpeg';
    if(bytes[0]===137&&text.slice(1,4)==='PNG')return 'image/png';
    if(text.startsWith('GIF8'))return 'image/gif';
    if(text.startsWith('RIFF')&&text.slice(8,12)==='WEBP')return 'image/webp';
    if(text.startsWith('BM'))return 'image/bmp';
    if(text.slice(4,8)==='ftyp'){if(/avif|avis/.test(text.slice(8)))return 'image/avif';if(/heic|heix|hevc|hevx|mif1|msf1/.test(text.slice(8)))return 'image/heic';}
    return '';
  }
  async function decodePhoto(file){
    if(!file||file.size>40*1024*1024)throw Error('Выберите фото размером до 40 МБ.');
    let mime='';try{mime=photoMime(new Uint8Array(await bytesOf(file.slice(0,80))));}catch{}
    const image=new Image(),source=URL.createObjectURL(mime?new Blob([file],{type:mime}):file);
    try{
      await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Фото не открылось. Выберите его ещё раз или используйте JPEG/PNG.')),20000);image.onload=()=>{clearTimeout(timer);resolve();};image.onerror=()=>{clearTimeout(timer);reject(Error('Не удалось открыть фото. Выберите JPEG или PNG либо сохраните снимок в этом формате.'));};image.src=source;});
      if(!image.naturalWidth||!image.naturalHeight)throw Error('Фото оказалось пустым. Выберите другой снимок.');
      return {image,url:source,dispose:()=>URL.revokeObjectURL(source)};
    }catch(error){URL.revokeObjectURL(source);throw error;}
  }
  async function jpegCanvas(canvas){for(const quality of [.9,.78,.62,.45]){const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',quality));if(blob&&blob.size<=2*1024*1024)return blob;}throw Error('Фото слишком большое. Выберите снимок меньшего размера.');}
  async function compressPhoto(file,avatarMode=false){
    const decoded=await decodePhoto(file);
    try{const image=decoded.image,max=avatarMode?640:1600,scale=Math.min(1,max/Math.max(image.naturalWidth,image.naturalHeight)),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(image.naturalWidth*scale));canvas.height=Math.max(1,Math.round(image.naturalHeight*scale));const context=canvas.getContext('2d');context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(image,0,0,canvas.width,canvas.height);return await jpegCanvas(canvas);}finally{decoded.dispose();}
  }
  async function uploadBlob(blob,clientId){const form=new FormData();form.append('file',blob,'photo.jpg');form.append('clientId',clientId);const result=await api('/media',{method:'POST',body:form,timeout:45000});const media=result?.media||result;if(!media?.id)throw Error('Не удалось загрузить фото. Повторите попытку.');return media;}
  async function uploadPhoto(file,avatarMode=false,clientId=uuid()){return uploadBlob(await compressPhoto(file,avatarMode),clientId);}
  function photos(items=[]){return items.length?`<div class="community-photos">${items.map(media=>`<button type="button" class="community-photo" data-community-photo="${html(media.id)}" aria-label="Открыть фотографию"><span>Фото</span><img data-private-media="${html(media.id)}" alt="Фото к записи" hidden><span class="community-photo-error">Недоступно без связи</span></button>`).join('')}</div>`:'';}
  function bindPhotos(node){node.querySelectorAll('[data-community-photo]').forEach(button=>{button.onclick=async()=>{try{const url=await privatePhoto(button.dataset.communityPhoto);openDialog('Фотография',`<img class="community-photo-full" src="${html(url)}" alt="Фото к записи">`);}catch(error){notify(error.message);}};});hydrateMedia(node);}
  function navigate(next){if(typeof setView==='function')setView(next);else window.dispatchEvent(new CustomEvent('atlas-community-navigate',{detail:{view:next}}));}

  function authForm(mode='login'){
    const register=mode==='register';
    return `<form class="community-auth-form" data-community-auth="${mode}"><div class="community-auth-tabs" aria-label="Вход и регистрация"><button type="button" data-auth-mode="login" class="${!register?'active':''}" aria-pressed="${!register}">Войти</button><button type="button" data-auth-mode="register" class="${register?'active':''}" aria-pressed="${register}">Создать профиль</button></div><p class="community-copy">${register?'Представьтесь коллегам и выберите данные для входа.':'Войдите в общий чат и записи бригады.'}</p><label class="community-field">Логин<input name="login" autocomplete="username" inputmode="text" autocapitalize="none" spellcheck="false" required minlength="3" maxlength="40"></label>${register?'<label class="community-field">Имя для коллег<input name="nickname" autocomplete="nickname" required minlength="2" maxlength="40"></label>':''}<label class="community-field">Пароль<input name="password" type="password" autocomplete="${register?'new-password':'current-password'}" required minlength="4" maxlength="128"></label>${register?'<label class="community-field">Должность<select name="position"><option value="operator">Оператор</option><option value="master">Мастер</option></select></label><label class="community-field" data-grade-field>Разряд<select name="grade" required><option value="">Выберите разряд</option><option value="3">3 разряд</option><option value="4">4 разряд</option><option value="5">5 разряд</option><option value="6">6 разряд</option></select></label>':''}<label class="community-check"><input type="checkbox" name="remember" checked><span>Запомнить меня</span></label><p class="community-form-error" role="alert" data-auth-error>${html(authNotice)}</p><button class="btn primary community-submit" type="submit">${register?'Создать профиль':'Войти'}</button></form>`;
  }
  function bindAuth(node,onSuccess){
    const form=node.querySelector('[data-community-auth]');if(!form)return;
    form.querySelectorAll('[data-auth-mode]').forEach(button=>button.onclick=()=>{authMode=button.dataset.authMode;node.innerHTML=authForm(authMode);bindAuth(node,onSuccess);});
    const position=form.elements.position,grade=form.elements.grade;
    if(position)position.onchange=()=>{const hidden=position.value==='master';form.querySelector('[data-grade-field]').hidden=hidden;grade.disabled=hidden;grade.required=!hidden;if(hidden)grade.value='';};
    form.onsubmit=async event=>{
      event.preventDefault();if(!form.reportValidity())return;
      const button=form.querySelector('[type="submit"]'),error=form.querySelector('[data-auth-error]');
      const register=form.dataset.communityAuth==='register';
      const authEpoch=sessionEpoch;
      const values={login:form.elements.login.value.trim(),password:form.elements.password.value,remember:form.elements.remember.checked};
      if(register){values.nickname=form.elements.nickname.value.trim();values.position=position.value;values.grade=position.value==='master'?null:Number(grade.value);}
      authPending++;button.disabled=true;button.textContent=register?'Создаём профиль…':'Входим…';error.textContent='';
      try{const result=await api(register?'/auth/register':'/auth/login',{method:'POST',body:values,auth:false});if(authEpoch!==sessionEpoch)throw new ApiError('Вход уже изменился. Обновите профиль.',0,'stale_session');saveSession(result,values.remember);form.dataset.authCompleted='true';form.elements.password.value='';await onSuccess?.();refreshVisible();}
      catch(e){error.textContent=e.message;}
      finally{authPending--;values.password='';if(button.isConnected){button.disabled=false;button.textContent=register?'Создать профиль':'Войти';}}
    };
  }
  function authModal(){const node=openDialog('Профиль бригады',`<div data-auth-host>${authForm(authMode)}</div>`);bindAuth(node.querySelector('[data-auth-host]'),()=>closeDialog(node));}
  function bindLogin(node){node.querySelectorAll('[data-community-login]').forEach(button=>button.onclick=authModal);}


  function changed(type,detail={}){window.dispatchEvent(new CustomEvent('atlas-community-change',{detail:{type,...detail}}));}
  function elementFrom(markup){const template=document.createElement('template');template.innerHTML=markup.trim();return template.content.firstElementChild;}
  function stableView(host,kind,markup){
    const key=kind+':'+userKey()+':'+sessionEpoch;let node=viewShells.get(key),created=false;
    if(!node){node=elementFrom(markup);node.dataset.communityOwner=userKey();viewShells.set(key,node);created=true;}
    if(host.firstElementChild!==node)host.replaceChildren(node);
    return {node,created};
  }
  function disposeDraftViews(){
    for(const node of viewShells.values())node.querySelectorAll('[data-compose]').forEach(form=>form._communityDispose?.());
    viewShells.clear();for(const state of profileStates.values())state.dispose?.();profileStates.clear();
  }
  function content(node,markup){if(node&&node._communityMarkup!==markup){node.innerHTML=markup;node._communityMarkup=markup;}}
  function scrollParent(node){for(let p=node?.parentElement;p;p=p.parentElement){const style=getComputedStyle(p);if(/auto|scroll/.test(style.overflowY)&&p.scrollHeight>p.clientHeight+2)return p;}return document.scrollingElement;}

  function patchFeed(feed,items,options={}){
    if(!feed)return;const scroller=options.scroller||scrollParent(feed),active=document.activeElement,editing=active?.matches?.('textarea,input,select')&&scroller?.contains(active),nearBottom=scroller?scroller.scrollHeight-scroller.scrollTop-scroller.clientHeight<80:true,top=scroller?.getBoundingClientRect?.().top||0;
    const anchor=editing?active:[...feed.querySelectorAll('[data-message-id]')].find(node=>node.getBoundingClientRect().bottom>top+2),anchorTop=anchor?.getBoundingClientRect().top,oldTop=scroller?.scrollTop||0;
    const old=new Map([...feed.querySelectorAll(':scope > [data-message-id]')].map(node=>[node.dataset.messageId,node])),days=new Map([...feed.querySelectorAll(':scope > [data-feed-day]')].map(node=>[node.dataset.feedDay,node])),plan=[];let lastDay='';
    for(const item of items){
      if(options.chatMode){const date=new Date(item.createdAt),day=Number.isFinite(date.getTime())?date.toLocaleDateString('sv-SE'):'';if(day&&day!==lastDay){let divider=days.get(day);if(!divider){divider=elementFrom(`<div class="community-date-separator" data-feed-day="${html(day)}"><span>${html(date.toLocaleDateString('ru-RU',{day:'numeric',month:'long',year:date.getFullYear()!==new Date().getFullYear()?'numeric':undefined}))}</span></div>`);}plan.push(divider);lastDay=day;}}
      const id=String(item.id),fingerprint=JSON.stringify([item,getUser()?.id,Boolean(options.editable),Boolean(options.chatMode)]);let node=old.get(id);
      if(!node){node=elementFrom(itemMarkup(item,options));node._communityFingerprint=fingerprint;}
      else if(node._communityFingerprint!==fingerprint){const updated=elementFrom(itemMarkup(item,options));node.replaceChildren(...updated.childNodes);node.className=updated.className;node._communityFingerprint=fingerprint;}
      plan.push(node);
    }
    if(!plan.length)plan.push(elementFrom(`<p class="community-empty">${html(options.empty||'Пока нет записей.')}</p>`));
    const keep=new Set(plan);for(const node of [...feed.children])if(!keep.has(node))node.remove();
    let previous=null;for(const node of plan){const expected=previous?previous.nextElementSibling:feed.firstElementChild;if(expected!==node)feed.insertBefore(node,expected||null);previous=node;}
    bindPhotos(feed);
    if(scroller){if(editing&&anchor?.isConnected)scroller.scrollTop+=anchor.getBoundingClientRect().top-anchorTop;else if(options.stickBottom&&nearBottom)scroller.scrollTop=scroller.scrollHeight;else if(anchor?.isConnected)scroller.scrollTop+=anchor.getBoundingClientRect().top-anchorTop;else scroller.scrollTop=oldTop;}
  }
  async function snapshotWindow(path,previous,firstResult){
    const owner=userKey(),epoch=sessionEpoch,oldest=previous[0]?.cursor;
    let result=firstResult||await read(path+'?limit=50'),data=result.data,items=listItems(data),cursor=data.nextCursor,pages=1;
    while(cursor&&oldest&&compareCursor(items[0]?.cursor,oldest)>0&&pages<6){
      const page=await api(path+'?limit=50&before='+encodeURIComponent(cursor));
      if(owner!==userKey()||epoch!==sessionEpoch)throw new ApiError('Вход изменился.',0,'stale_session');
      items=mergeItems(listItems(page),items);cursor=page.nextCursor;pages++;
    }
    // The returned window is authoritative: edits and deletions are reconciled too.
    const boundary=items[0]?.cursor;
    const older=boundary&&cursor?previous.filter(item=>compareCursor(item.cursor,boundary)<0):[];
    return {result,items:mergeItems(older,items),before:cursor||null};
  }


  function profileEditorMarkup(){return `<div class="community-avatar-editor" data-avatar-editor hidden><div class="community-avatar-crop" tabindex="0" role="group" aria-label="Кадр фотографии. Перемещайте фото пальцем или клавишами со стрелками"><canvas width="320" height="320" data-avatar-canvas aria-label="Предпросмотр фото профиля"></canvas><span class="community-avatar-crop-circle" aria-hidden="true"></span></div><p class="community-avatar-instructions">Переместите фото и выберите масштаб</p><label class="community-avatar-zoom">Масштаб <input type="range" min="1" max="4" step="0.01" value="1" data-avatar-zoom aria-label="Масштаб фотографии"><output data-avatar-scale>100%</output></label><div class="community-avatar-editor-actions"><button type="button" class="btn" data-avatar-reset>По центру</button><button type="button" class="btn" data-avatar-cancel>Отменить фото</button></div></div>`;}
  function drawCrop(state,output){
    if(!state.crop)return;const {image}=state.crop.decoded,size=320,scale=Math.max(size/image.naturalWidth,size/image.naturalHeight)*state.crop.zoom,w=image.naturalWidth*scale,h=image.naturalHeight*scale;
    state.crop.x=Math.max(-(w-size)/2,Math.min((w-size)/2,state.crop.x));state.crop.y=Math.max(-(h-size)/2,Math.min((h-size)/2,state.crop.y));
    const canvas=output||state.form.querySelector('[data-avatar-canvas]'),factor=canvas.width/size,context=canvas.getContext('2d');context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(image,((size-w)/2+state.crop.x)*factor,((size-h)/2+state.crop.y)*factor,w*factor,h*factor);
    state.form.querySelector('[data-avatar-zoom]').value=String(state.crop.zoom);state.form.querySelector('[data-avatar-scale]').textContent=Math.round(state.crop.zoom*100)+'%';
  }
  function cropChanged(state){state.avatarRevision++;state.avatarBlob=null;state.avatarMedia=null;state.avatarClientId=uuid();drawCrop(state);state.form.querySelector('[data-avatar-choice]').textContent='Кадр готов · нажмите «Сохранить профиль»';}
  function bindProfile(host,node){
    const form=node.querySelector('[data-profile-form]'),owner=userKey(),epoch=sessionEpoch;
    const state={form,owner,epoch,nameDirty:false,nameRevision:0,avatarRevision:0,avatarClientId:uuid(),avatarMedia:null,avatarBlob:null,crop:null,fileSeq:0,pending:false,decoding:false};
    profileStates.set(owner,state);state.dispose=()=>{state.fileSeq++;state.crop?.decoded.dispose();state.crop=null;};
    const valid=()=>state.owner===userKey()&&state.epoch===sessionEpoch&&profileStates.get(owner)===state;
    const setPending=value=>{state.pending=value;form.dataset.sending=String(value);form.querySelectorAll('[name="avatar"],[data-avatar-editor] button,[data-avatar-zoom]').forEach(control=>control.disabled=value);form.querySelector('[type="submit"]').disabled=value||state.decoding||!online();};
    form.elements.nickname.oninput=()=>{state.nameDirty=true;state.nameRevision++;};
    form.elements.avatar.onchange=async()=>{
      const file=form.elements.avatar.files[0];if(!file||state.pending)return;const sequence=++state.fileSeq;state.decoding=true;form.querySelector('[type="submit"]').disabled=true;form.elements.avatar.value='';form.querySelector('[data-profile-error]').textContent='';form.querySelector('[data-avatar-choice]').textContent='Открываем фото…';
      try{const decoded=await decodePhoto(file);if(!valid()||sequence!==state.fileSeq){decoded.dispose();return;}state.crop?.decoded.dispose();state.crop={decoded,zoom:1,x:0,y:0};form.querySelector('[data-avatar-editor]').hidden=false;cropChanged(state);}catch(error){if(valid()&&sequence===state.fileSeq){form.querySelector('[data-profile-error]').textContent=error.message;form.querySelector('[data-avatar-choice]').textContent=state.crop?'Выбран предыдущий кадр':'Выберите другое фото';}}finally{if(valid()&&sequence===state.fileSeq){state.decoding=false;form.querySelector('[type="submit"]').disabled=state.pending||!online();}}
    };
    form.querySelector('[data-avatar-zoom]').oninput=event=>{if(!state.crop||state.pending)return;state.crop.zoom=Number(event.target.value);cropChanged(state);};
    form.querySelector('[data-avatar-reset]').onclick=()=>{if(!state.crop||state.pending)return;state.crop.zoom=1;state.crop.x=0;state.crop.y=0;cropChanged(state);};
    form.querySelector('[data-avatar-cancel]').onclick=()=>{if(state.pending)return;state.fileSeq++;state.decoding=false;state.crop?.decoded.dispose();state.crop=null;state.avatarMedia=null;state.avatarBlob=null;state.avatarRevision++;form.querySelector('[type="submit"]').disabled=!online();form.querySelector('[data-avatar-editor]').hidden=true;form.querySelector('[data-avatar-choice]').textContent='Фото видно участникам бригады';};
    const crop=form.querySelector('.community-avatar-crop'),pointers=new Map();let drag,pinch;
    crop.onpointerdown=event=>{if(!state.crop||state.pending)return;event.preventDefault();crop.setPointerCapture?.(event.pointerId);pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});drag={x:event.clientX,y:event.clientY,offsetX:state.crop.x,offsetY:state.crop.y};if(pointers.size===2){const [a,b]=[...pointers.values()];pinch={distance:Math.hypot(a.x-b.x,a.y-b.y),zoom:state.crop.zoom};}};
    crop.onpointermove=event=>{if(!pointers.has(event.pointerId)||!state.crop||state.pending)return;event.preventDefault();pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});if(pointers.size>=2&&pinch){const [a,b]=[...pointers.values()];state.crop.zoom=Math.max(1,Math.min(4,pinch.zoom*Math.hypot(a.x-b.x,a.y-b.y)/Math.max(1,pinch.distance)));}else if(drag){const ratio=320/crop.getBoundingClientRect().width;state.crop.x=drag.offsetX+(event.clientX-drag.x)*ratio;state.crop.y=drag.offsetY+(event.clientY-drag.y)*ratio;}cropChanged(state);};
    const release=event=>{pointers.delete(event.pointerId);pinch=null;drag=null;if(pointers.size===1){const value=[...pointers.values()][0];drag={x:value.x,y:value.y,offsetX:state.crop.x,offsetY:state.crop.y};}};crop.onpointerup=release;crop.onpointercancel=release;
    crop.onkeydown=event=>{if(!state.crop||state.pending)return;const move={ArrowLeft:[-5,0],ArrowRight:[5,0],ArrowUp:[0,-5],ArrowDown:[0,5]}[event.key];if(move){event.preventDefault();state.crop.x+=move[0];state.crop.y+=move[1];cropChanged(state);}};
    form.onsubmit=async event=>{
      event.preventDefault();if(!form.reportValidity()||state.pending||state.decoding||!valid())return;
      const submittedName=form.elements.nickname.value.trim(),nameRevision=state.nameRevision,avatarRevision=state.avatarRevision,button=form.querySelector('[type="submit"]'),error=form.querySelector('[data-profile-error]');setPending(true);button.textContent='Сохраняем…';error.textContent='';
      try{const update={nickname:submittedName};if(state.crop){if(!state.avatarBlob){const canvas=document.createElement('canvas');canvas.width=640;canvas.height=640;drawCrop(state,canvas);state.avatarBlob=await jpegCanvas(canvas);}if(!valid())return;if(!state.avatarMedia)state.avatarMedia=await uploadBlob(state.avatarBlob,state.avatarClientId);if(!valid())return;update.avatarMediaId=state.avatarMedia.id;}
        const result=await api('/me',{method:'PATCH',body:update});if(!valid())return;session.user=result.user||result;
        if(state.nameRevision===nameRevision){state.nameDirty=false;form.elements.nickname.value=session.user.nickname;}
        if(state.avatarRevision===avatarRevision){state.crop?.decoded.dispose();state.crop=null;state.avatarMedia=null;state.avatarBlob=null;form.querySelector('[data-avatar-editor]').hidden=true;form.querySelector('[data-avatar-choice]').textContent='Фото профиля сохранено';}
        saveSession(session,session.remember);renderProfile(host);changed('profile',{userId:owner});notify('Профиль сохранён.');
      }catch(errorValue){if(valid())error.textContent=errorValue.message;}finally{if(valid()){setPending(false);button.textContent='Сохранить профиль';}}
    };
    node.querySelector('[data-community-logout]').onclick=async()=>{const start=sessionEpoch;await window.AtlasNotifications?.prepareLogout?.();if(start!==sessionEpoch)return;try{await api('/auth/logout',{method:'POST'});}catch{}if(start!==sessionEpoch)return;clearSession();renderProfile(host);refreshVisible();};
  }
  function renderProfile(host){
    if(view!=='profile')return;const user=getUser();
    if(!user){const shell=stableView(host,'profile-guest',`<div class="community-page"><header class="community-section-head"><div><span class="community-kicker">БРИГАДА №2</span><h2>Ваш профиль</h2></div></header><article class="community-card community-auth-card">${authForm(authMode)}</article><p class="community-source" data-profile-offline hidden>Для входа и создания профиля нужно подключение к интернету.</p></div>`);if(shell.created)bindAuth(shell.node.querySelector('.community-auth-card'));shell.node.querySelector('[data-profile-offline]').hidden=online();const error=shell.node.querySelector('[data-auth-error]');if(authNotice&&error&&!error.textContent)error.textContent=authNotice;return;}
    const shell=stableView(host,'profile',`<div class="community-page"><header class="community-section-head"><div><span class="community-kicker">ВАС ВИДЯТ КОЛЛЕГИ</span><h2>Ваш профиль</h2></div><button type="button" class="btn" data-community-logout>Выйти</button></header><article class="community-card community-profile-card"><div class="community-profile-summary"><div data-profile-avatar></div><div><h3 data-profile-name></h3><p data-profile-position></p><span class="community-login-name" data-profile-login></span></div></div><form data-profile-form data-owner="${html(userKey())}"><label class="community-field">Имя для коллег<input name="nickname" autocomplete="nickname" minlength="2" maxlength="40" required value="${html(user.nickname)}"></label><div class="community-profile-photo-row"><label class="btn community-file-button">Выбрать фото<input type="file" name="avatar" accept="image/*" aria-label="Выбрать фото профиля"></label><span data-avatar-choice>Фото видно участникам бригады</span></div>${profileEditorMarkup()}<p class="community-form-error" role="alert" data-profile-error></p><button class="btn primary" type="submit">Сохранить профиль</button></form><p class="community-source" data-profile-offline hidden>Профиль сохранён на этом устройстве. Изменения будут доступны при подключении.</p></article></div>`);
    const node=shell.node;if(shell.created)bindProfile(host,node);node.querySelector('[data-profile-name]').textContent=user.nickname;node.querySelector('[data-profile-position]').textContent=positionLabel(user);node.querySelector('[data-profile-login]').textContent='Логин: '+user.login;
    content(node.querySelector('[data-profile-avatar]'),avatar(user,'large'));hydrateMedia(node.querySelector('[data-profile-avatar]'));
    const state=profileStates.get(userKey());if(state&&!state.nameDirty&&!state.pending&&state.form.elements.nickname!==document.activeElement)state.form.elements.nickname.value=user.nickname;
    node.querySelector('[data-profile-offline]').hidden=online();if(state&&!state.pending)state.form.querySelector('[type="submit"]').disabled=state.decoding||!online();
  }
  function composeMarkup(scope,label='Написать запись',readOnly=false){
    const draft=getDraft(scope),disabled=!online()||readOnly?'disabled':'';
    if(scope==='chat')return `<form class="community-composer" data-compose="chat" data-owner="${html(userKey())}"><div class="community-reply-target" data-reply-target hidden></div><div class="community-attachment-previews" data-attachment-previews></div><p class="community-attachment-hint" data-chat-attachment-hint hidden>Можно прикрепить до 3 фото</p><div class="community-chat-compose-row"><label class="community-file-button community-chat-attach" title="Прикрепить фотографии"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m8 12 6.7-6.7a3 3 0 0 1 4.3 4.2l-9 9a5 5 0 0 1-7-7l9.3-9.3"/><path d="m6.5 13.5 8-8"/></svg><input type="file" accept="image/*" name="photos" multiple aria-label="Прикрепить до трёх фотографий" ${disabled}></label><label class="community-field community-chat-input"><span class="community-compose-label">Сообщение</span><textarea name="body" rows="1" maxlength="4000" placeholder="Сообщение">${html(draft.body)}</textarea></label><button class="btn primary community-chat-send" type="submit" aria-label="Отправить сообщение" title="Отправить сообщение" ${disabled}><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.5 3.4 3 10.2c-.9.4-.9 1.2.1 1.5l6.2 1.9 1.9 6.2c.3 1 .8 1.1 1.4.3l3.4-4.6 4 3c.7.5 1.3.2 1.5-.6l2.1-13.1c.2-1.1-.3-1.7-1.1-1.4ZM10.8 12.7l7.9-6.1-6.5 7.5-.7 3.5-.7-4.9Z"/></svg><span class="community-compose-label" data-send-label>Отправить</span></button></div><p class="community-draft-hint" data-draft-hint>${draft.body?'Черновик сохранён на этом устройстве.':''}</p><p class="community-form-error" role="alert" data-compose-error></p><button type="button" class="btn" data-compose-new hidden>Начать новую запись</button></form>`;
    return `<form class="community-composer" data-compose="${html(scope)}" data-owner="${html(userKey())}"><label class="community-field"><span class="community-compose-label">${html(label)}</span><textarea name="body" rows="3" maxlength="4000" placeholder="Что важно сообщить коллегам?">${html(draft.body)}</textarea></label><div class="community-reply-target" data-reply-target hidden></div><div class="community-attachment-previews" data-attachment-previews></div><div class="community-composer-actions"><label class="btn community-file-button">+ Фото<input type="file" accept="image/*" name="photos" multiple aria-label="Прикрепить до трёх фотографий" ${disabled}></label><span class="community-attachment-hint">До 3 фото</span><button class="btn primary" type="submit" ${disabled}>Отправить</button></div><p class="community-draft-hint" data-draft-hint>${draft.body?'Черновик сохранён на этом устройстве.':''}</p><p class="community-form-error" role="alert" data-compose-error></p><button type="button" class="btn" data-compose-new hidden>Начать новую запись</button></form>`;
  }
  function composerAvailability(form,readOnly=false){if(!form)return;form.dataset.readonly=String(readOnly);if(form.dataset.sending!=='true'){form.querySelector('[type="submit"]').disabled=!online()||readOnly;form.elements.photos.disabled=!online()||readOnly;}}

  function bindComposer(node,scope,onSend){
    const form=node.querySelector(`[data-compose="${CSS.escape(scope)}"]`);if(!form)return;
    const draft=getDraft(scope),epoch=sessionEpoch;let clientId=draft.clientId||uuid(),files=[],pending=false,attempt=draft.attempt||null,composing=false,disposed=false;
    const sameOwner=()=>!disposed&&epoch===sessionEpoch&&form.dataset.owner===userKey(),error=form.querySelector('[data-compose-error]'),hint=form.querySelector('[data-draft-hint]'),newButton=form.querySelector('[data-compose-new]');
    form._communityState=()=>({busy:pending,hasDraft:sameOwner()&&Boolean(form.elements.body.value.trim()||form.dataset.parentId),hasFiles:!disposed&&files.length>0});composerStates.add(form);
    const fingerprint=()=>JSON.stringify([form.elements.body.value.trim(),form.dataset.parentId||null,files.map(entry=>entry.clientId)]);
    function remember(){if(sameOwner())saveDraft(scope,form.elements.body.value,clientId,form.dataset.parentId,attempt);}
    function checkAttempt(){const changed=Boolean(attempt&&attempt!==fingerprint());newButton.hidden=!changed||pending;if(changed&&!pending){error.textContent='Предыдущая отправка ещё не подтверждена. Начните новую запись, чтобы отправить изменённый текст.';error.dataset.attemptNotice='true';}else if(error.dataset.attemptNotice==='true'){error.textContent='';delete error.dataset.attemptNotice;}return !changed;}
    function resizeInput(){if(scope!=='chat')return;const input=form.elements.body;input.style.height='auto';input.style.height=Math.min(124,Math.max(42,input.scrollHeight))+'px';updateChatViewport();}
    function sendLabel(value){const button=form.querySelector('[type="submit"]');if(scope==='chat'){button.setAttribute('aria-label',value);button.title=value;button.querySelector('[data-send-label]').textContent=value;}else button.textContent=value;}
    function setPending(value){pending=value;form.dataset.sending=String(value);form.setAttribute('aria-busy',String(value));form.elements.photos.disabled=value||!online()||form.dataset.readonly==='true';form.querySelectorAll('button').forEach(button=>button.disabled=value);form.querySelector('[type="submit"]').disabled=value||!online()||form.dataset.readonly==='true';if(node.contains(form))node.querySelectorAll('[data-reply-note]').forEach(button=>button.disabled=value);}
    form._communityDispose=()=>{disposed=true;files.forEach(entry=>URL.revokeObjectURL(entry.url));files=[];if(!pending)composerStates.delete(form);};
    newButton.onclick=()=>{if(pending||!sameOwner())return;clientId=uuid();attempt=null;remember();checkAttempt();error.textContent='';hint.textContent='Новая запись подготовлена. Проверьте текст и нажмите «Отправить».';};
    const cancelReply=()=>{if(pending)return;delete form.dataset.parentId;form.querySelector('[data-reply-target]').hidden=true;remember();checkAttempt();};
    if(draft.parentId){form.dataset.parentId=draft.parentId;const target=form.querySelector('[data-reply-target]');target.hidden=false;target.innerHTML='Ответ на запись <button type="button" data-cancel-reply aria-label="Отменить ответ">×</button>';target.querySelector('button').onclick=cancelReply;}
    form.elements.body.addEventListener('compositionstart',()=>{composing=true;form.dataset.composing='true';});
    form.elements.body.addEventListener('compositionend',()=>{composing=false;delete form.dataset.composing;remember();resizeInput();checkAttempt();});
    form.elements.body.oninput=()=>{remember();hint.textContent='Черновик сохранён на этом устройстве. Ещё не отправлен.';resizeInput();if(!composing)checkAttempt();};
    form.elements.body.addEventListener('focus',updateChatViewport);form.elements.body.addEventListener('blur',()=>setTimeout(updateChatViewport,150));
    form.querySelector('[type="submit"]').addEventListener('pointerdown',event=>{if(document.activeElement===form.elements.body)event.preventDefault();});
    function previews(){const target=form.querySelector('[data-attachment-previews]');const attachmentHint=form.querySelector('[data-chat-attachment-hint]');if(attachmentHint)attachmentHint.hidden=!files.length;target.innerHTML=files.map((entry,index)=>`<span class="community-draft-photo"><img src="${html(entry.url)}" alt="Выбранное фото ${index+1}"><button type="button" data-remove-photo="${index}" aria-label="Убрать фото ${index+1}">×</button></span>`).join('');target.querySelectorAll('[data-remove-photo]').forEach(button=>button.onclick=()=>{if(pending)return;const [removed]=files.splice(Number(button.dataset.removePhoto),1);URL.revokeObjectURL(removed.url);previews();remember();checkAttempt();});if(scope==='chat')updateChatViewport();}
    form.elements.photos.onchange=()=>{if(pending)return;const selected=[...form.elements.photos.files];error.textContent='';if(selected.length+files.length>3){error.textContent='К одной записи можно прикрепить не больше трёх фото.';form.elements.photos.value='';return;}for(const file of selected)files.push({file,url:URL.createObjectURL(file),clientId:uuid()});form.elements.photos.value='';previews();remember();checkAttempt();};
    form.onsubmit=async event=>{
      event.preventDefault();if(pending||composing||!sameOwner())return;if(form.dataset.readonly==='true'){error.textContent='Сначала обновите общие данные. Текст сохранён как черновик.';return;}
      const rawBody=form.elements.body.value,body=rawBody.trim(),parentId=form.dataset.parentId||null,sentFiles=[...files],sentId=clientId;
      if(!body&&!sentFiles.length){error.textContent='Напишите сообщение или прикрепите фото.';return;}
      if(!online()){error.textContent='Нет связи. Текст сохранён как черновик и ещё не отправлен.';remember();return;}
      if(!checkAttempt())return;attempt=fingerprint();remember();setPending(true);const button=form.querySelector('[type="submit"]');error.textContent='';
      try{
        const mediaIds=[];for(let i=0;i<sentFiles.length;i++){const entry=sentFiles[i];sendLabel(`Загружаем фото ${i+1}/${sentFiles.length}…`);if(!entry.mediaId){if(!entry.blob)entry.blob=await compressPhoto(entry.file);if(!sameOwner())return;entry.mediaId=(await uploadBlob(entry.blob,entry.clientId)).id;if(!sameOwner())return;}mediaIds.push(entry.mediaId);}
        if(!sameOwner())return;sendLabel('Отправляем…');await onSend({body,clientId:sentId,mediaIds,...(parentId?{parentId}:{})});if(!sameOwner())return;
        const continued=composing||form.elements.body.value!==rawBody;
        clientId=uuid();attempt=null;for(const entry of sentFiles)URL.revokeObjectURL(entry.url);files=files.filter(entry=>!sentFiles.includes(entry));previews();
        if(!continued){form.elements.body.value='';delete form.dataset.parentId;form.querySelector('[data-reply-target]').hidden=true;clearDraft(scope);hint.textContent='';}
        else{remember();hint.textContent='Отправлено. Новый текст остался в черновике.';}
        resizeInput();checkAttempt();
      }catch(failure){if(sameOwner()){remember();error.textContent=failure.message;hint.textContent='Черновик сохранён. Отправка ещё не подтверждена.';}}
      finally{setPending(false);if(disposed)composerStates.delete(form);checkAttempt();if(button.isConnected)sendLabel(scope==='chat'?'Отправить сообщение':'Отправить');}
    };
    resizeInput();checkAttempt();
  }

  function itemMarkup(item,{editable=false,chatMode=false}={}){
    if(chatMode){const stamp=new Date(item.createdAt),clock=Number.isFinite(stamp.getTime())?stamp.toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'}):'';
      return `<article class="community-message community-chat-message ${own(item.author?.id)?'own':''}" data-message-id="${html(item.id)}"><header>${author(item.author)}</header>${item.body?`<p class="community-message-body">${html(item.body)}</p>`:''}${photos(item.media||[])}<footer class="community-bubble-footer">${item.updatedAt&&item.updatedAt!==item.createdAt?'<small>изменено</small>':''}<time datetime="${html(item.createdAt)}">${html(clock)}</time></footer>${own(item.author?.id)?`<details class="community-message-menu"><summary aria-label="Действия с сообщением" title="Действия с сообщением">⋮</summary><div class="community-message-actions"><button type="button" data-edit-chat="${html(item.id)}">Изменить</button><button type="button" data-delete-chat="${html(item.id)}">Удалить</button></div></details>`:''}</article>`;
    }

    return `<article class="community-message ${own(item.author?.id)?'own':''} ${item.parentId?'reply':''}" data-message-id="${html(item.id)}"><header>${author(item.author)}<span class="community-note-times"><time datetime="${html(item.createdAt)}">Записано ${html(recordedTime(item.createdAt))}</time>${item.updatedAt&&item.updatedAt!==item.createdAt?`<time datetime="${html(item.updatedAt)}">Изменено ${html(recordedTime(item.updatedAt))}</time>`:''}</span></header>${item.parentId?`<button type="button" class="community-parent-link" data-parent-note="${html(item.parentId)}">↳ Ответ на запись</button>`:''}${item.body?`<p class="community-message-body">${html(item.body)}</p>`:''}${photos(item.media||[])}${chatMode&&own(item.author?.id)?`<div class="community-message-tools"><button type="button" data-edit-chat="${html(item.id)}">Изменить</button><button type="button" data-delete-chat="${html(item.id)}">Удалить</button></div>`:editable?`<div class="community-message-tools"><button type="button" data-reply-note="${html(item.id)}">Ответить</button>${own(item.author?.id)?`<button type="button" data-edit-note="${html(item.id)}">Изменить</button><button type="button" data-delete-note="${html(item.id)}">Удалить</button>`:''}</div>`:''}</article>`;
  }
  function compareCursor(left,right){const a=String(left??''),b=String(right??'');return /^\d+$/.test(a)&&/^\d+$/.test(b)?Number(a)-Number(b):a.localeCompare(b);}
  function mergeItems(left,right){const map=new Map(left.map(item=>[String(item.id),item]));right.forEach(item=>map.set(String(item.id),item));return [...map.values()].sort((a,b)=>new Date(a.createdAt)-new Date(b.createdAt)||compareCursor(a.cursor||a.id,b.cursor||b.id));}
  const listItems=result=>Array.isArray(result)?result:result?.items||[];
  function chatHost(){return document.querySelector('#community-view');}

  function renderChat(host,{keepScroll=false}={}){
    if(view!=='chat')return;
    if(!getUser()){
      const shell=stableView(host,'chat-guest',`<div class="community-page"><header class="community-section-head"><div><span class="community-kicker">БРИГАДА №2</span><h2>Общий чат</h2></div></header><article class="community-card">${loginGate()}</article></div>`);if(shell.created)bindLogin(shell.node);return;
    }
    const shell=stableView(host,'chat',`<div class="community-page community-chat-page"><header class="community-section-head community-chat-header"><span class="community-group-avatar" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 4v2"/></svg></span><div><h2>Бригада №2</h2><p>Общий чат</p></div></header><div data-chat-source></div><p class="community-form-error" role="status" data-chat-error></p><section class="community-chat-feed community-card" aria-label="Сообщения бригады" data-chat-scroll><div class="community-load-older"><button type="button" class="btn" data-chat-older hidden>Предыдущие сообщения</button></div><div data-chat-messages></div></section><button class="community-new-messages" type="button" data-chat-new hidden></button>${composeMarkup('chat','Сообщение бригаде')}</div>`);
    const node=shell.node,scroller=node.querySelector('[data-chat-scroll]');
    if(shell.created){
      node.querySelector('[data-chat-older]').onclick=()=>loadChat({older:true});
      node.querySelector('[data-chat-new]').onclick=()=>{scroller.scrollTop=scroller.scrollHeight;chat.unread=0;renderChat(host);};
      scroller.onscroll=()=>{if(scroller.scrollHeight-scroller.scrollTop-scroller.clientHeight<80){chat.unread=0;node.querySelector('[data-chat-new]').hidden=true;}};
      node.querySelector('[data-chat-messages]').onclick=event=>{const edit=event.target.closest('[data-edit-chat]'),remove=event.target.closest('[data-delete-chat]');if(edit||remove){event.target.closest('details')?.removeAttribute('open');editChat(chat.items.find(item=>String(item.id)===(edit?.dataset.editChat||remove?.dataset.deleteChat)),Boolean(remove));}};
      node.addEventListener('toggle',event=>{const menu=event.target;if(!menu.matches?.('.community-message-menu')||!menu.open)return;node.querySelectorAll('.community-message-menu[open]').forEach(other=>{if(other!==menu)other.open=false;});const actions=menu.querySelector('.community-message-actions'),space=scroller.getBoundingClientRect().bottom-menu.getBoundingClientRect().bottom;menu.classList.toggle('above',space<actions.offsetHeight+12);},true);
      bindComposer(node,'chat',async message=>{
        const result=await api('/chat/messages',{method:'POST',body:message});const item=result.message||result.item||result;
        chat.items=mergeItems(chat.items,[item]);chat.error='';chat.cached=false;chat.mutation=(chat.mutation||0)+1;saveChatCache();renderChat(host);changed('chat',{id:item.id});loadChat({fresh:true});
      });
    }
    content(node.querySelector('[data-chat-source]'),sourceNotice({cached:chat.cached,at:chat.cacheAt}));
    node.querySelector('[data-chat-error]').textContent=chat.error||'';
    node.querySelector('[data-chat-older]').hidden=!chat.hasOlder;
    node.querySelector('[data-chat-older]').disabled=chat.loading;
    const newButton=node.querySelector('[data-chat-new]');newButton.hidden=!chat.unread;newButton.textContent=chat.unread?chat.unread+' новых ↓':'';
    patchFeed(node.querySelector('[data-chat-messages]'),chat.items,{chatMode:true,scroller,stickBottom:!keepScroll,empty:chat.loading?'Загружаем сообщения…':chat.error?'Сообщения пока недоступны.':'Пока нет сообщений. Напишите первым.'});
    composerAvailability(node.querySelector('[data-compose]'),chat.cached);
  }
  function saveChatCache(){storage.set(cacheKey('/chat/messages?limit=50'),{data:{items:chat.items,nextCursor:chat.before},at:new Date().toISOString(),cached:false});}
  function editChat(item,remove=false){
    if(!item)return;
    const node=openDialog(remove?'Удалить сообщение?':'Изменить сообщение',remove?'<p class="community-copy">Сообщение будет удалено из общего чата.</p><p class="community-form-error" role="alert"></p><button type="button" class="btn community-danger" data-delete-chat-confirm>Удалить сообщение</button>':`<form><label class="community-field">Текст сообщения<textarea name="body" rows="5" maxlength="4000">${html(item.body)}</textarea></label><p class="community-form-error" role="alert"></p><button type="submit" class="btn primary">Сохранить изменения</button></form>`);
    const action=async event=>{event.preventDefault();const button=node.querySelector('button[type="submit"], [data-delete-chat-confirm]');button.disabled=true;try{const result=await api('/chat/messages/'+encodeURIComponent(item.id),{method:remove?'DELETE':'PATCH',...(!remove?{body:{body:node.querySelector('textarea').value.trim(),revision:item.revision}}:{})});chat.mutation=(chat.mutation||0)+1;chat.items=remove?chat.items.filter(value=>String(value.id)!==String(item.id)):mergeItems(chat.items,[result.item||result]);saveChatCache();renderChat(chatHost(),{keepScroll:true});changed('chat',{id:item.id,deleted:remove});closeDialog(node);await loadChat({fresh:true});}catch(error){node.querySelector('[role="alert"]').textContent=error.message;button.disabled=false;}};
    if(remove)node.querySelector('[data-delete-chat-confirm]').onclick=action;else node.querySelector('form').onsubmit=action;
  }

  async function loadChat({fresh=false,older=false,poll=false}={}){
    const host=chatHost();if(!getUser()||!host||view!=='chat')return;
    if(chat.loading){if(fresh)chat.queued=true;return;}
    if(poll&&(!visible(host)||!online()))return;
    const epoch=sessionEpoch,owner=userKey(),mutation=chat.mutation||0;
    const scroller=host.querySelector('[data-chat-scroll]'),nearBottom=!scroller||scroller.scrollHeight-scroller.scrollTop-scroller.clientHeight<90;
    chat.loading=true;chat.last=Date.now();renderChat(host,{keepScroll:true});
    try{
      const oldIds=new Set(chat.items.map(item=>String(item.id)));
      if(older&&chat.before){const page=await api('/chat/messages?limit=50&before='+encodeURIComponent(chat.before));if(epoch!==sessionEpoch||owner!==userKey())return;chat.items=mergeItems(listItems(page),chat.items);chat.before=page.nextCursor||null;chat.hasOlder=Boolean(chat.before);}
      else{
        const snapshot=await snapshotWindow('/chat/messages',chat.items);
        if(epoch!==sessionEpoch||owner!==userKey())return;
        if(mutation!==(chat.mutation||0)){chat.queued=true;return;}
        chat.items=snapshot.items;chat.before=snapshot.before;chat.hasOlder=Boolean(snapshot.before);chat.cached=snapshot.result.cached;chat.cacheAt=snapshot.result.at;
      }
      chat.error='';if(!chat.cached)saveChatCache();
      if(poll&&!nearBottom)chat.unread+=chat.items.filter(item=>!oldIds.has(String(item.id))).length;
    }catch(error){if(epoch===sessionEpoch&&owner===userKey()&&error.code!=='stale_session')chat.error=error.message;}
    finally{if(epoch===sessionEpoch&&owner===userKey()){chat.loading=false;renderChat(host,{keepScroll:older||!nearBottom});if(chat.queued){chat.queued=false;queueMicrotask(()=>loadChat({fresh:true}));}}}
  }

  function mountObject(container,target){
    if(typeof container==='string')container=document.querySelector(container);
    if(!container||!target?.key)return;
    const previous=hosts.get(container);
    const record=previous?.kind==='object'&&previous.target.key===target.key&&previous.owner===userKey()&&previous.epoch===sessionEpoch?previous:{kind:'object',target,container,result:null,loading:false,last:0,owner:userKey(),epoch:sessionEpoch};
    if(record!==previous)container.querySelector('[data-compose]')?._communityDispose?.();record.target=target;hosts.set(container,record);renderObject(record);loadObject(record).then(()=>{if(!currentObject(record))return;const focus=target.noteId||(pendingFocus?.key===target.key?pendingFocus.noteId:null);if(focus){pendingFocus=null;focusNote(record,focus);}});return ()=>{if(hosts.get(container)===record)hosts.delete(container);};
  }
  const currentObject=record=>record.container.isConnected&&hosts.get(record.container)===record&&record.owner===userKey()&&record.epoch===sessionEpoch;

  function renderObject(record){
    const {container,target,result}=record;if(!currentObject(record))return;
    const owner=userKey(),existing=container.querySelector('.community-object');
    if(!getUser()){if(!existing||existing.dataset.owner!=='guest'){container.replaceChildren(elementFrom(`<section class="community-object" data-owner="guest"><h3>Общие записи</h3>${loginGate()}</section>`));bindLogin(container);}return;}
    if(!existing||existing.dataset.owner!==owner||existing.dataset.objectKey!==target.key||existing.dataset.epoch!==String(sessionEpoch)){
      container.querySelector('[data-compose]')?._communityDispose?.();
      container.replaceChildren(elementFrom(`<section class="community-object" data-owner="${html(owner)}" data-epoch="${sessionEpoch}" data-object-key="${html(target.key)}"><header class="community-object-head"><div><span class="community-kicker">ДЛЯ ВСЕЙ БРИГАДЫ</span><h3>Общие записи</h3><p class="community-object-label">${html(target.label||'')}</p></div><button class="btn" type="button" data-object-refresh>Обновить</button></header><div data-object-source></div><p class="community-form-error" role="status" data-object-error></p><form class="community-status-form" data-status-form><label class="community-field">Состояние объекта<select name="status">${statusesFor(target.key).map(([key,label])=>`<option value="${key}">${label}</option>`).join('')}</select></label><button class="btn" type="submit">Сохранить состояние</button></form><p class="community-status-by"></p><div class="community-object-feed"></div><button type="button" class="btn community-older-notes" data-notes-older hidden>Более ранние записи</button>${composeMarkup(target.key,'Запись об объекте')}</section>`));
      const form=container.querySelector('[data-status-form]');
      form.elements.status.onchange=()=>{record.statusDirty=true;record.baseRevision=record.result?.status?.data?.revision||0;};
      form.onsubmit=async event=>{event.preventDefault();if(record.statusPending)return;record.statusPending=true;renderObject(record);try{const saved=await api('/objects/'+encodeURIComponent(target.key)+'/status',{method:'PUT',body:{status:form.elements.status.value,revision:record.statusDirty?record.baseRevision:record.result?.status?.data?.revision||0}});if(!currentObject(record))return;record.mutation=(record.mutation||0)+1;record.statusDirty=false;record.result.status={data:saved,cached:false,at:new Date().toISOString()};record.error='';changed('object',{key:target.key,padId:target.padId});}catch(error){if(currentObject(record)){record.error=error.message;if(error.status===409){record.statusDirty=false;record.queued=true;}}}finally{record.statusPending=false;renderObject(record);if(record.queued){record.queued=false;loadObject(record);}}};
      container.querySelector('[data-object-refresh]').onclick=()=>loadObject(record);
      container.querySelector('[data-notes-older]').onclick=()=>loadObject(record,true);
      bindComposer(container,target.key,async message=>{const response=await api('/objects/'+encodeURIComponent(target.key)+'/notes',{method:'POST',body:message});if(!currentObject(record))return;const item=response.item||response.note||response;record.mutation=(record.mutation||0)+1;if(record.result)record.result.notes.data.items=mergeItems(listItems(record.result.notes.data),[item]);record.error='';renderObject(record);changed('object',{key:target.key,padId:target.padId});loadObject(record);});
      container.querySelector('.community-object-feed').onclick=event=>{
        const button=event.target.closest('[data-reply-note],[data-parent-note],[data-edit-note],[data-delete-note]');if(!button||!currentObject(record))return;
        const notes=listItems(record.result?.notes?.data),form=container.querySelector('[data-compose]');
        if(button.dataset.parentNote){focusNote(record,button.dataset.parentNote);return;}
        const id=button.dataset.replyNote||button.dataset.editNote||button.dataset.deleteNote,note=notes.find(item=>String(item.id)===id);if(!note)return;
        if(button.dataset.editNote){editNote(record,note);return;}if(button.dataset.deleteNote){deleteNote(record,note);return;}
        if(form.dataset.sending==='true')return;const reply=form.querySelector('[data-reply-target]');form.dataset.parentId=note.id;reply.hidden=false;reply.innerHTML=`Ответ: ${html(note.author?.nickname||'участник')}<button type="button" aria-label="Отменить ответ">×</button>`;reply.querySelector('button').onclick=()=>{if(form.dataset.sending==='true')return;delete form.dataset.parentId;reply.hidden=true;saveDraft(target.key,form.elements.body.value,getDraft(target.key).clientId);};saveDraft(target.key,form.elements.body.value,getDraft(target.key).clientId,note.id);form.elements.body.focus({preventScroll:true});
      };
    }
    const status=result?.status?.data||{status:'unknown',revision:0},shared=status.author||status.updatedBy,form=container.querySelector('[data-status-form]');
    if(!record.statusDirty&&!record.statusPending)form.elements.status.value=status.status;
    form.elements.status.disabled=!online()||!result||Boolean(result.status?.cached)||record.statusPending;
    const statusButton=form.querySelector('button');statusButton.disabled=form.elements.status.disabled;statusButton.textContent=record.statusPending?'Сохраняем…':'Сохранить состояние';
    container.querySelector('.community-status-by').textContent=status.updatedAt?`${shared?.nickname||'Участник'} · ${time(status.updatedAt)}`:'';
    content(container.querySelector('[data-object-source]'),sourceNotice(result?.notes?.cached?result.notes:result?.status?.cached?result.status:null));container.querySelector('[data-object-error]').textContent=record.error||'';
    container.querySelector('[data-object-refresh]').disabled=record.loading;container.querySelector('[data-notes-older]').hidden=!record.notesBefore;
    patchFeed(container.querySelector('.community-object-feed'),listItems(result?.notes?.data),{editable:true,empty:record.loading&&!result?'Загружаем общие записи…':!result?'Общие записи пока недоступны.':'Общих записей пока нет.'});
    composerAvailability(container.querySelector('[data-compose]'),Boolean(result?.notes?.cached));
  }

  async function loadObject(record,older=false){
    if(!currentObject(record)||!getUser())return;if(record.loading){record.queued=true;return;}
    record.loading=true;record.last=Date.now();const mutation=record.mutation||0;renderObject(record);
    try{
      const path='/objects/'+encodeURIComponent(record.target.key);
      if(older&&record.notesBefore){const page=await api(path+'/notes?limit=50&before='+encodeURIComponent(record.notesBefore));if(!currentObject(record))return;record.result.notes.data.items=mergeItems(listItems(page),listItems(record.result.notes.data));record.notesBefore=page.nextCursor||null;}
      else{
        const [status,snapshot]=await Promise.all([read(path+'/status'),snapshotWindow(path+'/notes',listItems(record.result?.notes?.data))]);
        if(!currentObject(record))return;if(mutation!==(record.mutation||0)){record.queued=true;return;}
        record.result={status,notes:{...snapshot.result,data:{items:snapshot.items,nextCursor:snapshot.before}}};record.notesBefore=snapshot.before;
      }
      record.error='';
    }catch(error){if(currentObject(record)&&error.code!=='stale_session')record.error=error.message;}
    finally{record.loading=false;renderObject(record);if(currentObject(record)&&record.queued){record.queued=false;queueMicrotask(()=>loadObject(record));}}
  }
  function editNote(record,note){
    if(!note)return;
    const node=openDialog('Изменить запись',`<form data-edit-note-form><label class="community-field">Текст записи<textarea name="body" rows="5" maxlength="4000">${html(note.body)}</textarea></label><p class="community-form-error" role="alert"></p><button type="submit" class="btn primary">Сохранить изменения</button></form>`);
    const form=node.querySelector('form');form.onsubmit=async event=>{event.preventDefault();const button=form.querySelector('button');button.disabled=true;try{const result=await api('/notes/'+encodeURIComponent(note.id),{method:'PATCH',body:{body:form.elements.body.value.trim(),revision:note.revision}});if(!currentObject(record))return;record.mutation=(record.mutation||0)+1;if(record.result)record.result.notes.data.items=mergeItems(listItems(record.result.notes.data),[result.item||result]);renderObject(record);changed('object',{key:record.target.key,padId:record.target.padId});closeDialog(node);await loadObject(record);}catch(e){form.querySelector('[role="alert"]').textContent=e.message;button.disabled=false;}};
  }
  function deleteNote(record,note){
    if(!note)return;const node=openDialog('Удалить запись?',`<p class="community-copy">Запись будет удалена из общей ленты объекта.</p><p class="community-form-error" role="alert"></p><button type="button" class="btn community-danger" data-confirm-delete>Удалить запись</button>`);
    node.querySelector('[data-confirm-delete]').onclick=async event=>{const button=event.currentTarget;button.disabled=true;try{await api('/notes/'+encodeURIComponent(note.id),{method:'DELETE'});if(!currentObject(record))return;record.mutation=(record.mutation||0)+1;if(record.result)record.result.notes.data.items=listItems(record.result.notes.data).filter(item=>String(item.id)!==String(note.id));renderObject(record);changed('object',{key:record.target.key,padId:record.target.padId});closeDialog(node);await loadObject(record);}catch(e){node.querySelector('[role="alert"]').textContent=e.message;button.disabled=false;}};
  }

  const samplingDraftKey=padId=>PREFIX+'sampling-draft.'+userKey()+'.'+padId;
  function samplingItem(result,padId){const value=result?.data;if(value?.padId)return value;return listItems(value).find(item=>String(item.padId)===padId)||{padId,sampled:false,revision:0};}
  function samplingPad(padId){return typeof data==='object'&&Array.isArray(data?.pads)?data.pads.find(pad=>String(pad.id)===padId):null;}
  function samplingWells(record){
    const pad=samplingPad(record.padId),item=samplingItem(record.result,record.padId),canonical=Array.isArray(item.productionWellIds)?new Set(item.productionWellIds.map(String)):null,map=new Map();
    for(const well of pad?.wells||[])if(well.type==='production'&&(!canonical||canonical.has(String(well.id)))&&!map.has(String(well.id)))map.set(String(well.id),{id:String(well.id),position:well.position||null});
    for(const id of canonical||[])if(!map.has(id))map.set(id,{id,position:null});return [...map.values()];
  }
  function sampleSelected(item,wells){const allowed=new Set(wells.map(well=>well.id));return new Set((Array.isArray(item.selectedWellIds)?item.selectedWellIds:item.sampled?wells.map(well=>well.id):[]).map(String).filter(id=>allowed.has(id)));}
  function rememberSampling(record){
    if(!currentObject(record))return;
    if(!record.sampleDirty){storage.remove(samplingDraftKey(record.padId));return;}
    storage.set(samplingDraftKey(record.padId),{selected:[...record.sampleDraft],base:[...record.sampleBase],revision:record.sampleBaseRevision,touched:[...record.sampleTouched],at:new Date().toISOString()});
  }
  function clearSamplingDraft(record){record.sampleDraft=null;record.sampleBase=null;record.sampleTouched=null;record.sampleDirty=false;record.sampleBaseRevision=null;rememberSampling(record);}
  function startSamplingDraft(record){
    if(record.sampleDirty&&record.sampleDraft)return;const item=samplingItem(record.result,record.padId),selected=sampleSelected(item,samplingWells(record));record.sampleDraft=new Set(selected);record.sampleBase=new Set(selected);record.sampleTouched=new Map();record.sampleBaseRevision=Number(item.revision)||0;
  }
  function mountSampling(container,padId){
    if(typeof container==='string')container=document.querySelector(container);if(!container)return;
    const previous=hosts.get(container),record=previous?.kind==='sampling'&&previous.padId===String(padId)&&previous.owner===userKey()&&previous.epoch===sessionEpoch?previous:{kind:'sampling',container,padId:String(padId),result:null,loading:false,last:0,owner:userKey(),epoch:sessionEpoch};
    if(record!==previous){const saved=storage.get(samplingDraftKey(String(padId)));if(saved&&Array.isArray(saved.selected)&&Array.isArray(saved.base)&&Array.isArray(saved.touched)){record.sampleDraft=new Set(saved.selected.map(String));record.sampleBase=new Set(saved.base.map(String));record.sampleTouched=new Map(saved.touched.filter(entry=>Array.isArray(entry)&&entry.length===2).map(([id,value])=>[String(id),Boolean(value)]));record.sampleBaseRevision=Number(saved.revision)||0;record.sampleDirty=record.sampleTouched.size>0;}}
    hosts.set(container,record);renderSampling(record);loadSampling(record);return()=>{if(hosts.get(container)===record)hosts.delete(container);};
  }
  function renderSampling(record){
    const {container,padId,result}=record;if(!currentObject(record))return;
    const pad=samplingPad(padId);if(pad?.samplingExcluded){content(container,`<section class="community-sampling"><h3>Отбор проб</h3><p class="community-copy">${html(pad.samplingExclusionReason||'Отбор проб не требуется')}</p></section>`);return;}
    if(!getUser()){content(container,`<section class="community-sampling"><h3>Отбор проб</h3>${loginGate()}</section>`);bindLogin(container);return;}
    const item=samplingItem(result,padId),wells=samplingWells(record),selected=sampleSelected(item,wells),by=item.author||item.updatedBy,signature=JSON.stringify([userKey(),sessionEpoch,padId,wells]),existing=container.querySelector('[data-sampling-form]');
    if(!existing||existing.dataset.signature!==signature){
      const groups=new Map();for(const well of wells){const position=well.position||0;if(!groups.has(position))groups.set(position,[]);groups.get(position).push(well);}
      container.replaceChildren(elementFrom(`<section class="community-sampling"><header><span class="community-sampling-icon" aria-hidden="true" data-sample-progress-icon>○</span><div><h3>Отбор проб</h3><p data-sample-summary></p></div><button type="button" class="btn" data-sample-refresh>Обновить</button></header><p class="community-sample-by" data-sample-by></p><div data-sample-source></div><form data-sampling-form data-signature="${html(signature)}"><p class="community-sampling-help">Отметьте добывающие скважины, затем сохраните выбор.</p><div class="community-sample-wells">${[...groups].map(([position,items])=>`<fieldset><legend>${position?`${position}-я позиция`:'Добывающие скважины'}</legend><div class="community-sample-checkboxes">${items.map(well=>`<label><input type="checkbox" name="wellIds" value="${html(well.id)}" data-sample-well="${html(well.id)}"><span>№ ${html(well.id)}</span></label>`).join('')}</div></fieldset>`).join('')}</div><p class="community-sampling-draft" role="status" data-sample-draft hidden></p><p class="community-sampling-warning" role="status" data-sample-warning hidden></p><p class="community-form-error" role="alert" data-sample-error></p><div class="community-sampling-actions"><button class="btn primary" type="submit" data-sample-save>Сохранить выбранные</button><button type="button" class="btn" data-sample-toggle>Отметить весь куст</button><button type="button" class="btn" data-sample-discard hidden>Использовать общие отметки</button></div></form></section>`));
      const form=container.querySelector('[data-sampling-form]');
      form.onchange=event=>{const input=event.target.closest('[data-sample-well]');if(!input||record.samplePending||!currentObject(record))return;startSamplingDraft(record);const id=input.dataset.sampleWell;if(input.checked)record.sampleDraft.add(id);else record.sampleDraft.delete(id);if(record.sampleBase.has(id)===input.checked)record.sampleTouched.delete(id);else record.sampleTouched.set(id,input.checked);record.sampleDirty=record.sampleTouched.size>0;if(!record.sampleDirty){clearSamplingDraft(record);record.sampleWarning='';}else rememberSampling(record);record.error='';record.sampleWriteError=false;renderSampling(record);};
      form.onsubmit=event=>{event.preventDefault();saveSampling(record);};
      container.querySelector('[data-sample-toggle]').onclick=()=>{if(record.samplePending)return;startSamplingDraft(record);const liveWells=samplingWells(record),all=sampleSelected(samplingItem(record.result,record.padId),liveWells).size!==liveWells.length;record.sampleDraft=new Set(all?liveWells.map(well=>well.id):[]);record.sampleTouched=new Map(liveWells.filter(well=>record.sampleBase.has(well.id)!==all).map(well=>[well.id,all]));record.sampleDirty=true;rememberSampling(record);saveSampling(record);};
      container.querySelector('[data-sample-discard]').onclick=()=>{if(record.samplePending)return;clearSamplingDraft(record);record.sampleWarning='';record.error='';record.sampleWriteError=false;renderSampling(record);};
      container.querySelector('[data-sample-refresh]').onclick=()=>loadSampling(record);
    }
    const form=container.querySelector('[data-sampling-form]'),checked=record.sampleDirty?record.sampleDraft:selected,total=wells.length,progress=selected.size===0?'none':selected.size===total?'done':'partial',icon=container.querySelector('[data-sample-progress-icon]');
    icon.textContent=progress==='done'?'✓':progress==='partial'?'◐':'○';icon.className='community-sampling-icon '+progress;
    container.querySelector('[data-sample-summary]').textContent=!result?(record.error?'Общие отметки пока недоступны':'Загружаем общие отметки…'):`${selected.size} из ${total} отобрано`;
    container.querySelector('[data-sample-by]').textContent=item.updatedAt?`${by?.nickname||'Участник'} · ${recordedTime(item.updatedAt)}`:'';
    content(container.querySelector('[data-sample-source]'),sourceNotice(result));
    for(const input of form.querySelectorAll('[data-sample-well]')){input.checked=checked?.has(input.dataset.sampleWell)||false;input.disabled=Boolean(record.samplePending);}
    const draft=form.querySelector('[data-sample-draft]');draft.hidden=!record.sampleDirty;draft.textContent=record.sampleDirty?`Выбрано ${[...checked].filter(id=>wells.some(well=>well.id===id)).length} из ${total}. Выбор сохранён на этом телефоне и ещё не отправлен.`:'';
    const warning=form.querySelector('[data-sample-warning]'),changedRevision=record.sampleDirty&&Number(item.revision)!==record.sampleBaseRevision;warning.textContent=record.sampleWarning||(changedRevision?'Коллеги изменили общий отбор. Ваш несохранённый выбор сохранён. Проверьте обновлённый результат.':'');warning.hidden=!warning.textContent;
    form.querySelector('[data-sample-error]').textContent=record.error||'';
    const readOnly=!online()||!result||result.cached,save=form.querySelector('[data-sample-save]'),whole=form.querySelector('[data-sample-toggle]');save.disabled=Boolean(record.samplePending)||readOnly||!record.sampleDirty||!total;save.textContent=record.samplePending?'Сохраняем…':'Сохранить выбранные';whole.disabled=Boolean(record.samplePending)||readOnly||!total;whole.textContent=selected.size===total&&total?'Сбросить все отметки':'Отметить весь куст';form.querySelector('[data-sample-discard]').hidden=!record.sampleDirty&&!record.sampleWarning;form.querySelector('[data-sample-discard]').disabled=Boolean(record.samplePending);container.querySelector('[data-sample-refresh]').disabled=record.loading||Boolean(record.samplePending);
  }
  async function saveSampling(record){
    if(!currentObject(record)||record.samplePending||!record.sampleDirty)return;
    if(!online()||!record.result||record.result.cached){record.error='Нет актуальных общих отметок. Выбор сохранён на этом телефоне; обновите данные перед отправкой.';renderSampling(record);return;}
    const wells=samplingWells(record),wellIds=wells.filter(well=>record.sampleDraft.has(well.id)).map(well=>well.id),revision=record.sampleBaseRevision;record.samplePending=true;record.error='';record.sampleWriteError=false;renderSampling(record);
    try{
      const response=await api('/samples/'+encodeURIComponent(record.padId),{method:'PUT',body:{wellIds,revision}});if(!currentObject(record))return;
      record.sampleMutation=(record.sampleMutation||0)+1;const item=response.item||response;record.result={data:item,cached:false,at:new Date().toISOString()};storage.set(cacheKey('/samples?padId='+encodeURIComponent(record.padId)),record.result);clearSamplingDraft(record);record.sampleWarning='';changed('sampling',{padId:record.padId});notify('Отбор проб сохранён.');
    }catch(error){
      if(!currentObject(record))return;
      if(error.status===409){
        try{let current=error.details?.current;if(!current){const response=await api('/samples?padId='+encodeURIComponent(record.padId));if(!currentObject(record))return;current=samplingItem({data:response},record.padId);}if(!currentObject(record))return;
          record.sampleMutation=(record.sampleMutation||0)+1;record.result={data:current,cached:false,at:new Date().toISOString()};storage.set(cacheKey('/samples?padId='+encodeURIComponent(record.padId)),record.result);const base=sampleSelected(current,samplingWells(record)),merged=new Set(base),touched=new Map();for(const [id,checked] of record.sampleTouched||[]){if(checked)merged.add(id);else merged.delete(id);if(base.has(id)!==checked)touched.set(id,checked);}record.sampleBase=base;record.sampleDraft=merged;record.sampleBaseRevision=Number(current.revision)||0;record.sampleTouched=touched;record.sampleDirty=touched.size>0;rememberSampling(record);record.sampleWarning=record.sampleDirty?'Коллеги уже обновили отбор. Общие отметки загружены, ваш выбор сохранён. Проверьте скважины и нажмите «Сохранить выбранные» ещё раз.':'Коллеги уже обновили отбор. Ваш выбор совпадает с общими отметками.';record.error='';
        }catch(refreshError){if(currentObject(record))record.error='Общие отметки изменились. Не удалось их загрузить. Ваш выбор сохранён; обновите данные и повторите.';}
      }else{record.error=error.message;record.sampleWriteError=true;}
    }finally{record.samplePending=false;renderSampling(record);if(currentObject(record)&&record.sampleQueued){record.sampleQueued=false;loadSampling(record);}}
  }
  async function loadSampling(record){
    if(!currentObject(record)||!getUser())return;if(record.loading||record.samplePending){record.sampleQueued=true;return;}record.loading=true;record.last=Date.now();const mutation=record.sampleMutation||0;
    try{const result=await read('/samples?padId='+encodeURIComponent(record.padId));if(!currentObject(record))return;if(mutation!==(record.sampleMutation||0)){record.sampleQueued=true;return;}record.result=result;if(!record.samplePending&&!record.sampleWriteError)record.error='';}catch(error){if(currentObject(record)&&error.code!=='stale_session')record.error=error.message;}finally{record.loading=false;renderSampling(record);if(currentObject(record)&&record.sampleQueued&&!record.samplePending){record.sampleQueued=false;queueMicrotask(()=>loadSampling(record));}}
  }
  function openView(next){
    if(next!=='chat')document.documentElement.classList.remove('community-keyboard-open');if(next==='notifications'){view=next;return window.AtlasNotifications?.openView()||'';}
    if(!['profile','chat'].includes(next))return '';view=next;
    const host=document.querySelector('#community-view');if(!host)return '';
    host.dataset.communitySection=next;
    if(next==='profile')renderProfile(host);else{renderChat(host);loadChat({fresh:!chat.items.length});}
    if(next==='chat')requestAnimationFrame(updateChatViewport);return host.innerHTML;
  }
  function refreshVisible(){
    const host=chatHost();if(host&&visible(host)&&view==='profile')renderProfile(host);else if(host&&visible(host)&&view==='chat'){renderChat(host);if(getUser())loadChat({fresh:true});}
    for(const [node,record] of hosts){if(!node.isConnected){node.querySelector('[data-compose]')?._communityDispose?.();hosts.delete(node);continue;}if(!currentObject(record)){if(record.kind==='object')mountObject(node,record.target);else mountSampling(node,record.padId);continue;}if(record.kind==='object'){renderObject(record);loadObject(record);}else{renderSampling(record);loadSampling(record);}}
  }
  function poll(){
    if(!online()||!getUser()||document.visibilityState!=='visible')return;
    if(view==='chat'&&visible(chatHost())&&Date.now()-(chat.last||0)>=1800)loadChat({poll:true});
    for(const [node,record] of hosts){if(!node.isConnected){node.querySelector('[data-compose]')?._communityDispose?.();hosts.delete(node);continue;}if(visible(node)&&Date.now()-record.last>=2400){if(record.kind==='object')loadObject(record);else loadSampling(record);}}
  }
  async function focusNote(record,noteId){
    if(!currentObject(record))return;
    try{
      if(!record.result)await loadObject(record);
      if(!currentObject(record))return;
      let items=listItems(record.result?.notes?.data);
      if(!items.some(item=>String(item.id)===String(noteId))){const result=await api('/notes/'+encodeURIComponent(noteId));if(!currentObject(record))return;const note=result.item||result.note||result;if(note.objectKey&&note.objectKey!==record.target.key)throw Error('Запись относится к другому объекту.');items=mergeItems(items,[note]);if(note.parentId&&!items.some(item=>item.id===note.parentId)){try{const parent=await api('/notes/'+encodeURIComponent(note.parentId));if(!currentObject(record))return;items=mergeItems(items,[parent.item||parent.note||parent]);}catch{}}if(!currentObject(record))return;if(record.result)record.result.notes.data={...record.result.notes.data,items};renderObject(record);}
      const item=record.container.querySelector('[data-message-id="'+CSS.escape(String(noteId))+'"]');
      if(item){item.classList.add('community-highlight');item.tabIndex=-1;item.scrollIntoView({behavior:'smooth',block:'center'});item.focus({preventScroll:true});setTimeout(()=>item.classList.remove('community-highlight'),6000);}else notify('Запись удалена или пока недоступна.');
    }catch(error){if(currentObject(record))notify(error.message);}
  }

  const pendingChatFocus=new Map();
  async function focusChatMessage(id){
    id=String(id||'');if(!id||!getUser())return;if(pendingChatFocus.has(id))return pendingChatFocus.get(id);
    const epoch=sessionEpoch,owner=userKey();
    const promise=(async()=>{try{
      const response=await api('/chat/messages/'+encodeURIComponent(id)),item=response.item||response.message||response;
      if(epoch!==sessionEpoch||owner!==userKey()||view!=='chat')return;
      const context=await api('/chat/messages?limit=30&before='+encodeURIComponent(item.cursor));
      if(epoch!==sessionEpoch||owner!==userKey()||view!=='chat')return;
      chat.mutation=(chat.mutation||0)+1;chat.items=mergeItems(chat.items,[...listItems(context),item]);chat.error='';renderChat(chatHost(),{keepScroll:true});
      const message=chatHost()?.querySelector('[data-message-id="'+CSS.escape(id)+'"]');if(message){message.tabIndex=-1;message.classList.add('community-highlight');message.scrollIntoView({behavior:'smooth',block:'center'});message.focus({preventScroll:true});setTimeout(()=>message.classList.remove('community-highlight'),6000);}
    }catch(error){if(epoch===sessionEpoch&&owner===userKey()&&error.code!=='stale_session')notify(error.status===404?'Это сообщение уже удалено.':error.message);}finally{pendingChatFocus.delete(id);}})();pendingChatFocus.set(id,promise);return promise;
  }
  document.addEventListener('pointerdown',event=>{document.querySelectorAll('.community-message-menu[open]').forEach(menu=>{if(!menu.contains(event.target))menu.open=false;});});
  document.addEventListener('keydown',event=>{if(event.key!=='Escape')return;const menu=document.activeElement?.closest?.('.community-message-menu[open]')||document.querySelector('.community-message-menu[open]');if(menu){event.preventDefault();event.stopPropagation();menu.open=false;menu.querySelector('summary').focus({preventScroll:true});}},true);
  let viewportWidth=0,largestViewport=0;
  function updateChatViewport(){
    if(view!=='chat')return;const host=chatHost(),node=host?.querySelector('.community-chat-page');if(!node||!visible(host))return;
    const viewport=window.visualViewport,height=viewport?.height||innerHeight,width=innerWidth;
    if(width!==viewportWidth){viewportWidth=width;largestViewport=height;}largestViewport=Math.max(largestViewport,height);
    const keyboard=largestViewport-height>130&&Boolean(document.activeElement?.matches?.('textarea,input'));
    document.documentElement.classList.toggle('community-keyboard-open',keyboard);
    const top=Math.max(0,node.getBoundingClientRect().top-(viewport?.offsetTop||0)),rail=document.querySelector('.rail'),bottom=!keyboard&&rail&&getComputedStyle(rail).position==='fixed'?rail.getBoundingClientRect().height:0;
    node.style.height=Math.max(220,height-top-bottom-8)+'px';node.style.setProperty('--chat-composer-height',(node.querySelector('[data-compose]')?.getBoundingClientRect().height||64)+'px');
  }
  window.visualViewport?.addEventListener('resize',updateChatViewport);window.visualViewport?.addEventListener('scroll',updateChatViewport);window.addEventListener('resize',updateChatViewport);

  let pendingFocus=null;
  window.addEventListener('atlas-open-object',event=>{pendingFocus=event.detail;queueMicrotask(()=>{for(const record of hosts.values())if(record.kind==='object'&&record.target.key===pendingFocus?.key&&pendingFocus.noteId){focusNote(record,pendingFocus.noteId);pendingFocus=null;break;}});});
  function configureNativeNotifications(enabled){
    if(!window.SdngGps?.configureNotifications)throw new Error('Фоновые уведомления недоступны в этой версии приложения.');
    if(enabled&&(!authenticated()||!session.remember))throw new Error('Для фоновых уведомлений войдите с отметкой «Запомнить меня».');
    window.SdngGps.configureNotifications(enabled?String(window.ATLAS_API_BASE||'/api/v1'):'',enabled?session.token:'',Boolean(enabled));
  }
  function getUpdateState(){
    const result={busy:authPending>0||apiWrites>0,hasDraft:false,hasFiles:false,hasTransientDraft:false};
    for(const form of composerStates){const state=form._communityState?.();if(state)for(const key of Object.keys(result))result[key]||=Boolean(state[key]);}
    for(const state of profileStates.values()){result.busy||=Boolean(state.pending||state.decoding);result.hasDraft||=Boolean(state.nameDirty);result.hasTransientDraft||=Boolean(state.nameDirty);result.hasFiles||=Boolean(state.crop||state.decoding);}
    const authForms=new Set(document.querySelectorAll('[data-community-auth]'));for(const shell of viewShells.values())for(const form of shell.querySelectorAll('[data-community-auth]'))if(form.dataset.authCompleted!=='true')authForms.add(form);
    for(const form of authForms)if(form.dataset.authCompleted!=='true'&&(visible(form)||[...viewShells.values()].some(shell=>shell.contains(form)))){const dirty=[...form.querySelectorAll('input:not([type="checkbox"])')].some(input=>input.value);result.hasDraft||=dirty;result.hasTransientDraft||=dirty;}
    for(const record of hosts.values()){result.busy||=Boolean(record.statusPending||record.samplePending);result.hasDraft||=Boolean(record.sampleDirty);}
    return result;
  }
  window.Community=Object.freeze({openView,mountObject,mountSampling,getUser,api,getUpdateState,renderObject:mountObject,renderSampling:mountSampling,auth:authModal,refresh:refreshVisible,sessionRemembered:()=>Boolean(authenticated()&&session.remember),configureNativeNotifications,focusChatMessage,focusNote:(key,id)=>{for(const record of hosts.values())if(record.kind==='object'&&record.target.key===key)return focusNote(record,id);pendingFocus={key,noteId:id};}});
  restore();
  scheduleExpiry();
  window.addEventListener('online',()=>{refreshVisible();poll();});
  window.addEventListener('offline',refreshVisible);
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')poll();});
  setInterval(poll,1000);
  if(authenticated()&&online())api('/me').then(result=>{if(session){const incoming=result.user||result;if(session.user.updatedAt&&incoming.updatedAt&&Date.parse(incoming.updatedAt)<Date.parse(session.user.updatedAt))return;session.user=incoming;saveSession(session,session.remember);refreshVisible();}}).catch(error=>{if(error.status!==401&&error.code!=='stale_session'){authNotice='Не удалось проверить вход. Показаны сохранённые данные.';refreshVisible();}});
})();
