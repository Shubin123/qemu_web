import {architectures,systems,machineProblem,selectedBootOptions,defaultBioses,defaultVgaBios} from './machines.js';
import {QemuHost} from './src/qemu-host.js';
import {bootCachyos} from './src/qemu-cachyos.js';
import {getBootCacheInfo,clearBootCache,prepareCachedMachine} from './src/qemu-boot-cache.js';
import {createBootProgress} from './boot-progress.js';
import {isCached,getCachedBlob,putCachedBlob,deleteCached,fetchWithCache,getCacheSummary} from './downloads.js';
import {buildFlash} from './firmware.js';

const el=id=>document.getElementById(id), canvas=el('screen');
let host=null, paused=false, state='idle', bootOptions=null, bootGeneration=0, bootAbort=null, cacheCleanup=Promise.resolve();
const bootProgress=createBootProgress(el('boot-progress'));
const keys=new Map();
let bootCacheInfo={cached:false,saved:false}, savingSession=false, biosChoiceChanged=false, infoSlot=null;
const cacheSlot=()=>el('os').value==='cachyos'?'cachyos':`pc:${el('architecture').value}:${el('os').value}`;
try {
  const prefs=JSON.parse(localStorage.getItem('qemu-browser-startup')||'null');
  if(prefs){el('boot-cache').checked=prefs.cache!==false;el('session-mode').value=prefs.mode==='fresh'?'fresh':'resume';}
} catch {}
async function refreshBootCache({restoreSettings=false}={}){
  const slot=cacheSlot();
  if(infoSlot!==slot){bootCacheInfo={cached:false,saved:false};infoSlot=slot;cacheControls();}
  const info=await getBootCacheInfo(slot);
  if(slot!==cacheSlot())return;
  bootCacheInfo=info;
  if(restoreSettings&&info.settings){if(info.settings.memory)el('memory').value=String(info.settings.memory);if(info.settings.diskFormat)el('format').value=info.settings.diskFormat;if(typeof info.serial==='boolean')el('serial').checked=info.serial;}
  el('boot-cache-status').textContent=bootCacheInfo.cached
    ?`Cached boot files: ${bootCacheInfo.name}. ${bootCacheInfo.saved?'Saved session available ('+new Date(bootCacheInfo.savedAt).toLocaleString()+').':'No compatible session has been saved yet.'}`
    :'No cached boot files yet. Choose boot files for the first start.';
  cacheControls();
}
function cacheControls(){
  const enabled=el('boot-cache').checked;
  if(!enabled)el('session-mode').value='fresh';
  el('session-mode').disabled=state!=='idle'||!enabled;
  el('boot-cache').disabled=state!=='idle';
  el('clear-boot-cache').disabled=state!=='idle';
  el('pause').disabled=savingSession||state!=='running';
  el('resume').disabled=savingSession||state!=='paused';
  el('reset').disabled=savingSession||!['running','paused'].includes(state);
  el('start-cached').disabled=state!=='idle'||!enabled||!bootCacheInfo.cached;
  el('save-session').disabled=savingSession||!['running','paused'].includes(state)||!host?.saveBootSession;
}
for(const id of ['boot-cache','session-mode'])el(id).addEventListener('change',()=>{
  try{localStorage.setItem('qemu-browser-startup',JSON.stringify({cache:el('boot-cache').checked,mode:el('session-mode').value}));}catch{}
  cacheControls();
});
el('clear-boot-cache').onclick=async()=>{
  try{await clearBootCache();await refreshBootCache();status('Browser boot files and saved session cleared.');}catch(e){status(e.message);}
};
el('start-cached').onclick=async()=>{
  if(state!=='idle'||!bootCacheInfo.cached)return;
  await refreshBootCache({restoreSettings:true});
  if(state!=='idle'||!bootCacheInfo.cached)return;
  for(const id of ['bios','disc','disk'])el(id).value='';
  biosChoiceChanged=false;el('start').click();
};
el('save-session').onclick=async()=>{
  if(!host?.saveBootSession||savingSession)return;
  const session=host;
  try{await session.saveBootSession();await refreshBootCache();}catch(e){if(host===session)status(`Session was not saved: ${e.message}`);}finally{if(host===session){savingSession=false;cacheControls();}}
};
cacheControls();

