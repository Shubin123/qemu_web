// Local-media OS acceptance tests. No firmware or images are downloaded or saved.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createReadStream,existsSync} from 'node:fs';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {chromium} from 'playwright-core';
import {serve} from '../tools/serve.mjs';
import {machineProblem} from '../app/machines.js';

const planPath=process.argv[2];
if(!planPath)throw new Error('Usage: npm run test:os -- /path/to/os-plan.json (see tests/os-plan.example.json)');
const plan=JSON.parse(await readFile(planPath,'utf8'));
assert.ok(Array.isArray(plan.cases)&&plan.cases.length,'At least one OS case is required');
const base=dirname(resolve(planPath));
for(const entry of plan.cases){
  assert.ok(entry.name&&entry.os&&entry.architecture,'Each case needs name, os and architecture');
  assert.equal(machineProblem(entry.architecture,entry.os),'',`${entry.name}: unsupported guest`);
  assert.ok(entry.bios&&(entry.disk||entry.disc),'Local BIOS and boot media are required');
  assert.ok(entry.steps?.length&&entry.steps.every(step=>typeof step.expect==='string'&&step.expect.length),'Each step requires a literal guest console checkpoint');
  assert.ok(entry.steps.some(step=>typeof step.type==='string'&&step.type.length),'OS acceptance requires a keyboard interaction and its resulting console checkpoint');
}
const hashFile=async path=>{const hash=createHash('sha256');for await(const bytes of createReadStream(path))hash.update(bytes);return hash.digest('hex');};
const executablePath=[process.env.CHROME_PATH,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/google-chrome','/usr/bin/chromium'].find(p=>p&&existsSync(p));
const {server,url}=await serve({port:0,quiet:true});let browser;
const report={schemaVersion:1,createdAt:new Date().toISOString(),validation:plan.validation??'os-acceptance',coreId:JSON.parse(await readFile('runtime/runtime.json','utf8')).coreId,cases:[]};
try{
  browser=await chromium.launch({executablePath,headless:true});report.browser=`Chromium ${browser.version()}`;
  for(const entry of plan.cases){
    const result={name:entry.name,os:entry.os,architecture:entry.architecture,passed:false,media:{},checkpoints:[]};
    report.cases.push(result);const page=await browser.newPage();const errors=[];
    page.on('pageerror',error=>errors.push(error.message));const started=Date.now();
    try{
      await page.goto(url);await page.waitForFunction(()=>window.bootPc);
      if(await page.locator('#setup-menu').count())await page.click('#menu-toggle');
      await page.selectOption('#architecture',entry.architecture);await page.selectOption('#os',entry.os);
      for(const key of ['bios','disk','disc'])if(entry[key]){
        const path=resolve(base,entry[key]);result.media[key]={sha256:await hashFile(path)};
        await page.setInputFiles(`#${key}`,path);
      }
      await page.locator('details').filter({has:page.locator('#memory')}).locator('summary').click();
      await page.selectOption('#memory',String(entry.memory??128));
      await page.selectOption('#format',entry.diskFormat??'raw');
      await page.check('#serial');
      await page.evaluate(()=>{
        const boot=window.bootPc;window.osConsole='';
        window.bootPc=options=>{
          const pending=boot(options);
          window.pcHost.addEventListener('log',event=>{window.osConsole=(window.osConsole+event.detail.lines.map(line=>line.text).join('\n')+'\n').slice(-1000000);});
          return pending;
        };
      });
      if(await page.locator('#menu-done').isVisible())await page.click('#menu-done');
      await page.click('#start');
      await page.waitForFunction(()=>window.pcHost?.getStats()?.running,{timeout:30000});
      for(const step of entry.steps){
        // Consume preceding output, so the next checkpoint must follow this action.
        if(step.type){
          await page.evaluate(()=>{window.osConsole='';});await page.focus('#screen');
          for(const character of step.type){
            if(character==='\n')await page.keyboard.press('Enter');
            else await page.keyboard.type(character,{delay:30});
          }
        }
        await page.waitForFunction(text=>window.osConsole.includes(text),step.expect,{timeout:entry.timeoutMs??180000});
        result.checkpoints.push(step.expect);
      }
      assert.deepEqual(errors,[]);result.passed=true;
    }catch(error){result.error=error.message;}
    finally{
      result.elapsedMs=Date.now()-started;
      result.console=await page.evaluate(()=>window.osConsole||'').catch(()=>'');
      await page.close();console.log(`${result.passed?'PASS':'FAIL'} ${entry.name} (${result.elapsedMs} ms)`);
    }
  }
}finally{
  await browser?.close();await new Promise(done=>server.close(done));
  report.passed=report.cases.length===plan.cases.length&&report.cases.every(entry=>entry.passed);
  const reportPath=process.argv[3]||'tests/artifacts/os-results.json';
  await mkdir(dirname(reportPath),{recursive:true});
  await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');
}
assert.ok(report.passed,`OS acceptance failed; see ${process.argv[3]||'tests/artifacts/os-results.json'}`);
