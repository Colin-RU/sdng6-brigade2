'use strict';
(() => {
  const panel=document.querySelector('.map-panel');
  const button=document.querySelector('[data-map-expand]');
  if(!panel||!button)return;
  const root=document.documentElement;
  let expanded=false,scrollPosition=0,previousFocus;
  const label=button.querySelector('[data-map-expand-label]');
  function resizeMaps(){
    requestAnimationFrame(()=>{
      if(typeof fieldMap!=='undefined'&&fieldMap)fieldMap.invalidateSize({pan:false});
      if(typeof geoMap!=='undefined'&&geoMap)geoMap.invalidateSize({pan:false});
    });
  }
  function setExpanded(next,{restoreFocus=true,restoreScroll=true}={}){
    if(expanded===next)return;
    if(next){scrollPosition=window.scrollY;previousFocus=document.activeElement;root.style.setProperty('--map-scroll-offset',`${-scrollPosition}px`);}
    expanded=next;root.classList.toggle('map-expanded',expanded);
    button.setAttribute('aria-pressed',String(expanded));
    button.setAttribute('aria-label',expanded?'Свернуть карту':'Развернуть карту на весь экран');
    button.title=expanded?'Свернуть карту':'Развернуть карту на весь экран';
    label.textContent=expanded?'Свернуть':'Развернуть';
    if(expanded)button.focus({preventScroll:true});
    else{
      root.style.removeProperty('--map-scroll-offset');
      if(restoreScroll)window.scrollTo({top:scrollPosition,behavior:'instant'});
      if(restoreFocus&&previousFocus?.isConnected)previousFocus.focus({preventScroll:true});
    }
    resizeMaps();setTimeout(resizeMaps,120);
  }
  button.addEventListener('click',()=>setExpanded(!expanded));
  document.addEventListener('keydown',event=>{
    if(event.key!=='Escape'||!expanded||document.querySelector('dialog[open]')||!document.querySelector('#drawer')?.classList.contains('hidden'))return;
    event.preventDefault();setExpanded(false);
  },true);
  document.addEventListener('click',event=>{
    if(expanded&&(event.target.closest('[data-view]')||event.target.closest('[data-action="info"]')))setExpanded(false,{restoreFocus:false,restoreScroll:false});
  },true);
  const workspace=document.querySelector('#workspace');
  const atlas=document.querySelector('#atlas-view');
  const observer=new MutationObserver(()=>{
    if(expanded&&(workspace?.classList.contains('list-mode')||atlas?.classList.contains('hidden')))setExpanded(false,{restoreFocus:false,restoreScroll:false});
  });
  if(workspace)observer.observe(workspace,{attributes:true,attributeFilter:['class']});
  if(atlas)observer.observe(atlas,{attributes:true,attributeFilter:['class']});
  window.addEventListener('resize',resizeMaps);
  window.visualViewport?.addEventListener('resize',resizeMaps);
})();
