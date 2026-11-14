import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { installCheckpointGate } from '../skills/cloakhub-browser/scripts/checkpoint-gate.mjs';
import { test, expect } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, writeFile, rm, symlink, mkdir, rename } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { hostname } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkpointBatch, checkpointRead, checkpointPage } from '../skills/cloakhub-browser/scripts/checkpoint.mjs';
import { withBrowser } from '../skills/cloakhub-browser/scripts/browser.mjs';

async function fixture(action) {
  const dir = await mkdtemp(join(tmpdir(), 'checkpoint-v2-'));
  const rows = [{ key: 'a', value: 1 }, { key: 'b', value: 2 }];
  const destination = { siteOrigin: 'https://site.test', accountKey: 'a', scope: { collection: 'one' } };
  const records = [], attempts = [], path = join(dir, 'checkpoint.json');
  const saved = async () => JSON.parse(await readFile(path, 'utf8'));
  async function options(change = {}) {
    const page = new EventEmitter(); let closed = false;
    const gate = { generation: 'test-document', admitted: 0, blocked: [] }; let approval;
    const context = { serviceWorkers: () => [], newPage: async () => page };
    Object.assign(page, { context: () => context, addInitScript: async () => {}, goto: async () => {}, evaluate: async (_, args) => {
      if (!args?.command) return false;
      if (args.command === 'arm') approval=args.approval;
      if (args.command === 'disarm') approval=null;
      return structuredClone(gate);
    }, close: async () => { closed = true; }, isClosed: () => closed,
      waitForResponse: (match, { timeout }) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => { page.off('response', listener); reject(Error('timeout')); }, timeout);
        const listener = response => { try { if (match(response)) { clearTimeout(timer); page.off('response', listener); resolve(response); } } catch (error) { clearTimeout(timer); page.off('response', listener); reject(error); } };
        page.on('response', listener);
      }) });
    await checkpointPage(context, destination.siteOrigin);
    return { page, path, operation: 'entry', adapterVersion: '1', intent: 'ensure_exists', target: { url: 'http://hub.test', profile: 'work' }, rows, destination,
      read: async request => {
        const json = { destination, records: records.filter(r => request.key === null || r.fields.key === request.key), cursor: null, nextCursor: null, revision: '1' };
        json.total = json.records.length;
        const captured = await checkpointRead(page, request, { timeoutMs: 100, match: () => true, trigger: async () => {
          const req = {}; page.emit('request', req); page.emit('response', { request: () => req, ok: () => true, json: async () => json, url: () => destination.siteOrigin });
        } });
        return { ...json, evidence: captured.evidence };
      }, prepare: async () => {}, write: {url:destination.siteOrigin+'/records',method:'POST',accountKey:['destination','accountKey'],scope:{collection:['destination','scope','collection']},fields:{key:['fields','key'],value:['fields','value']}},
      submit: async fields => {
        expect(approval.fields).toEqual(fields); gate.admitted++; approval=null;
        const cp=await saved(); expect(cp.pending.stage).toBe('sent'); expect(cp.pending.key).toBe(fields.key);
        attempts.push(fields.key); records.push({fields,recordId:`id-${attempts.length}`,status:'confirmed'});
      }, ...change };
  }
  try { await action({ options, rows, destination, records, attempts, saved, dir, path }); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

test('v2 durable pending before writes, lost reply reconciles without replay', () => fixture(async ({ options, attempts, saved }) => {
  const o = await options(); const submit = o.submit; o.submit = async row => { await submit(row); throw null; };
  await expect(checkpointBatch(o)).rejects.toBeNull(); expect((await saved()).pending.key).toBe('a');
  expect((await checkpointBatch(await options())).status).toBe('complete'); expect(attempts).toEqual(['a','b']);
}));
for (const mode of ['duplicate','mismatch','missing','processing','rejected']) test(`v2 reconciliation blocks ${mode}`, () => fixture(async ({ options, records, attempts }) => {
  await checkpointBatch(await options({ maxItems: 1 }));
  if (mode === 'duplicate') records.push({ ...records[0], recordId: 'duplicate' });
  if (mode === 'mismatch') records[0].fields.value = 99;
  if (mode === 'missing') records.length = 0;
  if (['processing','rejected'].includes(mode)) records[0].status = mode;
  await expect(checkpointBatch(await options())).rejects.toThrow('Checkpoint'); expect(attempts).toHaveLength(1);
}));
test('v2 input, adapter, target and scope identity cannot change', () => fixture(async ({ options, destination }) => {
  await checkpointBatch(await options({ maxItems: 1 }));
  for (const change of [{ adapterVersion: '2' }, { target: { url: 'http://other.test', profile: 'work' } },
    { rows: [{key:'a',value:99}] }, { destination: { ...destination, scope: { collection: 'two' } } }])
    await expect(checkpointBatch(await options(change))).rejects.toThrow('IDENTITY');
}));
test('v2 rejects legacy checkpoints and malformed state', () => fixture(async ({ options, path, attempts }) => {
  await writeFile(path, JSON.stringify({version:1})); await expect(checkpointBatch(await options())).rejects.toThrow('IDENTITY');
  await writeFile(path, '{'); await expect(checkpointBatch(await options())).rejects.toThrow(); expect(attempts).toHaveLength(0);
}));
test('v2 symlink checkpoint rejected', () => fixture(async ({ options, path, dir }) => {
  await writeFile(join(dir,'other'), '{}'); await symlink(join(dir,'other'),path);
  await expect(checkpointBatch(await options())).rejects.toThrow('STORAGE');
}));
test('v2 atomic write failure prevents site write', () => fixture(async ({ options, path, dir, attempts }) => {
  const o = await options(); const read = o.read;
  o.read = async req => { await rename(path,join(dir,'original')); await mkdir(path); return read(req); };
  await expect(checkpointBatch(o)).rejects.toThrow(); expect(attempts).toHaveLength(0);
}));
test('v2 concurrent path owner is rejected', () => fixture(async ({ options }) => {
  let enter, leave; const entered = new Promise(r => enter=r), pause = new Promise(r=>leave=r);
  const o = await options(); const read=o.read; o.read=async req=>{enter();await pause;return read(req);};
  const first=checkpointBatch(o); await entered;
  try { await expect(checkpointBatch(await options())).rejects.toThrow('LOCKED'); } finally { leave(); }
  await first;
}));
test('v2 progress error does not replay committed record', () => fixture(async ({ options, attempts, saved }) => {
  await expect(checkpointBatch(await options({ onProgress: () => {throw Error('progress');} }))).rejects.toThrow('progress');
  expect((await saved()).pending).toBeNull(); await checkpointBatch(await options()); expect(attempts).toEqual(['a','b']);
}));
test('browser API injects actual target and checkpointRead', () => fixture(async ({ options, saved }) => {
  const o=await options(); const target={endpoint:'ws://hub.test',metadata:o.target};
  await withBrowser(target, async api=>{
    expect(typeof api.checkpointRead).toBe('function');
    await api.checkpointBatch({...o,target:{url:'http://spoof.test',profile:'wrong'}});
  }, async()=>({contexts:()=>[{setDefaultTimeout(){},setDefaultNavigationTimeout(){}}],close:async()=>{}}));
  expect((await saved()).identity.profileId).toBe('work');
}));
test('fresh read timeout bounds trigger and removes request listener', async () => {
  const page = new EventEmitter(); page.waitForResponse = async()=>new Promise(()=>{});
  await expect(checkpointRead(page,{}, {match:()=>true,trigger:()=>new Promise(()=>{}),timeoutMs:10})).rejects.toThrow('timed out');
  expect(page.listenerCount('request')).toBe(0);
});

test('v2 dead owner lock recovers persisted pending from a lost reply', () => fixture(async ({ options, path, attempts }) => {
  const o=await options(); const submit=o.submit; o.submit=async row=>{await submit(row);throw Error('lost reply');};
  await expect(checkpointBatch(o)).rejects.toThrow('lost reply');
  const child=spawnSync('node',['-e','console.log(process.pid)'],{encoding:'utf8'});
  await mkdir(path+'.lock'); await writeFile(join(path+'.lock','owner.json'),JSON.stringify({pid:Number(child.stdout.trim()),host:hostname(),nonce:'dead-owner'}));
  expect((await checkpointBatch(await options())).status).toBe('complete'); expect(attempts).toEqual(['a','b']);
}));
test('v2 rejects reused evidence from a previous read request', () => fixture(async ({ options, attempts }) => {
  const o=await options(); const read=o.read; let first;
  o.read=async req=>first || (first=await read(req));
  await expect(checkpointBatch(o)).rejects.toThrow('EVIDENCE'); expect(attempts).toHaveLength(0);
}));
test('v2 cannot accept a response to a request started before capture', async () => {
  const page=new EventEmitter(), old={};
  page.waitForResponse=(match)=>new Promise(resolve=>page.on('response',r=>{if(match(r))resolve(r);}));
  page.emit('request',old);
  await expect(checkpointRead(page,{}, {timeoutMs:10,match:()=>true,trigger:async()=>page.emit('response',{request:()=>old})})).rejects.toThrow('timed out');
});
test('v2 pagination cycles and inconsistent revisions stop before writes', () => fixture(async ({ options, attempts }) => {
  for (const mode of ['cycle','revision','count']) {
    const o=await options(); const read=o.read; let n=0;
    o.read=async req=>{
      const result=await read(req); n++;
      return {...result, records:[{fields:{key:'unrelated-'+n},recordId:'id-'+n,status:'confirmed'}], cursor:req.cursor,
        nextCursor:mode==='cycle'?'repeat':(n===1?'next':null), total:mode==='count'?3:2,
        revision:mode==='revision'?String(n):'stable'};
    };
    await expect(checkpointBatch(o)).rejects.toThrow('INCOMPLETE');
  }
  expect(attempts).toHaveLength(0);
}));
test('v2 closes dedicated page on invalid contract before lock acquisition', () => fixture(async ({ options }) => {
  const o=await options({intent:'unsupported'});
  await expect(checkpointBatch(o)).rejects.toThrow('INVALID'); expect(o.page.isClosed()).toBe(true);
}));

test('a denied second fetch cannot erase cancellation of a still-parsing first body', async () => {
  let writes=0, controller;
  const sandbox=vm.createContext({crypto:{getRandomValues:webcrypto.getRandomValues.bind(webcrypto)},structuredClone,Request,URL,navigator:{},addEventListener(){},
    XMLHttpRequest:class {open(){}send(){}},HTMLFormElement:class {submit(){}},fetch:async()=>{writes++;}});
  vm.runInContext(`(${installCheckpointGate.toString()})({key:'gate'})`,sandbox);
  const before=sandbox.gate({command:'snapshot'});
  sandbox.gate({command:'arm',generation:before.generation,approval:{destination:{siteOrigin:'https://site.test',accountKey:'a',scope:{collection:'one'}},fields:{key:'a'},
    write:{url:'https://site.test/records',method:'POST',accountKey:['account'],scope:{collection:['collection']},fields:{key:['key']}}}});
  const stream=new ReadableStream({start(c){controller=c;}});
  const first=sandbox.fetch('https://site.test/records',{method:'POST',body:stream,duplex:'half'});
  await expect(sandbox.fetch('https://site.test/records',{method:'POST',body:'{}'})).rejects.toThrow('WRITE_GATE');
  sandbox.gate({command:'disarm'});
  controller.enqueue(new TextEncoder().encode(JSON.stringify({account:'a',collection:'one',key:'a'})));controller.close();
  await expect(first).rejects.toThrow('Commit window ended');expect(writes).toBe(0);
});

test('v2 refuses a user-owned page without closing it', async () => {
  let closed=false;const page={isClosed:()=>closed,close:async()=>{closed=true;}};
  await expect(checkpointBatch({page})).rejects.toThrow('INVALID');expect(closed).toBe(false);
});
test('v2 default batch bound survives continuation over twenty records', () => fixture(async ({options,attempts}) => {
  const rows=Array.from({length:20},(_,i)=>({key:'row-'+i,value:i}));
  const first=await checkpointBatch(await options({rows}));expect(first.status).toBe('active');expect(first.processed).toBe(10);
  const second=await checkpointBatch(await options({rows}));expect(second.status).toBe('complete');expect(second.completed).toBe(20);
  expect((await checkpointBatch(await options({rows}))).processed).toBe(0);expect(attempts).toHaveLength(20);expect(new Set(attempts).size).toBe(20);
}));
