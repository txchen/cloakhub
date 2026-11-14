#!/usr/bin/env node
// Isolated local experiment: never connects to a Hub or reads client credentials.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../skills/cloakhub-browser/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const dependencyPath = require.resolve('playwright-core/package.json');
const dependencySource = dependencyPath.includes('/skills/cloakhub-browser/node_modules/') ? 'skill' : 'root-fallback';
const browsers = [];
let repetitions = 2;
let output;
let focusLifecycleOnly = false;
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--browser') {
    const value = process.argv[++i] ?? '';
    const split = value.indexOf('=');
    if (split < 1) throw new Error('--browser requires LABEL=/absolute/path/to/chrome');
    browsers.push({ label: value.slice(0, split), executable: value.slice(split + 1) });
  } else if (arg === '--repeat') repetitions = Number(process.argv[++i]);
  else if (arg === '--output') output = process.argv[++i];
  else if (arg === '--focus-lifecycle-only') focusLifecycleOnly = true;
  else throw new Error(`Unknown option: ${arg}`);
}
if (!browsers.length || !Number.isInteger(repetitions) || repetitions < 1 || repetitions > 20)
  throw new Error('Usage: DISPLAY=:99 node scripts/evaluate-background-tabs.mjs --browser stock=/path/chrome [--browser cloak=/path/chrome] [--repeat 2 | --focus-lifecycle-only] [--output /tmp/result.json]');
if (!process.env.DISPLAY) throw new Error('Set DISPLAY to a private test X server; do not use a personal desktop.');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const exec = promisify(execFile);
const fixture = `<!doctype html><title>Background tab fixture</title>
<label>Value <input aria-label="Value"></label><button onclick="document.querySelector('output').textContent=String(++window.clicks)">Save</button><output>0</output>
<script>window.clicks=0;window.framesSeen=0;function tick(){window.framesSeen++;requestAnimationFrame(tick)}requestAnimationFrame(tick)</script>`;
const flagSets = {
  current: ['--disable-gpu', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader'],
  unthrottled: ['--disable-gpu', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding']
};
const modes = [
  { name: 'noDefaults', noDefaults: true },
  { name: 'playwrightDefaults', noDefaults: false },
  { name: 'noDefaults+focus', noDefaults: true, focus: true }
];
const report = { createdAt: new Date().toISOString(), platform: process.platform, architecture: process.arch, playwright: require('playwright-core/package.json').version, dependencySource, repetitions, flagSets, incomplete: false, results: [] };
report.scope = focusLifecycleOnly ? 'two-client focus lifecycle and native X input' : 'background matrix';
let activeProcess;
let interruption;
let killDeadline;
function killGroup(child, signal) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  interruption ??= signal;
  killGroup(activeProcess, 'SIGTERM');
  if (!killDeadline) killDeadline = setTimeout(() => killGroup(activeProcess, 'SIGKILL'), 1000);
});

