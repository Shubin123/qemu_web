import {QemuHost} from './src/qemu-host.js';
const el=id=>document.getElementById(id), canvas=el('screen');
let host=null, paused=false;
const keys=new Map();
function status(text){el('status').textContent=text;}
function controls(running){for(const id of ['pause','resume','reset','stop'])el(id).disabled=!running;el('start').disabled=running;}
function log(text){el('log').textContent=(el('log').textContent+text+'\n').slice(-24000);}
async function releaseKeys(){if(!host)return;const pending=[...keys.values()];keys.clear();await Promise.allSettled(pending.map(key=>host.key(key,false)));}
const special={Enter:'ret',Escape:'esc',Backspace:'backspace',Tab:'tab',Space:'spc',ArrowUp:'up',ArrowDown:'down',ArrowLeft:'left',ArrowRight:'right',ShiftLeft:'shift',ShiftRight:'shift_r',ControlLeft:'ctrl',ControlRight:'ctrl_r',AltLeft:'alt',AltRight:'alt_r',Delete:'delete',Insert:'insert',Home:'home',End:'end',PageUp:'pgup',PageDown:'pgdn',CapsLock:'caps_lock',Minus:'minus',Equal:'equal',BracketLeft:'bracket_left',BracketRight:'bracket_right',Backslash:'backslash',Semicolon:'semicolon',Quote:'apostrophe',Backquote:'grave_accent',Comma:'comma',Period:'dot',Slash:'slash'};
function qcode(code){return special[code]||(/^Key[A-Z]$/.test(code)?code.slice(3).toLowerCase():/^Digit[0-9]$/.test(code)?code.slice(5):/^F([1-9]|1[0-2])$/.test(code)?code.toLowerCase():null);}
canvas.addEventListener('keydown',e=>{const key=qcode(e.code);if(!host||paused||!key)return;e.preventDefault();if(keys.has(e.code))return;keys.set(e.code,key);host.key(key,true).catch(e=>status(e.message));});
canvas.addEventListener('keyup',e=>{const key=keys.get(e.code);if(!key||!host)return;e.preventDefault();keys.delete(e.code);host.key(key,false).catch(e=>status(e.message));});
canvas.addEventListener('blur',releaseKeys);window.addEventListener('blur',releaseKeys);
window.bootPc=async options=>{
  host?.terminate();keys.clear();paused=false;host=new QemuHost({canvas});window.pcHost=host;
  host.addEventListener('log',e=>e.detail.lines.forEach(line=>log(line.text)));
  for(const type of ['error','abort'])host.addEventListener(type,e=>{status(e.detail.message);host?.terminate();host=null;controls(false);});
  host.addEventListener('exited',()=>{status('PC stopped.');controls(false);});
  controls(true);status('Starting PC…');
  try{await host.boot({memoryOrder:'auto',...options});status('PC running. Click the display to use the keyboard.');canvas.focus();return host;}
  catch(e){host?.terminate();host=null;controls(false);status(e.message);throw e;}
};
el('boot').addEventListener('submit',async e=>{e.preventDefault();const bios=el('bios').files[0],disk=el('disk').files[0];if(!bios)return;await window.bootPc({files:{bios,...(disk?{hdd:disk}:{})},settings:{diskFormat:el('format').value,memory:Number(el('memory').value)}}).catch(()=>{});});
el('pause').onclick=async()=>{try{await releaseKeys();await host.pause();paused=true;status('PC paused.');}catch(e){status(e.message);}};
el('resume').onclick=async()=>{try{await host.resume();paused=false;status('PC running.');canvas.focus();}catch(e){status(e.message);}};
el('reset').onclick=async()=>{try{await releaseKeys();await host.reset();status('PC reset.');}catch(e){status(e.message);}};
el('stop').onclick=()=>{host?.terminate();host=null;keys.clear();controls(false);status('PC stopped.');};
async function isolation(){if(crossOriginIsolated)return;if(!('serviceWorker' in navigator)){status('This browser needs cross-origin isolation support.');return;}await navigator.serviceWorker.register('./coi-serviceworker.js');if(!navigator.serviceWorker.controller){navigator.serviceWorker.addEventListener('controllerchange',()=>location.reload(),{once:true});}else if(!sessionStorage.getItem('qemu-isolation-reload')){sessionStorage.setItem('qemu-isolation-reload','1');location.reload();}}
isolation().catch(e=>status(e.message));
