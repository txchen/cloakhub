import { chromium } from '/runtime/node_modules/playwright-core/index.mjs';
import { PNG } from 'pngjs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { surface } from './surface.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const key=readFileSync('/run/key','utf8').trim();
const output='/work/results';mkdirSync(output,{recursive:true});
const clean=x=>String(x).replaceAll(key,'[REDACTED]').replace(/https?:\/\/\S+/g,'[URL]');
const hash=x=>createHash('sha256').update(Buffer.from(x)).digest('hex');
const cpu=()=>Number(readFileSync('/sys/fs/cgroup/cpu.stat','utf8').match(/usage_usec (\d+)/)[1]);
function summarizeSurface(s){
 const {pixel1,pixel2,png,...info}=s.canvas;const decoded=PNG.sync.read(Buffer.from(png)).data;
 const diff=(a,b)=>a.reduce((n,v,i)=>n+(v!==b[i]?1:0),0);
 s.canvas={...info,pixelsHash:hash(pixel1),repeatHash:hash(pixel2),pngPixelsHash:hash(decoded),repeatDiffBytes:diff(pixel1,pixel2),exportDiffBytes:diff(pixel1,decoded),bytes:pixel1.length};return s;
}
function handler(req,res){
 const url=new URL(req.url,'http://localhost');
 res.setHeader('Accept-CH','Sec-CH-UA-Full-Version-List, Sec-CH-UA-Arch, Sec-CH-UA-Bitness, Sec-CH-UA-Platform-Version');
 if(url.pathname==='/worker.js'){res.setHeader('Content-Type','application/javascript');res.end(`(${surface.toString()})().then(x=>postMessage(x)).catch(e=>postMessage({error:String(e)}));`);return;}
 if(url.pathname==='/echo'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(Object.fromEntries(Object.entries(req.headers).filter(([k])=>k==='user-agent'||k.startsWith('sec-ch-ua')))));return;}
 if(url.pathname.startsWith('/api/')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,id:url.searchParams.get('id')}));return;}
 res.setHeader('Content-Type','text/html');
 if(url.pathname==='/popup-test'){res.end('<!doctype html><body><script>setTimeout(()=>{const w=window.open("/popup-target");window.popupProbe={opened:!!w};if(w)w.close();},700);</script>popup probe');return;}
 if(url.pathname==='/animation'){res.end('<!doctype html><canvas width=800 height=600></canvas><script>window.framesDrawn=0;const c=document.querySelector("canvas").getContext("2d");function f(t){c.fillStyle="rgb("+(Math.floor(t/10)%255)+",70,100)";c.fillRect(0,0,800,600);for(let i=0;i<50;i++){c.fillStyle="rgba(120,200,50,.3)";c.fillRect((t/5+i*17)%800,i*11,70,30);}window.framesDrawn++;requestAnimationFrame(f)}requestAnimationFrame(f);</script>');return;}
 res.end('<!doctype html><html><body>controlled probe</body></html>');
}
const servers=[18080,18081].map(port=>createServer(handler).listen(port,'127.0.0.1'));
const display=spawn('Xvnc',[':99','-ac','-websocketPort','16999','-rfbport','-1','-geometry','1366x768','-depth','24','-SecurityTypes','None','-DisableBasicAuth','1','-interface','127.0.0.1','-AlwaysShared','-httpd','/usr/share/kasmvnc/www'],{stdio:'ignore'});
await sleep(1500);
async function run(v,seed,mode,round,{popupFlag=false,site=false,persona='macos',gpuVendor=null,geometryFlag=false,maximized=false,touch=null,referenceSoftware=false}={}){
 if(v==='reference')persona='native';
 const id=`${v}-${persona}-${mode}-${seed}-r${round}${popupFlag?'-popupflag':''}${gpuVendor?'-gpu'+gpuVendor:''}${geometryFlag?'-geometry':''}${maximized?'-maximized':''}${touch!==null?'-touch'+touch:''}${referenceSoftware?'-software':''}`;
 const bin=v===152?'/opt/cloakbrowser/chrome':v===156?'/opt/browser156/chrome':'/work/reference-browser/chromium-1248/chrome-linux64/chrome';
 const args=['--no-sandbox','--no-first-run','--no-default-browser-check',`--user-data-dir=/tmp/profiles/${id}`,'--remote-debugging-address=127.0.0.1','--remote-debugging-port=19222',...(maximized?['--start-maximized']:[`--window-size=${geometryFlag?'900,500':'1366,768'}`,`--window-position=${geometryFlag?'4000,3000':'0,0'}`]),...(v==='reference'?[]:[`--fingerprint=${seed}`,`--fingerprint-platform=${persona}`,'--fingerprint-hardware-concurrency=4','--fingerprint-timezone=America/Los_Angeles','--fingerprint-locale=en-US']),'--lang=en-US','--accept-lang=en-US',...(mode==='headless'?['--headless=new','--use-gl=angle']:[]),...(referenceSoftware?[...(mode==='headed'?['--use-gl=angle']:[]),'--use-angle=swiftshader','--enable-unsafe-swiftshader']:[]),...(popupFlag?['--disable-popup-blocking']:[]),...(gpuVendor?[`--fingerprint-gpu-vendor=${gpuVendor}`]:[]),...(touch!==null?[`--fingerprint-max-touch-points=${touch}`]:[]),'about:blank'];
 const out={id,v,seed,mode,round,persona,popupFlag,gpuVendor,geometryFlag,maximized,touch,referenceSoftware,args,start:new Date().toISOString()};let proc,browser,stderr='';
 try{
  proc=spawn(bin,args,{env:{...process.env,DISPLAY:':99',FONTCONFIG_FILE:'/app/macos-fonts.conf',CLOAKBROWSER_LICENSE_KEY:key,HOME:'/tmp/browser-home'},stdio:['ignore','ignore','pipe']});proc.stderr.on('data',b=>{stderr=(stderr+b.toString()).slice(-60000)});
  let ready=false;for(let i=0;i<60;i++){if(proc.exitCode!==null)throw Error('exit '+proc.exitCode);try{const r=await fetch('http://127.0.0.1:19222/json/version');if(r.ok){out.version=(await r.json()).Browser;ready=true;break;}}catch{}await sleep(500)}if(!ready)throw Error('CDP startup timeout');
  out.actualArgv=readFileSync(`/proc/${proc.pid}/cmdline`,'utf8').split('\0').filter(Boolean);
  browser=await chromium.connectOverCDP('http://127.0.0.1:19222');const context=browser.contexts()[0];let page=await context.newPage();await page.goto('http://127.0.0.1:18080/');
  out.main=summarizeSurface(await page.evaluate(surface));
  try{const session=await context.newCDPSession(page);out.physicalWindow=await session.send('Browser.getWindowForTarget');await session.detach();}catch(e){out.physicalWindowError=clean(e.message)}
  const worker=await page.evaluate(()=>new Promise((resolve,reject)=>{const w=new Worker('/worker.js');const timer=setTimeout(()=>{w.terminate();reject(Error('worker timeout'))},20000);w.onmessage=e=>{clearTimeout(timer);w.terminate();resolve(e.data)};w.onerror=e=>{clearTimeout(timer);w.terminate();reject(Error(e.message))}}));
  out.worker=worker.error?worker:summarizeSurface(worker);
  const [frame]=await Promise.all([page.waitForEvent('framenavigated',{predicate:f=>f.url().startsWith('http://127.0.0.1:18081'),timeout:10000}),page.evaluate(()=>{const f=document.createElement('iframe');f.src='http://127.0.0.1:18081/';document.body.append(f)})]);
  out.frame=summarizeSurface(await frame.evaluate(surface));out.headers=await page.evaluate(()=>fetch('/echo').then(r=>r.json()));
  const fontNames=['Arial','Helvetica Neue','Times New Roman','Courier New','Menlo','Monaco','Helvetica','Apple Color Emoji','SF Pro Text','SF Pro Display','Verdana','Georgia','Palatino','Tahoma','Trebuchet MS','Comic Sans MS'];
  out.fonts=await page.evaluate(names=>{const output=[];for(let r=0;r<3;r++){const start=performance.now();let present=0;for(let i=0;i<200;i++){const name=i<names.length?names[i]:'NonexistentProbeFont'+i;if(document.fonts.check('16px "'+name+'"'))present++;}output.push({ms:performance.now()-start,checkTrue:present})}return output},fontNames);
  await page.goto('http://127.0.0.1:18080/popup-test');await sleep(1800);out.popup=await page.evaluate(()=>window.popupProbe);
  if(!site && round<=2){
   let handled=0;await page.route('**/api/**',async route=>{try{const response=await route.fetch();await route.fulfill({response,json:{...await response.json(),intercepted:true}});handled++;}catch(e){out.routeHandlerError=clean(e.message)}});
   const t=Date.now();out.interception=await page.evaluate(async()=>{let good=0;const errors=[];for(let batch=0;batch<25;batch++){await Promise.all(Array.from({length:8},(_,i)=>{const id=batch*8+i;return fetch('/api/data?id='+id).then(r=>r.json()).then(x=>{if(x.intercepted&&x.id===String(id))good++;else errors.push('bad response')}).catch(e=>errors.push(String(e)))}))}return {good,errors}});out.interception.handled=handled;out.interception.wallMs=Date.now()-t;await page.unrouteAll({behavior:'wait'});
   await page.goto('http://127.0.0.1:18080/');await sleep(1500);let start=cpu(),time=Date.now();await sleep(5000);out.idle={cpuUsec:cpu()-start,wallMs:Date.now()-time};
   await page.goto('http://127.0.0.1:18080/animation');await page.bringToFront();await sleep(1500);let frames=await page.evaluate(()=>window.framesDrawn);start=cpu();time=Date.now();await sleep(5000);out.animation={cpuUsec:cpu()-start,wallMs:Date.now()-time,frames:(await page.evaluate(()=>window.framesDrawn))-frames};
  }
  await page.close();
  if(site){
   page=await context.newPage();out.fingerprint={signals:{},statuses:[],errors:[]};const pending=[];
   page.on('response',r=>{const u=new URL(r.url());if(u.pathname.startsWith('/api/event/')&&r.headers()['content-type']?.includes('json'))pending.push((async()=>{out.fingerprint.statuses.push(r.status());try{const x=await r.json();for(const k of ['bot','tampering','tampering_ml_score','virtual_machine','suspect_score','vpn','vpn_methods','tampering_details','developer_tools','privacy_settings','simulator'])if(k in x)out.fingerprint.signals[k]=x[k];}catch{}})());});
   page.on('pageerror',e=>out.fingerprint.errors.push(clean(e.message)));
   await page.goto('https://demo.fingerprint.com/',{waitUntil:'domcontentloaded',timeout:35000});for(let i=0;i<20;i++){await sleep(1000);if('bot' in out.fingerprint.signals)break}await Promise.allSettled(pending);out.fingerprint.complete='bot' in out.fingerprint.signals;out.fingerprint.rateLimited=(await page.locator('body').innerText()).includes('429: Too many requests');await page.close();
  }
 }catch(e){out.error=clean(e.stack)}finally{
  if(browser){try{const s=await browser.newBrowserCDPSession();await s.send('Browser.close')}catch{}try{await browser.close()}catch{}}
  if(proc){for(let i=0;i<30&&proc.exitCode===null;i++)await sleep(500);if(proc.exitCode===null){out.forcedStop=true;proc.kill('SIGTERM');await sleep(2000)}}
  out.end=new Date().toISOString();out.gpuErrors=clean(stderr).split('\n').filter(l=>/Vulkan|eglInitialize|GL implementation|GPU process exited/.test(l)).slice(0,8);writeFileSync(`${output}/${id}.json`,JSON.stringify(out,null,2));console.log(JSON.stringify({id,error:out.error,geometry:out.main?.geometry,canvas:out.main?.canvas,workerCanvas:out.worker?.canvas,popup:out.popup,fonts:out.fonts,interception:out.interception,idle:out.idle,animation:out.animation,fingerprint:out.fingerprint}));await sleep(4000);
 }
}
try{
 const command=process.argv[2]||'smoke';
 if(command==='smoke')for(const v of [152,156,'reference'])await run(v,20260909,'headed',0);
 if(command==='surfaces')for(const round of [1,2])for(const seed of [20260909,20260910,20260911])for(const mode of ['headed','headless'])for(const v of (round===1?[152,156]:[156,152]))await run(v,seed,mode,round);
 if(command==='extras'){
  for(const v of [152,156,'reference'])for(const popupFlag of [false,true])await run(v,20260909,'headed',3,{popupFlag});
  for(const v of [152,156,'reference'])for(const mode of ['headed','headless'])await run(v,20260909,mode,4,{geometryFlag:true});
  for(const v of [152,156]){await run(v,20260909,'headed',7,{gpuVendor:'intel',persona:'windows'});await run(v,20260909,'headed',7,{touch:5,persona:'windows'});}
  for(const v of [152,156,'reference'])for(const mode of ['headed','headless'])await run(v,20260909,mode,8,{maximized:true});
 }
 if(command==='sites'){
  for(const mode of ['headed','headless']){await run('reference',20260909,mode,5,{site:true});await sleep(45000)}
  for(const persona of ['linux','macos'])for(const v of [152,156]){await run(v,20260909,'headed',6,{site:true,persona});await sleep(45000)}
  for(const mode of ['headed','headless']){await run('reference',20260909,mode,9,{site:true,referenceSoftware:true});await sleep(45000)}
 }
 if(command==='popup')for(const v of [152,156,'reference'])for(const popupFlag of [false,true])await run(v,20260909,'headed',3,{popupFlag});
 if(command==='geometry')for(const v of [152,156,'reference'])for(const mode of ['headed','headless'])await run(v,20260909,mode,4,{geometryFlag:true});
 if(command==='reference')for(const mode of ['headed','headless']){await run('reference',20260909,mode,5,{site:true});await sleep(45000)}
 if(command==='persona')for(const persona of ['linux','macos'])for(const v of [152,156]){await run(v,20260909,'headed',6,{site:true,persona});await sleep(45000)}
 if(command==='features')for(const v of [152,156]){await run(v,20260909,'headed',7,{gpuVendor:'intel',persona:'windows'});await run(v,20260909,'headed',7,{touch:5,persona:'windows'});}
 if(command==='maximized')for(const v of [152,156,'reference'])for(const mode of ['headed','headless'])await run(v,20260909,mode,8,{maximized:true});
}finally{display.kill('SIGTERM');for(const s of servers)s.close()}
