import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const key=readFileSync('/run/key','utf8').trim();
const root='/work/results'; mkdirSync(root,{recursive:true});
const old=['--disable-gpu','--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader'];
const clean=s=>String(s).replaceAll(key,'[KEY]').replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g,'[IP]').replace(/https?:\/\/\S+/g,'[URL]');
const signals=new Set(['bot','tampering','anti_detect_browser','virtual_machine','tampering_ml_score','suspect_score','vpn','os_mismatch','proxy','incognito','browser_tampering','isBot']);
function pick(x,out={},path='') {if(!x||typeof x!=='object')return out;for(const [k,v] of Object.entries(x)){const p=path?path+'.'+k:k;if(signals.has(k))out[p]=v;else if(k==='visitorId'||k==='visitor_id')out.visitorHash=createHash('sha256').update(String(v)).digest('hex').slice(0,16);else if(v&&typeof v==='object')pick(v,out,p);}return out;}
const display=spawn('Xvnc',[':99','-ac','-websocketPort','16999','-rfbport','-1','-geometry','1366x768','-depth','24','-SecurityTypes','None','-DisableBasicAuth','1','-interface','127.0.0.1','-AlwaysShared','-httpd','/usr/share/kasmvnc/www'],{stdio:'ignore'});
await sleep(1500);
async function run(v,seed,mode,variant,round,sites=true){
 const id=`${v}-${mode}-${variant}-${seed}-r${round}`;
 const bin=v===152?'/opt/cloakbrowser/chrome':'/opt/browser156/chrome';
 const args=['--no-sandbox','--no-first-run','--no-default-browser-check',`--user-data-dir=/tmp/profiles/${id}`,'--remote-debugging-address=127.0.0.1','--remote-debugging-port=19222','--window-size=1366,768','--window-position=0,0',`--fingerprint=${seed}`,'--fingerprint-platform=macos','--fingerprint-hardware-concurrency=4','--fingerprint-timezone=America/Los_Angeles','--fingerprint-locale=en-US','--lang=en-US','--accept-lang=en-US',...(mode==='headless'?['--headless=new']:[]),...(variant==='old'?old:variant==='clean'?[]:[old[Number(variant)]]),'about:blank'];
 const result={id,v,seed,mode,variant,round,start:new Date().toISOString(),args};
 let proc,browser,err='';
 try {
 proc=spawn(bin,args,{env:{...process.env,DISPLAY:':99',FONTCONFIG_FILE:'/app/macos-fonts.conf',CLOAKBROWSER_LICENSE_KEY:key,HOME:'/tmp/browser-home'},stdio:['ignore','ignore','pipe']});
 proc.stderr.on('data',d=>{err+=d.toString();if(err.length>100000)err=err.slice(-100000);});
 let ready=false;for(let i=0;i<60;i++){if(proc.exitCode!==null)throw Error('browser exited '+proc.exitCode);try{const r=await fetch('http://127.0.0.1:19222/json/version');if(r.ok){result.cdpVersion=await r.json();delete result.cdpVersion.webSocketDebuggerUrl;ready=true;break;}}catch{}await sleep(500);}if(!ready)throw Error('CDP startup timeout');
 result.actualArgv=readFileSync(`/proc/${proc.pid}/cmdline`,'utf8').split('\0').filter(Boolean);
 browser=await chromium.connectOverCDP('http://127.0.0.1:19222');
 const context=browser.contexts()[0];let page=await context.newPage();
 result.local=await page.evaluate(async()=>{const gl={};for(const type of ['webgl','webgl2']){const c=document.createElement('canvas');const g=c.getContext(type);const e=g?.getExtension('WEBGL_debug_renderer_info');gl[type]=g?{vendor:e?g.getParameter(e.UNMASKED_VENDOR_WEBGL):null,renderer:e?g.getParameter(e.UNMASKED_RENDERER_WEBGL):null,error:g.getError()}:null;}return {ua:navigator.userAgent,platform:navigator.platform,webdriver:navigator.webdriver,languages:navigator.languages,hardwareConcurrency:navigator.hardwareConcurrency,screen:{width:screen.width,height:screen.height,dpr:devicePixelRatio},timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,gl};});
 await page.close(); result.sites={};
 if(sites)for(const [name,url,delay] of [['fingerprint','https://demo.fingerprint.com/',15000],['sannysoft','https://bot.sannysoft.com/',6000],['browserscan','https://www.browserscan.net/bot-detection',8000],['iphey','https://iphey.com/',25000]]){
  const item={signals:{},jsonShapes:[],errors:[]};result.sites[name]=item;page=await context.newPage();
  const pending=[];page.on('response',r=>{if(name==='fingerprint'&&r.headers()['content-type']?.includes('json'))pending.push((async()=>{try{const x=await r.json();Object.assign(item.signals,pick(x));item.jsonShapes.push({path:new URL(r.url()).pathname,status:r.status(),keys:Object.keys(x).slice(0,30)});}catch{}})());});
  page.on('pageerror',e=>item.errors.push(clean(e.message).slice(0,500)));
  try{await page.goto(url,{waitUntil:'domcontentloaded',timeout:35000});await page.bringToFront();const waitStart=Date.now();while(Date.now()-waitStart<delay){await sleep(1000);if(name==='fingerprint'&&item.signals.bot)break;if(name==='sannysoft'&&await page.locator('body').innerText().then(t=>t.includes('CHR_MEMORY')))break;if(name==='browserscan'&&await page.locator('body').innerText().then(t=>/Test Results:\s*Normal/.test(t)&&/CDP\s*Normal/.test(t)))break;if(name==='iphey'&&await page.locator('body').innerText().then(t=>/Your Digital Identity Looks\s*(Trustworthy|Unreliable)/.test(t)&&!t.includes('Temporary value')))break;}item.observationWaitMs=Date.now()-waitStart;item.title=await page.title();item.text=clean(await page.locator('body').innerText({timeout:5000})).slice(0,22000);if(name==='sannysoft')item.failed=await page.locator('td.failed,td.warn').allTextContents();if(name==='fingerprint')await Promise.allSettled(pending);}catch(e){item.error=clean(e.message).slice(0,800);}finally{await page.close();}
 }
 }catch(e){result.error=clean(e.stack).slice(0,1500);}finally{
  if(browser){try{const s=await browser.newBrowserCDPSession();await s.send('Browser.close');}catch{}try{await browser.close();}catch{}}
  if(proc&&proc.exitCode===null){for(let i=0;i<30&&proc.exitCode===null;i++)await sleep(500);if(proc.exitCode===null){result.forcedStop=true;proc.kill('SIGTERM');await sleep(2000);}}
  result.stderr=clean(err);result.end=new Date().toISOString();writeFileSync(`${root}/${id}.json`,JSON.stringify(result,null,2));console.log(JSON.stringify({id,error:result.error,gl:result.local?.gl,signals:result.sites?.fingerprint?.signals,forcedStop:result.forcedStop}));await sleep(3000);
 }
}
try{
const command=process.argv[2]||'smoke';
if(command==='smoke'){await run(152,20260909,'headed','clean',0);await run(156,20260909,'headed','clean',0);}
if(command==='matrix'){for(const round of [1,2])for(const seed of [20260909,20260910,20260911])for(const mode of ['headed','headless'])for(const v of (round===1?[152,156]:[156,152]))await run(v,seed,mode,'clean',round);}
if(command==='legacy'){for(const v of [152,156]){await run(v,20260909,'headed','old',4);await sleep(20000);}}
if(command==='corrected'){for(const round of [5,6])for(const seed of [20260909,20260910,20260911])for(const v of (round===5?[152,156]:[156,152])){await run(v,seed,'headless','2',round);await sleep(20000);}}
if(command==='flags'){for(const mode of ['headed','headless'])for(const variant of ['clean','old','0','1','2','3'])for(const v of [152,156])await run(v,20260909,mode,variant,3,false);}
}finally{display.kill('SIGTERM');}
