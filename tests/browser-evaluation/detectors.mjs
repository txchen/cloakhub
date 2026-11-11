import { sleep, withSignal } from './util.mjs';

const SITES = {
  fingerprint: ['https://demo.fingerprint.com/', 20000],
  sannysoft: ['https://bot.sannysoft.com/', 10000],
  browserscan: ['https://www.browserscan.net/bot-detection', 12000],
  iphey: ['https://iphey.com/', 30000],
};
export function fingerprintSignals(value) {
  if (!value || typeof value !== 'object') return {};
  const out = {};
  if (['not_detected', 'bad', 'good'].includes(value.bot)) out.bot = value.bot;
  for (const key of ['tampering', 'virtual_machine', 'developer_tools', 'vpn', 'proxy', 'incognito']) if (typeof value[key] === 'boolean') out[key] = value[key];
  for (const key of ['tampering_ml_score', 'suspect_score']) if (typeof value[key] === 'number' && Number.isFinite(value[key])) out[key] = value[key];
  if (typeof value.tampering_details?.anti_detect_browser === 'boolean') out.anti_detect_browser = value.tampering_details.anti_detect_browser;
  if (typeof value.vpn_methods?.os_mismatch === 'boolean') out.os_mismatch = value.vpn_methods.os_mismatch;
  return out;
}
export function fingerprintComplete(signals) {
  return typeof signals.bot === 'string' && typeof signals.virtual_machine === 'boolean' && typeof signals.tampering === 'boolean';
}
export function parseDetectorText(name, text) {
  if (name === 'iphey') {
    const verdict = /Your Digital Identity Looks\s*(Trustworthy|Unreliable)/.exec(text)?.[1] ?? null;
    const score = /(\d+)\s*MX SCORE/.exec(text)?.[1];
    const complete = Boolean(verdict) && !text.includes('Temporary value') && score !== undefined;
    return { complete, verdict, score: complete ? Number(score) : null, pendingPlaceholder: text.includes('Temporary value') };
  }
  if (name === 'browserscan') {
    const verdict = /Test Results:\s*(Normal|Abnormal)\b/.exec(text)?.[1] ?? null;
    return { complete: Boolean(verdict) && /Chrome DevTools Protocol Detection/.test(text), verdict };
  }
  if (name === 'sannysoft') return { complete: text.includes('WebDriver Advanced') && text.includes('CHR_MEMORY') };
  return {};
}
export async function runDetectors(browser, names, signal, limitedSites, redact, results = {}) {
  for (const name of names) {
    signal.throwIfAborted();
    if (limitedSites.has(name)) {
      results[name] = { status: 'skipped', reason: 'Rate-limited earlier in this run; no automatic retry' };
      continue;
    }
    const [url, waitMs] = SITES[name];
    const page = await browser.contexts()[0].newPage();
    page.setDefaultTimeout(5000);
    const item = { status: 'pending', signals: {}, httpStatuses: [], pageErrors: [] };
    results[name] = item;
    const pending = [];
    const onResponse = response => {
      const u = new URL(response.url());
      const siteHost = new URL(url).hostname.replace(/^www\./, '');
      if (response.status() === 429 && (u.hostname === siteHost || u.hostname.endsWith(`.${siteHost}`))) limitedSites.add(name);
      if (name === 'fingerprint' && u.hostname === 'demo.fingerprint.com' && u.pathname.startsWith('/api/event/')) {
        item.httpStatuses.push(response.status());
        if (response.status() === 429) limitedSites.add(name);
        if (response.ok()) pending.push(response.json().then(data => Object.assign(item.signals, fingerprintSignals(data))).catch(() => {}));
      }
    };
    page.on('response', onResponse);
    page.on('pageerror', e => item.pageErrors.push(redact(e.message).slice(0, 300)));
    try {
      const navigation = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
      item.navigationStatus = navigation?.status() ?? null;
      if (navigation?.status() === 429) limitedSites.add(name);
      await page.bringToFront();
      const start = Date.now();
      let text = '';
      while (Date.now() - start < waitMs) {
        signal.throwIfAborted();
        if (limitedSites.has(name)) break;
        await sleep(1000, signal);
        text = await page.locator('body').innerText();
        if (/429: Too many requests/i.test(text)) { limitedSites.add(name); break; }
        if (name === 'fingerprint') { if (fingerprintComplete(item.signals)) break; }
        else { Object.assign(item, parseDetectorText(name, text)); if (item.complete) break; }
      }
      item.waitMs = Date.now() - start;
      await withSignal(Promise.allSettled(pending), AbortSignal.any([signal, AbortSignal.timeout(3000)])).catch(() => {});
      if (name === 'fingerprint') item.complete = fingerprintComplete(item.signals);
      if (limitedSites.has(name)) item.status = 'rate_limited';
      else if (item.complete) item.status = 'complete';
      else {
        const title = await page.title();
        item.status = /just a moment|verify.*human|captcha/i.test(title) ? 'blocked' : 'incomplete';
        item.reason = 'No complete detector result within the bounded observation window';
      }
      if (name === 'sannysoft' && item.complete) item.failedOrWarn = (await page.locator('td.failed,td.warn').allTextContents()).map(t => redact(t).slice(0, 200));
    } catch (error) {
      signal.throwIfAborted();
      item.status = 'error'; item.reason = redact(error.message);
    } finally {
      page.off('response', onResponse);
      await withSignal(page.close().catch(() => {}), AbortSignal.timeout(5000)).catch(() => {});
    }
    // Only allowlisted verdicts leave this function: no page text, screenshots, visitor IDs or URLs.
  }
  return results;
}
