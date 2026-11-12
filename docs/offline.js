'use strict';
async function offlineRequest(type){
  const registration=await navigator.serviceWorker?.getRegistration('./');
  const worker=registration?.active;
  if(!worker)throw new Error('Подключитесь к интернету и откройте атлас ещё раз.');
  return new Promise((resolve,reject)=>{const channel=new MessageChannel();const timer=setTimeout(()=>{channel.port1.close();reject(new Error('Подготовка ещё продолжается. Повторите проверку чуть позже.'));},25000);channel.port1.onmessage=e=>{clearTimeout(timer);channel.port1.close();resolve(e.data);};worker.postMessage({type},[channel.port2]);});
}
async function prepareForOffline(){
  showModal('Работа без связи',`<p class="modal-copy" id="offline-check-message">${navigator.onLine?'Сохраняем атлас на телефоне…':'Проверяем сохранённый атлас…'}</p><div id="offline-check-details"></div>`);
  try{
    const result=await offlineRequest(navigator.onLine?'PREPARE_OFFLINE':'CHECK_OFFLINE_STATUS');
    if(result.ready){
      $('#offline-check-message').innerHTML='<span class="offline-ready-mark">✓</span><strong>Готов к работе без интернета</strong>';
      $('#offline-check-details').innerHTML='<div class="offline-checklist"><span>✓ Реестр всех кустов и скважин</span><span>✓ Схема проезда и её фото</span><span>✓ Сохранённые дороги и расчёт маршрута</span><span>✓ Поиск, карточки и типы скважин</span><span>✓ Избранное и ваши заметки</span></div><p class="modal-copy">Можно уходить на смену без связи. Открывайте атлас с главного экрана телефона.</p><p class="form-help">GPS и расчёт маршрута по сохранённым дорогам работают без интернета. Разрешите доступ к местоположению. За пределами сохранённой области дороги могут отсутствовать.</p><button class="btn primary" data-action="close-modal">Понятно</button>';
      $('#offline-state').textContent='Доступен без сети';
    }else{
      $('#offline-check-message').textContent='Атлас ещё не сохранён полностью.';
      $('#offline-check-details').innerHTML='<p class="modal-copy">Подключитесь к интернету, заново откройте приложение и дождитесь отметки «Доступен без сети».</p>';
    }
  }catch(e){const message=$('#offline-check-message');if(message)message.textContent=e.message;}
}
document.addEventListener('click',e=>{if(e.target.closest('[data-action="offline-prepare"]'))prepareForOffline();});
