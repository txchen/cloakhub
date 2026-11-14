import net from 'node:net';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fork } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig, resolveTarget, withBrowser, safeError } from './browser.mjs';
import { errorHint, installOutputFilter } from './helpers.mjs';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const LIMIT = 64 * 1024;
const REQUEST_BYTES = LIMIT * 6 + 4096; // JSON can escape one UTF-16 code unit as six ASCII bytes.
const RESPONSE_BYTES = 1024 * 1024;
const ERROR_LIMIT = 2000;
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function redactProgress(value, token) {
  if (typeof value === 'string') return safeError(value, token);
  if (Array.isArray(value)) return value.map(item => redactProgress(item, token));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [safeError(key, token), redactProgress(item, token)]));
  return value;
}
export function createExecutor(api, token, { timeoutMs = 120_000 } = {}) {
  const state = {};
  let busy = false;
  let completedExecutions = 0;
  let lastExecution = null;
  let currentExecution = null;
  const recentExecutions = [];
  const executionScope = new AsyncLocalStorage();
  const scriptApi = { ...api };
  if (typeof api.checkpointBatch === 'function') {
    // Saved task functions may survive many exec calls. Bind progress at invocation,
    // not when the agent happened to define the function in a prior execution.
    scriptApi.checkpointBatch = options => {
      const current = executionScope.getStore();
      if (!current || !busy || currentExecution?.executionId !== current.id) throw new Error('Execution is no longer active');
      return api.checkpointBatch({ ...options, onProgress: options.onProgress ?? current.reportProgress });
    };
  }
  // Inspect implicit state by names/types only, without getters or serialization.
  // Progress and outcome summaries are explicitly reported by the executing script.
  const status = () => {
    const names = Object.getOwnPropertyNames(state);
    return {
      running: busy, completedExecutions, lastExecution, currentExecution,
      recentExecutions: [...recentExecutions], executionTimeoutMs: timeoutMs,
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
    const executionId = completedExecutions + 1;
    currentExecution = { executionId, startedAt: started, deadlineAt: started + timeoutMs, progress: null };
    const execution = {
      id: executionId, deadlineAt: started + timeoutMs,
      remainingMs: () => Math.max(0, started + timeoutMs - Date.now()),
      reportProgress: value => {
        if (!busy || currentExecution?.executionId !== executionId) throw new Error('Execution is no longer active');
        const text = JSON.stringify(value);
        if (text === undefined || text.length > 2048) throw new Error('Progress must be JSON data under 2048 characters');
        currentExecution.progress = redactProgress(JSON.parse(text), token);
      }
    };
    let failure;
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
      await executionScope.run(execution, () => new AsyncFunction(...Object.keys(scriptApi), 'state', 'execution', source)(...Object.values(scriptApi), state, execution));
      ok = true;
      return { ok: true, executionId, output, truncated };
    } catch (error) {
      const message = safeError(error, token);
      const result = { ok: false, executionId, output, truncated, error: message.slice(0, ERROR_LIMIT) };
      if (message.length > ERROR_LIMIT) result.errorTruncated = true;
      const hint = errorHint(result.error);
      if (hint) result.hint = hint;
      if (message === 'Execution is no longer active') {
        result.hint = 'A retained callback captured an older execution, not necessarily a lost session. For checkpointBatch omit onProgress to use current-execution progress automatically, or rebuild the callback in this call. Inspect the checkpoint before continuing; prior writes remain committed.';
      }
      if (error instanceof ReferenceError) {
        result.hint = 'Local variables last for one call. Store reusable values/functions on state (for example state.page), then use that same session. Completed changes before an error remain; inspect before retrying writes.';
      }
      failure = { error: result.error, ...(result.errorTruncated ? { errorTruncated: true } : {}), ...(result.hint ? { hint: result.hint } : {}) };
      return result;
    } finally {
      restore(); busy = false; completedExecutions++;
      lastExecution = { executionId, ok, durationMs: Date.now() - started,
        progress: currentExecution.progress, ...failure };
      recentExecutions.push(lastExecution);
      if (recentExecutions.length > 10) recentExecutions.shift();
      currentExecution = null;
    }
  };
  execute.status = status;
  return execute;
}

export function request(socketPath, message, timeoutMs = 125_000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let data = '';
    let bytes = 0;
    socket.setEncoding('utf8'); // Preserve code points split across socket chunks.
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error('Session response timed out; outcome unknown. Inspect before retrying.')));
    socket.on('connect', () => socket.write(JSON.stringify(message) + '\n'));
    socket.on('data', chunk => {
      bytes += Buffer.byteLength(chunk, 'utf8');
      if (bytes > RESPONSE_BYTES) return socket.destroy(new Error('Session response exceeded its limit; outcome unknown. Inspect before retrying.'));
      data += chunk;
      if (data.includes('\n')) {
        socket.end();
        try {
          const response = JSON.parse(data.slice(0, data.indexOf('\n')));
          if (!isRecord(response)) throw new Error('Invalid session response; inspect before retrying.');
          resolve(response);
        } catch (error) { reject(error); }
      }
    });
    socket.on('error', reject);
    socket.on('end', () => { if (!data.includes('\n')) reject(new Error('Session ended; outcome may be unknown. Inspect before retrying.')); });
  });
}

