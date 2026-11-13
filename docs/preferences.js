'use strict';
const PREF_KEY='sdng6.brigade2.preferences';
let preferences={theme:'system',textSize:'normal',mapLayer:'geo',motion:'full'};
try{const p=JSON.parse(localStorage.getItem(PREF_KEY)||'null');if(p&&typeof p==='object')preferences={...preferences,...p};}catch{}
const appearanceMedia=matchMedia('(prefers-color-scheme: dark)');
const motionMedia=matchMedia('(prefers-reduced-motion: reduce)');
let themeTransitionTimer;
function systemAppearance(){
  if(window.isNativeAtlas&&window.SdngGps?.getSystemTheme){
    try{const value=String(window.SdngGps.getSystemTheme());if(value==='light'||value==='dark')return value;}catch{}
  }
  return appearanceMedia.matches?'dark':'light';
}
function applyPreferences(){
  preferences.theme=['light','dark','system'].includes(preferences.theme)?preferences.theme:'system';
  preferences.textSize=preferences.textSize==='large'?'large':'normal';
  preferences.motion=preferences.motion==='reduced'?'reduced':'full';
  preferences.mapLayer=['clean','original','geo'].includes(preferences.mapLayer)?preferences.mapLayer:'geo';
  const root=document.documentElement,previousTheme=root.dataset.theme;
  const theme=preferences.theme==='system'?systemAppearance():preferences.theme;
  const reduced=preferences.motion==='reduced'||motionMedia.matches;
  const changed=previousTheme!==theme;
  if(changed||reduced){
    clearTimeout(themeTransitionTimer);
    root.classList.toggle('theme-changing',Boolean(changed&&previousTheme&&!reduced));
  }
  root.dataset.motion=reduced?'reduced':'full';
  root.dataset.textSize=preferences.textSize;
  root.dataset.theme=theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content',theme==='dark'?'#102730':'#ffffff');
  // A font, map or motion choice must not repaint every road on the map.
  if(changed)window.dispatchEvent(new Event('atlas-theme-change'));
  if(changed&&root.classList.contains('theme-changing'))themeTransitionTimer=setTimeout(()=>root.classList.remove('theme-changing'),240);
}
applyPreferences();
appearanceMedia.addEventListener('change',()=>{if(preferences.theme==='system')applyPreferences();});
motionMedia.addEventListener('change',applyPreferences);
window.addEventListener('atlas-system-theme-change',()=>{if(preferences.theme==='system')applyPreferences();});
function savePreferences(){applyPreferences();try{localStorage.setItem(PREF_KEY,JSON.stringify(preferences));}catch{toast('Настройки действуют в текущем сеансе.');}}
function renderSettings(){
  const offline=document.querySelector('#offline-state').textContent.includes('Доступен без сети');
  document.querySelector('#settings-view').innerHTML=`<div class="settings-grid"><article class="settings-card"><div class="eyebrow">КАК ВАМ УДОБНЕЕ</div><h2>Оформление</h2><div class="theme-options" aria-label="Тема оформления">${[['light','Светлая'],['dark','Тёмная'],['system','Как в телефоне']].map(([id,label])=>`<button class="theme-option ${preferences.theme===id?'active':''}" data-theme-choice="${id}" aria-pressed="${preferences.theme===id}"><span class="theme-preview ${id}" aria-hidden="true"></span>${label}</button>`).join('')}</div><div class="settings-row"><div><span class="settings-label">Размер текста</span><p class="settings-copy">Увеличьте номера и подписи для чтения на ходу.</p></div><select class="setting-switch" id="text-size" aria-label="Размер текста"><option value="normal" ${preferences.textSize==='normal'?'selected':''}>Обычный</option><option value="large" ${preferences.textSize==='large'?'selected':''}>Крупный</option></select></div><div class="settings-row"><div><span class="settings-label">Анимации</span><p class="settings-copy">Плавные переходы и подсветка выбранных объектов.</p></div><select class="setting-switch" id="motion-setting" aria-label="Анимации"><option value="full" ${preferences.motion!=='reduced'?'selected':''}>Включены</option><option value="reduced" ${preferences.motion==='reduced'?'selected':''}>Минимум</option></select></div></article><article class="settings-card"><h2>Карта и навигация</h2><div class="settings-row"><div><span class="settings-label">Карта при открытии</span><p class="settings-copy">Выберите привычный вид карты.</p></div><select class="setting-switch" id="default-map" aria-label="Карта при открытии"><option value="clean" ${preferences.mapLayer==='clean'?'selected':''}>Схема кустов</option><option value="original" ${preferences.mapLayer==='original'?'selected':''}>Фото схемы</option><option value="geo" ${preferences.mapLayer==='geo'?'selected':''}>GPS-карта</option></select></div><div class="settings-row"><div><span class="settings-label">Моё местоположение</span><p class="settings-copy">Покажет вашу точку и ближайшие кусты с сохранёнными координатами.</p></div><button class="btn" data-action="gps">${icon('gps')}Где я?</button></div><p class="settings-note">Для поездки введите номер куста и нажмите «Маршрут». Отправление — от вашего текущего местоположения. Все 32 куста уже имеют точки въезда. Маршруты рассчитываются внутри сохранённого района.</p></article><article class="settings-card"><h2>Всегда под рукой</h2><span class="status-chip">${offline?'✓ Атлас доступен без сети':'Подготовка доступа без сети'}</span><p class="settings-copy">Сохраните приложение на главный экран. Реестр и схема останутся под рукой даже без связи.</p><div class="settings-buttons"><button class="btn primary" data-action="install">${icon('download')}На главный экран</button><button class="btn" data-action="offline-prepare">Готовность без связи</button></div><p class="settings-note">Дороги сохранённой области и маршруты работают без сети. Для определения положения разрешите приложению доступ к GPS.</p></article><article class="settings-card"><h2>Мои данные</h2><p class="settings-copy">Избранное, заметки и GPS-точки сохраняются на этом телефоне. Сделайте копию, чтобы перенести их на другое устройство.</p><div class="settings-buttons"><button class="btn" data-action="export">${icon('download')}Сохранить копию</button><button class="btn" data-action="import">Загрузить копию</button></div><p class="settings-note">Если очистить данные приложения или браузера, личные записи могут удалиться. Сохранённая копия позволит их восстановить.</p></article></div>`;
}
document.addEventListener('click',e=>{const b=e.target.closest('[data-theme-choice]');if(!b)return;preferences.theme=b.dataset.themeChoice;savePreferences();document.querySelectorAll('[data-theme-choice]').forEach(el=>{el.classList.toggle('active',el.dataset.themeChoice===preferences.theme);el.setAttribute('aria-pressed',String(el.dataset.themeChoice===preferences.theme));});});
document.addEventListener('change',e=>{const id=e.target.id;if(id==='text-size')preferences.textSize=e.target.value;else if(id==='motion-setting')preferences.motion=e.target.value;else if(id==='default-map')preferences.mapLayer=e.target.value;else return;savePreferences();});