for(const item of architectures)el('architecture').add(new Option(item.name+(item.available?'':' — engine unavailable'),item.id));
for(const item of systems)el('os').add(new Option(item.name,item.id));
for(const item of systems.filter(item=>item.id!=='custom')){
  const row=el('os-coverage').insertRow();
  for(const text of [item.name,item.architectures.join(', '),'Not tested'])row.insertCell().textContent=text;
}

async function updateStorageSummary(){
  try{
    const summary=await getCacheSummary();
    if(el('storage-summary')){
      el('storage-summary').textContent=summary.count>0
        ?`${summary.count} cached download${summary.count===1?'':'s'} (${(summary.totalBytes/1048576).toFixed(1)} MB in browser storage).`
        :'No downloads cached yet.';
    }
    if(el('btn-clear-cache'))el('btn-clear-cache').hidden=summary.count===0;
  }catch(_){}
}

function updateFixture(){
  const sys=systems.find(item=>item.id===el('os').value);
  const fix=sys?.fixture;
  if(!fix){if(el('fixture-notice'))el('fixture-notice').hidden=true;return;}
  el('fixture-notice').hidden=false;
  el('fixture-info').textContent=`${fix.name} fixture (${(fix.size/1048576).toFixed(1)} MB from archive.org CDN — downloads locally)`;
  isCached(fix.streamUrl).then(cached=>{
    if(el('os').value!==sys.id)return;
    el('fixture-info').textContent=`${fix.name} fixture (${(fix.size/1048576).toFixed(1)} MB from archive.org CDN${cached?' — cached in browser storage':' — downloads locally'})`;
    el('fixture-download').textContent=cached?'✓ Cached in browser':'Download locally to browser';
    el('fixture-download').disabled=cached;
    if(el('fixture-clear'))el('fixture-clear').hidden=!cached;
    el('fixture-progress').hidden=!cached;
    if(cached)el('fixture-progress').textContent=`Ready: ${(fix.size/1048576).toFixed(1)} MB cached in browser storage.`;
  }).catch(()=>{});
}

async function downloadFixture(fix){
  el('fixture-download').disabled=true;
  el('fixture-progress').hidden=false;
  el('fixture-progress').textContent=`Downloading ${fix.name} locally from CDN…`;
  status(`Downloading ${fix.name} locally from CDN (${(fix.size/1048576).toFixed(1)} MB)…`);
  try{
    const blob=await fetchWithCache(fix.streamUrl,({loaded,total,cached})=>{
      if(cached){
        el('fixture-progress').textContent=`Loaded from cache (${(loaded/1048576).toFixed(1)} MB).`;
      }else{
        const pct=total?Math.round((loaded/total)*100):0;
        el('fixture-progress').textContent=`Downloading: ${pct}% (${(loaded/1048576).toFixed(1)} / ${(total/1048576).toFixed(1)} MB)…`;
      }
    });
    await updateFixture();
    await updateStorageSummary();
    status(`${fix.name} ready in local browser storage.`);
    return blob;
  }catch(err){
    el('fixture-download').disabled=false;
    el('fixture-progress').textContent=`Download failed: ${err.message}`;
    status(`Download failed: ${err.message}`);
    throw err;
  }
}