export async function sessionCommand(args) {
  const [command, id, ...rest] = args;
  if (command === 'start') {
    let alias;
    let timeoutMs = 120_000;
    const options = args.slice(1);
    const seen = new Set();
    for (let i = 0; i < options.length; i += 2) {
      const name = options[i]; const value = options[i + 1];
      if (!value || seen.has(name) || !['--target', '--timeout-ms'].includes(name)) throw new Error('session start [--target ALIAS] [--timeout-ms 1000..600000]');
      seen.add(name);
      if (name === '--target') alias = value;
      else timeoutMs = Number(value);
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600_000) throw new Error('Execution timeout must be 1000..600000 milliseconds');
    const target = await resolveTarget(await readConfig(), alias);
    const directory = await mkdtemp(join(tmpdir(), 'cloakhub-session-'));
    const socket = join(directory, 'control.sock');
    const child = fork(fileURLToPath(import.meta.url), ['worker', socket], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Session startup timed out.')), 70_000);
        child.once('message', message => { clearTimeout(timer); message.ok ? resolve() : reject(new Error(message.error)); });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', () => { clearTimeout(timer); reject(new Error('Session exited during startup.')); });
        child.send({ ...target, executionTimeoutMs: timeoutMs });
      });
      child.disconnect(); child.unref();
      console.log(JSON.stringify({ ok: true, session: socket, executionTimeoutMs: timeoutMs, ...target.metadata }));
    } catch (error) { child.kill(); await rm(directory, { recursive: true, force: true }); throw error; }
    return;
  }
  if (!['exec', 'end', 'status'].includes(command) || !id || rest.length) throw new Error('session exec|status|end SOCKET');
  let source = '';
  if (command === 'exec') {
    if (process.stdin.isTTY) throw new Error('Pass JavaScript on stdin.');
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
      source += chunk;
      if (source.length > LIMIT) throw new Error('Script exceeds 65,536 characters.');
    }
  }
  let timeoutMs = 125_000;
  if (command === 'exec') {
    const status = await request(id, { command: 'status' });
    if (Number.isSafeInteger(status.executionTimeoutMs)) timeoutMs = status.executionTimeoutMs + 5000;
  }
  const result = await request(id, { command, source }, timeoutMs);
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
    const execute = createExecutor(api, target.token, { timeoutMs: target.executionTimeoutMs });
    let running = false;
    server = net.createServer(socket => {
      let input = '';
      let bytes = 0;
      socket.setEncoding('utf8');
      socket.on('error', () => {});
      socket.setTimeout(5000, () => socket.destroy());
      socket.on('data', async chunk => {
        bytes += Buffer.byteLength(chunk, 'utf8');
        input += chunk;
        if (bytes > REQUEST_BYTES) return socket.destroy();
        if (!input.includes('\n')) return;
        socket.removeAllListeners('data'); socket.setTimeout(0);
        let message;
        try { message = JSON.parse(input.slice(0, input.indexOf('\n'))); }
        catch { return socket.end(JSON.stringify({ ok: false, error: 'Invalid request' }) + '\n'); }
        const reply = value => socket.end(JSON.stringify(value) + '\n');
        if (!isRecord(message)) return reply({ ok: false, error: 'Invalid request' });
        if (message.command === 'end') { reply({ ok: true }); return stop(); }
        if (message.command === 'status') return reply({ ok: true, ...execute.status(), ...target.metadata });
        if (message.command !== 'exec' || typeof message.source !== 'string' || message.source.length > LIMIT) return reply({ ok: false, error: 'Invalid command' });
        if (running) return reply({ ok: false, error: 'Session busy; do not replay an active operation.' });
        running = true; clearTimeout(idle);
        const deadline = setTimeout(stop, target.executionTimeoutMs);
        // A separate process also terminates synchronous loops that block this event loop.
        const watchdog = fork(fileURLToPath(import.meta.url), ['watchdog', String(process.pid), String(target.executionTimeoutMs + 1000)], { stdio: ['pipe', 'ignore', 'ignore', 'ipc'] });
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
  setTimeout(() => { try { process.kill(Number(process.argv[3]), 'SIGKILL'); } catch {} process.exit(); }, Number(process.argv[4]) || 121_000);
}
