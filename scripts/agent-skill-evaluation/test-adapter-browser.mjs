import { test, before as beforeAll, after as afterAll } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { chromium } from '../../skills/cloakhub-browser/node_modules/playwright-core/index.mjs';
import { checkpointBatch, checkpointRead, checkpointPage } from '../../skills/cloakhub-browser/scripts/checkpoint.mjs';
const executablePath = process.env.CLOAKHUB_TEST_BROWSER;
const enabled = executablePath && existsSync(executablePath);

let browser, server, origin, cdpPort;
const cases = new Map();
beforeAll(async () => {
  if (!enabled) return;
  const portProbe = createServer(); await new Promise(r=>portProbe.listen(0,'127.0.0.1',r)); cdpPort=portProbe.address().port; await new Promise(r=>portProbe.close(r));
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', `--remote-debugging-port=${cdpPort}`] });
  server = createServer(async (req, res) => {
    const url = new URL(req.url, origin), c = cases.get(url.pathname.split('/')[1]);
    res.setHeader('Content-Type', 'application/json');
    if (!c) { res.end('{}'); return; }
    if (req.method === 'POST') {
      let body = ''; for await (const chunk of req) body += chunk;
      const row = JSON.parse(body);
      c.writes.push(row); c.audits.push(JSON.parse(await readFile(c.path, 'utf8')));
      if (c.redirect) { res.writeHead(307, { Location: `/${url.pathname.split('/')[1]}/redirected` }); res.end(); return; }
      if (!c.unknown) c.records.push({ fields: row.fields, recordId: `id-${c.records.length}`, status: c.status || 'confirmed' });
      c.revision++;
      res.end('{}'); return;
    }
    c.reads++;
    const key = url.searchParams.get('key'), cursor = url.searchParams.get('cursor'), start = Number(cursor || 0);
    const all = c.records.filter(r => !key || r.fields.key === key);
    res.end(JSON.stringify({ destination: c.destination, records: all.slice(start, start + 1), cursor,
      nextCursor: start + 1 < all.length ? String(start + 1) : null,
      total: all.length + (c.badTotal ? 1 : 0), revision: String(c.revision) }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); });
async function fixture(action) {
  const dir = await mkdtemp(join(tmpdir(), 'adapter-')), id = dir.split('/').at(-1), context = await browser.newContext({ serviceWorkers: 'block' });
  const c = { records: [], writes: [], audits: [], revision: 0, reads: 0, path: join(dir, 'checkpoint.json'),
    destination: { siteOrigin: origin, accountKey: 'a', scope: { collection: 'one' } } };
  cases.set(id, c);
  const rows = [{ key: 'a', value: 1 }, { key: 'b', value: 2 }];
  async function options(change = {}) {
    const page = await checkpointPage(context, `${origin}/${id}`);
    return { page, path: c.path, operation: 'entry', adapterVersion: '1', intent: 'ensure_exists', target: { url: 'http://hub.test', profile: 'p' }, destination: structuredClone(c.destination), rows,
      read: async request => {
        const url = new URL(`${origin}/${id}`);
        if (request.key !== null) url.searchParams.set('key', request.key);
        if (request.cursor !== null) url.searchParams.set('cursor', request.cursor);
        const captured = await checkpointRead(page, request, { match: r => r.url() === url.href,
          trigger: () => page.evaluate(url => fetch(url).then(r => r.json()), url.href) });
        return { ...captured.json, evidence: captured.evidence };
      },
      prepare: async () => {},
      write: {url:`${origin}/${id}`,method:'POST',accountKey:['destination','accountKey'],scope:{collection:['destination','scope','collection']},fields:{key:['fields','key'],value:['fields','value']}},
      submit: async fields => page.evaluate(body => fetch(location.href, { method: 'POST', body: JSON.stringify(body) }).then(r => r.json()), { destination: c.destination, fields }),
      ...change };
  }
  try { await action({ c, rows, options, url: `${origin}/${id}`, saved: async () => JSON.parse(await readFile(c.path, 'utf8')) }); }
  finally { cases.delete(id); await context.close(); await rm(dir, { recursive: true, force: true }); }
}
const check = enabled ? test : test.skip;
check('v2 follows pages, preserves preexisting records, audits sent before every network write', () => fixture(async ({ c, rows, options, saved }) => {
  c.records = [{ fields: { key: 'other' }, recordId: 'other', status: 'confirmed' }, { fields: rows[1], recordId: 'preexisting', status: 'confirmed' }];
  assert.equal((await checkpointBatch(await options())).status, 'complete');
  assert.equal(c.writes.length, 1);
  assert.equal(c.audits[0].pending.key, 'a'); assert.equal(c.audits[0].pending.stage, 'sent');
  assert.equal((await saved()).completed.find(r => r.key === 'b').recordId, 'preexisting');
}));
check('v2 rejects old DOM booleans and missing pagination evidence before writing', () => fixture(async ({ c, options }) => {
  await assert.rejects(checkpointBatch(await options({ read: async () => ({ complete: true, records: [], destination: c.destination }) })), new RegExp('EVIDENCE'));
  assert.equal(c.writes.length, 0);
  c.badTotal = true;
  await assert.rejects(checkpointBatch(await options()), new RegExp('INCOMPLETE'));
}));
check('v2 prevents wrong-scope request after last read and records safe no-send', () => fixture(async ({ c, options, saved }) => {
  const o = await options();
  const submit = o.submit;
  o.submit = async row => { c.destination.scope.collection = 'two'; return submit(row); };
  await assert.rejects(checkpointBatch(o), new RegExp('WRITE_GATE'));
  assert.equal(c.writes.length, 0); assert.equal((await saved()).pending, null); assert.equal((await saved()).notSent.length, 1);
  c.destination.scope.collection = 'one';
  assert.equal((await checkpointBatch(await options())).status, 'complete');
}));
check('prepare failure and pre-click failure can resume same checkpoint without manual clearing', () => fixture(async ({ c, options, saved }) => {
  await assert.rejects(checkpointBatch(await options({ prepare: async () => { throw Error('missing locator'); } })), new RegExp('missing locator'));
  assert.equal((await saved()).pending, null);
  await assert.rejects(checkpointBatch(await options({ submit: async () => { throw Error('disabled button'); } })), new RegExp('disabled button'));
  assert.equal((await saved()).notSent.length, 1);
  assert.equal((await saved()).notSent[0].stage, 'not_sent'); assert.equal((await saved()).notSent[0].priorStage, 'sent');
  assert.equal((await checkpointBatch(await options())).status, 'complete'); assert.equal(c.writes.length, 2);
}));
for (const status of ['processing', 'rejected']) check(`business ${status} is not success and cannot replay`, () => fixture(async ({ c, options, saved }) => {
  c.status = status;
  await assert.rejects(checkpointBatch(await options()), new RegExp(status.toUpperCase()));
  assert.equal((await saved()).pending.stage, 'sent');
  await assert.rejects(checkpointBatch(await options()), new RegExp(status.toUpperCase()));
  assert.equal(c.writes.length, 1);
}));
check('lost reply reconciles durable record; absent outcome remains pending', () => fixture(async ({ c, options, saved }) => {
  c.unknown = true;
  await assert.rejects(checkpointBatch(await options()), new RegExp('PENDING'));
  await assert.rejects(checkpointBatch(await options()), new RegExp('PENDING')); assert.equal(c.writes.length, 1);
  c.records.push({ fields: { key: 'a', value: 1 }, recordId: 'late', status: 'confirmed' }); c.unknown = false;
  assert.equal((await checkpointBatch(await options())).status, 'complete'); assert.equal(c.writes.length, 2);
}));
check('autosave in prepare is blocked before any pending write', () => fixture(async ({ c, options, saved }) => {
  const o = await options(); o.prepare = o.submit;
  await assert.rejects(checkpointBatch(o));
  assert.equal(c.writes.length, 0); assert.equal((await saved()).pending, null);
}));
check('scope and adapter version bind recovery identity', () => fixture(async ({ c, options }) => {
  await checkpointBatch(await options({ maxItems: 1 }));
  await assert.rejects(checkpointBatch(await options({ adapterVersion: '2' })), new RegExp('IDENTITY'));
  c.destination.scope.collection = 'two';
  await assert.rejects(checkpointBatch(await options()), new RegExp('IDENTITY')); assert.equal(c.writes.length, 1);
}));

check('write redirect cannot forward the validated body to another endpoint', () => fixture(async ({ c, options, saved }) => {
  c.redirect = true;
  await assert.rejects(checkpointBatch(await options()));
  assert.equal(c.writes.length, 1);
  assert.equal((await saved()).pending.stage, 'sent');
}));
check('second concurrent submission is rejected with first outcome left pending', () => fixture(async ({ c, options, saved }) => {
  const o = await options(); const submit = o.submit;
  o.submit = row => Promise.all([submit(row), submit(row)]);
  await assert.rejects(checkpointBatch(o), /WRITE_GATE/);
  assert.equal(c.writes.length, 1);
  assert.equal((await saved()).pending.stage, 'sent');
}));
check('a delayed write after submit returns is cancelled by closing the owned tab', () => fixture(async ({ c, options, saved }) => {
  const o = await options();
  o.submit = fields => o.page.evaluate(body => { setTimeout(() => fetch(location.href, { method: 'POST', body: JSON.stringify(body) }), 100); }, { destination: c.destination, fields });
  await assert.rejects(checkpointBatch(o), /NOT_SENT/);
  await new Promise(r => setTimeout(r, 200));
  assert.equal(c.writes.length, 0); assert.equal((await saved()).notSent.length, 1);
}));

check('body validation still in flight is cancelled before a no-send rollback', () => fixture(async ({ c, options, saved }) => {
  const o=await options();
  o.submit=fields=>o.page.evaluate(body=>{
    const stream=new ReadableStream({start(controller){setTimeout(()=>{controller.enqueue(new TextEncoder().encode(JSON.stringify(body)));controller.close();},100);}});
    fetch(location.href,{method:'POST',body:stream,duplex:'half'}).catch(()=>{});
  },{destination:c.destination,fields});
  await assert.rejects(checkpointBatch(o));
  await new Promise(r=>setTimeout(r,200));
  assert.equal(c.writes.length,0);assert.equal((await saved()).pending,null);
}));
for (const mode of ['wrong-scope-after-disconnect','commit-before-disconnect']) check(mode+' keeps the browser alive', () => fixture(async ({ c, rows, url, saved, options }) => {
  const module=new URL('../../skills/cloakhub-browser/scripts/checkpoint.mjs',import.meta.url).href;
  const playwright=new URL('../../skills/cloakhub-browser/node_modules/playwright-core/index.mjs',import.meta.url).href;
  const config={path:c.path,operation:'entry',adapterVersion:'1',intent:'ensure_exists',target:{url:'http://hub.test',profile:'p'},destination:c.destination,rows,
    write:{url,method:'POST',accountKey:['destination','accountKey'],scope:{collection:['destination','scope','collection']},fields:{key:['fields','key'],value:['fields','value']}}};
  const script=`import {chromium} from ${JSON.stringify(playwright)};import {checkpointBatch,checkpointPage,checkpointRead} from ${JSON.stringify(module)};
    const browser=await chromium.connectOverCDP('http://127.0.0.1:${cdpPort}');const page=await checkpointPage(browser.contexts()[0],${JSON.stringify(url)});
    const options=${JSON.stringify(config)};
    await checkpointBatch({...options,page,prepare:async()=>{},read:async request=>{
      const u=new URL(${JSON.stringify(url)});if(request.key!==null)u.searchParams.set('key',request.key);if(request.cursor!==null)u.searchParams.set('cursor',request.cursor);
      const r=await checkpointRead(page,request,{match:r=>r.url()===u.href,trigger:()=>page.evaluate(u=>fetch(u).then(r=>r.json()),u.href)});return {...r.json,evidence:r.evidence};
    },submit:async fields=>{
      const body={destination:structuredClone(options.destination),fields};
      if('${mode}'==='wrong-scope-after-disconnect'){
        body.destination.scope.collection='other';
        await page.evaluate(body=>{setTimeout(()=>fetch(location.href,{method:'POST',body:JSON.stringify(body)}).catch(()=>{}),500)},body);
      }else await page.evaluate(body=>fetch(location.href,{method:'POST',body:JSON.stringify(body)}).then(r=>r.json()),body);
      console.log('KILL_CLIENT_NOW');await new Promise(()=>{});
    }});`;
  const child=spawn('node',['--input-type=module','-e',script],{stdio:['ignore','pipe','pipe']});let stderr='';child.stderr.on('data',d=>stderr+=d);
  try {
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Child timeout: '+stderr)),15000);child.stdout.on('data',d=>{if(String(d).includes('KILL_CLIENT_NOW')){clearTimeout(timer);resolve();}});child.on('exit',()=>{clearTimeout(timer);reject(Error('Early child exit: '+stderr));});});
    child.kill('SIGKILL');await new Promise(r=>child.on('exit',r));await new Promise(r=>setTimeout(r,800));
    assert.equal(c.writes.length,mode==='wrong-scope-after-disconnect'?0:1);
    assert.equal((await saved()).pending.stage,'sent');
    if(mode==='commit-before-disconnect') {assert.equal((await checkpointBatch(await options())).status,'complete');assert.equal(c.writes.length,2);}
    else {await assert.rejects(checkpointBatch(await options()),/PENDING/);assert.equal(c.writes.length,0);}
  }finally{child.kill('SIGKILL');}
}));
