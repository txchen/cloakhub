// Container CPU (cgroup usage_usec delta) for one headed macOS profile: idle static page, then a rAF canvas animation.
import {chromium} from '@playwright/test';
import {execFileSync} from 'node:child_process';
import {writeFile,mkdir} from 'node:fs/promises';
const label=process.env.EVAL_LABEL, hub=process.env.CLOAKHUB_URL, container=process.env.EVAL_CONTAINER;
const root='.cloakhub/cloak154-572-evaluation/'+label+'/cpu';await mkdir(root,{recursive:true});
const headers={'content-type':'application/json',authorization:'Bearer '+process.env.CLOAKHUB_AUTH_TOKEN};
async function api(path,method='GET',body){const r=await fetch(hub+'/api/profiles'+path,{method,headers,body:body?JSON.stringify(body):undefined});if(!r.ok)throw Error(`${r.status} ${await r.text()}`);return r.status===204?null:r.json()}
const usage=()=>Number(/usage_usec (\d+)/.exec(execFileSync('docker',['exec',container,'cat','/sys/fs/cgroup/cpu.stat'],{encoding:'utf8'}))[1]);
async function measure(seconds){const u0=usage(),t0=Date.now();await new Promise(r=>setTimeout(r,seconds*1000));return (usage()-u0)/1000/(Date.now()-t0)*100;} // % of one core
const pages={
 static:'<!doctype html><title>static</title><p>static page</p>',
 animation:'<!doctype html><title>anim</title><canvas id=c width=800 height=500></canvas><script>const x=c.getContext("2d");let t=0;(function f(){t++;x.fillStyle=`hsl(${t%360},70%,50%)`;x.fillRect(0,0,800,500);for(let i=0;i<200;i++){x.fillStyle="#fff";x.fillRect((t*3+i*37)%800,(i*23)%500,8,8)}requestAnimationFrame(f)})()</script>',
};
const id='cpu_'+label+'_'+Date.now();const result={label,samples:[]};let b;
try{
 const p=await api('','POST',{profile_id:id,fingerprint_seed:'20260909',headless:false});b=await chromium.connectOverCDP(p.connection.cdp_url);result.browserVersion=b.version();const page=await b.contexts()[0].newPage();
 for(const [name,html] of Object.entries(pages)){await page.route('http://127.0.0.1:7788/cpu-'+name,r=>r.fulfill({contentType:'text/html',body:html}));await page.goto('http://127.0.0.1:7788/cpu-'+name);await new Promise(r=>setTimeout(r,10000));
  for(let i=0;i<3;i++)result.samples.push({page:name,i,cpuPctOneCore:await measure(20)});
  if(name==='animation')result.fps=await page.evaluate(()=>new Promise(r=>{let n=0;const s=performance.now();(function f(){n++;performance.now()-s<5000?requestAnimationFrame(f):r(n/5)})()}));}
}finally{await b?.close();await api('/'+id+'/stop','POST').catch(()=>{});await api('/'+id,'DELETE').catch(()=>{});await writeFile(root+'/cpu.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));}
