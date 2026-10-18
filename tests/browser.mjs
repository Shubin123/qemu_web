import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {chromium} from 'playwright-core';
import {serve} from '../tools/serve.mjs';
import {buildFlash,expectedChecksum} from './test-flash.js';

const executablePath=[process.env.CHROME_PATH,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/google-chrome','/usr/bin/chromium'].find(p=>p&&existsSync(p));
const {server,url}=process.env.TEST_BASE_URL?{server:null,url:process.env.TEST_BASE_URL}:await serve({port:0,quiet:true});
let browser;

try{
  browser=await chromium.launch({executablePath,headless:true});
  const page=await browser.newPage();
  const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://archive.org/**',route=>route.fulfill({
    status:200,
    contentType:'application/octet-stream',
    body:Buffer.alloc(2048),
    headers:{'content-length':'2048','access-control-allow-origin':'*'}
  }));

  await page.goto(url);
  await page.waitForFunction(()=>window.bootPc&&window.QemuLayout);
  await page.waitForFunction(()=>crossOriginIsolated,null,{timeout:30000});

  // 1. Core Azahar layout structure
  assert.equal(await page.locator('#btn-layout-menu').isVisible(),true);
  assert.equal(await page.locator('#start svg.pyramid').count(),1);
  assert.equal(await page.getByRole('button',{name:'Start PC',exact:true}).count(),1);
  assert.equal(await page.locator('#btn-templeos').isVisible(),true);
  assert.equal(await page.locator('#screen').isVisible(),true);
  assert.equal(await page.locator('#layout-menu').isVisible(),false);

  // Check that all 6 widgets are present in the masonry grid
  const widgetIds=['machine','media','controls','coverage','log','system'];
  for(const id of widgetIds){
    assert.equal(await page.locator(`#widget-grid > .card[data-widget="${id}"]`).count(),1);
  }

  // 2. Widget tools (collapse, span, hide)
  const machineCard=page.locator('.card[data-widget="machine"]');
  const collapseBtn=machineCard.locator('.widget-tool-collapse');
  assert.equal(await collapseBtn.getAttribute('aria-expanded'),'true');
  await collapseBtn.click();
  assert.equal(await machineCard.evaluate(el=>el.classList.contains('is-collapsed')),true);
  assert.equal(await collapseBtn.getAttribute('aria-expanded'),'false');
  await collapseBtn.click();
  assert.equal(await machineCard.evaluate(el=>el.classList.contains('is-collapsed')),false);

  // Span button cycles column span
  const spanBtn=machineCard.locator('.widget-tool-span');
  await spanBtn.click();
  const spanAfter=await machineCard.evaluate(el=>el.style.gridColumn);
  assert.match(spanAfter,/span \d/);

  // Hide button hides the widget
  const systemCard=page.locator('.card[data-widget="system"]');
  assert.equal(await systemCard.isVisible(),true);
  await systemCard.locator('.widget-tool-hide').click();
  assert.equal(await systemCard.isVisible(),false);

  // 3. Layout drawer menu
  await page.click('#btn-layout-menu');
  assert.equal(await page.locator('#layout-menu').isVisible(),true);
  assert.equal(await page.locator('#btn-layout-menu').getAttribute('aria-expanded'),'true');

  // Verify widget list in layout menu: system widget should be unchecked (hidden)
  const systemLi=page.locator('#layout-widget-list li[data-widget-id="system"]');
  assert.equal(await systemLi.locator('input[type="checkbox"]').isChecked(),false);
  // Restore system widget by checking its checkbox
  await systemLi.locator('input[type="checkbox"]').check();
  assert.equal(await systemCard.isVisible(),true);

  // Sliders: widget width and gap
  await page.locator('#layout-widget-width').fill('280');
  await page.locator('#layout-widget-width').dispatchEvent('input');
  assert.equal(await page.locator('#layout-widget-width-value').textContent(),'280px');
  assert.equal(await page.locator('#widget-grid').evaluate(el=>el.style.getPropertyValue('--widget-w')),'280px');

  await page.locator('#layout-gap').fill('16');
  await page.locator('#layout-gap').dispatchEvent('input');
  assert.equal(await page.locator('#layout-gap-value').textContent(),'16px');
  assert.equal(await page.locator('#widget-grid').evaluate(el=>el.style.getPropertyValue('--widget-gap')),'16px');

  // Reordering via layout menu move buttons (up/down)
  const firstLi=page.locator('#layout-widget-list li').first();
  const firstId=await firstLi.getAttribute('data-widget-id');
  await firstLi.locator('.layout-widget-actions button[title*="down"]').click();
  const newFirstId=await page.locator('#layout-widget-list li').first().getAttribute('data-widget-id');
  assert.notEqual(firstId,newFirstId);

  // Close menu via backdrop, close button, and Escape key
  await page.click('#btn-layout-menu-close');
  assert.equal(await page.locator('#layout-menu').isVisible(),false);
  assert.equal(await page.locator('#btn-layout-menu').getAttribute('aria-expanded'),'false');

  await page.click('#btn-layout-menu');
  assert.equal(await page.locator('#layout-menu').isVisible(),true);
  await page.click('#layout-menu-backdrop');
  assert.equal(await page.locator('#layout-menu').isVisible(),false);

  await page.click('#btn-layout-menu');
  assert.equal(await page.locator('#layout-menu').isVisible(),true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#layout-menu').isVisible(),false);

  // Reset layout to defaults
  await page.click('#btn-layout-menu');
  await page.click('#btn-layout-reset');
  assert.equal(await page.locator('#layout-widget-width-value').textContent(),'260px');
  assert.equal(await page.locator('#layout-gap-value').textContent(),'12px');
  await page.click('#btn-layout-menu-close');

  // 4. Moveable and Resizable widgets interaction & persistence
  // Double-clicking the resize handle resets span and height
  const resizeHandle=machineCard.locator('.widget-resize');
  await resizeHandle.dblclick();
  assert.equal(await machineCard.evaluate(el=>el.style.height),'');

  // Test layout reordering programmatic move and localStorage persistence
  await page.evaluate(()=>window.QemuLayout.move('system',0));
  const gridFirstId=await page.locator('#widget-grid > .card').first().getAttribute('data-widget');
  assert.equal(gridFirstId,'system');
  const stored=JSON.parse(await page.evaluate(()=>localStorage.getItem('qemu-layout')));
  assert.equal(stored.order[0],'system');

  // Reset back to defaults for clean state
  await page.evaluate(()=>window.QemuLayout.reset());

  // 5. TempleOS CDN Preset Button & Machine Setup
  await page.click('#btn-templeos');
  assert.equal(await page.locator('#os').inputValue(),'templeos');
  assert.equal(await page.locator('#architecture').inputValue(),'x86_64');
  assert.equal(await page.locator('#memory').inputValue(),'512');
  assert.equal(await page.locator('#start').isEnabled(),true);
  assert.equal(await page.locator('#fixture-notice').isVisible(),true);
  assert.match(await page.locator('#fixture-info').textContent(),/TempleOS V5\.03/);

  // Unavailable architecture checks (ARM 64-bit)
  await page.selectOption('#architecture','aarch64');
  assert.equal(await page.locator('#start').isDisabled(),true);
  assert.match(await page.locator('#compatibility-note').textContent(),/not included/);

  // 64-bit architecture enabled checks
  await page.selectOption('#architecture','x86_64');
  assert.equal(await page.locator('#start').isEnabled(),true);
  assert.match(await page.locator('#compatibility-note').textContent(),/64-bit engine available/);

  // Incompatible guest architecture combination check (e.g. Ubuntu requires x86_64/aarch64, not i386)
  await page.selectOption('#os','ubuntu');
  assert.equal(await page.locator('#architecture').inputValue(),'x86_64');
  assert.equal(await page.locator('#start').isEnabled(),true);
  await page.selectOption('#architecture','i386');
  assert.equal(await page.locator('#start').isDisabled(),true);
  assert.match(await page.locator('#compatibility-note').textContent(),/requires a different guest architecture/);

  await page.selectOption('#os','custom');
  assert.equal(await page.locator('#fixture-notice').isVisible(),false);
  await page.selectOption('#architecture','i386');
  assert.equal(await page.locator('#start').isEnabled(),true);
  assert.equal(await page.locator('#os-coverage tr').count(),7);

  // BIOS defaults and source selection
  assert.equal(await page.locator('#bios-source').inputValue(),'seabios');
  assert.equal(await page.locator('#bios-custom-box').isVisible(),false);
  assert.match(await page.locator('#bios-info').textContent(),/SeaBIOS.*bundled/i);
  await page.selectOption('#bios-source','builtin-test');
  assert.equal(await page.locator('#bios-custom-box').isVisible(),false);
  assert.match(await page.locator('#bios-info').textContent(),/diagnostic/i);
  await page.selectOption('#bios-source','custom');
  assert.equal(await page.locator('#bios-custom-box').isVisible(),true);

  // Form options: memory, format, serial
  await page.locator('form details summary').click();
  await page.selectOption('#memory','128');
  await page.selectOption('#format','qcow2');
  await page.check('#serial');

  // Test persistent download caching via Cache API
  await page.evaluate(async()=>{
    const cache=await caches.open('qemu-downloads-v1');
    await cache.put('https://example.com/test-fixture.iso',new Response(new Uint8Array([1,2,3,4]),{
      headers:{'content-type':'application/octet-stream','content-length':'4'}
    }));
  });
  // Trigger storage summary update
  await page.evaluate(async()=>await window.updateStorageSummary());
  const storageText=await page.locator('#storage-summary').textContent();
  assert.match(storageText,/cached download/);

  // Setting custom file and testing Reset defaults
  await page.locator('#bios').setInputFiles({name:'discard.bin',mimeType:'application/octet-stream',buffer:Buffer.from([0])});
  assert.equal(await page.locator('#bios-source').inputValue(),'custom');
  await page.selectOption('#os','templeos');
  await page.click('#menu-reset');
  assert.match(await page.locator('#menu-notice').textContent(),/Defaults restored/);
  assert.equal(await page.locator('#architecture').inputValue(),'i386');
  assert.equal(await page.locator('#os').inputValue(),'custom');
  assert.equal(await page.locator('#bios-source').inputValue(),'seabios');
  assert.equal(await page.locator('#bios-custom-box').isVisible(),false);
  assert.equal(await page.locator('#memory').inputValue(),'64');
  assert.equal(await page.locator('#format').inputValue(),'raw');
  assert.equal(await page.locator('#serial').isChecked(),false);
  assert.equal(await page.locator('#bios').inputValue(),'');
  assert.equal(await page.locator('form details').getAttribute('open'),null);

  // 6. BIOS boot and console checksum verification (using default built-in diagnostic BIOS)
  await page.selectOption('#bios-source','builtin-test');

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

  // Machine controls test: pause, resume, reset, stop
  assert.equal(await page.locator('#start').isDisabled(),true);
  assert.equal(await page.locator('#resume').isDisabled(),true);
  assert.equal(await page.locator('#menu-reset').isDisabled(),true);
  assert.equal(await page.locator('#setup-state').isVisible(),true);
  assert.equal(await page.locator('#bios').isDisabled(),true);

  await page.click('#pause');
  await page.waitForFunction(()=>document.querySelector('#status').textContent==='PC paused.');
  assert.equal(await page.locator('#pause').isDisabled(),true);

  await page.click('#resume');
  await page.waitForFunction(()=>document.querySelector('#status').textContent==='PC running.');

  await page.click('#reset');
  await page.waitForFunction(()=>document.querySelector('#status').textContent.startsWith('PC running.'));

  await page.click('#stop');
  await page.waitForFunction(()=>document.querySelector('#status').textContent==='PC stopped.');
  assert.equal(await page.locator('#start').isEnabled(),true);
  assert.equal(await page.locator('#machine-controls').isVisible(),false);

  // Clear log test
  await page.click('#clear-log');
  assert.equal(await page.locator('#log').textContent(),'');

  // Cancel startup and immediately start again
  await page.click('#start');
  await page.click('#stop');
  await page.click('#start');
  await page.waitForFunction(()=>document.querySelector('#status').textContent.startsWith('PC running.'));
  await page.click('#stop');
  await page.waitForFunction(()=>document.querySelector('#status').textContent==='PC stopped.');

  // Verify Start PC button works after pressing TempleOS button
  await page.click('#btn-templeos');
  assert.equal(await page.locator('#start').isEnabled(),true);
  await page.click('#start');
  await page.waitForFunction(()=>document.querySelector('#status').textContent.startsWith('PC running.'),null,{timeout:30000});
  await page.waitForFunction(()=>window.pcHost?.getStats()?.width>0&&window.pcHost?.getStats()?.framesPresented>0,null,{timeout:30000});
  await page.click('#stop');
  await page.waitForFunction(()=>document.querySelector('#status').textContent==='PC stopped.');

  // 7. Responsive viewport check
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);

  assert.deepEqual(errors,[]);
  console.log('Azahar moveable widget layout and emulator lifecycle tests passed');
}finally{
  await browser?.close();
  server?.close();
}
