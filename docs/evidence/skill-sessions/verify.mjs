import { spawn } from 'node:child_process';
import { writeFile, access, rm } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
const helper = process.env.CLOAKHUB_VERIFY_HELPER;
const target = process.env.CLOAKHUB_TARGET;
if (!helper || !target) throw new Error('Set CLOAKHUB_VERIFY_HELPER and CLOAKHUB_TARGET explicitly.');
const results = [];
const sessions = new Set();
const created = [];
async function cli(args, source = '') {
  const start = performance.now();
  const child = spawn(process.execPath, [helper, ...args], { stdio: ['pipe','pipe','pipe'] });
  let out = '', err = '';
  child.stdout.on('data', b => out += b); child.stderr.on('data', b => err += b);
  child.stdin.end(source);
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  let data; try { data = JSON.parse(out); } catch {}
  return { code, data, err, ms: Math.round(performance.now() - start) };
}
async function start() {
  const r = await cli(['session','start','--target',target]);
  assert.equal(r.code,0,r.err); sessions.add(r.data.session); return r.data.session;
}
const exec = (id, source) => cli(['session','exec',id],source);
const record = (name, details = {}) => { results.push({ name, passed:true, ...details }); console.log(JSON.stringify(results.at(-1))); };
const delay = ms => new Promise(resolve => setTimeout(resolve,ms));
try {
  const idle = await start();
  const idleStarted = performance.now();
  const main = await start();
  let r = await exec(main,`state.original = await Promise.all(context.pages().map(tabId)); state.page = await context.newPage(); console.log(JSON.stringify({id:await tabId(state.page),label:'session live verification'}));`);
  assert.equal(r.data.ok,true); created.push(JSON.parse(r.data.output).id);
  console.log(r.data.output.trim());
  r = await exec(main,`await state.page.goto('data:text/html,<title>Example Domain</title><h1>Example Domain</h1>', {waitUntil:'domcontentloaded'}); state.title=await state.page.title(); state.transform = x => x.toUpperCase(); console.log(await observe(state.page, {maxChars:1000}));`);
  assert.equal(r.data.ok,true,r.data.error); assert.match(r.data.output,/Example Domain/);
  r = await exec(main,`console.log(state.transform(state.title));`);
  assert.match(r.data.output,/EXAMPLE DOMAIN/); record('real remote browser fixture and cross-call page/function/data persistence');
  r = await exec(main,`state.value=7; throw new Error('intentional failure');`); assert.equal(r.data.ok,false);
  r = await exec(main,`console.log(state.value)`); assert.equal(r.data.output,'7\n'); record('script error preserves session state');
  const pending = exec(main,`state.busy=true; await new Promise(r=>setTimeout(r,2500)); state.value++;`);
  await delay(500);
  r = await exec(main,`state.value=999`); assert.equal(r.data.ok,false); assert.match(r.data.error,/busy/);
  await pending;
  r = await exec(main,`console.log(state.value)`); assert.equal(r.data.output,'8\n'); record('concurrent command rejected without execution');
  r = await exec(main,`console.log('x'.repeat(100000))`); assert.equal(r.data.truncated,true); assert.equal(r.data.output.length,65536); record('output limit');
  r = await exec(main,`await state.page.goto('data:text/html,' + encodeURIComponent(${JSON.stringify('<title>Fixture</title><button onclick="this.textContent=String.fromCharCode(83,97,118,101,100)">Save</button>')}), {waitUntil:'domcontentloaded'}); await state.page.bringToFront(); console.log(await expectChange(state.page,state.page.getByRole('button'),()=>state.page.getByRole('button').click()));`);
  assert.equal(r.data.ok,true,r.data.error); assert.match(r.data.output,/changed: true/); record('real rendered click and effect verification');
  r = await cli(['session','end',main]); assert.equal(r.data.ok,true); sessions.delete(main);
  r = await cli(['run','--target',target],`const p=await tab(${JSON.stringify(created[0])}); console.log(JSON.stringify({title:await p.title()})); await p.close();`);
  assert.equal(r.data.title,'Fixture'); created.length=0; record('end releases client and preserves remote tab');
  const asyncTimeout = await start();
  const syncTimeout = await start();
  const asyncPending = exec(asyncTimeout,'await new Promise(() => {});');
  const syncPending = exec(syncTimeout,'while (true) {}');
  const [a,b] = await Promise.all([asyncPending,syncPending]);
  assert.notEqual(a.code,0); assert.notEqual(b.code,0);
  assert(a.ms>=119000 && a.ms<130000); assert(b.ms>=120000 && b.ms<132000);
  record('async deadline terminates session',{ms:a.ms}); record('watchdog terminates synchronous loop',{ms:b.ms});
  for (const id of [asyncTimeout,syncTimeout]) {
    const status=await cli(['session','status',id]); assert.notEqual(status.code,0); sessions.delete(id);
    await rm(id.slice(0,id.lastIndexOf('/')),{recursive:true,force:true});
  }
  while (performance.now()-idleStarted<305000) {
    const status=await cli(['session','status',idle]);
    if(status.code!==0) break;
    console.log(JSON.stringify({waiting:'default idle expiry',elapsedSeconds:Math.round((performance.now()-idleStarted)/1000)}));
    await delay(20000);
  }
  r=await cli(['session','status',idle]); assert.notEqual(r.code,0);
  await assert.rejects(access(idle)); sessions.delete(idle);
  record('five-minute idle expiry despite status polling',{ms:Math.round(performance.now()-idleStarted)});
  r=await cli(['check','--target',target]); assert.equal(r.data.ok,true); record('remote profile remains connectable after deadline and idle termination');
} finally {
  for(const id of sessions) await cli(['session','end',id]);
  if(created.length) await cli(['run','--target',target],`for(const id of ${JSON.stringify(created)}) { try { await (await tab(id)).close(); } catch {} }`);
  await writeFile(new URL('./results.json',import.meta.url),JSON.stringify({date:new Date().toISOString(),target,results},null,2)+'\n');
}
