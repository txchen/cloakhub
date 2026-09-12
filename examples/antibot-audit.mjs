// Public diagnostic sites only. Results are observations, not automatic pass/fail verdicts.
// node examples/antibot-audit.mjs [default_headed|default_headless|windows_headed|stock_headless]
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const mode = process.argv[2] ?? 'default_headed';
// Explicit overrides support controlled experiments; environment.json records the result.
const profileOverrides = JSON.parse(process.env.AUDIT_PROFILE_OVERRIDES ?? '{}');
if (!profileOverrides || typeof profileOverrides !== 'object' || Array.isArray(profileOverrides)) {
  throw new Error('AUDIT_PROFILE_OVERRIDES must be a JSON object');
}
const variants = {
  default_headed: { headless: false },
  default_headless: { headless: true },
  windows_headed: { headless: false, platform: 'windows' },
  stock_headless: null,
};
if (!(mode in variants)) throw new Error(`Unknown variant: ${mode}`);
const hub = process.env.CLOAKHUB_URL ?? 'http://127.0.0.1:7788';
const out = resolve(process.env.AUDIT_OUTPUT ?? '.cloakhub/antibot-20260909/results', mode);
await mkdir(out, { recursive: true });
const headers = { 'Content-Type': 'application/json' };
if (process.env.CLOAKHUB_AUTH_TOKEN) headers.Authorization = `Bearer ${process.env.CLOAKHUB_AUTH_TOKEN}`;
async function api(path, method = 'GET', body) {
  const r = await fetch(`${hub}/api/profiles${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(data));
  return data;
}
const sites = [
  ['sannysoft', 'https://bot.sannysoft.com/', 12_000],
  ['rebrowser', 'https://bot-detector.rebrowser.net/', 5_000],
  ['creepjs', 'https://abrahamjuliot.github.io/creepjs/', 20_000],
  ['deviceinfo', 'https://deviceandbrowserinfo.com/are_you_a_bot', 15_000],
  ['incolumitas', 'https://bot.incolumitas.com/', 18_000],
  ['browserscan', 'https://www.browserscan.net/bot-detection', 18_000],
  ['fingerprint', 'https://demo.fingerprint.com/playground', 20_000],
  ['iphey', 'https://iphey.com/', 20_000],
  ['recaptcha', 'https://recaptcha-demo.appspot.com/recaptcha-v3-request-scores.php', 12_000],
].filter(([name]) => !process.env.AUDIT_SITES || process.env.AUDIT_SITES.split(',').includes(name));

let browser;
let profile;
const id = `audit_20260909_${mode}_${Date.now()}`;
try {
  if (mode === 'stock_headless') {
    browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--no-sandbox'] });
    await browser.newContext({ viewport: { width: 1366, height: 768 } });
  } else {
    profile = await api('', 'POST', {
      display_name: `Anti-bot audit: ${mode}`,
      fingerprint_seed: process.env.AUDIT_SEED ?? '20260909', notes: 'Public diagnostic audit, no accounts or proxies.',
      ...variants[mode],
      ...profileOverrides,
      profile_id: id,
    });
    const state = await api(`/${id}/start`, 'POST');
    browser = await chromium.connectOverCDP(state.connection.cdp_url, { timeout: 90_000 });
  }
  await writeFile(`${out}/environment.json`, JSON.stringify({
    date: new Date().toISOString(), mode, browserVersion: browser.version(), profile,
    stockCaveat: mode === 'stock_headless' ? 'Host Chrome for Testing, different version/OS environment from Docker CloakBrowser; sanity control, not matched patch A/B.' : undefined,
  }, null, 2));
  const context = browser.contexts()[0];
  for (const [name, url, settle] of sites) {
    console.log(`${new Date().toISOString()} ${mode} ${name} start`);
    const page = await context.newPage();
    const result = { name, url, started: new Date().toISOString(), failures: [], errors: [] };
    page.on('requestfailed', r => result.failures.push({ url: r.url(), error: r.failure()?.errorText }));
    page.on('pageerror', e => result.errors.push(e.message));
    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      result.status = response?.status();
      await page.waitForTimeout(settle);
      if (name === 'rebrowser') {
        // Required by the site's own instructions to exercise its probes.
        await page.evaluate(() => window.dummyFn());
        await page.exposeFunction('exposedFn', () => {});
        await page.evaluate(() => document.getElementById('detections-json'));
        await page.evaluate(() => document.getElementsByClassName('div'));
        await page.waitForTimeout(3_000);
        result.detections = await page.locator('#detections-json').inputValue();
        result.rebrowserNote = 'mainWorldExecution intentionally exercised in main world per Playwright instructions; exposeFunction intentionally used. See individual probe meaning.';
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
          screen: { width: screen.width, height: screen.height, availWidth: screen.availWidth, availHeight: screen.availHeight },
          window: { innerWidth, innerHeight, outerWidth, outerHeight, devicePixelRatio },
          webglVendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : null,
          webglRenderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null,
          uaData: navigator.userAgentData ? await navigator.userAgentData.getHighEntropyValues(['platformVersion', 'architecture', 'bitness', 'fullVersionList']) : null,
        };
      });
      if (name === 'incolumitas') result.sections = await page.locator('#behavioralScore, #new-tests, #detection-tests, #ip-api-data, #tls-fingerprint').evaluateAll(es => es.map(e => ({ id: e.id, text: e.innerText })));
      if (name === 'recaptcha') result.verification = await page.locator('.response').innerText();
    } catch (e) {
      result.error = String(e);
      result.text ??= await page.locator('body').innerText({ timeout: 3_000 }).catch(() => '');
    } finally {
      await page.screenshot({ path: `${out}/${name}.png`, fullPage: name === 'fingerprint', timeout: 15_000 }).catch(e => result.screenshotError = String(e));
      await writeFile(`${out}/${name}.json`, JSON.stringify(result, null, 2));
      await writeFile(`${out}/${name}.txt`, result.text ?? '');
      console.log(`${new Date().toISOString()} ${mode} ${name} saved status=${result.status} error=${result.error ?? 'none'}`);
      await page.close();
    }
  }
} finally {
  await browser?.close();
  if (profile) await api(`/${id}/stop`, 'POST');
}
