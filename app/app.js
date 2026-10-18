import {architectures,systems,machineProblem,selectedBootOptions} from './machines.js';
import {QemuHost} from './src/qemu-host.js';
const el=id=>document.getElementById(id), canvas=el('screen');
let host=null, paused=false, state='idle', bootOptions=null;
const keys=new Map();
for(const item of architectures)el('architecture').add(new Option(item.name+(item.available?'':' — engine unavailable'),item.id));
for(const item of systems)el('os').add(new Option(item.name,item.id));
for(const item of systems.filter(item=>item.id!=='custom')){
  const row=el('os-coverage').insertRow();
  for(const text of [item.name,item.architectures.join(', '),'Not tested'])row.insertCell().textContent=text;
}
const fixtureBlobs = new Map();
function updateFixture(){
  const sys=systems.find(item=>item.id===el('os').value);
  const fix=sys?.fixture;
  if(!fix){el('fixture-notice').hidden=true;return;}
  el('fixture-notice').hidden=false;
  const loaded=fixtureBlobs.has(fix.id);
  el('fixture-info').textContent=`${fix.name} fixture (${(fix.size/1048576).toFixed(1)} MB from archive.org CDN — downloads locally)`;
  el('fixture-download').textContent=loaded?'✓ Downloaded locally':'Download locally to browser';
  el('fixture-download').disabled=loaded;
  el('fixture-progress').hidden=!loaded;
  if(loaded)el('fixture-progress').textContent=`Ready: ${(fix.size/1048576).toFixed(1)} MB in local browser memory.`;
}
async function downloadFixture(fix){
  if(fixtureBlobs.has(fix.id))return fixtureBlobs.get(fix.id);
  el('fixture-download').disabled=true;
  el('fixture-progress').hidden=false;
  el('fixture-progress').textContent=`Downloading ${fix.name} locally from CDN…`;
  status(`Downloading ${fix.name} locally from CDN (${(fix.size/1048576).toFixed(1)} MB)…`);
  try{
    const res=await fetch(fix.streamUrl);
    if(!res.ok)throw new Error(`HTTP ${res.status}`);
    const blob=await res.blob();
    fixtureBlobs.set(fix.id,blob);
    el('fixture-download').textContent='✓ Downloaded locally';
    el('fixture-progress').textContent=`Downloaded locally (${(blob.size/1048576).toFixed(1)} MB).`;
    status(`${fix.name} downloaded locally to browser memory.`);
    return blob;
  }catch(err){
    el('fixture-download').disabled=false;
    el('fixture-progress').textContent=`Download failed: ${err.message}`;
    status(`Download failed: ${err.message}`);
    throw err;
  }
}
el('fixture-download').onclick=()=>{
  const sys=systems.find(item=>item.id===el('os').value);
  if(sys?.fixture)downloadFixture(sys.fixture).catch(()=>{});
};
el('btn-templeos').onclick=async()=>{
  if(state!=='idle')return;
  el('os').value='templeos';
  const system=systems.find(item=>item.id==='templeos');
  if(!system.architectures.includes(el('architecture').value))el('architecture').value=system.architectures[0];
  compatibility();
  const fix=system?.fixture;
  if(!el('bios').files.length){
    openMenu();el('bios').focus();
    status('TempleOS fixture selected. Choose a PC BIOS to begin.');
  }
  if(fix&&!fixtureBlobs.has(fix.id)){
    downloadFixture(fix).then(()=>{
      status('TempleOS downloaded locally to browser memory.');
    }).catch(e=>{
      status(`Failed to download ${fix.name}: ${e.message}`);
    });
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
function openMenu(){
  if(el('setup-menu').open)return;
  el('menu-notice').hidden=true;
  el('setup-menu').showModal();el('menu-toggle').setAttribute('aria-expanded','true');
}
function closeMenu(){if(el('setup-menu').open)el('setup-menu').close();el('menu-toggle').setAttribute('aria-expanded','false');}
el('menu-toggle').onclick=openMenu;
el('menu-close').onclick=closeMenu;
el('menu-done').onclick=()=>{closeMenu();if(!el('start').disabled)el('start').focus();};
el('setup-menu').addEventListener('cancel',e=>{e.preventDefault();closeMenu();});
el('setup-menu').addEventListener('close',()=>el('menu-toggle').setAttribute('aria-expanded',String(el('setup-menu').open)));
el('setup-menu').addEventListener('click',e=>{
  if(e.target!==el('setup-menu'))return;
  const rect=e.target.getBoundingClientRect();
  if(e.clientX<rect.left||e.clientX>rect.right||e.clientY<rect.top||e.clientY>rect.bottom)closeMenu();
});
el('menu-reset').onclick=()=>{
  if(state!=='idle')return;
  el('boot').reset();el('architecture').value='i386';el('os').value='custom';bootOptions=null;fixtureBlobs.clear();
  for(const details of el('setup-menu').querySelectorAll('details'))details.open=false;
  compatibility();el('menu-notice').hidden=false;el('menu-notice').textContent='Defaults restored. Choose your BIOS and boot files again.';
  status('Menu defaults restored. Choose a local PC BIOS to begin.');
};
el('start').addEventListener('click',e=>{
  if(!el('bios').files.length){e.preventDefault();openMenu();el('bios').focus();}
});
el('boot').addEventListener('change',()=>{el('menu-notice').hidden=true;});
el('boot').addEventListener('invalid',()=>openMenu(),true);
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
  for(const id of ['bios','disk','disc','format','memory','architecture','os','serial'])el(id).disabled=active;
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
      disc=fixtureBlobs.get(sys.fixture.id)||await downloadFixture(sys.fixture);
    }
    await window.bootPc(selectedBootOptions({architecture:el('architecture').value,system:el('os').value,
      bios:el('bios').files[0],disk:el('disk').files[0],disc,
      format:el('format').value,memory:el('memory').value,serial:el('serial').checked}));
  }catch(e){if(state==='idle'&&e.message!=='Core terminated')status(e.message);}
});
el('pause').onclick=async()=>{try{await releaseKeys();await host.pause();paused=true;controls('paused');status('PC paused.');}catch(e){status(e.message);}};
el('resume').onclick=async()=>{try{await host.resume();paused=false;controls('running');status('PC running.');canvas.focus();}catch(e){status(e.message);}};
el('reset').onclick=async()=>{try{await window.bootPc(bootOptions);}catch(e){if(state==='idle')status(e.message);}};
el('stop').onclick=()=>{host?.terminate();host=null;window.pcHost=null;keys.clear();paused=false;controls('idle');status('PC stopped.');};
async function isolation(){if(crossOriginIsolated)return;if(!('serviceWorker' in navigator)){status('This browser needs cross-origin isolation support.');return;}await navigator.serviceWorker.register('./coi-serviceworker.js');if(!navigator.serviceWorker.controller){navigator.serviceWorker.addEventListener('controllerchange',()=>location.reload(),{once:true});}else if(!sessionStorage.getItem('qemu-isolation-reload')){sessionStorage.setItem('qemu-isolation-reload','1');location.reload();}}
isolation().catch(e=>status(e.message));
