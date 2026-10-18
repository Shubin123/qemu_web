import assert from 'node:assert/strict';
import {test} from 'node:test';
import {machineProblem,selectedBootOptions} from '../app/machines.js';
import {buildArguments} from '../runtime/src/qemu-config.js';
test('unavailable and incompatible guests cannot launch the 32-bit core',()=>{
  for(const architecture of ['x86_64','aarch64','invalid'])assert.throws(()=>selectedBootOptions({architecture,bios:{}}));
  for(const system of ['ubuntu','fedora','windows','invalid'])assert.ok(machineProblem('i386',system));
  assert.equal(machineProblem('i386','templeos'),'');
});
test('ISO and disk selections produce valid pinned-runtime configuration',()=>{
  const bios={},disk={},disc={};
  const options=selectedBootOptions({architecture:'i386',system:'alpine',bios,disk,disc,format:'qcow2',memory:128,serial:true});
  assert.equal(options.files.bios,bios);assert.equal(options.files.disc,disc);assert.equal(options.files.hdd,disk);
  const args=[...buildArguments(options.settings,{...options.files,disc:'/media/disc-1.iso'}),...options.args];
  assert.ok(args.includes('order=dc'));assert.ok(args.includes('isa-serial,chardev=console,index=0'));
  assert.ok(args.includes('file=/media/disc-1.iso,if=ide,index=2,media=cdrom,format=raw,readonly=on'));
  assert.ok(args.includes('file=/disk/disk.img,if=ide,index=0,media=disk,format=qcow2'));
});
test('TempleOS fixture produces valid boot options on i386',()=>{
  const bios={};
  const options=selectedBootOptions({architecture:'i386',system:'templeos',bios});
  assert.equal(options.architecture,'i386');
  assert.equal(options.files.bios,bios);
  assert.equal(options.files.disc.id,'templeos');
  assert.ok(options.args.includes('order=dc'));
});