el('fixture-download')?.addEventListener('click',()=>{
  const sys=systems.find(item=>item.id===el('os').value);
  if(sys?.fixture)downloadFixture(sys.fixture).catch(()=>{});
});
el('fixture-clear')?.addEventListener('click',async()=>{
  const sys=systems.find(item=>item.id===el('os').value);
  if(sys?.fixture){
    await deleteCached(sys.fixture.streamUrl);
    await updateFixture();
    await updateStorageSummary();
    status(`${sys.fixture.name} removed from browser cache.`);
  }
});
el('btn-clear-cache')?.addEventListener('click',async()=>{
  const summary=await getCacheSummary();
  for(const url of summary.urls)await deleteCached(url);
  await updateFixture();
  await updateStorageSummary();
  status('All cached downloads cleared.');
});

// BIOS source selection and custom file upload handling
function updateBiosSource(){
  const source=el('bios-source')?.value||'seabios';
  if(el('bios-custom-box'))el('bios-custom-box').hidden=source!=='custom';
  if(el('bios-info')){
    if(source==='seabios')el('bios-info').textContent='Open source SeaBIOS 256K (bundled LGPL firmware, ready to boot).';
    else if(source==='builtin-test')el('bios-info').textContent='Open source diagnostic test BIOS (runs instantly offline).';
    else el('bios-info').textContent='Upload an authentic x86 PC BIOS ROM (.bin / .rom).';
  }
}
el('bios-source')?.addEventListener('change',()=>{biosChoiceChanged=true;updateBiosSource();});
el('bios')?.addEventListener('change',()=>{
  if(el('bios').files.length){
    biosChoiceChanged=true;
    if(el('bios-source'))el('bios-source').value='custom';
    updateBiosSource();
    if(el('bios-info'))el('bios-info').textContent=`Custom BIOS: ${el('bios').files[0].name}`;
  }
});
updateBiosSource();

el('btn-templeos').onclick=async()=>{
  if(state!=='idle')return;
  el('os').value='templeos';
  el('architecture').value='x86_64';
  if(el('memory'))el('memory').value='512';
  compatibility();
  const system=systems.find(item=>item.id==='templeos');
  const fix=system?.fixture;
  if(fix){
    const cached=await isCached(fix.streamUrl);
    if(cached){
      status('TempleOS ready from browser cache.');
    }else{
      downloadFixture(fix).catch(e=>{
        status(`Failed to download ${fix.name}: ${e.message}`);
      });
    }
  }
};

el('btn-cachyos')?.addEventListener('click',async()=>{
  if(state!=='idle')return;
  el('os').value='cachyos';
  el('architecture').value='x86_64';
  if(el('memory'))el('memory').value='3072';
  compatibility();
  if(el('disc')?.files?.length||(el('boot-cache').checked&&bootCacheInfo.cached)){
    status('Starting CachyOS live desktop with selected ISO…');
    el('start').click();
  }else{
    window.QemuLayout?.show?.('media');
    el('disc').focus();
    const onChosen=()=>{
      el('disc').removeEventListener('change',onChosen);
      if(el('disc').files?.length){
        status('CachyOS ISO selected. Starting…');
        el('start').click();
      }
    };
    el('disc').addEventListener('change',onChosen,{once:true});
    el('disc').click();
    status('Please choose your local CachyOS ISO to start.');
  }
});

function compatibility(){
  el('boot-cache-options').hidden=false;
  refreshBootCache().catch(()=>{});
  const problem=machineProblem(el('architecture').value,el('os').value);
  el('compatibility-note').textContent=problem||(el('os').value==='cachyos'
    ?'CachyOS live desktop profile with Wayland and KDE Plasma (x86_64).'
    :el('architecture').value==='x86_64'
    ?'64-bit engine available. OS boot compatibility has not been verified; memory is configurable up to 3072 MiB.'
    :'32-bit engine available. OS boot compatibility has not been verified; memory is limited to 128 MiB.');
  el('start').disabled=state!=='idle'||!!problem;
  el('selection-note').hidden=!problem;el('selection-note').textContent=problem;
  updateFixture();
}
el('architecture').addEventListener('change',()=>{compatibility();refreshBootCache({restoreSettings:true}).catch(()=>{});});
el('os').addEventListener('change',()=>{
  const system=systems.find(item=>item.id===el('os').value);
  if(!system.architectures.includes(el('architecture').value))el('architecture').value=system.architectures[0];
  biosChoiceChanged=false;
  compatibility();
  refreshBootCache({restoreSettings:true}).catch(()=>{});
});
compatibility();
refreshBootCache({restoreSettings:true}).catch(()=>{});
updateStorageSummary();
window.addEventListener('focus',updateStorageSummary);
window.updateStorageSummary=updateStorageSummary;

