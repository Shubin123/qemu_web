import {architectures,systems,machineProblem,selectedBootOptions,defaultBioses,defaultVgaBios} from './machines.js';
import {QemuHost} from './src/qemu-host.js';
import {isCached,getCachedBlob,putCachedBlob,deleteCached,fetchWithCache,getCacheSummary} from './downloads.js';
import {buildFlash} from './firmware.js';

const el=id=>document.getElementById(id), canvas=el('screen');
let host=null, paused=false, state='idle', bootOptions=null;
const keys=new Map();

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
el('bios-source')?.addEventListener('change',updateBiosSource);
el('bios')?.addEventListener('change',()=>{
  if(el('bios').files.length){
    if(el('bios-source'))el('bios-source').value='custom';
    updateBiosSource();
    if(el('bios-info'))el('bios-info').textContent=`Custom BIOS: ${el('bios').files[0].name}`;
  }
});
updateBiosSource();

el('btn-templeos').onclick=async()=>{
  if(state!=='idle')return;
  el('os').value='templeos';
  const system=systems.find(item=>item.id==='templeos');
  if(!system.architectures.includes(el('architecture').value))el('architecture').value=system.architectures[0];
  if(el('memory'))el('memory').value='128';
  compatibility();
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

function compatibility(){
  const problem=machineProblem(el('architecture').value,el('os').value);
  el('compatibility-note').textContent=problem||'32-bit engine available. OS boot compatibility has not been verified; memory is limited to 128 MiB.';
  el('start').disabled=state!=='idle'||!!problem;
  el('selection-note').hidden=!problem;el('selection-note').textContent=problem;
  updateFixture();
}
el('architecture').addEventListener('change',compatibility);
el('os').addEventListener('change',()=>{
  const system=systems.find(item=>item.id===el('os').value);
  if(!system.architectures.includes(el('architecture').value))el('architecture').value=system.architectures[0];
  compatibility();
});
compatibility();
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
  if(source==='custom'&&!el('bios').files.length){
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
  const active=state!=='idle', running=state==='running';
  el('machine-controls').hidden=!active;
  compatibility();
  el('start-label').textContent=state==='starting'?'Starting…':'Start PC';
  el('pause').disabled=!running;
  el('resume').disabled=state!=='paused';
  el('reset').disabled=!['running','paused'].includes(state);
  el('stop').disabled=!active;
  el('btn-templeos').disabled=active;
  for(const id of ['bios','bios-source','disk','disc','format','memory','architecture','os','serial'])if(el(id))el(id).disabled=active;
  el('menu-reset').disabled=active;
  el('setup-state').hidden=!active;
  el('setup-state').textContent=active?'Stop the PC to change setup or reset menu defaults.':'';
  el('boot').setAttribute('aria-busy',String(state==='starting'));
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

window.bootPc=async options=>{
  const problem=machineProblem(options.architecture??'i386');
  if(problem)throw new Error(problem);
  if(!crossOriginIsolated||typeof SharedArrayBuffer==='undefined')throw new Error('PC startup requires cross-origin isolation. Reload the page once setup finishes.');
  bootOptions={...options,files:Object.fromEntries(Object.entries(options.files||{}).map(([key,value])=>[key,value instanceof ArrayBuffer?value.slice(0):ArrayBuffer.isView(value)?value.slice():value]))};
  host?.terminate();keys.clear();paused=false;
  const session=new QemuHost({canvas});host=session;window.pcHost=session;
  const current=()=>host===session;
  const finish=message=>{if(!current())return;host=null;window.pcHost=null;session.terminate();keys.clear();paused=false;controls('idle');status(message);};
  session.addEventListener('log',e=>{if(current())log(e.detail.lines);});
  for(const type of ['error','abort'])session.addEventListener(type,e=>finish(e.detail.message));
  session.addEventListener('exited',()=>finish('PC stopped.'));
  controls('starting');status('Starting PC…');
  const started=performance.now();
  try{
    await session.boot({memoryOrder:'auto',...options});
    if(!current())return null;
    controls('running');status(`PC running. Started in ${((performance.now()-started)/1000).toFixed(1)}s. Click the display to use the keyboard.`);
    canvas.focus();return session;
  }catch(e){finish(e.message);throw e;}
};

el('boot').addEventListener('submit',async e=>{
  e.preventDefault();if(state!=='idle')return;
  closeMenu();
  try{
    const sys=systems.find(item=>item.id===el('os').value);
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
    }else if(source==='builtin-test'){
      status('Preparing built-in diagnostic BIOS…');
      const flash=buildFlash();
      bios=new Blob([flash],{type:'application/octet-stream'});
    }else{
      status('Preparing open source SeaBIOS…');
      const sea=defaultBioses.find(b=>b.id==='seabios')||defaultBioses[0];
      bios=await fetchWithCache(sea.streamUrl,null,sea.fallbackUrl);
      if(defaultVgaBios?.streamUrl){
        vgabios=await fetchWithCache(defaultVgaBios.streamUrl,null,defaultVgaBios.fallbackUrl).catch(()=>undefined);
      }
    }
    await window.bootPc(selectedBootOptions({architecture:el('architecture').value,system:el('os').value,
      bios,disk:el('disk').files[0],disc,
      format:el('format').value,memory:el('memory').value,serial:el('serial').checked}));
  }catch(e){if(state==='idle'&&e.message!=='Core terminated')status(e.message);}
});

el('pause').onclick=async()=>{try{await releaseKeys();await host.pause();paused=true;controls('paused');status('PC paused.');}catch(e){status(e.message);}};
el('resume').onclick=async()=>{try{await host.resume();paused=false;controls('running');status('PC running.');canvas.focus();}catch(e){status(e.message);}};
el('reset').onclick=async()=>{try{await window.bootPc(bootOptions);}catch(e){if(state==='idle')status(e.message);}};
el('stop').onclick=()=>{host?.terminate();host=null;window.pcHost=null;keys.clear();paused=false;controls('idle');status('PC stopped.');};

async function isolation(){if(crossOriginIsolated)return;if(!('serviceWorker' in navigator)){status('This browser needs cross-origin isolation support.');return;}await navigator.serviceWorker.register('./coi-serviceworker.js');if(!navigator.serviceWorker.controller){navigator.serviceWorker.addEventListener('controllerchange',()=>location.reload(),{once:true});}else if(!sessionStorage.getItem('qemu-isolation-reload')){sessionStorage.setItem('qemu-isolation-reload','1');location.reload();}}
isolation().catch(e=>status(e.message));
