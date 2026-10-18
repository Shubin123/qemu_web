import {cpSync,existsSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const manifest=JSON.parse(readFileSync('runtime/runtime.json'));
for(const file of manifest.files){if(!/^(src|cores)\/[a-zA-Z0-9_./-]+$/.test(file.path)||file.path.includes('..'))throw Error('Invalid manifest path');const bytes=readFileSync(`runtime/${file.path}`);if(bytes.length!==file.size||createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw Error(`Runtime mismatch: ${file.path}`);}
const wasm=readFileSync('runtime/cores/qemu/qemu-core.wasm');if(!WebAssembly.validate(wasm)||manifest.coreId!==`sha256:${createHash('sha256').update(wasm).digest('hex')}`)throw Error('Invalid i386 core');
const wasm64=readFileSync('runtime/cores/qemu-x86_64-wasm64/qemu-core.wasm');
const isWasm64=wasm64.length>=8&&wasm64[0]===0&&wasm64[1]===0x61&&wasm64[2]===0x73&&wasm64[3]===0x6d;
const hash64=createHash('sha256').update(wasm64).digest('hex');
if(!isWasm64||hash64!==(manifest.cores?.x86_64?.replace(/^sha256:/,'')||'ff9e35ded3d93cdd9b11812c689fdf0594282fc71f7ab344b60b78272c58d750'))throw Error('Invalid x86_64 core');
rmSync('web',{recursive:true,force:true});mkdirSync('web');cpSync('app','web',{recursive:true});cpSync('runtime/src','web/src',{recursive:true});cpSync('runtime/cores','web/cores',{recursive:true});cpSync('LICENSE','web/LICENSE');cpSync('runtime/runtime.json','web/runtime.json');
const sw='web/coi-serviceworker.js';writeFileSync(sw,readFileSync(sw,'utf8').replace('__QEMU_RELEASE__',manifest.coreId.slice(7,23)));writeFileSync('web/.nojekyll','');console.log(`Built ${manifest.coreId} (includes i386 and x86_64 cores)`);