function openMenu(){
  if(window.QemuLayout)window.QemuLayout.setMenuOpen(true);
  el('menu-notice').hidden=true;
}
function closeMenu(){
  if(window.QemuLayout)window.QemuLayout.setMenuOpen(false);
}
el('menu-toggle')?.addEventListener('click',()=>openMenu());
el('menu-close')?.addEventListener('click',()=>closeMenu());
el('menu-done')?.addEventListener('click',()=>{
  closeMenu();
  if(!el('start').disabled)el('start').focus();
});
el('menu-reset').onclick=()=>{
  if(state!=='idle')return;
  el('boot').reset();
  el('architecture').value='i386';
  el('os').value='custom';
  if(el('bios-source'))el('bios-source').value='seabios';
  updateBiosSource();
  bootOptions=null;
  for(const details of document.querySelectorAll('details'))details.open=false;
  compatibility();
  el('menu-notice').hidden=false;
  el('menu-notice').textContent='Defaults restored. Choose your boot files again.';
  status('Menu defaults restored. SeaBIOS selected by default.');
};

el('start').addEventListener('click',e=>{
  const source=el('bios-source')?.value||'seabios';
  if(source==='custom'&&!el('bios').files.length&&!(el('boot-cache').checked&&bootCacheInfo.cached&&!biosChoiceChanged)){
    e.preventDefault();
    window.QemuLayout?.show?.('media');
    el('bios').focus();
    status('Choose a local PC BIOS file to begin.');
  }
});
el('boot').addEventListener('change',()=>{el('menu-notice').hidden=true;});
el('boot').addEventListener('invalid',()=>{
  window.QemuLayout?.show?.('media');
  window.QemuLayout?.show?.('machine');
},true);
function status(text){el('status').textContent=text;}

function controls(next){
  state=next;
  cacheControls();
  const active=state!=='idle', running=state==='running';
  el('machine-controls').hidden=!active;
  compatibility();
  el('start-label').textContent=state==='starting'?'Starting…':'Start PC';
  el('pause').disabled=!running;
  el('resume').disabled=state!=='paused';
  el('reset').disabled=!['running','paused'].includes(state);
  el('stop').disabled=!active;
  el('btn-templeos').disabled=active;
  if(el('btn-cachyos'))el('btn-cachyos').disabled=active;
  for(const id of ['bios','bios-source','disk','disc','format','memory','architecture','os','serial'])if(el(id))el(id).disabled=active;
  el('menu-reset').disabled=active;
  el('setup-state').hidden=!active;
  el('setup-state').textContent=active?'Stop the PC to change setup or reset menu defaults.':'';
  el('boot').setAttribute('aria-busy',String(state==='starting'));
  cacheControls();
}

let logText='', logFrame=0;
function log(lines){
  logText=(logText+lines.map(line=>line.text).join('\n')+'\n').slice(-24000);
  if(!logFrame)logFrame=requestAnimationFrame(()=>{el('log').textContent=logText;logFrame=0;});
}
el('clear-log')?.addEventListener('click',()=>{
  logText='';
  el('log').textContent='';
});

