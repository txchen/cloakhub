// Direct-CDP smoke test for a CloakBrowser binary launched with --remote-debugging-port.
// Verifies ordinary browsing/fingerprint surfaces; no Hub required.
// Env: CDP_URL (default http://127.0.0.1:9222), OUT (output dir)
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';

const cdpUrl = process.env.CDP_URL ?? 'http://127.0.0.1:9222';
const out = process.env.OUT ?? '.cloakhub/patched-verification/direct';
await mkdir(out, { recursive: true });

const html = `<!doctype html><meta charset="utf-8"><title>cloak</title>
<h1>smoke</h1><div id="x">ab</div><input id="i">
<button id="probe" onclick="this.textContent='clicked'">probe</button>
<iframe id="frame" src="http://localhost:9633/frame"></iframe>`;
const server = createServer((req, res) => {
  if (req.url === '/headers') {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ 'user-agent': req.headers['user-agent'] }));
  }
  if (req.url === '/frame') {
    res.setHeader('content-type', 'text/html');
    return res.end('<!doctype html><title>frame</title><p>frame-body</p>');
  }
  res.setHeader('content-type', 'text/html');
  res.end(html);
});
await new Promise(r => server.listen(9633, '127.0.0.1', r));

const browser = await chromium.connectOverCDP(cdpUrl, { timeout: 60_000 });
const context = browser.contexts()[0];
const result = { cdpUrl, browserVersion: browser.version(), checks: {}, errors: [] };

const page = await context.newPage();
page.on('pageerror', e => result.errors.push(e.message));

// 1. Basic JS + DOM + storage
await page.goto('http://127.0.0.1:9633/', { waitUntil: 'load' });
await page.evaluate(() => { document.getElementById('x').textContent = String(6 * 7); localStorage.setItem('cloak.test', 'persisted'); });
result.checks.domJs = await page.locator('#x').innerText();
result.checks.localStorage = await page.evaluate(() => localStorage.getItem('cloak.test'));
await page.reload({ waitUntil: 'load' });
result.checks.localStorageAfterReload = await page.evaluate(() => localStorage.getItem('cloak.test'));
await page.fill('#i', 'hello');
result.checks.inputValue = await page.inputValue('#i');
await page.locator('#probe').click();
result.checks.click = await page.locator('#probe').innerText();

// 2. Fingerprint / identity surface
result.checks.identity = await page.evaluate(async () => {
  const uaData = navigator.userAgentData ? await navigator.userAgentData.getHighEntropyValues(['architecture', 'bitness', 'platformVersion', 'fullVersionList']) : null;
  return {
    userAgent: navigator.userAgent, platform: navigator.platform, webdriver: navigator.webdriver,
    languages: [...navigator.languages], hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    screen: { width: screen.width, height: screen.height, colorDepth: screen.colorDepth },
    uaData,
  };
});
result.checks.httpUserAgent = await page.evaluate(async () => (await (await fetch('/headers')).json())['user-agent']);
result.checks.uaMatchesHttp = result.checks.identity.userAgent === result.checks.httpUserAgent;

// 3. Cross-origin iframe identity
result.checks.frame = await (async () => {
  const frame = page.frames().find(f => f.url().startsWith('http://localhost:9633/frame'));
  return frame ? frame.evaluate(() => ({ ua: navigator.userAgent, platform: navigator.platform })) : null;
})();

// 4. WebGL / WebGL2 pixel rendering
result.checks.webgl = await page.evaluate(() => {
  const out = {};
  for (const type of ['webgl', 'webgl2']) {
    const c = document.createElement('canvas'); c.width = 8; c.height = 8;
    const gl = c.getContext(type);
    if (!gl) { out[type] = null; continue; }
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    gl.clearColor(0.25, 0.5, 0.75, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    const px = new Uint8Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    out[type] = { vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : null, renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null, version: gl.getParameter(gl.VERSION), pixel: [...px] };
  }
  return out;
});

// 5. OffscreenCanvas WebGL2
result.checks.offscreenWebgl2 = await page.evaluate(() => {
  const oc = new OffscreenCanvas(8, 8); const gl = oc.getContext('webgl2');
  if (!gl) return null;
  gl.clearColor(0.1, 0.2, 0.3, 1); gl.clear(gl.COLOR_BUFFER_BIT);
  const px = new Uint8Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return [...px];
});

// 6. Web Worker identity consistency
result.checks.worker = await page.evaluate(async () => {
  const code = `postMessage({ua:navigator.userAgent,platform:navigator.platform,webdriver:navigator.webdriver})`;
  const w = new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
  const data = await new Promise((res, rej) => { const t = setTimeout(() => rej(Error('timeout')), 10000); w.onmessage = e => { clearTimeout(t); res(e.data); }; w.onerror = e => rej(Error(e.message)); });
  w.terminate(); return data;
});

// 7. WebGPU adapter
result.checks.webgpu = await page.evaluate(async () => {
  if (!navigator.gpu) return null;
  const adapter = await navigator.gpu.requestAdapter().catch(() => null);
  return adapter ? { ok: true } : { ok: false };
});

// 8. Audio
result.checks.audio = await page.evaluate(async () => {
  const ctx = new OfflineAudioContext(1, 1024, 44100);
  const osc = ctx.createOscillator(); osc.frequency.value = 440; osc.connect(ctx.destination); osc.start(0);
  const buf = await ctx.startRendering();
  const ch = buf.getChannelData(0);
  return { nonSilent: ch.some(v => v !== 0), canPlayH264: document.createElement('video').canPlayType('video/mp4; codecs="avc1.42E01E"') };
});

// 9. Multiple tabs
const page2 = await context.newPage();
await page2.goto('http://127.0.0.1:9633/', { waitUntil: 'load' });
result.checks.tab2Title = await page2.title();
await page2.close();

await page.screenshot({ path: `${out}/page.png` });

result.ok = result.checks.domJs === '42' && result.checks.localStorageAfterReload === 'persisted'
  && result.checks.inputValue === 'hello' && result.checks.click === 'clicked'
  && result.checks.worker.ua === result.checks.identity.userAgent
  && result.checks.uaMatchesHttp === true
  && result.checks.webgl.webgl && result.checks.webgl.webgl.pixel[3] === 255
  && result.checks.webgl.webgl2 && result.checks.webgl.webgl2.pixel[3] === 255
  && result.checks.audio.nonSilent === true;

await writeFile(`${out}/direct-smoke.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
await page.close();
await browser.close();
server.close();
process.exit(result.ok ? 0 : 1);
