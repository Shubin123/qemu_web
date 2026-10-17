import {QemuHost} from './src/qemu-host.js';
const el=id=>document.getElementById(id), canvas=el('screen');
let host=null, paused=false, state='idle', bootOptions=null;
const keys=new Map();
function status(text){el('status').textContent=text;}
function controls(next){
  state=next;
  const active=state!=='idle', running=state==='running';
  el('machine-controls').hidden=!active;
  el('start').disabled=active;
  el('start').textContent=state==='starting'?'Starting…':'Start PC';
  el('pause').disabled=!running;
  el('resume').disabled=state!=='paused';
  el('reset').disabled=!['running','paused'].includes(state);
  el('stop').disabled=!active;
  for(const id of ['bios','disk','format','memory'])el(id).disabled=active;
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
el('boot').addEventListener('submit',async e=>{e.preventDefault();const bios=el('bios').files[0],disk=el('disk').files[0];if(!bios||state!=='idle')return;await window.bootPc({files:{bios,...(disk?{hdd:disk}:{})},settings:{diskFormat:el('format').value,memory:Number(el('memory').value)}}).catch(e=>{if(state==='idle'&&e.message!=='Core terminated')status(e.message);});});
el('pause').onclick=async()=>{try{await releaseKeys();await host.pause();paused=true;controls('paused');status('PC paused.');}catch(e){status(e.message);}};
el('resume').onclick=async()=>{try{await host.resume();paused=false;controls('running');status('PC running.');canvas.focus();}catch(e){status(e.message);}};
el('reset').onclick=async()=>{try{await window.bootPc(bootOptions);}catch(e){if(state==='idle')status(e.message);}};
el('stop').onclick=()=>{host?.terminate();host=null;window.pcHost=null;keys.clear();paused=false;controls('idle');status('PC stopped.');};
async function isolation(){if(crossOriginIsolated)return;if(!('serviceWorker' in navigator)){status('This browser needs cross-origin isolation support.');return;}await navigator.serviceWorker.register('./coi-serviceworker.js');if(!navigator.serviceWorker.controller){navigator.serviceWorker.addEventListener('controllerchange',()=>location.reload(),{once:true});}else if(!sessionStorage.getItem('qemu-isolation-reload')){sessionStorage.setItem('qemu-isolation-reload','1');location.reload();}}
isolation().catch(e=>status(e.message));