async function releaseKeys(){if(!host)return;const pending=[...keys.values()];keys.clear();await Promise.allSettled(pending.map(key=>host.key(key,false)));}
const special={Enter:'ret',Escape:'esc',Backspace:'backspace',Tab:'tab',Space:'spc',ArrowUp:'up',ArrowDown:'down',ArrowLeft:'left',ArrowRight:'right',ShiftLeft:'shift',ShiftRight:'shift_r',ControlLeft:'ctrl',ControlRight:'ctrl_r',AltLeft:'alt',AltRight:'alt_r',Delete:'delete',Insert:'insert',Home:'home',End:'end',PageUp:'pgup',PageDown:'pgdn',CapsLock:'caps_lock',Minus:'minus',Equal:'equal',BracketLeft:'bracket_left',BracketRight:'bracket_right',Backslash:'backslash',Semicolon:'semicolon',Quote:'apostrophe',Backquote:'grave_accent',Comma:'comma',Period:'dot',Slash:'slash'};
function qcode(code){return special[code]||(/^Key[A-Z]$/.test(code)?code.slice(3).toLowerCase():/^Digit[0-9]$/.test(code)?code.slice(5):/^F([1-9]|1[0-2])$/.test(code)?code.toLowerCase():null);}
canvas.addEventListener('keydown',e=>{const key=qcode(e.code);if(!host||paused||!key)return;e.preventDefault();if(keys.has(e.code))return;keys.set(e.code,key);host.key(key,true).catch(e=>status(e.message));});
canvas.addEventListener('keyup',e=>{const key=keys.get(e.code);if(!key||!host)return;e.preventDefault();keys.delete(e.code);host.key(key,false).catch(e=>status(e.message));});
canvas.addEventListener('blur',releaseKeys);window.addEventListener('blur',releaseKeys);
for(const ev of ['pointermove','pointerdown','pointerup'])canvas.addEventListener(ev,e=>{
  if(!host)return;
  if(ev==='pointerdown'){canvas.focus();canvas.setPointerCapture?.(e.pointerId);}
  const rect=canvas.getBoundingClientRect();
  const buttons=(e.buttons&1)|((e.buttons&2)?2:0)|((e.buttons&4)?4:0);
  host.pointer?.((e.clientX-rect.left)/rect.width,(e.clientY-rect.top)/rect.height,buttons)?.catch?.(()=>{});
});
canvas.oncontextmenu=e=>e.preventDefault();
canvas.addEventListener('wheel',e=>{
  if(!host)return;
  e.preventDefault();
  const rect=canvas.getBoundingClientRect();
  host.pointer?.((e.clientX-rect.left)/rect.width,(e.clientY-rect.top)/rect.height,0,e.deltaY)?.catch?.(()=>{});
},{passive:false});

