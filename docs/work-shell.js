'use strict';
(() => {
 const extraViews=new Set(['profile','chat','notifications','calendar','equipment','samples','downloads']);
 const viewLabels={profile:'Мой профиль',chat:'Чат бригады',notifications:'Уведомления',calendar:'Производственный календарь',equipment:'Оборудование кустов',samples:'Отбор проб',downloads:'Загруженные карты'};
 const viewCopy={profile:'Ваши данные и настройки входа.',chat:'Общий разговор и фотографии коллег.',notifications:'Ответы на ваши записи — всё в одном месте.',calendar:'Рабочие дни, праздники и смены сотрудников.',equipment:'Состояние, общие записи и фотографии оборудования.',samples:'Отметки бригады об отборе проб.',downloads:'Сохраните район месторождения для поездок без связи.'};
 const equipment=[['agzu','АГЗУ','drop'],['btma','БТМА','settings'],['bg','БГ','settings'],['drainage','Дренажная ёмкость','drop'],['control-stations','Станции управления','settings'],['cable-racks','Эстакада','settings']];
 const statusLabels={unknown:'Нет сведений',ok:'Работает',attention:'Нужно внимание',stopped:'Остановлен',absent:'Отсутствует'};
 const baseView=setView,baseDrawer=renderDrawer,baseWell=renderWellDetail;
 let lastView='map',menuOpen=false,menuFocus,selectedEquipmentPad='162',equipmentRequest=0,sampleRequest=0,pendingObject=null;
 const padTabs=new Map(),equipmentLoads=new WeakMap(),equipmentBusy=new WeakSet();
 let sampleBusy=false;
 let headerPhotoKey=null,headerPhotoURL=null;
 const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const user=()=>window.Community?.getUser();
 const ready=()=>typeof data==='object'&&data?.pads;
 const cacheTime=value=>new Date(value).toLocaleString('ru-RU',{timeZone:'Asia/Yekaterinburg',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
 function closeMenu(restore=true){if(!menuOpen)return;menuOpen=false;document.documentElement.classList.remove('work-menu-open');document.querySelector('#work-menu').classList.add('hidden');document.querySelector('#work-menu-backdrop').classList.add('hidden');document.querySelector('#work-menu-toggle').setAttribute('aria-expanded','false');if(document.querySelector('#drawer').classList.contains('hidden'))document.querySelector('.app-shell').inert=false;if(restore)menuFocus?.focus({preventScroll:true});}
 function toggleMenu(){if(menuOpen){closeMenu();return;}menuFocus=document.activeElement;menuOpen=true;document.documentElement.classList.add('work-menu-open');document.querySelector('#work-menu').classList.remove('hidden');document.querySelector('#work-menu-backdrop').classList.remove('hidden');document.querySelector('#work-menu-toggle').setAttribute('aria-expanded','true');document.querySelector('.app-shell').inert=true;document.querySelector('#work-menu [data-work-view]')?.focus();}
 async function headerProfile(){
  const u=user(),name=u?.nickname||'Войти в профиль';
  document.querySelectorAll('[data-profile-name]').forEach(el=>el.textContent=name);document.querySelectorAll('[data-profile-position]').forEach(el=>el.textContent=u?(u.position==='master'?'Мастер':`Оператор · ${u.grade} разряд`):'Профиль сотрудника');document.querySelectorAll('[data-profile-initial]').forEach(el=>el.textContent=u?.nickname?.trim()?.slice(0,1).toLocaleUpperCase('ru-RU')||'');document.querySelector('#header-profile')?.setAttribute('aria-label',name);
  const key=u?.avatarMediaId?`${u.id}:${u.avatarMediaId}`:null;if(key===headerPhotoKey)return;headerPhotoKey=key;
  document.querySelectorAll('.header-user-photo').forEach(el=>el.remove());if(headerPhotoURL){URL.revokeObjectURL(headerPhotoURL);headerPhotoURL=null;}
  if(!key)return;try{const photo=await Community.api('/media/'+encodeURIComponent(u.avatarMediaId),{response:'blob'});if(key!==headerPhotoKey||user()?.id!==u.id)return;headerPhotoURL=URL.createObjectURL(photo);document.querySelectorAll('#header-profile,.menu-avatar').forEach(container=>{const image=document.createElement('img');image.className='header-user-photo';image.alt='';image.src=headerPhotoURL;container.append(image);});}catch{}
 }
 function hideExtras(){for(const id of ['community-view','calendar-view','equipment-view','samples-view','downloads-view'])document.querySelector('#'+id)?.classList.add('hidden');}
 setView=function(view){
  document.documentElement.dataset.activeView=view;
  closeMenu(false);if(!ready()){toast('Реестр ещё загружается. Попробуйте через несколько секунд.');return;}
  hideExtras();
  if(!extraViews.has(view)){baseView(view);lastView=view;}
  else{
   baseView('info');document.querySelector('#info-view').classList.add('hidden');currentView=view;lastView=view;
   document.querySelector('#page-title').textContent=viewLabels[view];document.querySelector('#page-subtitle').textContent=viewCopy[view];
   const section=['profile','chat','notifications'].includes(view)?'community':view;
   document.querySelector('#'+section+'-view').classList.remove('hidden');
   if(['profile','chat','notifications'].includes(view))Community.openView(view);
   if(view==='calendar')WorkCalendar.open();
   if(view==='equipment')renderEquipment();
   if(view==='samples')renderSamples();
   if(view==='downloads')MapPacks.render(document.querySelector('#downloads-view'));
   if(matchMedia('(max-width:600px)').matches)window.scrollTo({top:0,behavior:preferences.motion==='reduced'?'auto':'smooth'});
  }
  document.querySelectorAll('[data-work-view]').forEach(el=>{if(el.dataset.workView===view)el.setAttribute('aria-current','page');else el.removeAttribute('aria-current');});
  document.dispatchEvent(new CustomEvent('atlas-view-change',{detail:{view}}));
 };
 function loginPanel(copy='Войдите в профиль, чтобы видеть общие данные бригады.'){return`<div class="work-login"><span class="work-login-icon">${icon('people')}</span><h2>Работаем одной бригадой</h2><p>${escape(copy)}</p><button class="btn primary" data-work-view="profile">Войти или создать профиль</button></div>`;}
 function equipmentGrid(pad){
  const found=data.pads.find(p=>p.id===pad),positions=found?.positions?.length?found.positions:[{id:1,label:null,shortLabel:null}],multiple=positions.length>1;
  const groups=positions.map(position=>`<section class="equipment-position-block" data-equipment-position="${position.id}">${position.label?`<header class="position-heading"><span>${escape(position.shortLabel)}</span><div><b>${escape(position.label)}</b><small>Оборудование и записи этой позиции</small></div></header>`:''}<div class="equipment-grid">${equipment.map(([kind,label,shape])=>{const key=multiple?`equipment:${pad}:p${position.id}:${kind}`:`equipment:${pad}:${kind}`;return`<button class="equipment-card" data-equipment-key="${kind}" data-equipment-pad="${escape(pad)}" data-equipment-object="${escape(key)}" data-equipment-position="${position.id}"><span class="equipment-symbol">${icon(shape)}</span><strong>${label}</strong><span class="equipment-state" data-equipment-state="${escape(key)}">${user()?'Загружаем состояние…':'Общие записи и фото'}</span>${icon('chevron')}</button>`;}).join('')}</div></section>`).join('');
  return`<div class="equipment-positions">${groups}</div><p class="equipment-hint">Разделы для записей по оборудованию${multiple?' каждой позиции':''}. Наличие и состояние уточняются бригадой.</p><div class="equipment-object"></div>`;
 }
 async function loadEquipmentStatuses(root,pad){if(equipmentBusy.has(root))return;equipmentBusy.add(root);try{const request=(equipmentLoads.get(root)||0)+1;equipmentLoads.set(root,request);if(!user())return;await Promise.allSettled([...root.querySelectorAll('[data-equipment-object]')].map(async button=>{const key=button.dataset.equipmentObject;try{const result=await Community.api('/objects/'+encodeURIComponent(key)+'/status');if(request!==equipmentLoads.get(root)||!root.isConnected)return;const el=root.querySelector(`[data-equipment-state="${key}"]`);if(el){el.textContent=statusLabels[result.status]||statusLabels.unknown;el.dataset.status=result.status;button.dataset.equipmentStatus=result.status;}}catch{const el=root.querySelector(`[data-equipment-state="${key}"]`);if(request===equipmentLoads.get(root)&&el)el.textContent=navigator.onLine?'Не удалось обновить':'Нет связи';}}));}finally{equipmentBusy.delete(root);}}
 function renderEquipment(){const root=document.querySelector('#equipment-view');if(!root||!ready())return;if(!data.pads.some(p=>p.id===selectedEquipmentPad&&p.id!=='ОД'))selectedEquipmentPad='162';root.innerHTML=`<div class="equipment-heading"><label>Куст <select id="equipment-pad" aria-label="Выберите куст">${data.pads.filter(p=>p.id!=='ОД').map(p=>`<option value="${escape(p.id)}" ${p.id===selectedEquipmentPad?'selected':''}>${escape(p.id)}</option>`).join('')}</select></label><button class="btn" data-open-pad="${escape(selectedEquipmentPad)}">Карточка куста ${icon('arrow')}</button></div>${equipmentGrid(selectedEquipmentPad)}`;loadEquipmentStatuses(root,selectedEquipmentPad);}
 function sampleCard(item){
  const pad=data.pads.find(p=>p.id===item.padId),total=item.totalWells??new Set(pad?.wells.filter(w=>w.type==='production'&&w.method!=='fountain').map(w=>w.id)).size,count=item.sampledCount??(item.sampled?total:0),partial=item.progress==='partial'||count>0&&count<total;
  const label=item.sampled?'Пробы отобраны':partial?'Отобрана часть куста':'Нет отметки';
  return `<button class="sample-card ${item.sampled?'done':partial?'partial':''}" data-open-sampling="${escape(item.padId)}"><div><small>КУСТ</small><b>${escape(item.padId)}</b></div><span>${label}<small>${count} из ${total} добывающих</small>${item.updatedAt?`<small>${escape(item.author?.nickname||'Сотрудник')} · ${escape(cacheTime(item.updatedAt))}</small>`:''}</span>${icon('chevron')}</button>`;
 }
 async function renderSamples(background=false){
  if(sampleBusy)return;const root=document.querySelector('#samples-view'),request=++sampleRequest;if(!root||!ready())return;
  if(!user()){root.innerHTML=loginPanel('Общие отметки отбора проб доступны сотрудникам после входа.');return;}
  if(!background||!root.querySelector('.sample-grid'))root.innerHTML='<div class="work-loading">Обновляем отбор проб…</div>';sampleBusy=true;
  try{
   const response=await Community.api('/samples');if(request!==sampleRequest||!root.isConnected)return;if(!Community.acceptSamplingPeriod(response.period)){const current=Community.getSamplingPeriod();if(!current||current.key!==response.period?.key||current.isBreak!==response.period?.isBreak)return;}
   const eligible=new Set(data.pads.filter(p=>p.id!=='ОД'&&!p.samplingExcluded).map(p=>p.id)),items=(response.items||[]).filter(item=>eligible.has(item.padId)),done=items.filter(x=>x.sampled).length,partial=items.filter(x=>x.progress==='partial').length,signature=JSON.stringify([response.period.key,response.period.isBreak,response.period.startDate,response.period.endDate,items]);
   if(background&&root.dataset.sampleSignature===signature)return;root.dataset.sampleSignature=signature;root.dataset.samplePeriodKey=response.period.key;
   root.innerHTML=`<div data-samples-period>${Community.samplingPeriodMarkup(response.period)}</div><div class="sample-summary"><div><b>${done}<small> / ${eligible.size}</small></b><span>кустов отобрано полностью</span></div><p>${partial?`Частично отобрано: ${partial}. `:''}Откройте куст, чтобы отметить отдельные добывающие скважины или весь куст.</p></div><div class="sample-grid">${items.map(sampleCard).join('')}</div>`;
  }catch(err){if(request===sampleRequest&&(!background||!root.querySelector('.sample-grid')))root.innerHTML=`<div class="work-login"><h2>Не удалось обновить отметки</h2><p>${escape(err.message)}</p><button class="btn" data-work-refresh="samples">Повторить</button></div>`;}
  finally{sampleBusy=false;}
 }
 function selectPadTab(tab){const drawer=document.querySelector('#drawer'),pad=selectedPad;if(!pad)return;if(tab==='sampling'&&pad.samplingExcluded)tab='wells';padTabs.set(pad.id,tab);drawer.querySelectorAll('[data-pad-tab]').forEach(button=>{const active=button.dataset.padTab===tab;button.classList.toggle('active',active);button.setAttribute('aria-selected',String(active));});drawer.querySelectorAll('[data-pad-pane]').forEach(pane=>pane.classList.toggle('hidden',pane.dataset.padPane!==tab));if(tab==='equipment'){const pane=drawer.querySelector('[data-pad-pane="equipment"]');pane.innerHTML=equipmentGrid(pad.id);loadEquipmentStatuses(pane,pad.id);}if(tab==='sampling')Community.mountSampling(drawer.querySelector('[data-pad-pane="sampling"]'),pad.id);if(tab==='notes')Community.mountObject(drawer.querySelector('[data-pad-pane="notes"]'),{key:`pad:${pad.id}`,label:`Куст ${pad.id}`,padId:pad.id});}
 renderDrawer=function(){baseDrawer();const pad=selectedPad;if(!pad||pad.id==='ОД')return;document.querySelector('#drawer .drawer-actions')?.insertAdjacentHTML('beforeend',`<button class="btn" type="button" data-share-pad="${escape(pad.id)}" aria-label="Поделиться кустом ${escape(pad.id)} в чате">${icon('people')}В чат</button>`);const body=document.querySelector('#drawer .drawer-body'),children=[...body.childNodes],wells=document.createElement('section');wells.dataset.padPane='wells';wells.append(...children);body.append(wells);const composition=document.createElement('details');composition.className='pad-composition';composition.innerHTML='<summary>Состав куста и обозначения</summary>';for(const selector of ['.atlas-donut','.type-summary']){const child=wells.querySelector(selector);if(child)composition.append(child);}wells.querySelector(':scope > .small-label')?.remove();wells.prepend(composition);body.insertAdjacentHTML('beforeend','<section class="hidden" data-pad-pane="equipment"></section><section class="hidden" data-pad-pane="sampling"></section><section class="hidden" data-pad-pane="notes"></section>');document.querySelector('#drawer .drawer-head').insertAdjacentHTML('afterend',`<nav class="pad-work-tabs" role="tablist" aria-label="Разделы куста">${[['wells','Скважины'],['equipment','Оборудование'],['sampling','Пробы'],['notes','Записи куста']].filter(([key])=>key!=='sampling'||!pad.samplingExcluded).map(([key,label])=>`<button data-pad-tab="${key}" role="tab">${label}</button>`).join('')}</nav>`);selectPadTab(selectedWell?'wells':padTabs.get(pad.id)||'wells');};
 function wellNotesTarget(pad,id,detail={}){const well=pad.wells.find(value=>value.id===id);return {...detail,key:`well:${pad.id}:${id}`,label:`${wellDisplayName(well||{id})}${pad.id==='ОД'?'':` · куст ${pad.id}`}${well?.position?` · ${well.position}-я позиция`:''}`,padId:pad.id,savedText:typeof local.notes[wellKey(pad.id,id)]==='string'?local.notes[wellKey(pad.id,id)]:''};}
 renderWellDetail=function(id){baseWell(id);const detail=document.querySelector('#well-detail');if(!detail||!selectedPad)return;detail.insertAdjacentHTML('beforeend','<section class="well-shared-panel"><div class="well-shared-content"></div></section>');Community.mountObject(detail.querySelector('.well-shared-content'),wellNotesTarget(selectedPad,id));};
 function openObject(detail){const parts=String(detail.key||'').split(':'),[kind,pad,object]=parts;if(!ready()){pendingObject=detail;return;}if(!data.pads.some(p=>p.id===pad))return;closeMenu(false);openPad(pad,kind==='well'?object:undefined);if(kind==='well'){const found=data.pads.find(value=>value.id===pad),container=document.querySelector('#well-detail .well-shared-content');if(container)Community.mountObject(container,wellNotesTarget(found,object,detail));}else if(kind==='equipment'){selectPadTab('equipment');const container=document.querySelector('#drawer .equipment-object');Community.mountObject(container,{...detail,padId:pad,label:detail.label||`${equipment.find(x=>x[0]===parts.at(-1))?.[1]||'Оборудование'} · куст ${pad}${parts.length===4?` · ${parts[2].slice(1)}-я позиция`:''}`});}else{selectPadTab('notes');Community.mountObject(document.querySelector('#drawer [data-pad-pane="notes"]'),{...detail,padId:pad,label:detail.label||`Куст ${pad}`});}}
 document.addEventListener('click',event=>{
  if(event.target.closest('#work-menu-toggle')){toggleMenu();return;}if(event.target.closest('#work-menu-backdrop,[data-close-work-menu]')){closeMenu();return;}
  const view=event.target.closest('[data-work-view]');if(view){setView(view.dataset.workView);return;}
  const tab=event.target.closest('[data-pad-tab]');if(tab){selectPadTab(tab.dataset.padTab);return;}
  const equip=event.target.closest('[data-equipment-key]');if(equip){const pad=equip.dataset.equipmentPad,key=equip.dataset.equipmentKey,container=equip.closest('[data-pad-pane],#equipment-view').querySelector('.equipment-object');Community.mountObject(container,{key:equip.dataset.equipmentObject,label:`${equipment.find(x=>x[0]===key)[1]} · куст ${pad}${data.pads.find(p=>p.id===pad)?.positions?.length>1?` · ${equip.dataset.equipmentPosition}-я позиция`:''}`,padId:pad});container.scrollIntoView({behavior:preferences.motion==='reduced'?'auto':'smooth',block:'start'});return;}
  const share=event.target.closest('[data-share-pad]');if(share){const pad=share.dataset.sharePad;if(!data.pads.some(item=>item.id===pad&&item.id!=='ОД'))return;if(typeof Community.preparePadShare!=='function'){toast('Чат ещё загружается. Повторите через несколько секунд.');return;}closeDrawer();Community.preparePadShare(pad);return;}
  const sampling=event.target.closest('[data-open-sampling]');if(sampling){openPad(sampling.dataset.openSampling);selectPadTab('sampling');return;}
  const pad=event.target.closest('[data-open-pad]');if(pad){openPad(pad.dataset.openPad);return;}
  const refresh=event.target.closest('[data-work-refresh]');if(refresh){refresh.dataset.workRefresh==='samples'?renderSamples():renderEquipment();return;}
  if(event.target.closest('[data-action="install"]'))closeMenu(false);
 });
 document.addEventListener('change',event=>{if(event.target.id==='equipment-pad'){selectedEquipmentPad=event.target.value;renderEquipment();}});
 document.addEventListener('keydown',event=>{if(event.key==='Escape'&&menuOpen){event.preventDefault();closeMenu();}if(event.key==='Tab'&&menuOpen){const buttons=[...document.querySelectorAll('#work-menu button')].filter(el=>!el.disabled),first=buttons[0],last=buttons.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}});
 window.addEventListener('atlas-open-object',event=>openObject(event.detail||{}));
 window.addEventListener('atlas-auth-change',()=>{headerProfile();if(lastView==='samples')renderSamples();if(lastView==='equipment')renderEquipment();});
 window.addEventListener('atlas-notifications-count',event=>{const count=Number(event.detail?.count??event.detail)||0;document.querySelectorAll('[data-notification-count]').forEach(el=>{el.textContent=count>99?'99+':String(count);el.classList.toggle('hidden',count===0);});});
 window.addEventListener('atlas-ready',()=>{headerProfile();if(pendingObject){const detail=pendingObject;pendingObject=null;openObject(detail);}});headerProfile();
 function refreshShared(){
  if(!ready()||!user()||navigator.onLine===false||document.visibilityState!=='visible')return;
  const equipmentView=document.querySelector('#equipment-view');if(equipmentView?.getClientRects().length)loadEquipmentStatuses(equipmentView,selectedEquipmentPad);
  const pane=document.querySelector('#drawer [data-pad-pane="equipment"]');if(pane?.getClientRects().length&&selectedPad)loadEquipmentStatuses(pane,selectedPad.id);
  if(document.querySelector('#samples-view')?.getClientRects().length)renderSamples(true);
 }
 setInterval(refreshShared,4000);
 window.addEventListener('atlas-community-change',event=>{if(event.detail?.type==='profile')headerProfile();refreshShared();});
 window.addEventListener('online',refreshShared);document.addEventListener('visibilitychange',refreshShared);
 function updateSamplingPeriod(){const root=document.querySelector('#samples-view'),period=Community.getSamplingPeriod?.();if(root?.querySelector('[data-samples-period]'))root.querySelector('[data-samples-period]').innerHTML=Community.samplingPeriodMarkup(period);if(period&&root?.dataset.samplePeriodKey&&root.dataset.samplePeriodKey!==period.key){root.querySelector('.sample-summary')?.setAttribute('hidden','');root.querySelector('.sample-grid')?.setAttribute('hidden','');if(!root.querySelector('[data-samples-transition]'))root.insertAdjacentHTML('beforeend','<p class="work-loading" data-samples-transition>Обновляем отметки нового круга…</p>');}if(root?.getClientRects().length&&navigator.onLine!==false)renderSamples(true);}
 window.addEventListener('atlas-sampling-period',updateSamplingPeriod);
 window.addEventListener('atlas-sampling-period-expired',updateSamplingPeriod);
 window.addEventListener('atlas-open-sampling',()=>setView('samples'));
 window.WorkShell={openObject,closeMenu,openView:view=>setView(view)};
})();
