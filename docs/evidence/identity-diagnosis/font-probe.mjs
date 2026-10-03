// Opt-in native-browser regression probe, not a hardware-independent unit test.
// Start a dedicated disposable CloakHub first. This creates and deletes ONE profile.
// CLOAKHUB_URL=http://127.0.0.1:18090 node docs/evidence/identity-diagnosis/font-probe.mjs
import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const hub = process.env.CLOAKHUB_URL;
if (!hub) throw new Error('Set CLOAKHUB_URL to a dedicated disposable test instance.');
const fonts = JSON.parse(await readFile(new URL('./font-names.json', import.meta.url), 'utf8'));
const id = `font_probe_${randomUUID().replaceAll('-', '')}`;
const token = process.env.CLOAKHUB_AUTH_TOKEN;
const limit = Number(process.env.FONT_TASK_LIMIT_MS ?? 3000);
if (!Number.isFinite(limit) || limit <= 0) throw new Error('Invalid FONT_TASK_LIMIT_MS');
const headers = { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
async function api(path, method = 'GET', body) {
  const r = await fetch(`${hub}/api/profiles${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000)
  });
  if (!r.ok) throw new Error(`Profile API returned ${r.status}`);
  return r.status === 204 ? null : r.json();
}
let browser, created = false;
try {
  const profile = await api('', 'POST', {
    profile_id: id, headless: true, fingerprint_seed: '20261001',
    platform: process.env.FONT_PROBE_PLATFORM ?? 'macos'
  });
  created = true;
  browser = await chromium.connectOverCDP(profile.connection.cdp_url, { noDefaults: true });
  const page = await browser.contexts()[0].newPage();
  // Local synthetic document: no IPHey script, external site, or network dependency.
  await page.route('http://127.0.0.1:7788/font-probe', route => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><title>Local font performance probe</title>'
  }));
  await page.goto('http://127.0.0.1:7788/font-probe');
  const rounds = await page.evaluate(async (fonts) => {
    const style = document.createElement('style');
    style.textContent = fonts.map(f => `@font-face {font-family:"${f}";src:local("${f}");}`).join('\n');
    document.head.append(style);
    const results = [];
    for (let round = 0; round < 2; round++) {
      await new Promise(resolve => setTimeout(resolve, 20));
      const start = performance.now();
      const timer = new Promise(resolve => setTimeout(() => resolve(performance.now() - start), 0));
      let available = 0;
      for (const font of fonts) available += Number(document.fonts.check(`16px "${font}"`));
      const taskMs = performance.now() - start;
      results.push({ round, taskMs, timerDelayMs: await timer, available });
    }
    return results;
  }, fonts);
  const passed = rounds.every(round => round.taskMs < limit);
  console.log(JSON.stringify({ browserVersion: browser.version(), fontCount: fonts.length, limitMs: limit, passed, rounds }, null, 2));
  if (!passed) process.exitCode = 1;
} catch (error) {
  const text = String(error);
  console.error(token ? text.split(token).join('<REDACTED>') : text);
  process.exitCode = 2;
} finally {
  await browser?.close();
  if (created) await api(`/${id}`, 'DELETE');
}
