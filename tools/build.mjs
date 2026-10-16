import {cpSync,existsSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const manifest=JSON.parse(readFileSync('runtime/runtime.json'));
for(const file of manifest.files){if(!/^(src|cores)\/[a-zA-Z0-9_./-]+$/.test(file.path)||file.path.includes('..'))throw Error('Invalid manifest path');const bytes=readFileSync(`runtime/${file.path}`);if(bytes.length!==file.size||createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw Error(`Runtime mismatch: ${file.path}`);}
const wasm=readFileSync('runtime/cores/qemu/qemu-core.wasm');if(!WebAssembly.validate(wasm)||manifest.coreId!==`sha256:${createHash('sha256').update(wasm).digest('hex')}`)throw Error('Invalid core');
rmSync('web',{recursive:true,force:true});mkdirSync('web');cpSync('app','web',{recursive:true});cpSync('runtime/src','web/src',{recursive:true});cpSync('runtime/cores','web/cores',{recursive:true});cpSync('LICENSE','web/LICENSE');cpSync('runtime/runtime.json','web/runtime.json');
const sw='web/coi-serviceworker.js';writeFileSync(sw,readFileSync(sw,'utf8').replace('__QEMU_RELEASE__',manifest.coreId.slice(7,23)));writeFileSync('web/.nojekyll','');console.log(`Built ${manifest.coreId}`);
