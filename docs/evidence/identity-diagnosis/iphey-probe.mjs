// Opt-in compatibility probe. Use ONLY with a dedicated disposable CloakHub.
// CLOAKHUB_URL=http://127.0.0.1:18090 node docs/evidence/identity-diagnosis/iphey-probe.mjs
// No site rewriting, API patching, font removal, or fabricated fingerprint fields.
import { chromium } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const hub = process.env.CLOAKHUB_URL;
if (!hub) throw new Error('Set CLOAKHUB_URL to a dedicated disposable test instance.');
const token = process.env.CLOAKHUB_AUTH_TOKEN;
const id = `iphey_probe_${randomUUID().replaceAll('-', '')}`;
const headers = { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
async function api(path, method = 'GET', body) {
  const r = await fetch(`${hub}/api/profiles${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000)
  });
  if (!r.ok) throw new Error(`Profile API returned ${r.status}`);
  return r.status === 204 ? null : r.json();
}
const result = { completed: false, serverErrors: [], pageErrors: [], sockets: [] };
let browser, created = false;
try {
  const profile = await api('', 'POST', {
    profile_id: id, headless: true, fingerprint_seed: '20261001',
    platform: process.env.IPHEY_PLATFORM ?? 'macos',
    ...(process.env.IPHEY_TIMEZONE ? { timezone: process.env.IPHEY_TIMEZONE } : {})
  });
  created = true;
  browser = await chromium.connectOverCDP(profile.connection.cdp_url, { noDefaults: true });
  const page = await browser.contexts()[0].newPage();
  page.on('pageerror', error => result.pageErrors.push(error.name));
  page.on('websocket', socket => {
    if (new URL(socket.url()).hostname !== 'api.iphey.com') return;
    const row = { sentBytes: [], receivedBytes: [], closed: false };
    result.sockets.push(row);
    socket.on('framesent', frame => row.sentBytes.push(frame.payload.length));
    socket.on('framereceived', frame => {
      row.receivedBytes.push(frame.payload.length);
      // Retain only the known diagnostic. Do not save encrypted payloads or identifiers.
      if (typeof frame.payload === 'string' && frame.payload.includes("e?.performance.h3")) {
        result.serverErrors.push("null is not an object (evaluating 'e?.performance.h3')");
      }
    });
    socket.on('close', () => { row.closed = true; });
  });
  const start = Date.now();
  await page.goto('https://iphey.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  result.completed = await page.waitForFunction(() =>
    !document.body.innerText.includes('Temporary value') &&
    Boolean(document.querySelector('#hero-status')?.textContent.trim()),
  null, { timeout: 30000 }).then(() => true).catch(() => false);
  result.elapsedMs = Date.now() - start;
  result.browserVersion = browser.version();
  result.verdict = await page.locator('#hero-status').textContent().catch(() => null);
  // Placeholder zero is not a score.
  result.score = result.completed
    ? await page.locator('.score-value').textContent().then(Number).catch(() => null)
    : null;
  console.log(JSON.stringify(result, null, 2));
  if (!result.completed) process.exitCode = 1;
} catch (error) {
  const text = String(error);
  console.error(token ? text.split(token).join('<REDACTED>') : text);
  process.exitCode = 2;
} finally {
  await browser?.close();
  if (created) await api(`/${id}`, 'DELETE');
}
