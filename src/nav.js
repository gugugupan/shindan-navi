(function(){
  var btn=document.getElementById('toolBtn'), pop=document.getElementById('toolPop');
  if(!btn) return;
  function set(open){ pop.hidden=!open; btn.setAttribute('aria-expanded',open); }
  btn.addEventListener('click',function(){ set(pop.hidden); if(!pop.hidden) pop.querySelector('a').focus(); });
  document.addEventListener('click',function(e){ if(!pop.hidden && !e.target.closest('.toolmenu')) set(false); });
  document.addEventListener('keydown',function(e){ if(e.key==='Escape' && !pop.hidden){ set(false); btn.focus(); } });
  pop.addEventListener('focusout',function(e){ if(!e.relatedTarget || !e.relatedTarget.closest('.toolmenu')) set(false); });
})();