matrix: for (const browserSpec of browsers) for (const [flagsName, flags] of Object.entries(flagSets)) for (const mode of modes) {
  if (focusLifecycleOnly && (flagsName !== 'current' || mode.name !== 'noDefaults')) continue;
  if (interruption) break matrix;
  const directory = await mkdtemp(join(tmpdir(), 'cloakhub-background-'));
  let browser;
  let stderr = '';
  const child = spawn(browserSpec.executable, [
    `--user-data-dir=${directory}`, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    '--no-sandbox', '--no-first-run', '--no-default-browser-check', '--window-size=1280,800',
    '--disable-infobars', '--test-type', ...flags, 'about:blank'
  ], { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  activeProcess = child;
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  let launchError;
  child.on('error', error => { launchError = error; });
  const result = { browser: browserSpec.label, flags: flagsName, mode: mode.name, trials: [] };
  try {
    let port;
    for (let i = 0; i < 200; i++) {
      if (interruption) throw new Error(`Interrupted by ${interruption}`);
      if (launchError) throw launchError;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Browser exited ${child.exitCode ?? child.signalCode}`);
      try { port = Number((await readFile(join(directory, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); } catch {}
      if (port) break;
      await pause(100);
    }
    if (!port) throw new Error('Browser CDP startup deadline exceeded');
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: mode.noDefaults, timeout: 15_000 });
    result.version = browser.version();
    const context = browser.contexts()[0];
    const target = await context.newPage();
    const cover = await context.newPage();
    await cover.goto('data:text/html,<title>Foreground cover</title><p>Other task</p>', { timeout: 5000 });
    if (mode.focus) {
      const cdp = await context.newCDPSession(target);
      await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
      // Keep this session attached throughout the trial.
    }
    for (let iteration = 0; iteration < (focusLifecycleOnly ? 0 : repetitions); iteration++) for (const foreground of [false, true]) {
      if (interruption) throw new Error(`Interrupted by ${interruption}`);
      await target.bringToFront();
      // A fresh document cancels the preceding trial's animation-frame callback.
      await target.goto(`data:text/html,${encodeURIComponent(fixture)}`, { timeout: 5000 });
      await (foreground ? target : cover).bringToFront();
      await pause(200);
      const snapshot = () => target.evaluate(() => ({ visible: document.visibilityState, focused: document.hasFocus(), frames: window.framesSeen, clicks: window.clicks, value: document.querySelector('input').value }));
      const before = await snapshot();
      await pause(400);
      const after = await snapshot();
      const trial = { iteration, foreground, visibility: after.visible, focused: after.focused, rafDelta: after.frames - before.frames };
      const started = Date.now();
      try { await target.getByLabel('Value').fill('verified', { timeout: 1500 }); trial.fill = 'ok'; }
      catch (error) { trial.fill = error.name; }
      try { await target.getByRole('button', { name: 'Save' }).click({ timeout: 1500 }); trial.click = 'ok'; }
      catch (error) { trial.click = error.name; trial.clickError = error.message.slice(0, 1000); }
      trial.durationMs = Date.now() - started;
      trial.effect = await snapshot();
      trial.confirmed = trial.effect.clicks === 1 && trial.effect.value === 'verified';
      result.trials.push(trial);
    }
    if (focusLifecycleOnly) {
      await target.goto(`data:text/html,${encodeURIComponent(fixture)}`, { timeout: 5000 });
      await cover.goto('data:text/html,<title>Native user tab</title><label>Native input<input aria-label="Native input"></label>', { timeout: 5000 });
      await cover.bringToFront();
      const other = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true, timeout: 15_000 });
      const userPage = other.contexts()[0].pages().find(page => page.url() === cover.url());
      const state = page => page.evaluate(() => ({ visible: document.visibilityState, focused: document.hasFocus() }));
      const evidence = result.focusLifecycle = { baseline: await state(target) };
      let focus;
      try {
        focus = await context.newCDPSession(target);
        await focus.send('Emulation.setFocusEmulationEnabled', { enabled: true });
        evidence.enabled = await state(target);
        evidence.otherPage = await state(userPage);
        await userPage.getByLabel('Native input').focus();
        await exec('xdotool', ['type', '--clearmodifiers', '--delay', '5', 'viewer-input']);
        evidence.nativeInputValue = await userPage.getByLabel('Native input').inputValue();
        await target.getByLabel('Value').fill('agent-input');
        await target.getByRole('button', { name: 'Save' }).click({ timeout: 1500 });
        evidence.agentClicks = await target.locator('output').innerText();
        evidence.nativeInputAfterAgentClick = await userPage.getByLabel('Native input').inputValue();
        await exec('xdotool', ['type', '--clearmodifiers', '--delay', '5', '--', '-after-agent']);
        evidence.nativeInputAfterSecondTyping = await userPage.getByLabel('Native input').inputValue();
        await focus.detach();
        evidence.afterDetach = await state(target);
        focus = await context.newCDPSession(target);
        await focus.send('Emulation.setFocusEmulationEnabled', { enabled: true });
        await focus.send('Emulation.setFocusEmulationEnabled', { enabled: false });
        evidence.afterExplicitDisable = await state(target);
        await focus.detach();
        focus = undefined;
        const otherTarget = other.contexts()[0].pages().find(page => page.url() === target.url());
        const otherFocus = await other.contexts()[0].newCDPSession(otherTarget);
        await otherFocus.send('Emulation.setFocusEmulationEnabled', { enabled: true });
        evidence.beforeClientDisconnect = await state(target);
        await other.close();
        await pause(200);
        evidence.afterClientDisconnect = await state(target);
        evidence.confirmed = evidence.nativeInputValue === 'viewer-input' && evidence.agentClicks === '1' && evidence.nativeInputAfterSecondTyping === 'viewer-input-after-agent' && evidence.afterDetach.visible === 'hidden' && evidence.afterExplicitDisable.visible === 'hidden' && evidence.afterClientDisconnect.visible === 'hidden';
      } finally {
        await focus?.send('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {});
        await focus?.detach().catch(() => {});
        await other.close().catch(() => {});
      }
    }
  } catch (error) { result.error = error.message; result.stderr = stderr; }
  finally {
    killGroup(child, 'SIGTERM');
    await browser?.close().catch(() => {}); // disconnect this owned CDP client
    for (let i = 0; i < 30 && child.exitCode === null && child.signalCode === null; i++) await pause(100);
    // Kill remaining owned descendants even if the browser parent already exited.
    killGroup(child, 'SIGKILL');
    await pause(200);
    clearTimeout(killDeadline);
    killDeadline = undefined;
    activeProcess = undefined;
    await rm(directory, { recursive: true, force: true });
  }
  report.results.push(result);
  console.error(JSON.stringify({ browser: result.browser, flags: result.flags, mode: result.mode, confirmed: result.trials.filter(t => t.confirmed).length, trials: result.trials.length, error: result.error }));
}
report.incomplete = Boolean(interruption) || report.results.some(result => result.error);
if (focusLifecycleOnly) report.validationPassed = !report.incomplete && report.results.every(result => result.focusLifecycle?.confirmed);
if (interruption) report.interruptedBy = interruption;
const json = JSON.stringify(report, null, 2) + '\n';
if (output) await writeFile(output, json);
else process.stdout.write(json);
if (interruption) process.exitCode = interruption === 'SIGINT' ? 130 : 143;
else if (report.incomplete || report.validationPassed === false) process.exitCode = 1;
