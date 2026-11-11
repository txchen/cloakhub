// Reuses the repository's unmodified probes; only process startup is adapted.
import { chromium } from 'playwright-core';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { startFixtures } from '../../../tests/browser-evaluation/fixtures.mjs';
import { measureLocal, summarizeSurface } from '../../../tests/browser-evaluation/measurements.mjs';
import { surface } from '../../../tests/browser-evaluation/surface.mjs';
import { runDetectors } from '../../../tests/browser-evaluation/detectors.mjs';
import { browserEnv, stopOwned, sleep, withSignal, redactor } from '../../../tests/browser-evaluation/util.mjs';
const [kind, executable, output, scope = 'all'] = process.argv.slice(2);
if (!output) throw Error('Usage: node run.mjs cloak|default|stealth EXECUTABLE OUTPUT.json');
const dir = await mkdtemp('/tmp/obscura-evaluation-');
const fixtures = await startFixtures();
const record = { kind, startedAt: new Date().toISOString(), version: execFileSync(executable,['--version'],{encoding:'utf8'}).trim(), executableSHA256: createHash('sha256').update(await readFile(executable)).digest('hex'), probes:{} };
const args = kind === 'cloak' ? ['--headless=new','--no-sandbox','--use-gl=angle','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0',`--user-data-dir=${dir}/profile`,'--no-first-run','--no-default-browser-check','--fingerprint=20260909','--fingerprint-platform=linux','--window-size=1366,768','about:blank'] : ['serve','--host','127.0.0.1','--port','0','--ready-file',`${dir}/ready`,'--allow-private-network','--storage-dir',`${dir}/storage`,...(kind === 'stealth' ? ['--stealth'] : [])];
record.args=args;
let child, browser;
const redact=redactor();
const deadline=setTimeout(async()=>{ record.error='Global deadline exceeded';record.finishedAt=new Date().toISOString();await writeFile(output,JSON.stringify(record,null,2));await stopOwned(child);await fixtures.close();await rm(dir,{recursive:true,force:true});process.exit(124); },300000);
async function probe(name,fn,ms=30000) { const start=Date.now(); try { record.probes[name]={status:'complete',value:await withSignal(fn(),AbortSignal.timeout(ms))}; } catch(e) {record.probes[name]={status:'error',error:redact(e.message)};} record.probes[name].wallMs=Date.now()-start; await writeFile(output,JSON.stringify(record,null,2)); }
try {
  const start=Date.now();
  child=spawn(executable,args,{detached:true,env:browserEnv(dir),stdio:['ignore','ignore','ignore']});
  child.on('error',e=>{record.spawnError=e.message;});
  let endpoint;
  for(let i=0;i<150;i++) { try { const ready=await readFile(kind==='cloak'?`${dir}/profile/DevToolsActivePort`:`${dir}/ready`,'utf8'); endpoint=kind==='cloak'?`http://127.0.0.1:${ready.split('\n')[0]}`:`http://${JSON.parse(ready).host}:${JSON.parse(ready).port}`; break; }catch{} if(child.exitCode!==null) throw Error(`Process exited ${child.exitCode}`); await sleep(100); }
  if(!endpoint) throw Error('No readiness file');
  record.readyMs=Date.now()-start;
  browser=await chromium.connectOverCDP(endpoint,{timeout:15000});
  record.cdpVersion=browser.version();
  await probe('suiteSmoke',async()=> { const partial={}; record.suitePartial=partial; await measureLocal(browser,fixtures,{plan:'smoke'},{routeRequests:8},AbortSignal.timeout(45000),partial); return partial; },50000);
  // Separate diagnostics keep an early suite failure from hiding other capabilities.
  const context=browser.contexts()[0];
  const page=await context.newPage(); page.setDefaultTimeout(5000);
  await page.goto(fixtures.origin,{timeout:10000});
  await probe('surface',async()=>summarizeSurface(await page.evaluate(surface)));
  await probe('identityHeaders',async()=>({identity:await page.evaluate(async()=>({ua:navigator.userAgent,platform:navigator.platform,webdriver:navigator.webdriver,cpu:navigator.hardwareConcurrency,hints:await navigator.userAgentData?.getHighEntropyValues(['architecture','bitness','platformVersion','fullVersionList'])})),headers:await page.evaluate(()=>fetch('/echo').then(r=>r.json()))}));
  await probe('workerIsolation',()=>page.evaluate(()=>new Promise((resolve,reject)=>{const blob=new Blob(["postMessage({document:typeof document,window:typeof window,importScripts:typeof importScripts,offscreen:typeof OffscreenCanvas})"],{type:'text/javascript'});const w=new Worker(URL.createObjectURL(blob));const t=setTimeout(()=>{w.terminate();reject(Error('Worker timeout'));},5000);w.onmessage=e=>{clearTimeout(t);w.terminate();resolve(e.data)};})));
  await probe('worker',()=>page.evaluate(()=>new Promise((resolve,reject)=>{const w=new Worker('/worker.js');const t=setTimeout(()=>{w.terminate();reject(Error('Worker timeout'));},10000);w.onmessage=e=>{clearTimeout(t);w.terminate();resolve(e.data);};w.onerror=e=>{clearTimeout(t);w.terminate();reject(Error(e.message));};})).then(v=>v.error?{error:v.error}:summarizeSurface(v)),15000);
  await probe('frame',async()=>{await page.evaluate(url=>{const f=document.createElement('iframe');f.src=url;document.body.append(f)},fixtures.frameOrigin);await sleep(1500);const frame=page.frames().find(f=>f.url().startsWith(fixtures.frameOrigin));if(!frame)throw Error('No cross-origin frame');return summarizeSurface(await frame.evaluate(surface));});
  await probe('interception',async()=>{let handled=0;await page.route('**/api/data?*',async r=>{const response=await r.fetch();await r.fulfill({response,json:{...await response.json(),intercepted:true}});handled++;});const result=await page.evaluate(async()=>{const rows=[];for(let i=0;i<8;i++)rows.push(await fetch(`/api/data?id=${i}`).then(r=>r.json()));return rows;});await page.unrouteAll({behavior:'wait'});return {handled,good:result.filter((x,i)=>x.intercepted&&x.id===String(i)).length,requested:8};});
  await probe('secondConnection',async()=>{await page.evaluate(()=>window.__obscuraComparisonMarker='owned-test-page');const second=await chromium.connectOverCDP(endpoint,{timeout:10000});try{return {firstPages:context.pages().length,secondPages:second.contexts()[0].pages().length,markerVisible:await Promise.all(second.contexts()[0].pages().map(p=>p.evaluate(()=>window.__obscuraComparisonMarker??null)))}}finally{await second.close();}});
  await page.close().catch(()=>{});
  if(scope === 'all' && kind !== 'cloak') {
    record.detectorAdaptation='Only Page.bringToFront replaced by no-op: headless engine does not implement this CDP method; detector parsing/waits unchanged';
    const originalNewPage=context.newPage.bind(context);
    context.newPage=async(...args)=>{const p=await originalNewPage(...args);p.bringToFront=async()=>{};return p;};
  }
  if(scope === 'all') await probe('detectors',()=>runDetectors(browser,['sannysoft','browserscan','fingerprint','iphey'],AbortSignal.timeout(150000),new Set(),redact),155000);
} catch(e) {record.error=redact(e.message);} finally {
  clearTimeout(deadline);
  if(browser) await withSignal(browser.close(),AbortSignal.timeout(3000)).catch(()=>{});
  await stopOwned(child);await fixtures.close();await rm(dir,{recursive:true,force:true});
  record.finishedAt=new Date().toISOString();await writeFile(output,JSON.stringify(record,null,2));
}
