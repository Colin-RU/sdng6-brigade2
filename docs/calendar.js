'use strict';
window.WorkCalendar=(()=>{
 const months=['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
 const holidayNames={'01-01':'Новогодние каникулы','01-02':'Новогодние каникулы','01-03':'Новогодние каникулы','01-04':'Новогодние каникулы','01-05':'Новогодние каникулы','01-06':'Новогодние каникулы','01-07':'Рождество Христово','01-08':'Новогодние каникулы','02-23':'День защитника Отечества','03-08':'Международный женский день','05-01':'Праздник Весны и Труда','05-09':'День Победы','06-12':'День России','11-04':'День народного единства'};
 const rules={
  2026:{extraOff:{'01-09':'Перенос с 3 января','03-09':'Выходной за 8 марта','05-11':'Выходной за 9 мая','12-31':'Перенос с 4 января'},extraWork:{},short:['04-30','05-08','06-11','11-03'],source:'https://static.government.ru/media/files/4jeB8hNKm69ggOa9yDiYOli6YoAyM21i.pdf',decree:'Постановление № 1466 от 24.09.2025'},
  2027:{extraOff:{'02-22':'Перенос с 20 февраля','05-03':'Выходной за 1 мая','05-10':'Выходной за 9 мая','06-14':'Выходной за 12 июня','11-05':'Перенос с 2 января','12-31':'Перенос с 3 января'},extraWork:{'02-20':'Рабочая суббота за 22 февраля'},short:['02-20','04-30','06-11','11-03'],source:'https://publication.pravo.gov.ru/document/0001202609180037',decree:'Постановление № 1187 от 17.09.2026'}
 };
 const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Yekaterinburg',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 let year=Math.min(2027,Math.max(2026,Number(today().slice(0,4)))),month=Number(today().slice(5,7))-1,selected=today(),tab='calendar',items=[],dutyItems=[],loading=false,generation=0,error='';
 const shiftDrafts=new Map(),DRAFT_KEY='atlas.calendar.drafts.v1';
 try{const saved=JSON.parse(localStorage.getItem(DRAFT_KEY)||'null');for(const [key,value] of saved?.drafts||[])if(typeof key==='string'&&value&&typeof value==='object')shiftDrafts.set(key,value);if(saved?.view&&[2026,2027].includes(saved.view.year)&&saved.view.month>=0&&saved.view.month<12){year=saved.view.year;month=saved.view.month;if(/^202[67]-\d{2}-\d{2}$/.test(saved.view.selected))selected=saved.view.selected;tab=saved.view.tab==='shifts'?'shifts':'calendar';}}catch{}
 function persistDrafts(){try{localStorage.setItem(DRAFT_KEY,JSON.stringify({drafts:[...shiftDrafts].slice(-300),view:{year,month,selected,tab}}));}catch{}}
 let activeRequest=null,refreshQueued=false,dataUser=null,loadedRange='',dutyReady=false;
 const e=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const iso=(y,m,d)=>`${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
 function day(date){const y=Number(date.slice(0,4)),md=date.slice(5),r=rules[y];if(!r)return null;const weekday=new Date(date+'T12:00:00Z').getUTCDay(),holiday=holidayNames[md],workOverride=r.extraWork[md],offOverride=r.extraOff[md],off=Boolean(holiday||offOverride||(!workOverride&&(weekday===0||weekday===6)));return{date,off,holiday:Boolean(holiday),short:!off&&r.short.includes(md),label:holiday||offOverride||workOverride||(off?'Выходной день':'Рабочий день'),workOverride:Boolean(workOverride)};}
 function totals(y,m){const last=m==null?365:new Date(Date.UTC(y,m+1,0)).getUTCDate();let work=0,off=0;for(let i=0;i<last;i++){const date=m==null?new Date(Date.UTC(y,0,i+1)).toISOString().slice(0,10):iso(y,m,i+1);day(date).off?off++:work++;}return{work,off};}
 function dateLabel(date){return new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'long',year:'numeric',timeZone:'Asia/Yekaterinburg'}).format(new Date(date+'T12:00:00+05:00'));}
 function shiftStart(s){return new Date(s.startAt||s.startsAt||s.start_at).getTime();}
 function shiftEnd(s){return new Date(s.endAt||s.endsAt||s.end_at).getTime();}
 function myShift(s){return (s.userId||s.user?.id||s.author?.id)===window.Community?.getUser()?.id;}
 function shiftLine(s){const user=s.user||s.author||{},start=shiftStart(s),end=shiftEnd(s),fmt=t=>new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',timeZone:'Asia/Yekaterinburg'}).format(t);return`<article class="shift-row"><span class="shift-dot"></span><div><b>${e(user.nickname||s.nickname||'Сотрудник')}</b><span>${Number.isFinite(start)&&Number.isFinite(end)?`${e(fmt(start))} — ${e(fmt(end))}`:e((s.kind==='night'?'Ночная смена':'Дневная смена')+' · время не указано')}</span>${s.note?`<small>${e(s.note)}</small>`:''}</div>${myShift(s)?`<button class="btn" data-shift-delete="${e(s.id)}" aria-label="Удалить мою смену">Удалить</button>`:''}</article>`;}
 const visible=()=>{const root=document.querySelector('#calendar-view');return Boolean(root&&!root.classList.contains('hidden')&&document.visibilityState==='visible');};
 const connected=()=>navigator.onLine!==false;
 const rangeKey=()=>`${year}-${String(month+1).padStart(2,'0')}`;
 const requestKey=()=>`${window.Community?.getUser()?.id||''}:${rangeKey()}:${today()}`;
 function onDate(s,date){return s.date===date||shiftStart(s)<new Date(date+'T23:59:59+05:00').getTime()&&shiftEnd(s)>new Date(date+'T00:00:00+05:00').getTime();}
 function dutyMarkup(){
  if(!window.Community?.getUser())return '<p>Войдите в профиль, чтобы видеть график коллег.</p><button class="btn primary" data-work-view="profile">Войти</button>';
  if(loading&&!dutyReady)return '<p>Загружаем смены…</p>';
  const current=Date.now(),onDuty=dutyItems.filter(s=>shiftStart(s)<=current&&shiftEnd(s)>current);
  return onDuty.length?onDuty.map(shiftLine).join(''):'<p>На это время смены ещё не добавлены.</p>';
 }
 function patchContent(node,html){if(node&&node.innerHTML!==html)node.innerHTML=html;}
 function patchDynamic(){
  const root=document.querySelector('#calendar-view');if(!root)return;
  patchContent(root.querySelector('#calendar-duty-list'),dutyMarkup());
  patchContent(root.querySelector('#calendar-selected-shifts'),items.filter(s=>onDate(s,selected)).map(shiftLine).join(''));
  const status=root.querySelector('#calendar-sync-error');if(status){status.textContent=error;status.hidden=!error;}
  for(const marker of root.querySelectorAll('[data-shift-marker]'))marker.hidden=!items.some(s=>onDate(s,marker.dataset.shiftMarker));
  const form=root.querySelector('#shift-form'),button=form?.querySelector('[type="submit"]');if(button)button.disabled=!connected()||form.dataset.saving==='true';
 }
 function render(){
  const root=document.querySelector('#calendar-view');if(!root)return;
  if(!selected.startsWith(rangeKey()))selected=iso(year,month,1);
  const key=JSON.stringify([year,month,selected,tab,window.Community?.getUser()?.id||null]);
  if(root.dataset.calendarRenderKey!==key||!root.querySelector('.calendar-layout')){renderStructure();root.dataset.calendarRenderKey=key;}
  else patchDynamic();
 }
 function renderStructure(){
  const root=document.querySelector('#calendar-view');if(!root)return;
  const previous=root.querySelector('#shift-form');if(previous&&!previous.dataset.shiftSaved){shiftDrafts.set(previous.dataset.shiftUser+':'+previous.dataset.shiftDate,{dirty:shiftDrafts.get(previous.dataset.shiftUser+':'+previous.dataset.shiftDate)?.dirty||false,kind:previous.querySelector('#shift-kind').value,start:previous.querySelector('#shift-start').value,end:previous.querySelector('#shift-end').value,note:previous.querySelector('#shift-note').value});}
  const stats=totals(year,month),annual=totals(year),days=new Date(Date.UTC(year,month+1,0)).getUTCDate(),offset=(new Date(Date.UTC(year,month,1)).getUTCDay()+6)%7,current=today();
  if(!selected.startsWith(`${year}-${String(month+1).padStart(2,'0')}`))selected=iso(year,month,1);
  const active=day(selected),logged=window.Community?.getUser(),now=Date.now(),onDuty=dutyItems.filter(s=>shiftStart(s)<=now&&shiftEnd(s)>now),dayShifts=items.filter(s=>s.date===selected||shiftStart(s)<new Date(selected+'T23:59:59+05:00').getTime()&&shiftEnd(s)>new Date(selected+'T00:00:00+05:00').getTime());
  const draft=shiftDrafts.get((logged?.id||'')+':'+selected)||{kind:'day',start:selected+'T08:00',end:selected+'T20:00',note:''};
  root.innerHTML=`<div class="calendar-switch" role="tablist"><button data-calendar-tab="calendar" class="${tab==='calendar'?'active':''}" role="tab" aria-selected="${tab==='calendar'}">Рабочие дни и праздники</button><button data-calendar-tab="shifts" class="${tab==='shifts'?'active':''}" role="tab" aria-selected="${tab==='shifts'}">Смены бригады</button></div><div class="calendar-layout"><section class="calendar-card"><div class="calendar-toolbar"><button class="icon-btn" data-calendar-move="-1" aria-label="Предыдущий месяц">‹</button><div><select id="calendar-month" aria-label="Месяц">${months.map((m,i)=>`<option value="${i}" ${month===i?'selected':''}>${m}</option>`).join('')}</select><select id="calendar-year" aria-label="Год">${[2026,2027].map(y=>`<option ${year===y?'selected':''}>${y}</option>`).join('')}</select></div><button class="icon-btn" data-calendar-move="1" aria-label="Следующий месяц">›</button></div><div class="calendar-weekdays">${['ПН','ВТ','СР','ЧТ','ПТ','СБ','ВС'].map(d=>`<span>${d}</span>`).join('')}</div><div class="calendar-grid">${'<span class="calendar-empty"></span>'.repeat(offset)}${Array.from({length:days},(_,i)=>{const date=iso(year,month,i+1),d=day(date),hasShift=items.some(s=>onDate(s,date));return`<button data-calendar-date="${date}" class="calendar-day ${d.off?'off':'work'} ${d.holiday?'holiday':''} ${d.short?'short':''} ${date===current?'today':''} ${selected===date?'selected':''}" aria-label="${e(dateLabel(date)+': '+d.label)}" aria-pressed="${selected===date}"><b>${i+1}</b>${d.short?'<small>−1 ч</small>':''}<i class="has-shift" data-shift-marker="${date}" aria-label="Есть смены" ${hasShift?'':'hidden'}></i></button>`;}).join('')}</div><div class="calendar-legend"><span><i class="holiday"></i>Праздник / выходной</span><span><i class="short"></i>Сокращённый день</span><span><i class="shift"></i>Есть смены</span></div><div class="calendar-totals"><span><b>${stats.work}</b> рабочих дней</span><span><b>${stats.off}</b> выходных</span><small>В ${year} году: ${annual.work} рабочих / ${annual.off} выходных</small></div><p class="calendar-source">Пятидневная рабочая неделя. Личные смены показаны отдельно.<br><a href="${rules[year].source}" target="_blank" rel="noopener">${rules[year].decree} ↗</a></p></section><section class="calendar-side"><article class="calendar-card"><div class="eyebrow">${e(dateLabel(selected))}</div><h2>${e(active.label)}</h2>${active.short?'<p>Продолжительность рабочего дня сокращена на один час.</p>':''}<p class="calendar-timezone">Время месторождения · UTC+5</p></article>${tab==='shifts'?`<article class="calendar-card"><h2>Сейчас на смене</h2><div id="calendar-duty-list" aria-live="polite">${dutyMarkup()}</div></article><article class="calendar-card"><h2>Смены на ${e(dateLabel(selected))}</h2><p id="calendar-sync-error" class="error-text" role="status" ${error?'':'hidden'}>${e(error)}</p><div id="calendar-selected-shifts">${dayShifts.map(shiftLine).join('')}</div>${logged?`<form id="shift-form" data-shift-date="${e(selected)}" data-shift-user="${e(logged?.id)}"><label class="form-field"><span>Тип смены</span><select id="shift-kind"><option value="day" ${draft.kind==='day'?'selected':''}>Дневная</option><option value="night" ${draft.kind==='night'?'selected':''}>Ночная</option></select></label><label class="form-field"><span>Моя смена: начало</span><input type="datetime-local" id="shift-start" value="${e(draft.start)}" required></label><label class="form-field"><span>Окончание</span><input type="datetime-local" id="shift-end" value="${e(draft.end)}" required></label><label class="form-field"><span>Примечание</span><input id="shift-note" value="${e(draft.note)}" maxlength="200" placeholder="Например: дневная смена"></label><button class="btn primary" type="submit" ${navigator.onLine?'':'disabled'}>Добавить мою смену</button><p class="form-help">Указывайте фактическое время по месторождению. Запись увидят коллеги.</p><p id="shift-error" class="error-text" role="alert"></p></form>`:'<p>Для добавления своего графика войдите в профиль.</p>'}</article>`:`<article class="calendar-card"><h2>График сотрудников</h2><p>Раздел смен позволяет видеть, кто работает сейчас, и добавлять свои смены. Праздники производственного календаря не заменяют личный график.</p><button class="btn" data-calendar-tab="shifts">Открыть смены бригады</button></article>`}</section></div>`;
 }
 async function loadShifts({force=false}={}){
  if(!visible())return;
  const user=window.Community?.getUser();
  if(!user){generation++;activeRequest?.controller.abort();refreshQueued=false;items=[];dutyItems=[];dataUser=null;loadedRange='';dutyReady=false;loading=false;error='';render();return;}
  if(dataUser!==user.id){items=[];dutyItems=[];loadedRange='';dutyReady=false;dataUser=user.id;error='';}
  if(loadedRange!==rangeKey())items=[];
  if(!connected()){error='Нет связи. Смены обновятся после подключения.';render();return;}
  const key=requestKey();
  if(activeRequest){if(force||activeRequest.key!==key)refreshQueued=true;if(activeRequest.key!==key)activeRequest.controller.abort();render();return;}
  const task={id:++generation,key,year,month,userId:user.id,controller:new AbortController()};activeRequest=task;loading=true;error='';render();
  try{
   const from=new Date(Date.UTC(task.year,task.month,-1)).toISOString().slice(0,10),to=iso(task.year,task.month,new Date(Date.UTC(task.year,task.month+1,0)).getUTCDate());
   const current=today(),dutyFrom=new Date(new Date(current+'T12:00:00Z').getTime()-2*86400000).toISOString().slice(0,10);
   const request=(begin,end)=>window.Community.api(`/shifts?from=${begin}&to=${end}`,{signal:task.controller.signal});
   const needDuty=dutyFrom<from||current>to;
   const [range,duty]=await Promise.all([request(from,to),needDuty?request(dutyFrom,current):Promise.resolve(null)]);
   if(task.id!==generation||task.key!==requestKey()||task.controller.signal.aborted||!visible()||!connected())return;
   items=range.items||[];dutyItems=duty?duty.items||[]:items;loadedRange=`${task.year}-${String(task.month+1).padStart(2,'0')}`;dutyReady=true;
  }catch(err){if(task.id===generation&&task.key===requestKey()&&!task.controller.signal.aborted)error=connected()?err.message:'Нет связи. Смены обновятся после подключения.';}
  finally{if(activeRequest===task){activeRequest=null;if(task.id===generation){loading=false;render();}if(refreshQueued){refreshQueued=false;if(visible()&&connected())queueMicrotask(()=>loadShifts());}}}
 }
 function pause(){generation++;activeRequest?.controller.abort();refreshQueued=false;loading=false;if(!connected())error='Нет связи. Смены обновятся после подключения.';if(visible())render();}
 function open(){render();loadShifts();}
 document.addEventListener('click',async event=>{const t=event.target.closest('[data-calendar-tab],[data-calendar-move],[data-calendar-date],[data-shift-delete]');if(!t)return;if(t.dataset.calendarTab){tab=t.dataset.calendarTab;render();if(tab==='shifts')loadShifts();}else if(t.dataset.calendarMove){let m=year*12+month+Number(t.dataset.calendarMove);m=Math.max(2026*12,Math.min(2027*12+11,m));year=Math.floor(m/12);month=m%12;loadShifts();}else if(t.dataset.calendarDate){selected=t.dataset.calendarDate;render();}else if(t.dataset.shiftDelete){t.disabled=true;try{await Community.api('/shifts/'+encodeURIComponent(t.dataset.shiftDelete),{method:'DELETE'});await loadShifts();}catch(err){t.disabled=false;error=err.message;render();}}});
 document.addEventListener('change',event=>{if(event.target.id==='calendar-month')month=Number(event.target.value);else if(event.target.id==='calendar-year')year=Number(event.target.value);else return;loadShifts();});
 document.addEventListener('submit',async event=>{
  if(event.target.id!=='shift-form')return;event.preventDefault();
  const form=event.target,submitted={kind:form.querySelector('#shift-kind').value,start:form.querySelector('#shift-start').value,end:form.querySelector('#shift-end').value,note:form.querySelector('#shift-note').value},key=form.dataset.shiftUser+':'+form.dataset.shiftDate,out=form.querySelector('#shift-error'),button=form.querySelector('[type="submit"]');
  if(!submitted.start||!submitted.end||new Date(submitted.end+'+05:00')<=new Date(submitted.start+'+05:00')){out.textContent='Окончание должно быть позже начала смены.';return;}
  const signature=draft=>JSON.stringify([draft.kind,draft.start,draft.end,draft.note]),submittedSignature=signature(submitted);
  button.disabled=true;form.dataset.saving='true';
  try{
   await Community.api('/shifts',{method:'POST',body:{date:submitted.start.slice(0,10),kind:submitted.kind,startAt:new Date(submitted.start+'+05:00').toISOString(),endAt:new Date(submitted.end+'+05:00').toISOString(),note:submitted.note.trim()}});
   const live=document.querySelector('#shift-form'),sameKey=live&&live.dataset.shiftUser+':'+live.dataset.shiftDate===key;
   let latest=shiftDrafts.get(key);
   if(sameKey)latest={kind:live.querySelector('#shift-kind').value,start:live.querySelector('#shift-start').value,end:live.querySelector('#shift-end').value,note:live.querySelector('#shift-note').value};
   if(latest&&signature(latest)===submittedSignature){shiftDrafts.delete(key);if(sameKey){live.dataset.shiftSaved='true';live.querySelector('#shift-error').textContent='';}}
   else if(latest){shiftDrafts.set(key,{...latest,dirty:true});if(sameKey){delete live.dataset.shiftSaved;live.querySelector('#shift-error').textContent='Смена сохранена. Новые изменения ещё не сохранены.';}}
   persistDrafts();await loadShifts({force:true});
  }catch(err){out.textContent=err.message;}
  finally{delete form.dataset.saving;button.disabled=!connected();}
 });
 const rememberDraft=event=>{const form=event.target.closest?.('#shift-form');if(!form)return;delete form.dataset.shiftSaved;shiftDrafts.set(form.dataset.shiftUser+':'+form.dataset.shiftDate,{dirty:true,kind:form.querySelector('#shift-kind').value,start:form.querySelector('#shift-start').value,end:form.querySelector('#shift-end').value,note:form.querySelector('#shift-note').value});persistDrafts();};
 document.addEventListener('input',rememberDraft);document.addEventListener('change',rememberDraft);
 window.addEventListener('atlas-auth-change',()=>{generation++;activeRequest?.controller.abort();loading=false;items=[];dutyItems=[];loadedRange='';dutyReady=false;dataUser=null;error='';if(visible()){render();loadShifts({force:true});}});
 document.addEventListener('visibilitychange',()=>{if(visible())loadShifts({force:true});else pause();});
 window.addEventListener('online',()=>{if(visible())loadShifts({force:true});});window.addEventListener('offline',pause);
 const calendarRoot=document.querySelector('#calendar-view');if(calendarRoot&&typeof MutationObserver!=='undefined')new MutationObserver(()=>{if(visible())loadShifts();else pause();}).observe(calendarRoot,{attributes:true,attributeFilter:['class']});
 setInterval(()=>{if(visible()&&connected())loadShifts();},5000);
 window.addEventListener('atlas-before-update',persistDrafts);window.addEventListener('beforeunload',persistDrafts);
 return{open,render,day,totals,rules,getUpdateState:()=>({busy:Boolean(document.querySelector('#shift-form[data-saving="true"]')),hasDraft:[...shiftDrafts].some(([key,value])=>key.startsWith((window.Community?.getUser()?.id||'guest')+':')&&value.dirty)})};
})();
