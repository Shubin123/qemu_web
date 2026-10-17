// End-to-end acceptance-runner self-test using original generated firmware.
// This is not an operating-system compatibility test.
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
const dir=mkdtempSync(join(tmpdir(),'qemu-os-harness-'));
try{
  const code=[0xfa,0xba,0xf8,0x03]; // CLI; DX = COM1
  const print=text=>{for(const byte of new TextEncoder().encode(text))code.push(0xb0,byte,0xee);};
  print('HARNESS:READY\n');
  // Poll the keyboard controller, then consume one key byte.
  code.push(0xe4,0x64,0xa8,0x01,0x74,0xfa,0xe4,0x60);
  print('HARNESS:KEY\n');code.push(0xf4,0xeb,0xfd);
  const bios=new Uint8Array(256*1024).fill(255);bios.set(code,bios.length-512);
  bios.set([0xe9,0x0d,0xfe],bios.length-16);
  writeFileSync(join(dir,'generated.bin'),bios);writeFileSync(join(dir,'generated.img'),new Uint8Array(512));
  writeFileSync(join(dir,'plan.json'),JSON.stringify({validation:'generated-firmware-harness',cases:[{
    name:'Generated firmware console and keyboard',os:'custom',architecture:'i386',
    bios:'generated.bin',disk:'generated.img',timeoutMs:10000,
    steps:[{expect:'HARNESS:READY'},{type:'a',expect:'HARNESS:KEY'}],
  }]}));
  const report='tests/artifacts/os-harness-results.json';
  const run=spawnSync(process.execPath,['tests/os-browser.mjs',join(dir,'plan.json'),report],{stdio:'inherit'});
  assert.equal(run.status,0);
  const result=JSON.parse(readFileSync(report));
  assert.equal(result.validation,'generated-firmware-harness');assert.equal(result.passed,true);
  assert.equal(result.cases[0].media.bios.sha256.length,64);
  assert.equal(result.cases[0].checkpoints.length,2);
}finally{rmSync(dir,{recursive:true,force:true});}
