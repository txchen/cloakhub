import { chromium } from 'playwright-core';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { access, mkdir, readFile, rm, open, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir, release, arch } from 'node:os';
import { launchArgs } from './config.mjs';
import { browserEnv, redactor, sleep, stopOwned, ownedGroupAlive, withSignal, hash } from './util.mjs';
import { startFixtures } from './fixtures.mjs';
import { measureLocal } from './measurements.mjs';
import { runDetectors } from './detectors.mjs';

const execute = promisify(execFile);
async function sha256(file) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
function spawnOwned(file, args, env, onData = () => {}) {
  const child = spawn(file, args, { env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  child.on('error', error => { child.spawnError = error; });
  child.stderr.on('data', onData);
  return child;
}
function ensureRunning(child) {
  if (child.spawnError) throw child.spawnError;
  if (child.exitCode !== null || child.signalCode !== null) throw Error(`Owned process exited (${child.exitCode ?? child.signalCode})`);
}
export class EvaluationEngine {
  constructor(config, runDir, signal) {
    this.config = config; this.runDir = runDir; this.signal = signal;
    this.privateDir = join(runDir, '.private'); this.keys = new Map(); this.limitedSites = new Set();
    this.redact = redactor(); this.binaryMetadata = []; this.fontMetadata = {};
  }
  async start(cases) {
    if (process.platform !== 'linux') throw Error('The evaluation engine currently requires Linux; use the documented Docker image');
    if (process.versions.bun) throw Error('Use Node, not Bun, to drive Playwright CDP');
    await mkdir(join(this.privateDir, 'home'), { recursive: true, mode: 0o700 });
    for (const binary of this.config.binaries) {
      const file = binary.kind === 'reference' ? undefined : (binary.licenseKeyFile ?? this.config.licenseKeyFile);
      if (file) {
        const info = await stat(file);
        if (!info.isFile() || info.size > 16384) throw Error('License file must be a small regular file containing one key');
        const key = (await readFile(file, 'utf8')).trim();
        if (!key || /[\r\n\0]/.test(key)) throw Error('License file must contain exactly one nonempty key');
        this.keys.set(binary.id, key);
      }
    }
    this.redact = redactor([...this.keys.values()]);
    for (const binary of this.config.binaries) {
      this.signal.throwIfAborted();
      await access(binary.executable, constants.X_OK);
      const { stdout } = await execute(binary.executable, ['--version'], { timeout: 15000, maxBuffer: 16384, env: browserEnv(join(this.privateDir, 'home')) });
      const version = stdout.match(/\b\d{3}\.\d+\.\d+\.\d+(?:\.\d+)?\b/)?.[0];
      if (version !== binary.expectedVersion) throw Error(`Version mismatch for ${binary.id}: expected ${binary.expectedVersion}, got ${version ?? 'unrecognized output'}`);
      this.binaryMetadata.push({ id: binary.id, kind: binary.kind, version, executableSHA256: await sha256(binary.executable) });
    }
    for (const persona of new Set(cases.map(c => c.persona))) {
      const file = this.config.fontconfigFiles[persona];
      const data = { file: file ?? null, sha256: file ? hash(await readFile(file)) : null, note: this.config.fontNotes[persona] ?? 'Font coverage not certified for this persona' };
      try {
        const { stdout } = await execute('fc-list', ['--format=%{family}\n'], { timeout: 15000, maxBuffer: 1024 * 1024, env: browserEnv(join(this.privateDir, 'home'), { fontconfig: file }) });
        data.families = [...new Set(stdout.trim().split('\n').filter(Boolean))].sort();
      } catch { data.inventoryUnavailable = true; }
      this.fontMetadata[persona] = data;
    }
    this.fixtures = await startFixtures();
    if (cases.some(c => c.mode === 'headed')) await this.startDisplay();
    const readOptional = async file => { try { return (await readFile(file, 'utf8')).trim(); } catch { return null; } };
    return {
      node: process.version, playwright: JSON.parse(await readFile(new URL('../../node_modules/playwright-core/package.json', import.meta.url), 'utf8').catch(() => '{}')).version ?? 'see package lock',
      kernel: release(), arch: arch(), environmentLabel: this.config.environmentLabel,
      binaries: this.binaryMetadata, fonts: this.fontMetadata, display: this.display ?? null,
      externalDisplay: Boolean(this.config.display), cpuMax: await readOptional('/sys/fs/cgroup/cpu.max'), memoryMax: await readOptional('/sys/fs/cgroup/memory.max'),
      performanceScope: 'whole cgroup v2; browser + renderer/GPU + display + runner/fixtures, not browser main process alone',
    };
  }
  async startDisplay() {
    if (this.config.display) { this.display = this.config.display; return; }
    await access(this.config.xvnc, constants.X_OK);
    for (let n = 90; n < 190; n++) {
      if (existsSync(`/tmp/.X11-unix/X${n}`) || existsSync(`/tmp/.X${n}-lock`)) continue;
      const lock = join(tmpdir(), `cloakhub-evaluation-display-${n}.lock`);
      try { const handle = await open(lock, 'wx', 0o600); await handle.close(); } catch (e) { if (e.code === 'EEXIST') continue; throw e; }
      this.displayLock = lock; this.display = `:${n}`;
      this.displayProcess = spawnOwned(this.config.xvnc, [this.display, '-ac', '-nolisten', 'tcp', '-websocketPort', String(await freePort()), '-rfbport', '-1', '-geometry', '1366x768', '-depth', '24', '-SecurityTypes', 'None', '-DisableBasicAuth', '1', '-interface', '127.0.0.1', '-AlwaysShared'], browserEnv(join(this.privateDir, 'home')));
      for (let attempt = 0; attempt < 50; attempt++) {
        ensureRunning(this.displayProcess);
        if (existsSync(`/tmp/.X11-unix/X${n}`)) return;
        await sleep(100, this.signal);
      }
      throw Error('Managed Xvnc did not become ready');
    }
    throw Error('No unused managed X display available');
  }
  async run(sample) {
    const binary = this.config.binaries.find(b => b.id === sample.binaryId);
    const profile = join(this.privateDir, sample.id);
    await mkdir(profile, { mode: 0o700 });
    const args = launchArgs(sample, profile);
    const record = { schemaVersion: 1, ...sample, startedAt: new Date().toISOString(), status: 'running', args };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(Error('Case deadline exceeded')), this.config.caseTimeoutMs);
    const signal = AbortSignal.any([this.signal, controller.signal]);
    let child, browser, stderr = '';
    try {
      signal.throwIfAborted();
      child = spawnOwned(binary.executable, args, browserEnv(join(this.privateDir, 'home'), { key: this.keys.get(binary.id), display: this.display, fontconfig: this.config.fontconfigFiles[sample.persona] }), bytes => { stderr = (stderr + bytes.toString()).slice(-48000); });
      const task = async () => {
        const activePort = join(profile, 'DevToolsActivePort');
        let port;
        for (let i = 0; i < 120; i++) {
          signal.throwIfAborted(); ensureRunning(child);
          try { const text = await readFile(activePort, 'utf8'); const candidate = Number(text.split('\n')[0]); if (candidate >= 1 && candidate <= 65535) { port = candidate; break; } } catch {}
          await sleep(250, signal);
        }
        if (!port) throw Error('Browser did not publish its private CDP port');
        record.actualArgv = (await readFile(`/proc/${child.pid}/cmdline`, 'utf8')).split('\0').filter(Boolean);
        record.argvMatches = JSON.stringify(record.actualArgv.slice(1)) === JSON.stringify(args);
        if (!record.argvMatches) throw Error('Actual launch argv differs from requested argv');
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 15000 });
        signal.throwIfAborted();
        record.cdpVersion = browser.version();
        record.local = {};
        await measureLocal(browser, this.fixtures, sample, this.config, signal, record.local);
        signal.throwIfAborted();
        if (sample.plan === 'detectors') {
          record.detectors = {};
          await runDetectors(browser, this.config.detectors, signal, this.limitedSites, this.redact, record.detectors);
        }
      };
      await withSignal(task(), signal);
      record.status = 'complete';
    } catch (error) {
      record.status = this.signal.aborted ? 'interrupted' : controller.signal.aborted ? 'timeout' : 'error';
      record.error = this.redact(error.message);
    } finally {
      clearTimeout(timer); controller.abort(Error('Case finished'));
      if (browser) {
        await withSignal((async () => { try { const session = await browser.newBrowserCDPSession(); await session.send('Browser.close'); } catch {} await browser.close().catch(() => {}); })(), AbortSignal.timeout(5000)).catch(() => {});
      }
      // Give descendants time to finish too, even if the main process already exited.
      for (let i = 0; i < 20 && ownedGroupAlive(child); i++) await sleep(100);
      try { record.forcedStop = await stopOwned(child); }
      catch (error) { record.status = 'cleanup-error'; record.error = this.redact(error.message); }
      record.exitCode = child?.exitCode ?? null;
      record.gpuErrors = stderr.split('\n').filter(line => /Vulkan|eglInitialize|EGL_NOT_INITIALIZED|GL implementation|GPU process exited/.test(line)).slice(0, 8).map(this.redact);
      record.finishedAt = new Date().toISOString();
      await rm(profile, { recursive: true, force: true }).catch(() => {});
    }
    return record;
  }
  async close() {
    try { await this.fixtures?.close(); }
    finally {
      try { await stopOwned(this.displayProcess); }
      finally {
        if (this.displayLock) await rm(this.displayLock, { force: true });
        await rm(this.privateDir, { recursive: true, force: true });
        this.keys.clear();
      }
    }
  }
}
