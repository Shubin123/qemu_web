import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {chromium} from 'playwright-core';
import {serve} from '../tools/serve.mjs';
import {buildFlash,expectedChecksum} from './test-flash.js';
const executablePath=[process.env.CHROME_PATH,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/google-chrome','/usr/bin/chromium'].find(p=>p&&existsSync(p));
const {server,url}=await serve({port:0,quiet:true});let browser;
try{
  browser=await chromium.launch({executablePath,headless:true});
  const page=await browser.newPage();const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(url);await page.waitForFunction(()=>window.bootPc);
  assert.equal(await page.locator('button:visible').count(),1);
  await page.locator('#bios').setInputFiles({name:'generated-test.bin',mimeType:'application/octet-stream',buffer:Buffer.from(buildFlash(20000000))});
  // Observe the normal form submission without bypassing its file/configuration path.
  await page.evaluate(()=>{
    const boot=window.bootPc;
    window.bootPc=options=>{
      const result=boot({...options,args:['-debugcon','stdio']});
      window.testLines=[];
      window.pcHost.addEventListener('log',e=>testLines.push(...e.detail.lines.map(l=>l.text)));
      return result;
    };
  });
  const started=Date.now();
  await page.click('#start');
  await page.waitForFunction(()=>testLines.some(l=>l.includes('XEMUWEB:DONE')),null,{timeout:60000});
  const lines=await page.evaluate(()=>testLines);
  assert.ok(lines.some(l=>l.includes(expectedChecksum(20000000).toString(16).toUpperCase().padStart(8,'0'))));
  console.log(`Start button to generated BIOS checksum: ${Date.now()-started} ms`);
  assert.equal(await page.locator('#start').isDisabled(),true);
  assert.equal(await page.locator('#resume').isDisabled(),true);
  await page.click('#pause');
  await page.waitForFunction(()=>document.querySelector('#status').textContent==='PC paused.');
  assert.equal(await page.locator('#pause').isDisabled(),true);
  await page.click('#resume');
  await page.waitForFunction(()=>document.querySelector('#status').textContent==='PC running.');
  await page.click('#reset');
  await page.waitForFunction(()=>document.querySelector('#status').textContent.startsWith('PC running.'));
  await page.click('#stop');
  assert.equal(await page.locator('#start').isEnabled(),true);
  assert.equal(await page.locator('button:visible').count(),1);
  // Cancel startup, then immediately start again with the same selected BIOS.
  await page.click('#start');await page.click('#stop');await page.click('#start');
  await page.waitForFunction(()=>document.querySelector('#status').textContent.startsWith('PC running.'));
  await page.click('#stop');
  assert.deepEqual(errors,[]);
  console.log('Start, checksum, pause/resume, reset, stop and restart passed');
}finally{await browser?.close();server.close();}
