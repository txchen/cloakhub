import net from 'node:net';
import { fork } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig, resolveTarget, withBrowser, safeError } from './browser.mjs';
import { installOutputFilter } from './helpers.mjs';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const LIMIT = 64 * 1024;
export function createExecutor(api, token) {
  const state = {};
  let busy = false;
  let completedExecutions = 0;
  let lastExecution = null;
  // Expose names/types only: inspecting status must never execute a getter or
  // serialize browser objects, collected records, cookies, or other state values.
  const status = () => {
    const names = Object.getOwnPropertyNames(state);
    return {
      running: busy, completedExecutions, lastExecution,
      state: names.slice(0, 50).map(name => {
        const descriptor = Object.getOwnPropertyDescriptor(state, name);
        return { name: safeError(name, token).slice(0, 120),
          type: Object.hasOwn(descriptor, 'value') ? typeof descriptor.value : 'accessor' };
      }),
      stateCount: names.length, stateTruncated: names.length > 50
    };
  };
  const execute = async (source) => {
    if (busy) return { ok: false, error: 'Session busy. Wait for the active call; do not replay it.' };
    busy = true;
    const started = Date.now();
    let ok = false;
    let output = '';
    let truncated = false;
    const stream = { write(value) {
      const remaining = LIMIT - output.length;
      output += value.slice(0, remaining);
      if (value.length > remaining) truncated = true;
    } };
    const restore = installOutputFilter([token], { out: stream, err: stream });
    try {
      if (!source?.trim()) throw new Error('Pass a nonempty async JavaScript body.');
      await new AsyncFunction(...Object.keys(api), 'state', source)(...Object.values(api), state);
      ok = true;
      return { ok: true, output, truncated };
    } catch (error) {
      const result = { ok: false, output, truncated, error: safeError(error, token) };
      if (error instanceof ReferenceError) {
        result.hint = 'Local variables last for one call. Store reusable values/functions on state (for example state.page), then use that same session. Completed changes before an error remain; inspect before retrying writes.';
      }
      return result;
    } finally {
      restore(); busy = false; completedExecutions++;
      lastExecution = { ok, durationMs: Date.now() - started };
    }
  };
  execute.status = status;
  return execute;
}

export function request(socketPath, message) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let data = '';
    socket.setTimeout(125_000, () => socket.destroy(new Error('Session response timed out; outcome unknown. Inspect before retrying.')));
    socket.on('connect', () => socket.write(JSON.stringify(message) + '\n'));
    socket.on('data', chunk => {
      data += chunk;
      if (data.includes('\n')) {
        socket.end();
        try { resolve(JSON.parse(data.slice(0, data.indexOf('\n')))); } catch (error) { reject(error); }
      }
    });
    socket.on('error', reject);
    socket.on('end', () => { if (!data.includes('\n')) reject(new Error('Session ended; outcome may be unknown. Inspect before retrying.')); });
  });
}

export async function sessionCommand(args) {
  const [command, id, ...rest] = args;
  if (command === 'start') {
    if (id && (id !== '--target' || rest.length !== 1)) throw new Error('session start [--target ALIAS]');
    const target = await resolveTarget(await readConfig(), rest[0]);
    const directory = await mkdtemp(join(tmpdir(), 'cloakhub-session-'));
    const socket = join(directory, 'control.sock');
    const child = fork(fileURLToPath(import.meta.url), ['worker', socket], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Session startup timed out.')), 70_000);
        child.once('message', message => { clearTimeout(timer); message.ok ? resolve() : reject(new Error(message.error)); });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', () => { clearTimeout(timer); reject(new Error('Session exited during startup.')); });
        child.send(target);
      });
      child.disconnect(); child.unref();
      console.log(JSON.stringify({ ok: true, session: socket, ...target.metadata }));
    } catch (error) { child.kill(); await rm(directory, { recursive: true, force: true }); throw error; }
    return;
  }
  if (!['exec', 'end', 'status'].includes(command) || !id || rest.length) throw new Error('session exec|status|end SOCKET');
  let source = '';
  if (command === 'exec') {
    if (process.stdin.isTTY) throw new Error('Pass JavaScript on stdin.');
    for await (const chunk of process.stdin) {
      source += chunk;
      if (source.length > LIMIT) throw new Error('Script exceeds 65,536 characters.');
    }
  }
  const result = await request(id, { command, source });
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
}

async function worker(socketPath, target) {
  const directory = socketPath.slice(0, socketPath.lastIndexOf('/'));
  let idle;
  let server;
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearTimeout(idle);
    server?.close();
    await rm(directory, { recursive: true, force: true });
    process.exit(0); // Closing this process drops CDP without closing browser tabs.
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  const arm = () => { clearTimeout(idle); idle = setTimeout(stop, 300_000); };
  await withBrowser(target, async api => {
    api.browser.on('disconnected', stop);
    const execute = createExecutor(api, target.token);
    let running = false;
    server = net.createServer(socket => {
      let input = '';
      socket.on('error', () => {});
      socket.setTimeout(5000, () => socket.destroy());
      socket.on('data', async chunk => {
        input += chunk;
        if (input.length > LIMIT * 2) return socket.destroy();
        if (!input.includes('\n')) return;
        socket.removeAllListeners('data'); socket.setTimeout(0);
        let message;
        try { message = JSON.parse(input.slice(0, input.indexOf('\n'))); }
        catch { return socket.end(JSON.stringify({ ok: false, error: 'Invalid request' }) + '\n'); }
        const reply = value => socket.end(JSON.stringify(value) + '\n');
        if (message.command === 'end') { reply({ ok: true }); return stop(); }
        if (message.command === 'status') return reply({ ok: true, ...execute.status(), ...target.metadata });
        if (message.command !== 'exec' || typeof message.source !== 'string') return reply({ ok: false, error: 'Invalid command' });
        if (running) return reply({ ok: false, error: 'Session busy; do not replay an active operation.' });
        running = true; clearTimeout(idle);
        const deadline = setTimeout(stop, 120_000);
        // A separate process also terminates synchronous loops that block this event loop.
        const watchdog = fork(fileURLToPath(import.meta.url), ['watchdog', String(process.pid)], { stdio: ['pipe', 'ignore', 'ignore', 'ipc'] });
        watchdog.once('error', stop);
        try { reply(await execute(message.source)); }
        finally { watchdog.kill(); clearTimeout(deadline); running = false; arm(); }
      });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    arm(); process.send?.({ ok: true });
    await new Promise(() => {});
  });
}
if (process.argv[2] === 'worker') {
  process.once('message', target => worker(process.argv[3], target).catch(async error => {
    process.send?.({ ok: false, error: safeError(error, target.token) });
    await rm(process.argv[3].slice(0, process.argv[3].lastIndexOf('/')), { recursive: true, force: true });
    process.exit(1);
  }));
} else if (process.argv[2] === 'watchdog') {
  process.on('disconnect', () => process.exit());
  setTimeout(() => { try { process.kill(Number(process.argv[3]), 'SIGKILL'); } catch {} process.exit(); }, 121_000);
}