function cachedProgress({phase,asset,received,message},generation){
  if(generation!==bootGeneration)return;
  if(phase==='checking-cache')status(`Checking ${asset||'boot files'}… ${received?Math.floor(received/1048576)+' MB':''}`);
  else if(phase==='caching')status(`Keeping ${asset||'boot files'} in this browser…`);
  else if(phase==='cache-hit')status(`Using cached ${asset||'boot files'}.`);
  else if(phase==='restoring')status('Restoring saved system…');
  else if(phase==='session-miss')status('No matching saved session. Starting a fresh boot.');
  else if(phase==='saving-session'){savingSession=true;cacheControls();status('Saving current system in this browser…');}
  else if(phase==='session-saved'){savingSession=false;cacheControls();refreshBootCache();status('System saved. The next start can resume from here.');}
  else if(phase==='session-save-failed'){savingSession=false;cacheControls();status(`System was not saved: ${message}`);}
}
window.bootPc=async options=>{
  bootProgress.hide();
  const problem=machineProblem(options.architecture??'i386');
  if(problem)throw new Error(problem);
  if(!crossOriginIsolated||typeof SharedArrayBuffer==='undefined')throw new Error('PC startup requires cross-origin isolation. Reload the page once setup finishes.');
  bootOptions={...options,files:Object.fromEntries(Object.entries(options.files||{}).map(([key,value])=>[key,value instanceof ArrayBuffer?value.slice(0):ArrayBuffer.isView(value)?value.slice():value]))};
  const generation=++bootGeneration;
  bootAbort?.abort();const abort=bootAbort=new AbortController();
  host?.terminate();host=null;window.pcHost=null;keys.clear();paused=false;
  const arch=architectures.find(a=>a.id===(options.architecture??'i386'));
  const coreUrl=new URL(options.coreUrl||arch?.coreUrl||'./cores/qemu/qemu-core.js',document.baseURI);
  let session,cached;
  const current=()=>generation===bootGeneration&&(!session||host===session);
  const finish=message=>{if(!current())return;session?.terminate();if(!session)cached?.dispose();host=null;window.pcHost=null;keys.clear();paused=false;controls('idle');status(message);};
  controls('starting');status('Starting PC…');
  const started=performance.now();
  try{
    await cacheCleanup;abort.signal.throwIfAborted();
    if(options.cacheBoot)cached=await prepareCachedMachine({slot:options.cacheSlot||cacheSlot(),label:options.cacheLabel||'PC',
      files:options.files,settings:options.settings,args:options.args,replaceFiles:!!options.replaceCachedFiles,coreUrl,sessionMode:options.sessionMode||'resume',
      signal:abort.signal,onProgress:e=>cachedProgress(e,generation)});
    abort.signal.throwIfAborted();
    session=new QemuHost({canvas,coreUrl:cached?.coreUrl||coreUrl});host=session;window.pcHost=session;
    if(cached){
      const terminate=session.terminate.bind(session);session.terminate=()=>{terminate();session.cacheClosed=cached.dispose();cacheCleanup=session.cacheClosed;};
      session.saveBootSession=()=>cached.save(session,true);session.resumedSession=cached.restore;
    }
    session.addEventListener('log',e=>{if(current())log(e.detail.lines);});
    for(const type of ['error','abort'])session.addEventListener(type,e=>finish(e.detail.message));
    session.addEventListener('exited',()=>finish('PC stopped.'));
    options.onHost?.(session);
    await session.boot({memoryOrder:'strict',...options,...cached?.boot});
    if(!current())return null;
    controls('running');status(session.resumedSession?'Saved system resumed.':'PC running. Click Save current session once the operating system is ready.');
    canvas.focus();return session;
  }catch(e){if(generation!==bootGeneration){cached?.dispose();return null;}finish(e.message);throw e;}
};

