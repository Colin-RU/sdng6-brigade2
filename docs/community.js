'use strict';
(() => {
  const PREFIX='atlas.community.v1.';
  const SESSION=PREFIX+'session';
  const LIMIT=30;
  const STATUS={unknown:'Не указан',ok:'Работает',attention:'Нужно внимание',stopped:'Остановлен'};
  const hosts=new Map(),photoPromises=new Map();
  let session=null,view=null,authMode='login',authNotice='',profilePending=false,expiryTimer,sessionEpoch=0;
  let chat={items:[],before:null,hasOlder:false,pending:false,loading:false,error:'',cacheAt:null,cached:false,unread:0};
  const html=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const uuid=()=>crypto.randomUUID?crypto.randomUUID():`${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  const online=()=>navigator.onLine!==false;
  const time=value=>{const date=new Date(value);return Number.isFinite(date.getTime())?date.toLocaleString('ru-RU',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}):'Время не указано';};
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
    photoPromises.clear();chat={items:[],before:null,hasOlder:false,pending:false,loading:false,error:'',cacheAt:null,cached:false,unread:0};authChanged();
  }
  function scheduleExpiry(){clearTimeout(expiryTimer);if(!session)return;const delay=expiry(session.expiresAt)-Date.now();if(delay<=0){clearSession('Время входа истекло. Войдите ещё раз.');refreshVisible();return;}expiryTimer=setTimeout(scheduleExpiry,Math.min(delay,2147480000));}
  class ApiError extends Error{constructor(message,status=0,code='network'){super(message);this.status=status;this.code=code;}}
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
    try{
      const response=await fetch(base+path,{method,headers,body,signal:controller.signal,cache:'no-store',credentials:'omit'});
      assertSession();
      if(response.status===204)return null;
      if(!response.ok){
        let result;try{result=await response.json();}catch{}
        assertSession();
        if(response.status===401&&auth){clearSession('Время входа истекло. Войдите ещё раз.');refreshVisible();}
        const fallback=({400:'Проверьте заполненные поля.',401:'Неверный логин или пароль.',403:'Это действие недоступно.',404:'Запись не найдена.',409:'Данные уже изменились. Обновите их и повторите.',413:'Фото слишком большое.',429:'Слишком много попыток. Подождите немного.'})[response.status]||'Не удалось сохранить данные. Повторите позже.';
        throw new ApiError(String(result?.error?.message||fallback).slice(0,300),response.status,result?.error?.code||'request_failed');
      }
      if(options.response==='blob'){const value=await response.blob();assertSession();return value;}
      const value=await response.json();assertSession();return value;
    }catch(error){
      if(error instanceof ApiError)throw error;
      assertSession();
      throw new ApiError(error.name==='AbortError'?'Сервер не ответил вовремя. Черновик сохранён, можно повторить.':'Нет соединения с общими данными. Проверьте связь и повторите.');
    }finally{clearTimeout(timeout);options.signal?.removeEventListener('abort',onAbort);}
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
  async function compressPhoto(file,avatarMode=false){
    if(!file||file.size>40*1024*1024)throw Error('Выберите фото размером до 40 МБ.');
    const source=URL.createObjectURL(file);const image=new Image();
    try{await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(Error('Не удалось открыть фото. Выберите JPEG или PNG.'));image.src=source;});
      const max=avatarMode?640:1600;const scale=Math.min(1,max/Math.max(image.naturalWidth,image.naturalHeight));
      const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(image.naturalWidth*scale));canvas.height=Math.max(1,Math.round(image.naturalHeight*scale));
      const context=canvas.getContext('2d');context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(image,0,0,canvas.width,canvas.height);
      for(const quality of [.88,.75,.6,.45]){const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',quality));if(blob&&blob.size<=2*1024*1024)return blob;}
      throw Error('Фото слишком большое. Выберите снимок меньшего размера.');
    }finally{URL.revokeObjectURL(source);}
  }
  async function uploadBlob(blob,clientId){const form=new FormData();form.append('file',blob,'photo.jpg');form.append('clientId',clientId);const result=await api('/media',{method:'POST',body:form,timeout:45000});const media=result?.media||result;if(!media?.id)throw Error('Не удалось загрузить фото. Повторите попытку.');return media;}
  async function uploadPhoto(file,avatarMode=false,clientId=uuid()){return uploadBlob(await compressPhoto(file,avatarMode),clientId);}
  function photos(items=[]){return items.length?`<div class="community-photos">${items.map(media=>`<button type="button" class="community-photo" data-community-photo="${html(media.id)}" aria-label="Открыть фотографию"><span>Фото</span><img data-private-media="${html(media.id)}" alt="Фото к записи" hidden><span class="community-photo-error">Недоступно без связи</span></button>`).join('')}</div>`:'';}
  function bindPhotos(node){node.querySelectorAll('[data-community-photo]').forEach(button=>{button.onclick=async()=>{try{const url=await privatePhoto(button.dataset.communityPhoto);openDialog('Фотография',`<img class="community-photo-full" src="${html(url)}" alt="Фото к записи">`);}catch(error){notify(error.message);}};});hydrateMedia(node);}
  function navigate(next){if(typeof setView==='function')setView(next);else window.dispatchEvent(new CustomEvent('atlas-community-navigate',{detail:{view:next}}));}

  function authForm(mode='login'){
    const register=mode==='register';
    return `<form class="community-auth-form" data-community-auth="${mode}"><div class="community-auth-tabs" aria-label="Вход и регистрация"><button type="button" data-auth-mode="login" class="${!register?'active':''}" aria-pressed="${!register}">Войти</button><button type="button" data-auth-mode="register" class="${register?'active':''}" aria-pressed="${register}">Создать профиль</button></div><p class="community-copy">${register?'Представьтесь коллегам и выберите данные для входа.':'Войдите в общий чат и записи бригады.'}</p><label class="community-field">Логин<input name="login" autocomplete="username" inputmode="text" autocapitalize="none" spellcheck="false" required minlength="3" maxlength="40"></label>${register?'<label class="community-field">Имя для коллег<input name="nickname" autocomplete="nickname" required minlength="2" maxlength="40"></label>':''}<label class="community-field">Пароль<input name="password" type="password" autocomplete="${register?'new-password':'current-password'}" required minlength="10" maxlength="128"></label>${register?'<label class="community-field">Должность<select name="position"><option value="operator">Оператор</option><option value="master">Мастер</option></select></label><label class="community-field" data-grade-field>Разряд<select name="grade" required><option value="">Выберите разряд</option><option value="3">3 разряд</option><option value="4">4 разряд</option><option value="5">5 разряд</option><option value="6">6 разряд</option></select></label>':''}<label class="community-check"><input type="checkbox" name="remember" checked><span>Запомнить меня</span></label><p class="community-form-error" role="alert" data-auth-error>${html(authNotice)}</p><button class="btn primary community-submit" type="submit">${register?'Создать профиль':'Войти'}</button></form>`;
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
      button.disabled=true;button.textContent=register?'Создаём профиль…':'Входим…';error.textContent='';
      try{const result=await api(register?'/auth/register':'/auth/login',{method:'POST',body:values,auth:false});if(authEpoch!==sessionEpoch)throw new ApiError('Вход уже изменился. Обновите профиль.',0,'stale_session');saveSession(result,values.remember);form.elements.password.value='';await onSuccess?.();refreshVisible();}
      catch(e){error.textContent=e.message;}
      finally{values.password='';if(button.isConnected){button.disabled=false;button.textContent=register?'Создать профиль':'Войти';}}
    };
  }
  function authModal(){const node=openDialog('Профиль бригады',`<div data-auth-host>${authForm(authMode)}</div>`);bindAuth(node.querySelector('[data-auth-host]'),()=>closeDialog(node));}
  function bindLogin(node){node.querySelectorAll('[data-community-login]').forEach(button=>button.onclick=authModal);}

  function renderProfile(host){
    if(view!=='profile')return;
    const user=getUser();
    if(!user){host.innerHTML=`<div class="community-page"><header class="community-section-head"><div><span class="community-kicker">БРИГАДА №2</span><h2>Ваш профиль</h2></div></header><article class="community-card community-auth-card">${authForm(authMode)}</article>${!online()?'<p class="community-source">Для входа и создания профиля нужно подключение к интернету.</p>':''}</div>`;bindAuth(host.querySelector('.community-auth-card'));return;}
    host.innerHTML=`<div class="community-page"><header class="community-section-head"><div><span class="community-kicker">ВАС ВИДЯТ КОЛЛЕГИ</span><h2>Ваш профиль</h2></div><button type="button" class="btn" data-community-logout>Выйти</button></header><article class="community-card community-profile-card"><div class="community-profile-summary">${avatar(user,'large')}<div><h3>${html(user.nickname)}</h3><p>${html(positionLabel(user))}</p><span class="community-login-name">Логин: ${html(user.login)}</span></div></div><form data-profile-form><label class="community-field">Имя для коллег<input name="nickname" autocomplete="nickname" minlength="2" maxlength="40" required value="${html(user.nickname)}"></label><div class="community-profile-photo-row"><label class="btn community-file-button">Изменить фото<input type="file" name="avatar" accept="image/*" aria-label="Выбрать фото профиля"></label><span data-avatar-choice>Фото видно участникам бригады</span></div><p class="community-form-error" role="alert" data-profile-error></p><button class="btn primary" type="submit" ${!online()?'disabled':''}>Сохранить профиль</button></form>${!online()?'<p class="community-source">Профиль сохранён на этом устройстве. Изменения будут доступны при подключении.</p>':''}</article></div>`;
    hydrateMedia(host);const form=host.querySelector('[data-profile-form]');let avatarClientId=uuid(),avatarMedia;
    form.elements.avatar.onchange=()=>{avatarClientId=uuid();avatarMedia=null;const file=form.elements.avatar.files[0];host.querySelector('[data-avatar-choice]').textContent=file?'Фото выбрано · сохраните профиль':'Фото видно участникам бригады';};
    form.onsubmit=async event=>{
      event.preventDefault();if(!form.reportValidity()||form.dataset.sending==='true')return;
      form.dataset.sending='true';const button=form.querySelector('[type="submit"]'),error=form.querySelector('[data-profile-error]');button.disabled=true;button.textContent='Сохраняем…';error.textContent='';
      try{const update={nickname:form.elements.nickname.value.trim()};if(form.elements.avatar.files[0]){if(!avatarMedia)avatarMedia=await uploadPhoto(form.elements.avatar.files[0],true,avatarClientId);update.avatarMediaId=avatarMedia.id;}
        const result=await api('/me',{method:'PATCH',body:update});session.user=result.user||result;saveSession(session,session.remember);renderProfile(host);notify('Профиль сохранён.');
      }catch(e){error.textContent=e.message;}finally{form.dataset.sending='false';if(button.isConnected){button.disabled=!online();button.textContent='Сохранить профиль';}}
    };
    host.querySelector('[data-community-logout]').onclick=async()=>{await window.AtlasNotifications?.prepareLogout?.();try{await api('/auth/logout',{method:'POST'});}catch{}clearSession();renderProfile(host);refreshVisible();};
  }

  function composeMarkup(scope,label='Написать запись',readOnly=false){
    const draft=getDraft(scope);
    return `<form class="community-composer" data-compose="${html(scope)}" data-owner="${html(userKey())}"><label class="community-field">${html(label)}<textarea name="body" rows="3" maxlength="4000" placeholder="Что важно сообщить коллегам?">${html(draft.body)}</textarea></label><div class="community-reply-target" data-reply-target hidden></div><div class="community-attachment-previews" data-attachment-previews></div><div class="community-composer-actions"><label class="btn community-file-button">+ Фото<input type="file" accept="image/*" name="photos" multiple aria-label="Прикрепить до трёх фотографий" ${!online()||readOnly?'disabled':''}></label><span class="community-attachment-hint">До 3 фото</span><button class="btn primary" type="submit" ${!online()||readOnly?'disabled':''}>Отправить</button></div><p class="community-draft-hint" data-draft-hint>${draft.body?'Черновик сохранён на этом устройстве.':''}</p><p class="community-form-error" role="alert" data-compose-error></p><button type="button" class="btn" data-compose-new hidden>Начать новую запись</button></form>`;
  }
  function composerAvailability(form,readOnly=false){if(!form)return;form.dataset.readonly=String(readOnly);if(form.dataset.sending!=='true'){form.querySelector('[type="submit"]').disabled=!online()||readOnly;form.elements.photos.disabled=!online()||readOnly;}}
  function bindComposer(node,scope,onSend){
    const form=node.querySelector(`[data-compose="${CSS.escape(scope)}"]`);if(!form)return;
    const draft=getDraft(scope);let clientId=draft.clientId||uuid(),files=[],pending=false,attempt=draft.attempt||null;
    const sameOwner=()=>form.dataset.owner===userKey();
    const error=form.querySelector('[data-compose-error]'),hint=form.querySelector('[data-draft-hint]'),newButton=form.querySelector('[data-compose-new]');
    const fingerprint=()=>JSON.stringify([form.elements.body.value.trim(),form.dataset.parentId||null,files.map(entry=>entry.clientId)]);
    function checkAttempt(){const changed=Boolean(attempt&&attempt!==fingerprint());newButton.hidden=!changed;if(changed){error.textContent='Предыдущая отправка ещё не подтверждена. Начните новую запись, чтобы отправить изменённый текст.';error.dataset.attemptNotice='true';}else if(error.dataset.attemptNotice==='true'){error.textContent='';delete error.dataset.attemptNotice;}return !changed;}
    function remember(){if(sameOwner())saveDraft(scope,form.elements.body.value,clientId,form.dataset.parentId,attempt);}
    function setPending(value){pending=value;form.dataset.sending=String(value);form.elements.body.disabled=value;form.elements.photos.disabled=value||!online()||form.dataset.readonly==='true';form.querySelectorAll('button').forEach(button=>button.disabled=value);form.querySelector('[type="submit"]').disabled=value||!online()||form.dataset.readonly==='true';if(node.contains(form))node.querySelectorAll('[data-reply-note]').forEach(button=>button.disabled=value);}
    newButton.onclick=()=>{if(pending||!sameOwner())return;clientId=uuid();attempt=null;remember();checkAttempt();error.textContent='';hint.textContent='Новая запись подготовлена. Проверьте текст и нажмите «Отправить».';};
    if(draft.parentId){form.dataset.parentId=draft.parentId;const target=form.querySelector('[data-reply-target]');target.hidden=false;target.innerHTML='Ответ на запись <button type="button" data-cancel-reply aria-label="Отменить ответ">×</button>';target.querySelector('button').onclick=()=>{if(pending)return;delete form.dataset.parentId;target.hidden=true;remember();checkAttempt();};}
    form.elements.body.oninput=()=>{if(pending)return;remember();hint.textContent='Черновик сохранён на этом устройстве. Ещё не отправлен.';checkAttempt();};
    function previews(){const target=form.querySelector('[data-attachment-previews]');target.innerHTML=files.map((entry,index)=>`<span class="community-draft-photo"><img src="${html(entry.url)}" alt="Выбранное фото ${index+1}"><button type="button" data-remove-photo="${index}" aria-label="Убрать фото ${index+1}">×</button></span>`).join('');target.querySelectorAll('[data-remove-photo]').forEach(button=>button.onclick=()=>{if(pending)return;const [removed]=files.splice(Number(button.dataset.removePhoto),1);URL.revokeObjectURL(removed.url);previews();remember();checkAttempt();});}
    form.elements.photos.onchange=()=>{if(pending)return;const selected=[...form.elements.photos.files];error.textContent='';if(selected.length+files.length>3){error.textContent='К одной записи можно прикрепить не больше трёх фото.';form.elements.photos.value='';return;}for(const file of selected)files.push({file,url:URL.createObjectURL(file),clientId:uuid()});form.elements.photos.value='';previews();remember();checkAttempt();};
    form.onsubmit=async event=>{
      event.preventDefault();if(pending||!sameOwner())return;if(form.dataset.readonly==='true'){error.textContent='Сначала обновите общие данные. Текст сохранён как черновик.';return;}
      const body=form.elements.body.value.trim();if(!body&&!files.length){error.textContent='Напишите сообщение или прикрепите фото.';return;}
      if(!online()){error.textContent='Нет связи. Текст сохранён как черновик и ещё не отправлен.';remember();return;}
      if(!checkAttempt())return;attempt=fingerprint();remember();
      setPending(true);const button=form.querySelector('[type="submit"]');error.textContent='';
      try{const mediaIds=[];for(let i=0;i<files.length;i++){button.textContent=`Загружаем фото ${i+1}/${files.length}…`;if(!files[i].mediaId){if(!files[i].blob)files[i].blob=await compressPhoto(files[i].file);files[i].mediaId=(await uploadBlob(files[i].blob,files[i].clientId)).id;}mediaIds.push(files[i].mediaId);}button.textContent='Отправляем…';await onSend({body,clientId,mediaIds,...(form.dataset.parentId?{parentId:form.dataset.parentId}:{})});
        if(!sameOwner())return;clearDraft(scope);clientId=uuid();attempt=null;form.elements.body.value='';delete form.dataset.parentId;form.querySelector('[data-reply-target]').hidden=true;for(const item of files)URL.revokeObjectURL(item.url);files=[];previews();checkAttempt();hint.textContent='Отправлено в общую ленту.';
      }catch(e){if(sameOwner()){remember();error.textContent=e.message;hint.textContent='Текст черновика сохранён. Запись ещё не подтверждена.';}}
      finally{setPending(false);if(button.isConnected)button.textContent='Отправить';}
    };
    checkAttempt();
  }

  function itemMarkup(item,{editable=false,chatMode=false}={}){
    return `<article class="community-message ${own(item.author?.id)?'own':''} ${item.parentId?'reply':''}" data-message-id="${html(item.id)}"><header>${author(item.author)}<time datetime="${html(item.createdAt)}">${html(time(item.createdAt))}${item.updatedAt&&item.updatedAt!==item.createdAt?' · изменено':''}</time></header>${item.parentId?`<button type="button" class="community-parent-link" data-parent-note="${html(item.parentId)}">↳ Ответ на запись</button>`:''}${item.body?`<p class="community-message-body">${html(item.body)}</p>`:''}${photos(item.media||[])}${chatMode&&own(item.author?.id)?`<div class="community-message-tools"><button type="button" data-edit-chat="${html(item.id)}">Изменить</button><button type="button" data-delete-chat="${html(item.id)}">Удалить</button></div>`:editable?`<div class="community-message-tools"><button type="button" data-reply-note="${html(item.id)}">Ответить</button>${own(item.author?.id)?`<button type="button" data-edit-note="${html(item.id)}">Изменить</button><button type="button" data-delete-note="${html(item.id)}">Удалить</button>`:''}</div>`:''}</article>`;
  }
  function mergeItems(left,right){const map=new Map(left.map(item=>[String(item.id),item]));right.forEach(item=>map.set(String(item.id),item));return [...map.values()].sort((a,b)=>new Date(a.createdAt)-new Date(b.createdAt)||String(a.cursor||a.id).localeCompare(String(b.cursor||b.id)));}
  const listItems=result=>Array.isArray(result)?result:result?.items||[];
  function chatHost(){return document.querySelector('#community-view');}
  function renderChat(host,{keepScroll=false,prepend=false}={}){
    if(view!=='chat')return;
    if(!getUser()){host.innerHTML=`<div class="community-page"><header class="community-section-head"><div><span class="community-kicker">БРИГАДА №2</span><h2>Общий чат</h2></div></header><article class="community-card">${loginGate()}</article></div>`;bindLogin(host);return;}
    const old=host.querySelector('[data-chat-scroll]');const oldTop=old?.scrollTop||0,oldHeight=old?.scrollHeight||0;
    const savedComposer=host.querySelector('[data-compose="chat"][data-owner="'+CSS.escape(userKey())+'"]');
    const draft=old?host.querySelector('[data-compose] textarea')?.value:null;if(draft!=null)saveDraft('chat',draft,getDraft('chat').clientId);
    host.innerHTML=`<div class="community-page community-chat-page"><header class="community-section-head"><div><span class="community-kicker">НА СВЯЗИ С БРИГАДОЙ</span><h2>Общий чат</h2></div><button type="button" class="btn" data-chat-refresh ${chat.loading?'disabled':''}>Обновить</button></header>${sourceNotice({cached:chat.cached,at:chat.cacheAt})}${chat.error?`<p class="community-form-error" role="status">${html(chat.error)}</p>`:''}<section class="community-chat-feed community-card" aria-label="Сообщения бригады" data-chat-scroll><div class="community-load-older">${chat.hasOlder?'<button type="button" class="btn" data-chat-older>Предыдущие сообщения</button>':''}</div><div data-chat-messages>${chat.items.length?chat.items.map(item=>itemMarkup(item,{chatMode:true})).join(''):`<p class="community-empty">${chat.loading?'Загружаем сообщения…':chat.error?'Сообщения пока недоступны.':'Пока нет сообщений. Напишите первым.'}</p>`}</div></section>${chat.unread?`<button class="community-new-messages" type="button" data-chat-new>${chat.unread} новых ↓</button>`:''}${composeMarkup('chat','Сообщение бригаде')}</div>`;
    const scroller=host.querySelector('[data-chat-scroll]');
    if(savedComposer)host.querySelector('[data-compose="chat"]').replaceWith(savedComposer);
    composerAvailability(host.querySelector('[data-compose="chat"]'),chat.cached);
    requestAnimationFrame(()=>{scroller.scrollTop=keepScroll?oldTop+(prepend?Math.max(0,scroller.scrollHeight-oldHeight):0):scroller.scrollHeight;});
    bindPhotos(host);host.querySelector('[data-chat-refresh]').onclick=()=>loadChat({fresh:true});host.querySelector('[data-chat-older]')?.addEventListener('click',()=>loadChat({older:true}));
    host.querySelectorAll('[data-edit-chat]').forEach(button=>button.onclick=()=>editChat(chat.items.find(item=>String(item.id)===button.dataset.editChat),false));
    host.querySelectorAll('[data-delete-chat]').forEach(button=>button.onclick=()=>editChat(chat.items.find(item=>String(item.id)===button.dataset.deleteChat),true));
    host.querySelector('[data-chat-new]')?.addEventListener('click',()=>{scroller.scrollTop=scroller.scrollHeight;chat.unread=0;host.querySelector('[data-chat-new]')?.remove();});
    scroller.onscroll=()=>{if(scroller.scrollHeight-scroller.scrollTop-scroller.clientHeight<80){chat.unread=0;host.querySelector('[data-chat-new]')?.remove();}};
    if(!savedComposer)bindComposer(host,'chat',async message=>{const result=await api('/chat/messages',{method:'POST',body:message});const item=result.message||result.item||result;chat.items=mergeItems(chat.items,[item]);chat.error='';chat.cached=false;storage.set(cacheKey('/chat/messages?limit='+LIMIT),{data:{items:chat.items,nextCursor:chat.before},at:new Date().toISOString(),cached:false});setTimeout(()=>renderChat(host),0);});
  }
  function editChat(item,remove=false){
    if(!item)return;
    const node=openDialog(remove?'Удалить сообщение?':'Изменить сообщение',remove?'<p class="community-copy">Сообщение будет удалено из общего чата.</p><p class="community-form-error" role="alert"></p><button type="button" class="btn community-danger" data-delete-chat-confirm>Удалить сообщение</button>':`<form><label class="community-field">Текст сообщения<textarea name="body" rows="5" maxlength="4000">${html(item.body)}</textarea></label><p class="community-form-error" role="alert"></p><button type="submit" class="btn primary">Сохранить изменения</button></form>`);
    const action=async event=>{event.preventDefault();const button=node.querySelector('button[type="submit"], [data-delete-chat-confirm]');button.disabled=true;try{await api('/chat/messages/'+encodeURIComponent(item.id),{method:remove?'DELETE':'PATCH',...(!remove?{body:{body:node.querySelector('textarea').value.trim(),revision:item.revision}}:{})});closeDialog(node);await loadChat({fresh:true});}catch(error){node.querySelector('[role="alert"]').textContent=error.message;button.disabled=false;}};
    if(remove)node.querySelector('[data-delete-chat-confirm]').onclick=action;else node.querySelector('form').onsubmit=action;
  }
  async function loadChat({fresh=false,older=false,poll=false}={}){
    const host=chatHost();if(!getUser()||chat.loading||!host||view!=='chat')return;
    if(poll&&(!visible(host)||!online()))return;
    const scroller=host.querySelector('[data-chat-scroll]');const nearBottom=!scroller||scroller.scrollHeight-scroller.scrollTop-scroller.clientHeight<90;
    chat.loading=true;
    if(!chat.items.length)renderChat(host);
    try{
      const newest=chat.items.at(-1),before=chat.before||chat.items[0]?.cursor;
      const query=new URLSearchParams({limit:String(LIMIT)});
      if(older&&before)query.set('before',before);else if(poll&&newest)query.set('after',newest.cursor);
      const result=poll||older?{data:await api('/chat/messages?'+query),cached:false,at:new Date().toISOString()}:await read('/chat/messages?limit='+LIMIT);
      const incoming=listItems(result.data),oldIds=new Set(chat.items.map(x=>String(x.id)));
      chat.items=fresh?mergeItems([],incoming):mergeItems(chat.items,incoming);
      if(!poll){chat.before=result.data.nextCursor||result.data.nextBefore||incoming[0]?.cursor;chat.hasOlder=Boolean(result.data.hasMore??result.data.nextCursor??incoming.length>=LIMIT);}
      chat.cached=result.cached;chat.cacheAt=result.at;chat.error=result.cached?'':null;
      if(poll&&!nearBottom)chat.unread+=incoming.filter(item=>!oldIds.has(String(item.id))).length;
      if(!poll||incoming.length)renderChat(host,{keepScroll:older||poll&&!nearBottom,prepend:older});
    }catch(error){chat.error=error.message;if(!poll)renderChat(host,{keepScroll:true});}
    finally{chat.loading=false;host.querySelector('[data-chat-refresh]')?.removeAttribute('disabled');}
  }

  function mountObject(container,target){
    if(typeof container==='string')container=document.querySelector(container);
    if(!container||!target?.key)return;
    const record={kind:'object',target,container,result:null,loading:false,last:0};hosts.set(container,record);renderObject(record);loadObject(record).then(()=>{if(!currentObject(record))return;const focus=target.noteId||(pendingFocus?.key===target.key?pendingFocus.noteId:null);if(focus){pendingFocus=null;focusNote(record,focus);}});return ()=>{if(hosts.get(container)===record)hosts.delete(container);};
  }
  const currentObject=record=>record.container.isConnected&&hosts.get(record.container)===record;
  function renderObject(record){
    const {container,target,result}=record;if(!currentObject(record))return;
    const savedComposer=container.querySelector('[data-compose="'+CSS.escape(target.key)+'"][data-owner="'+CSS.escape(userKey())+'"]');
    if(!getUser()){container.innerHTML=`<section class="community-object"><h3>Общие записи</h3>${loginGate()}</section>`;bindLogin(container);return;}
    const status=result?.status?.data||{status:'unknown',revision:0};const notes=listItems(result?.notes?.data);
    const shared=status.author||status.updatedBy;
    container.innerHTML=`<section class="community-object"><header class="community-object-head"><div><span class="community-kicker">ДЛЯ ВСЕЙ БРИГАДЫ</span><h3>Общие записи</h3></div><button class="btn" type="button" data-object-refresh>Обновить</button></header>${sourceNotice(result?.notes?.cached?result.notes:result?.status?.cached?result.status:null)}${record.error?`<p class="community-form-error" role="status">${html(record.error)}</p>`:''}<form class="community-status-form" data-status-form><label class="community-field">Состояние объекта<select name="status" ${!online()?'disabled':''}>${Object.entries(STATUS).map(([key,label])=>`<option value="${key}" ${status.status===key?'selected':''}>${label}</option>`).join('')}</select></label><button class="btn" type="submit" ${!online()||!result?'disabled':''}>Сохранить состояние</button></form>${status.updatedAt?`<p class="community-status-by">${html(shared?.nickname||'Участник')} · ${html(time(status.updatedAt))}</p>`:''}<div class="community-object-feed">${notes.length?notes.map(item=>itemMarkup(item,{editable:true})).join(''):`<p class="community-empty">${record.loading&&!result?'Загружаем общие записи…':!result?'Общие записи пока недоступны.':'Общих записей пока нет.'}</p>`}</div>${result?.notes?.data?.nextCursor?'<button type="button" class="btn community-older-notes" data-notes-older>Более ранние записи</button>':''}${composeMarkup(target.key,'Запись об объекте')}</section>`;
    if(savedComposer)container.querySelector('[data-compose]')?.replaceWith(savedComposer);
    composerAvailability(container.querySelector('[data-compose]'),Boolean(result?.notes?.cached));
    if(result?.status?.cached)container.querySelectorAll('[data-status-form] select,[data-status-form] button').forEach(control=>control.disabled=true);
    bindPhotos(container);container.querySelector('[data-object-refresh]').onclick=()=>loadObject(record);
    container.querySelector('[data-notes-older]')?.addEventListener('click',()=>loadObject(record,true));
    container.querySelector('[data-status-form]').onsubmit=async event=>{event.preventDefault();const button=event.currentTarget.querySelector('button');button.disabled=true;button.textContent='Сохраняем…';try{await api('/objects/'+encodeURIComponent(target.key)+'/status',{method:'PUT',body:{status:event.currentTarget.elements.status.value,revision:status.revision}});await loadObject(record);notify('Состояние объекта сохранено.');}catch(e){record.error=e.message;if(e.status===409)await loadObject(record);else renderObject(record);}};
    if(!savedComposer)bindComposer(container,target.key,async message=>{await api('/objects/'+encodeURIComponent(target.key)+'/notes',{method:'POST',body:message});setTimeout(()=>loadObject(record),0);});
    container.querySelectorAll('[data-reply-note]').forEach(button=>{button.disabled=container.querySelector('[data-compose]')?.dataset.sending==='true';button.onclick=()=>{const form=container.querySelector('[data-compose]');if(!form||form.dataset.sending==='true')return;const note=notes.find(n=>String(n.id)===button.dataset.replyNote),reply=form.querySelector('[data-reply-target]');form.dataset.parentId=note.id;reply.hidden=false;reply.innerHTML=`Ответ: ${html(note.author?.nickname||'участник')}<button type="button" aria-label="Отменить ответ">×</button>`;reply.querySelector('button').onclick=()=>{if(form.dataset.sending==='true')return;delete form.dataset.parentId;reply.hidden=true;saveDraft(target.key,form.elements.body.value,getDraft(target.key).clientId);};saveDraft(target.key,form.elements.body.value,getDraft(target.key).clientId,note.id);form.elements.body.focus();};});
    container.querySelectorAll('[data-parent-note]').forEach(button=>button.onclick=()=>focusNote(record,button.dataset.parentNote));
    container.querySelectorAll('[data-edit-note]').forEach(button=>button.onclick=()=>editNote(record,notes.find(n=>String(n.id)===button.dataset.editNote)));
    container.querySelectorAll('[data-delete-note]').forEach(button=>button.onclick=()=>deleteNote(record,notes.find(n=>String(n.id)===button.dataset.deleteNote)));
  }
  async function loadObject(record,older=false){
    if(!currentObject(record)||record.loading||!getUser())return;
    record.loading=true;record.last=Date.now();
    try{const path='/objects/'+encodeURIComponent(record.target.key);const cursor=record.result?.notes?.data?.nextCursor;
      if(older&&cursor){const page=await api(path+'/notes?limit='+LIMIT+'&before='+encodeURIComponent(cursor));if(!currentObject(record))return;record.result.notes.data={...page,items:mergeItems(listItems(record.result.notes.data),listItems(page))};}
      else{const [status,notes]=await Promise.all([read(path+'/status'),read(path+'/notes?limit='+LIMIT)]);if(!currentObject(record))return;record.result={status,notes};}
      record.error='';
    }catch(error){record.error=error.message;}finally{record.loading=false;renderObject(record);}
  }
  function editNote(record,note){
    if(!note)return;
    const node=openDialog('Изменить запись',`<form data-edit-note-form><label class="community-field">Текст записи<textarea name="body" rows="5" maxlength="4000">${html(note.body)}</textarea></label><p class="community-form-error" role="alert"></p><button type="submit" class="btn primary">Сохранить изменения</button></form>`);
    const form=node.querySelector('form');form.onsubmit=async event=>{event.preventDefault();const button=form.querySelector('button');button.disabled=true;try{await api('/notes/'+encodeURIComponent(note.id),{method:'PATCH',body:{body:form.elements.body.value.trim(),revision:note.revision}});closeDialog(node);await loadObject(record);}catch(e){form.querySelector('[role="alert"]').textContent=e.message;button.disabled=false;}};
  }
  function deleteNote(record,note){
    if(!note)return;const node=openDialog('Удалить запись?',`<p class="community-copy">Запись будет удалена из общей ленты объекта.</p><p class="community-form-error" role="alert"></p><button type="button" class="btn community-danger" data-confirm-delete>Удалить запись</button>`);
    node.querySelector('[data-confirm-delete]').onclick=async event=>{const button=event.currentTarget;button.disabled=true;try{await api('/notes/'+encodeURIComponent(note.id),{method:'DELETE'});closeDialog(node);await loadObject(record);}catch(e){node.querySelector('[role="alert"]').textContent=e.message;button.disabled=false;}};
  }

  function mountSampling(container,padId){
    if(typeof container==='string')container=document.querySelector(container);if(!container)return;
    const record={kind:'sampling',container,padId:String(padId),result:null,loading:false,last:0};hosts.set(container,record);renderSampling(record);loadSampling(record);return()=>hosts.delete(container);
  }
  function samplingItem(result,padId){const value=result?.data;if(value?.padId)return value;return listItems(value).find(item=>String(item.padId)===padId)||{padId,sampled:false,revision:0};}
  function renderSampling(record){
    const {container,padId,result}=record;if(!container.isConnected)return;
    const item=samplingItem(result,padId),by=item.author||item.updatedBy;
    container.innerHTML=`<section class="community-sampling"><header><span class="community-sampling-icon ${result&&item.sampled?'done':''}" aria-hidden="true">${result&&item.sampled?'✓':'○'}</span><div><h3>Отбор проб</h3><p>${!getUser()?'Войдите, чтобы проверить отметку':!result?(record.error?'Нет данных об отборе':'Загружаем отметку…'):item.sampled?'Отбор отмечен':'Отбор не отмечен'}</p></div></header>${item.updatedAt?`<p class="community-sample-by">${html(by?.nickname||'Участник')} · ${html(time(item.updatedAt))}</p>`:''}${sourceNotice(result)}${record.error?`<p class="community-form-error" role="status">${html(record.error)}</p>`:''}${getUser()?`<button type="button" class="btn ${item.sampled?'':'primary'}" data-sample-toggle ${!online()||record.loading||!result||result.cached?'disabled':''}>${record.loading?'Загружаем…':item.sampled?'Сбросить отметку':'Отметить отбор'}</button>`:'<button class="btn" type="button" data-community-login>Войти для отметки</button>'}</section>`;
    bindLogin(container);container.querySelector('[data-sample-toggle]')?.addEventListener('click',async event=>{const button=event.currentTarget;button.disabled=true;button.textContent='Сохраняем…';try{await api('/samples/'+encodeURIComponent(padId),{method:'PUT',body:{sampled:!item.sampled,revision:item.revision}});await loadSampling(record);notify(item.sampled?'Отметка сброшена.':'Отбор проб отмечен.');}catch(e){record.error=e.message;if(e.status===409)await loadSampling(record);else renderSampling(record);}});
  }
  async function loadSampling(record){
    if(!record.container.isConnected||record.loading||!getUser())return;record.loading=true;record.last=Date.now();
    try{record.result=await read('/samples?padId='+encodeURIComponent(record.padId));record.error='';}catch(e){record.error=e.message;}finally{record.loading=false;renderSampling(record);}
  }
  function openView(next){
    if(next==='notifications'){view=next;return window.AtlasNotifications?.openView()||'';}
    if(!['profile','chat'].includes(next))return '';view=next;
    const host=document.querySelector('#community-view');if(!host)return '';
    host.dataset.communitySection=next;
    if(next==='profile')renderProfile(host);else{renderChat(host);loadChat({fresh:!chat.items.length});}
    return host.innerHTML;
  }
  function refreshVisible(){
    const host=chatHost();if(host&&visible(host)&&view==='profile')renderProfile(host);else if(host&&visible(host)&&view==='chat'){renderChat(host);if(getUser())loadChat({fresh:true});}
    for(const [node,record] of hosts){if(!node.isConnected){hosts.delete(node);continue;}if(record.kind==='object'){renderObject(record);loadObject(record);}else{renderSampling(record);loadSampling(record);}}
  }
  function poll(){
    if(!online()||!getUser()||document.visibilityState!=='visible')return;
    if(view==='chat'&&visible(chatHost()))loadChat({poll:true});
    for(const [node,record] of hosts){if(!node.isConnected){hosts.delete(node);continue;}if(visible(node)&&!node.contains(document.activeElement)&&Date.now()-record.last>30000){if(record.kind==='object')loadObject(record);else loadSampling(record);}}
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
  let pendingFocus=null;
  window.addEventListener('atlas-open-object',event=>{pendingFocus=event.detail;queueMicrotask(()=>{for(const record of hosts.values())if(record.kind==='object'&&record.target.key===pendingFocus?.key&&pendingFocus.noteId){focusNote(record,pendingFocus.noteId);pendingFocus=null;break;}});});
  function configureNativeNotifications(enabled){
    if(!window.SdngGps?.configureNotifications)throw new Error('Фоновые уведомления недоступны в этой версии приложения.');
    if(enabled&&(!authenticated()||!session.remember))throw new Error('Для фоновых уведомлений войдите с отметкой «Запомнить меня».');
    window.SdngGps.configureNotifications(enabled?String(window.ATLAS_API_BASE||'/api/v1'):'',enabled?session.token:'',Boolean(enabled));
  }
  window.Community=Object.freeze({openView,mountObject,mountSampling,getUser,api,renderObject:mountObject,renderSampling:mountSampling,auth:authModal,refresh:refreshVisible,sessionRemembered:()=>Boolean(authenticated()&&session.remember),configureNativeNotifications,focusNote:(key,id)=>{for(const record of hosts.values())if(record.kind==='object'&&record.target.key===key)return focusNote(record,id);pendingFocus={key,noteId:id};}});
  restore();
  scheduleExpiry();
  window.addEventListener('online',()=>{refreshVisible();poll();});
  window.addEventListener('offline',refreshVisible);
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')poll();});
  setInterval(poll,7000);
  if(authenticated()&&online())api('/me').then(result=>{if(session){const incoming=result.user||result;if(session.user.updatedAt&&incoming.updatedAt&&Date.parse(incoming.updatedAt)<Date.parse(session.user.updatedAt))return;session.user=incoming;saveSession(session,session.remember);refreshVisible();}}).catch(error=>{if(error.status!==401&&error.code!=='stale_session'){authNotice='Не удалось проверить вход. Показаны сохранённые данные.';refreshVisible();}});
})();
