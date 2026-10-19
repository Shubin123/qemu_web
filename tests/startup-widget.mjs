// Widget choices and lifecycle are tested separately from the engine's real
// save/reload/restore test, using a small profile double and generated metadata.
import assert from 'node:assert/strict';
import {existsSync,mkdirSync} from 'node:fs';
import {chromium} from 'playwright-core';
import {serve} from '../tools/serve.mjs';
const executablePath=[process.env.CHROME_PATH,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/google-chrome','/usr/bin/chromium'].find(p=>p&&existsSync(p));
const {server,url}=await serve({port:0,quiet:true});
let browser;
try {
  browser=await chromium.launch({executablePath,headless:true});
  const page=await browser.newPage(), errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/src/qemu-boot-cache.js',route=>route.fulfill({contentType:'text/javascript',body:`
    window.fixtureCache={cached:true,saved:true,name:'generated.iso',settings:{memory:128,diskFormat:'raw'},savedAt:'2026-01-01T00:00:00Z'};
    export async function getBootCacheInfo(){return window.fixtureCache;}
    export async function clearBootCache(){window.fixtureCache={cached:false,saved:false};}
    export async function prepareCachedMachine(o){
      window.machineAttempts||=[];window.machineAttempts.push({slot:o.slot,mode:o.sessionMode});
      return {coreUrl:o.coreUrl,restore:o.sessionMode==='resume',boot:{files:{bios:new Uint8Array([255])}},dispose:async()=>{},
        save:async()=>{o.onProgress({phase:'saving-session'});window.genericSaved=o.slot;o.onProgress({phase:'session-saved'});}};
    }
  `}));
  await page.route('**/src/qemu-host.js',route=>route.fulfill({contentType:'text/javascript',body:`
    export class QemuHost extends EventTarget{constructor(){super();}async boot(o){window.genericOptions=o;}terminate(){}getStats(){return {running:true};}}
  `}));
  await page.route('**/src/qemu-cachyos.js',route=>route.fulfill({contentType:'text/javascript',body:`
    export async function bootCachyos(o){
      window.bootAttempts||=[];window.bootAttempts.push({cacheBoot:o.cacheBoot,sessionMode:o.sessionMode});
      if(window.failNextBoot){window.failNextBoot=false;throw new Error('generated restore failure');}
      if(window.delayBoot)await new Promise((resolve,reject)=>o.signal.addEventListener('abort',()=>{window.sawAbort=true;reject(new DOMException('Stopped','AbortError'));},{once:true}));
      const h=new EventTarget();h.resumedSession=o.sessionMode==='resume';h.desktopReady=Promise.resolve(h);
      h.terminate=()=>{};
      h.saveBootSession=async()=>{
        o.onProgress({phase:'saving-session'});
        if(window.failSave)throw new Error('generated quota failure');
        window.savedCount=(window.savedCount||0)+1;o.onProgress({phase:'session-saved'});
      };
      o.onHost(h);return h;
    }
  `}));
  const open=async()=>{
    await page.goto(url);
    await page.waitForFunction(()=>window.bootPc&&window.QemuLayout);
    await page.selectOption('#os','cachyos');
    await page.waitForFunction(()=>document.querySelector('#boot-cache-status').textContent.includes('generated.iso'));
  };
  await open();
  assert.equal(await page.locator('#boot-cache-options').isVisible(),true);
  mkdirSync('tests/artifacts',{recursive:true});
  await page.locator('#boot-cache-options').screenshot({path:'tests/artifacts/startup-widget.png'});
  assert.equal(await page.locator('#boot-cache').isChecked(),true);
  assert.equal(await page.locator('#session-mode').inputValue(),'resume');
  await page.click('#start');
  await page.waitForFunction(()=>window.bootAttempts?.length===1&&!document.querySelector('#save-session').disabled);
  assert.deepEqual(await page.evaluate(()=>bootAttempts[0]),{cacheBoot:true,sessionMode:'resume'});
  assert.equal(await page.locator('#clear-boot-cache').isDisabled(),true);
  await page.click('#save-session');
  await page.waitForFunction(()=>window.savedCount===1&&!document.querySelector('#save-session').disabled);
  await page.evaluate(()=>window.failSave=true);
  await page.click('#save-session');
  await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('quota failure'));
  assert.equal(await page.locator('#save-session').isDisabled(),false);
  await page.click('#stop');
  await page.selectOption('#session-mode','fresh');
  await page.click('#start');
  await page.waitForFunction(()=>window.bootAttempts?.length===2);
  assert.deepEqual(await page.evaluate(()=>bootAttempts[1]),{cacheBoot:true,sessionMode:'fresh'});
  await page.click('#stop');
  await open();
  assert.equal(await page.locator('#session-mode').inputValue(),'fresh','startup preference survives reload');
  await page.evaluate(()=>window.failNextBoot=true);
  await page.click('#start');
  await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('generated restore failure'));
  assert.equal(await page.locator('#start').isDisabled(),false,'failed restore returns to idle');
  await page.evaluate(()=>window.delayBoot=true);
  await page.click('#start');
  await page.waitForFunction(()=>window.bootAttempts?.length===2);
  await page.click('#stop');
  await page.waitForFunction(()=>window.sawAbort);
  assert.equal(await page.locator('#status').textContent(),'PC stopped.','aborted cache preparation must not overwrite stopped status');
  await page.selectOption('#os','custom');
  await page.selectOption('#architecture','i386');
  await page.waitForFunction(()=>!document.querySelector('#start-cached').disabled);
  await page.click('#start-cached');
  await page.waitForFunction(()=>window.machineAttempts?.length===1&&!document.querySelector('#save-session').disabled);
  assert.deepEqual(await page.evaluate(()=>machineAttempts[0]),{slot:'pc:i386:custom',mode:'fresh'});
  assert.equal(await page.evaluate(()=>genericOptions.settings.memory),128,'cached start restores saved memory settings');
  await page.click('#save-session');
  await page.waitForFunction(()=>window.genericSaved==='pc:i386:custom');
  await page.click('#stop');
  await page.selectOption('#session-mode','resume');
  await page.click('#start-cached');
  await page.waitForFunction(()=>window.machineAttempts?.length===2);
  assert.equal(await page.evaluate(()=>machineAttempts[1].mode),'resume');
  await page.click('#stop');
  await page.selectOption('#os','cachyos');
  await page.click('#clear-boot-cache');
  await page.waitForFunction(()=>document.querySelector('#boot-cache-status').textContent.includes('No cached boot files'));
  await page.click('#start');
  await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('choose a local CachyOS ISO'));
  await page.uncheck('#boot-cache');
  assert.equal(await page.locator('#session-mode').isDisabled(),true);
  assert.deepEqual(errors,[]);
  console.log('PASS: startup widget resume/fresh choices, preference persistence, save, clear and failure recovery');
} finally {await browser?.close();server.close();}