el('boot').addEventListener('submit',async e=>{
  e.preventDefault();if(state!=='idle')return;
  closeMenu();
  let attempt;
  try{
    if(el('os').value==='cachyos'){
      const generation=attempt=++bootGeneration;
      bootAbort?.abort();
      const abort=bootAbort=new AbortController();
      const disc=el('disc').files[0];
      if(!disc&&!(el('boot-cache').checked&&bootCacheInfo.cached))throw new Error('Please choose a local CachyOS ISO file for the first start.');
      controls('starting');
      status('Preparing CachyOS live desktop…');
      host?.terminate();keys.clear();paused=false;
      const started=performance.now();
      bootProgress.start();
      await cacheCleanup;abort.signal.throwIfAborted();
      const instance=await bootCachyos({
        canvas,
        disc,
        signal:abort.signal,
        cacheBoot:el('boot-cache').checked,
        sessionMode:el('boot-cache').checked?el('session-mode').value:'fresh',
        bios:'./firmware/bios-256k.bin',
        vgabios:'./firmware/vgabios-stdvga.bin',
        linuxboot:'./firmware/linuxboot_dma.bin',
        coreUrl:new URL('./cores/qemu-x86_64-wasm64/qemu-core.js',location.href),
        memory:Number(el('memory')?.value||3072),
        onProgress:({phase,asset,received,message})=>{
          if(generation!==bootGeneration)return;
          if(phase==='checking-cache'){status(`Checking ${asset||'boot files'}… ${received?Math.floor(received/1048576)+' MB':''}`);}
          else if(phase==='caching')status(`Saving ${asset||'boot files'} in this browser…`);
          else if(phase==='cache-hit')status(`Using cached ${asset||'boot files'}.`);
          else if(phase==='restoring'){status('Restoring saved session…');bootProgress.step('Restoring saved session',90);}
          else if(phase==='session-miss')status('No matching saved session. Starting a fresh boot with cached files.');
          else if(phase==='saving-session'){savingSession=true;cacheControls();status('Saving current session in this browser…');}
          else if(phase==='session-saved'){savingSession=false;cacheControls();refreshBootCache();status('Session saved. The next start can resume from here.');}
          else if(phase==='session-save-failed'){savingSession=false;cacheControls();status(`Desktop ready; session was not saved: ${message}`);}
          else if(phase==='loading')status(`Loading ${asset||''}… ${received?(Math.floor(received/1048576)+' MB'):''}`);
          else if(phase==='preparing'){status('Extracting CachyOS live kernel and initramfs…');bootProgress.start('Extracting the kernel and initramfs');}
          else if(phase==='booting'){status('Starting CachyOS live kernel…');bootProgress.step('Starting the Linux kernel',5);}
          else if(phase==='desktop-ready')status(`CachyOS live desktop ready (${((performance.now()-started)/1000).toFixed(1)}s).`);
        },
        onHost:session=>{
          if(generation!==bootGeneration){session.terminate();return;}
          const terminate=session.terminate.bind(session);
          session.terminate=()=>{terminate();if(session.cacheClosed)cacheCleanup=session.cacheClosed;};
          host=session;window.pcHost=session;
          const current=()=>host===session;
          const finish=message=>{if(!current())return;host=null;window.pcHost=null;session.terminate();keys.clear();paused=false;controls('idle');status(message);bootProgress.finish(false,message);};
          session.addEventListener('log',e=>{if(current()){log(e.detail.lines);bootProgress.update(e.detail.lines);}});
          for(const type of ['error','abort'])session.addEventListener(type,e=>finish(e.detail.message));
          session.addEventListener('exited',()=>finish('PC stopped.'));
        }
      });
      host=instance;window.pcHost=instance;
      controls('running');
      status(instance.resumedSession?'Saved session restored.':'CachyOS is booting. The first boot can take a long time; save the session to resume faster next time.');
      canvas.focus();
      try{
        await instance.desktopReady;
        if(generation!==bootGeneration)return;
        status(`CachyOS live desktop ready (${((performance.now()-started)/1000).toFixed(1)}s). Click display to interact.`);
        bootProgress.finish(true,'Desktop ready');
      }catch(err){
        if(generation!==bootGeneration)return;
        if(state!=='idle')status(err.message||'CachyOS desktop startup failed.');
        bootProgress.finish(false,err.message||'Desktop startup failed');
      }
      return;
    }
    const prepGeneration=attempt=++bootGeneration;
    bootAbort?.abort();bootAbort=new AbortController();
    controls('starting');
    const sys=systems.find(item=>item.id===el('os').value);
    await refreshBootCache();
    if(prepGeneration!==bootGeneration)return;
    const caching=el('boot-cache').checked;
    const noNewFiles=!el('disc').files[0]&&!el('disk').files[0]&&!el('bios').files[0];
    if(caching&&bootCacheInfo.cached&&noNewFiles&&!biosChoiceChanged){
      const architecture=el('architecture').value;
      await window.bootPc({architecture,cacheBoot:true,cacheSlot:cacheSlot(),cacheLabel:sys?.name||'Custom PC',sessionMode:el('session-mode').value,files:{},
        settings:{cpu:bootCacheInfo.settings?.cpu||(architecture==='x86_64'?'qemu64':'pentium3'),diskFormat:el('format').value,memory:Number(el('memory').value)},
        args:[...(bootCacheInfo.hasDisc?['-boot','order=dc']:[]),...(el('serial').checked?['-chardev','stdio,id=console','-device','isa-serial,chardev=console,index=0']:[])]});
      return;
    }
    let disc=el('disc').files[0];
    if(!disc&&sys?.fixture){
      status(`Preparing ${sys.fixture.name}…`);
      disc=await fetchWithCache(sys.fixture.streamUrl,({loaded,total,cached})=>{
        if(!cached&&total){
          status(`Downloading ${sys.fixture.name} (${Math.round((loaded/total)*100)}%)…`);
        }
      },sys.fixture.url);
    }
    const source=el('bios-source')?.value||'seabios';
    let bios=null;
    let vgabios=undefined;
    if(source==='custom'){
      bios=el('bios').files[0];
      if(!bios)throw new Error('Choose a local PC BIOS file to begin.');
      if(defaultVgaBios?.streamUrl){
        vgabios=await fetchWithCache(defaultVgaBios.streamUrl,null,defaultVgaBios.fallbackUrl).catch(()=>undefined);
      }
    }else if(source==='builtin-test'){
      status('Preparing built-in diagnostic BIOS…');
      const flash=buildFlash();
      bios=new Blob([flash],{type:'application/octet-stream'});
      vgabios=null;
    }else{
      status('Preparing open source SeaBIOS…');
      const sea=defaultBioses.find(b=>b.id==='seabios')||defaultBioses[0];
      bios=await fetchWithCache(sea.streamUrl,null,sea.fallbackUrl);
      if(defaultVgaBios?.streamUrl){
        vgabios=await fetchWithCache(defaultVgaBios.streamUrl,null,defaultVgaBios.fallbackUrl).catch(()=>undefined);
      }
    }
    const options=selectedBootOptions({architecture:el('architecture').value,system:el('os').value,
      bios,vgabios,disk:el('disk').files[0],disc,
      format:el('format').value,memory:el('memory').value,serial:el('serial').checked});
    if(caching){options.cacheBoot=true;options.replaceCachedFiles=true;options.cacheSlot=cacheSlot();options.cacheLabel=sys?.name||'Custom PC';options.sessionMode=el('session-mode').value;if(!disc)delete options.files.disc;}
    if(prepGeneration!==bootGeneration)return;
    await window.bootPc(options);
  }catch(e){
    if(attempt!==undefined&&attempt!==bootGeneration)return;
    if(attempt!==undefined){host?.terminate();host=null;window.pcHost=null;savingSession=false;controls('idle');if(el('os').value==='cachyos')bootProgress.finish(false,e.message);}
    if(state==='idle'&&e.message!=='Core terminated')status(e.message+(el('os').value==='cachyos'?' Choose Fresh boot to retry without restoring a session.':''));
  }
});

