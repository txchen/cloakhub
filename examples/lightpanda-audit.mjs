// Public diagnostic comparison. No stealth injection; incomplete tests are not passes.
// AUDIT_CDP=ws://127.0.0.1:9222 node examples/lightpanda-audit.mjs LABEL SITE
// Or AUDIT_HUB=http://127.0.0.1:7799 for a disposable CloakHub instance.
// Each invocation tests one site; use an external timeout to bound CDP hangs.
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const [label, site] = process.argv.slice(2);
const sites = {
  sannysoft: ['https://bot.sannysoft.com/', 12000],
  rebrowser: ['https://bot-detector.rebrowser.net/', 5000],
  creepjs: ['https://abrahamjuliot.github.io/creepjs/', 20000],
  deviceinfo: ['https://deviceandbrowserinfo.com/are_you_a_bot', 15000],
  incolumitas: ['https://bot.incolumitas.com/', 18000],
  browserscan: ['https://www.browserscan.net/bot-detection', 18000],
  fingerprint: ['https://demo.fingerprint.com/playground', 20000],
  iphey: ['https://iphey.com/', 20000],
  recaptcha: ['https://recaptcha-demo.appspot.com/recaptcha-v3-request-scores.php', 12000],
};
if (!label || !sites[site]) throw new Error('Expected LABEL SITE');
const out = resolve(process.env.AUDIT_OUTPUT ?? '.cloakhub/lightpanda-1.0/results', label);
await mkdir(out, { recursive: true });
const result = { label, site, url: sites[site][0], date: new Date().toISOString(), errors: [], failures: [] };
const save = () => writeFile(`${out}/${site}.json`, JSON.stringify(result, null, 2));
const id = `lp_compare_${Date.now()}_${site}`;
let browser, profile;
async function api(path, body) {
  const r = await fetch(`${process.env.AUDIT_HUB}/api/profiles${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) throw new Error(`Hub ${r.status}: ${await r.text()}`);
  return r.json();
}
async function capture(key, fn) {
  try { result[key] = await fn(); } catch (e) { result[`${key}Error`] = String(e); }
  await save();
}
try {
  await save();
  let endpoint = process.env.AUDIT_CDP;
  if (!endpoint) {
    profile = await api('', { profile_id: id, display_name: id, headless: true, fingerprint_seed: '20261002' });
    endpoint = (await api(`/${id}/start`)).connection.cdp_url;
  }
  browser = await chromium.connectOverCDP(endpoint, { timeout: 20000 });
  result.version = browser.version();
  const context = browser.contexts()[0] ?? await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on('pageerror', e => result.errors.push(e.message));
  page.on('requestfailed', r => result.failures.push({ url: r.url(), error: r.failure()?.errorText }));
  await capture('status', async () => (await page.goto(result.url, { waitUntil: 'domcontentloaded', timeout: 40000 }))?.status());
  await new Promise(r => setTimeout(r, sites[site][1]));
  if (site === 'rebrowser') await capture('detections', async () => {
    await page.evaluate(() => window.dummyFn());
    await page.exposeFunction('exposedFn', () => {});
    await page.evaluate(() => document.getElementById('detections-json'));
    await page.evaluate(() => document.getElementsByClassName('div'));
    await new Promise(r => setTimeout(r, 3000));
    return page.locator('#detections-json').inputValue();
  });
  await capture('title', () => page.title());
  result.finalUrl = page.url();
  await capture('text', () => page.locator('body').innerText());
  await capture('tables', () => page.locator('tr').evaluateAll(rows => rows.map(r => ({ text: r.innerText, classes: [...r.querySelectorAll('td')].map(c => c.className) }))));
  await capture('fingerprint', () => page.evaluate(() => {
    const safe = fn => { try { return fn(); } catch (e) { return { error: String(e) }; } };
    return {
      userAgent: navigator.userAgent, platform: navigator.platform, webdriver: navigator.webdriver,
      languages: navigator.languages, hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: navigator.deviceMemory, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      plugins: safe(() => [...navigator.plugins].map(p => p.name)),
      screen: safe(() => ({ width: screen.width, height: screen.height })),
      window: safe(() => ({ innerWidth, innerHeight, outerWidth, outerHeight, devicePixelRatio })),
      webgl: safe(() => { const g = document.createElement('canvas').getContext('webgl'); const e = g?.getExtension('WEBGL_debug_renderer_info'); return e ? [g.getParameter(e.UNMASKED_VENDOR_WEBGL), g.getParameter(e.UNMASKED_RENDERER_WEBGL)] : null; }),
      canvas: safe(() => document.createElement('canvas').toDataURL()),
    };
  }));
  await capture('htmlSaved', async () => { await writeFile(`${out}/${site}.html`, await page.content()); return true; });
  // Lightpanda intentionally has no graphical renderer. Do not request screenshots.
  result.finished = new Date().toISOString();
  await save();
  await page.close();
} catch (e) { result.error = String(e); await save(); }
finally {
  await browser?.close().catch(() => {});
  if (profile) await api(`/${id}/stop`).catch(e => console.error(String(e)));
}
console.log(label, site, result.status, result.error ?? 'saved');
