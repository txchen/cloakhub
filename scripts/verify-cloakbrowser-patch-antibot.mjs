// Direct-CDP public anti-detection audit, adapted from examples/antibot-audit.mjs.
// Connects straight to a CloakBrowser launched with --remote-debugging-port,
// so it does not need a Hub or a license key.
// Env: CDP_URL, AUDIT_SITES (csv), AUDIT_OUTPUT, LABEL
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const cdpUrl = process.env.CDP_URL ?? 'http://127.0.0.1:9222';
const label = process.env.LABEL ?? 'patched_headless';
const out = resolve(process.env.AUDIT_OUTPUT ?? `.cloakhub/cloak152-evaluation/patched-verification/antibot/${label}`);
await mkdir(out, { recursive: true });

const allSites = [
  ['sannysoft', 'https://bot.sannysoft.com/', 12_000],
  ['rebrowser', 'https://bot-detector.rebrowser.net/', 5_000],
  ['creepjs', 'https://abrahamjuliot.github.io/creepjs/', 20_000],
  ['deviceinfo', 'https://deviceandbrowserinfo.com/are_you_a_bot', 15_000],
  ['fingerprint', 'https://demo.fingerprint.com/playground', 20_000],
  ['iphey', 'https://iphey.com/', 20_000],
];
const sites = allSites.filter(([name]) => !process.env.AUDIT_SITES || process.env.AUDIT_SITES.split(',').includes(name));

const browser = await chromium.connectOverCDP(cdpUrl, { timeout: 60_000 });
await writeFile(`${out}/environment.json`, JSON.stringify({ date: new Date().toISOString(), label, browserVersion: browser.version(), cdpUrl }, null, 2));
const context = browser.contexts()[0];
const summary = { label, browserVersion: browser.version(), sites: {} };

for (const [name, url, settle] of sites) {
  console.log(`${name} start`);
  const page = await context.newPage();
  const result = { name, url, started: new Date().toISOString(), failures: [], errors: [] };
  page.on('requestfailed', r => result.failures.push({ url: r.url(), error: r.failure()?.errorText }));
  page.on('pageerror', e => result.errors.push(e.message));
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    result.status = response?.status();
    await page.waitForTimeout(settle);
    if (name === 'rebrowser') {
      await page.evaluate(() => window.dummyFn());
      await page.exposeFunction('exposedFn', () => {});
      await page.evaluate(() => document.getElementById('detections-json'));
      await page.evaluate(() => document.getElementsByClassName('div'));
      await page.waitForTimeout(3_000);
      result.detections = await page.locator('#detections-json').inputValue();
    }
    result.title = await page.title();
    result.finalUrl = page.url();
    await writeFile(`${out}/${name}.html`, await page.content());
    result.text = await page.locator('body').innerText({ timeout: 10_000 });
    result.tables = await page.locator('tr').evaluateAll(rows => rows.map(r => ({ text: r.innerText, classes: [...r.querySelectorAll('td')].map(c => c.className) })));
    result.fingerprint = await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl');
      const ext = gl?.getExtension('WEBGL_debug_renderer_info');
      return {
        userAgent: navigator.userAgent, platform: navigator.platform, webdriver: navigator.webdriver,
        languages: navigator.languages, hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemory: navigator.deviceMemory, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        screen: { width: screen.width, height: screen.height },
        webglVendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : null,
        webglRenderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null,
      };
    });
  } catch (e) {
    result.error = String(e);
    result.text = await page.locator('body').innerText({ timeout: 3_000 }).catch(() => '');
  } finally {
    await page.screenshot({ path: `${out}/${name}.png`, fullPage: name === 'fingerprint', timeout: 15_000 }).catch(e => result.screenshotError = String(e));
    await writeFile(`${out}/${name}.json`, JSON.stringify(result, null, 2));
    await writeFile(`${out}/${name}.txt`, result.text ?? '');
    console.log(`${name} saved status=${result.status} error=${result.error ?? 'none'}`);
    summary.sites[name] = { status: result.status, title: result.title, error: result.error, text: (result.text ?? '').slice(0, 4000) };
    await page.close();
  }
}

await writeFile(`${out}/summary.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
await browser.close();
