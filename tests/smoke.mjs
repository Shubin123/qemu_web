import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
const html=readFileSync('web/index.html','utf8');for(const id of ['bios','disk','screen','start','pause','resume','stop'])assert.ok(html.includes(`id="${id}"`));
assert.match(html,/releases\/download\/engine-fc8c638\/qemu-emscripten-fc8c638-source.tar.gz/);assert.ok(!readFileSync('web/coi-serviceworker.js','utf8').includes('__QEMU_RELEASE__'));console.log('Public bundle smoke checks passed');
