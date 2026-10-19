import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {chromium} from 'playwright-core';
import {serve} from '../tools/serve.mjs';
const executablePath=[process.env.CHROME_PATH,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/google-chrome','/usr/bin/chromium'].find(p=>p&&existsSync(p));
const {server,url}=await serve({port:0,quiet:true});
let browser;
try {
  browser=await chromium.launch({executablePath,headless:true});
  const page=await browser.newPage();
  await page.goto(url);
  await page.evaluate(async()=>{await navigator.serviceWorker.register('./coi-serviceworker.js');await navigator.serviceWorker.ready;});
  await page.waitForFunction(()=>navigator.serviceWorker.controller);
  const result=await page.evaluate(async()=>{
    await (await fetch('./cores/qemu/qemu-core.js?build=generated-test')).text();
    const name=(await caches.keys()).find(k=>k.startsWith('qemu-build-cache-'));
    const cache=await caches.open(name);
    const record=new URL('./cores/qemu/qemu-core.build.json',location.href);
    await cache.put(record,new Response(JSON.stringify({coreId:'obsolete-fixture'}),{headers:{'Content-Type':'application/json'}}));
    return {
      explicit:(await (await fetch(record,{cache:'no-store'})).json()).coreId,
      ordinary:(await (await fetch(record)).json()).coreId,
      cachedScript:!!await cache.match(new URL('./cores/qemu/qemu-core.js?build=generated-test',location.href))
    };
  });
  const expected=JSON.parse(readFileSync('runtime/runtime.json')).coreId;
  assert.equal(result.explicit,expected);
  assert.equal(result.ordinary,expected,'build records must bypass a stale service-worker cache');
  assert.equal(result.cachedScript,true,'versioned core assets remain cached');
  console.log('PASS: service worker caches core assets while revalidating build identities');
}finally{await browser?.close();server.close();}
