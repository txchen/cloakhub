// Run only against a disposable, unauthenticated, loopback Hub.
// Usage: node viewer-check.mjs http://127.0.0.1:PORT /path/to/viewer/chrome
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../../skills/cloakhub-browser/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const [origin, executablePath] = process.argv.slice(2);
const url = new URL(origin);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password)
  throw new Error('Use an isolated unauthenticated loopback Hub.');
const profile = `focus_viewer_${Date.now()}`;
const report = { playwright: require('playwright-core/package.json').version, scope: 'synthetic profile; real Hub CDP and voxl video/keyboard transport' };
let created = false;
let remote;
let second;
let viewer;
let cdp;
try {
  const response = await fetch(`${origin}/api/profiles`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ profile_id: profile, sleep_policy: { mode: 'never' } })
  });
  if (response.status !== 201) throw new Error(`Profile create failed: ${response.status}`);
  created = true;
  const endpoint = `${origin}/api/profiles/${profile}/cdp`;
  remote = await chromium.connectOverCDP(endpoint, { noDefaults: true, timeout: 60_000 });
  report.remoteVersion = remote.version();
  const context = remote.contexts()[0];
  const task = await context.newPage();
  await task.goto('data:text/html,<title>Agent task</title><button onclick="document.querySelector(\'output\').textContent=\'saved\'">Save</button><output>pending</output>');
  const user = await context.newPage();
  await user.goto('data:text/html,<title>Viewer user</title><label>Viewer input<input aria-label="Viewer input"></label>');
  await user.bringToFront();
  second = await chromium.connectOverCDP(endpoint, { noDefaults: true });
  const secondUser = second.contexts()[0].pages().find(page => page.url() === user.url());
  await secondUser.getByLabel('Viewer input').focus();
  cdp = await context.newCDPSession(task);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  viewer = await chromium.launch({ executablePath, headless: true });
  report.viewerVersion = viewer.version();
  const page = await viewer.newPage({ viewport: { width: 1366, height: 768 } });
  await page.goto(`${origin}/ui/profiles/${profile}/viewer`);
  const display = page.frameLocator('#display-frame');
  await display.locator('#surface').waitFor({ state: 'visible' });
  const video = display.locator('video').first();
  await video.waitFor({ state: 'visible' });
  for (let i = 0; i < 50; i++) {
    if (await video.evaluate(v => v.readyState >= 2 && v.videoWidth > 0)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  report.video = await video.evaluate(v => ({ readyState: v.readyState, width: v.videoWidth, height: v.videoHeight, decodedFrames: v.getVideoPlaybackQuality().totalVideoFrames }));
  await display.locator('#surface').focus();
  await page.keyboard.type('viewer-input', { delay: 20 });
  const waitForValue = async expected => {
    for (let i = 0; i < 30; i++) {
      const actual = await secondUser.getByLabel('Viewer input').inputValue();
      if (actual === expected) return actual;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return secondUser.getByLabel('Viewer input').inputValue();
  };
  report.beforeAgent = await waitForValue('viewer-input');
  await task.getByRole('button', { name: 'Save' }).click({ timeout: 1500 });
  report.agentResult = await task.locator('output').innerText();
  await page.keyboard.type('-after-agent', { delay: 20 });
  report.afterAgent = await waitForValue('viewer-input-after-agent');
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  await cdp.detach(); cdp = undefined;
  report.taskAfterCleanup = await task.evaluate(() => ({ visible: document.visibilityState, focused: document.hasFocus() }));
  await page.keyboard.type('-after-cleanup', { delay: 20 });
  report.afterCleanup = await waitForValue('viewer-input-after-agent-after-cleanup');
  report.confirmed = report.video.readyState >= 2 && report.video.decodedFrames > 0 && report.beforeAgent === 'viewer-input' && report.agentResult === 'saved' && report.afterAgent === 'viewer-input-after-agent' && report.afterCleanup === 'viewer-input-after-agent-after-cleanup' && report.taskAfterCleanup.visible === 'hidden';
} catch (error) {
  report.error = error.message.replaceAll(origin, '<disposable-hub>').replaceAll(profile, '<synthetic-profile>');
} finally {
  await cdp?.send('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {});
  await cdp?.detach().catch(() => {});
  await viewer?.close().catch(() => {});
  await second?.close().catch(() => {});
  await remote?.close().catch(() => {});
  if (created) report.profileDeleted = (await fetch(`${origin}/api/profiles/${profile}`, { method: 'DELETE' })).status === 204;
}
console.log(JSON.stringify(report, null, 2));
if (!report.confirmed || !report.profileDeleted) process.exitCode = 1;