el('pause').onclick=async()=>{try{await releaseKeys();await host.pause();paused=true;controls('paused');status('PC paused.');}catch(e){status(e.message);}};
el('resume').onclick=async()=>{try{await host.resume();paused=false;controls('running');status('PC running.');canvas.focus();}catch(e){status(e.message);}};
el('reset').onclick=async()=>{try{if(el('os').value==='cachyos')el('start').click();else await window.bootPc({...bootOptions,sessionMode:'fresh'});}catch(e){if(state==='idle')status(e.message);}};
el('stop').onclick=()=>{++bootGeneration;bootAbort?.abort();bootAbort=null;savingSession=false;bootProgress.hide();host?.terminate();host=null;window.pcHost=null;keys.clear();paused=false;controls('idle');status('PC stopped.');};

async function isolation(){if(crossOriginIsolated)return;if(!('serviceWorker' in navigator)){status('This browser needs cross-origin isolation support.');return;}await navigator.serviceWorker.register('./coi-serviceworker.js');if(!navigator.serviceWorker.controller){navigator.serviceWorker.addEventListener('controllerchange',()=>location.reload(),{once:true});}else if(!sessionStorage.getItem('qemu-isolation-reload')){sessionStorage.setItem('qemu-isolation-reload','1');location.reload();}}
isolation().catch(e=>status(e.message));
