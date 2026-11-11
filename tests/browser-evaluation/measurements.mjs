import { PNG } from 'pngjs';
import { surface } from './surface.mjs';
import { auditRenderedFonts } from './fonts.mjs';
import { hash, sleep, cpuUsage, cpuDelta, withSignal } from './util.mjs';

export function summarizeSurface(value) {
  const { pixel1, pixel2, png, ...info } = value.canvas;
  const decoded = PNG.sync.read(Buffer.from(png)).data;
  if (pixel1.length !== pixel2.length || pixel1.length !== decoded.length) throw Error('Canvas readback/export dimensions differ');
  const diff = (a, b) => a.reduce((n, v, i) => n + Number(v !== b[i]), 0);
  return { ...value, canvas: { ...info, bytes: pixel1.length, pixelsHash: hash(Buffer.from(pixel1)), repeatHash: hash(Buffer.from(pixel2)), pngPixelsHash: hash(decoded), repeatDiffBytes: diff(pixel1, pixel2), exportDiffBytes: diff(pixel1, decoded) } };
}
export function contextChecks(main, other) {
  const shared = Object.keys(main.identity).filter(k => k in other.identity);
  return { sharedIdentityMatches: shared.every(k => JSON.stringify(main.identity[k]) === JSON.stringify(other.identity[k])), pixelsMatch: main.canvas.pixelsHash === other.canvas.pixelsHash, exportMatches: main.canvas.pngPixelsHash === other.canvas.pngPixelsHash };
}
export async function measureLocal(browser, fixtures, sample, config, signal, out = {}) {
  const context = browser.contexts()[0];
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.setDefaultNavigationTimeout(20000);
  try {
    signal.throwIfAborted();
    await page.goto(fixtures.origin);
    out.main = summarizeSurface(await page.evaluate(surface));
    signal.throwIfAborted();
    const session = await context.newCDPSession(page);
    try { out.physicalWindow = await session.send('Browser.getWindowForTarget'); } finally { await session.detach(); }
    if (sample.plan !== 'flags') {
      const worker = await page.evaluate(() => new Promise((resolve, reject) => {
        const worker = new Worker('/worker.js');
        const finish = () => { clearTimeout(timer); worker.terminate(); };
        const timer = setTimeout(() => { finish(); reject(Error('Worker probe timeout')); }, 15000);
        worker.onmessage = e => { finish(); resolve(e.data); };
        worker.onerror = e => { finish(); reject(Error(e.message)); };
      }));
      if (worker.error) throw Error(`Worker probe failed: ${worker.error}`);
      out.worker = summarizeSurface(worker);
      signal.throwIfAborted();
      const [frame] = await Promise.all([
        page.waitForEvent('framenavigated', { predicate: f => f.url().startsWith(fixtures.frameOrigin) }),
        page.evaluate(url => { const f = document.createElement('iframe'); f.src = url; document.body.append(f); }, fixtures.frameOrigin),
      ]);
      out.frame = summarizeSurface(await frame.evaluate(surface));
      out.contextChecks = { worker: contextChecks(out.main, out.worker), frame: contextChecks(out.main, out.frame) };
      out.headers = await page.evaluate(() => fetch('/echo').then(r => r.json()));
      out.headerChecks = { uaMatches: out.headers['user-agent'] === out.main.identity.ua, platformMatches: out.headers['sec-ch-ua-platform'] === JSON.stringify(out.main.identity.hints?.platform), archMatches: out.headers['sec-ch-ua-arch'] === JSON.stringify(out.main.identity.hints?.architecture) };
      out.fontProbe = await page.evaluate(() => {
        const names = ['Arial', 'Helvetica Neue', 'Times New Roman', 'Courier New', 'Menlo', 'Monaco', 'Segoe UI', 'Calibri', 'Verdana', 'Georgia'];
        return Array.from({ length: 3 }, () => {
          const start = performance.now(); let checkTrue = 0;
          for (let i = 0; i < 200; i++) if (document.fonts.check(`16px "${names[i] ?? 'NonexistentEvaluationFont' + i}"`)) checkTrue++;
          return { ms: performance.now() - start, checkTrue };
        });
      });
      // checkTrue is NOT a count of installed fonts: nonexistent families can return true.
      out.renderedFonts = await auditRenderedFonts(context, page);
    }
    signal.throwIfAborted();
    if (sample.plan === 'features') {
      await page.goto(`${fixtures.origin}/popup`);
      await sleep(1800, signal);
      out.popup = await page.evaluate(() => window.popupProbe);
      if (!out.popup) throw Error('Popup fixture did not produce a result');
    }
    if (sample.plan === 'local' || sample.plan === 'smoke') {
      let handled = 0;
      const routeErrors = [];
      await page.route('**/api/data?*', async route => {
        try { const response = await route.fetch({ timeout: 10000 }); await route.fulfill({ response, json: { ...await response.json(), intercepted: true } }); handled++; }
        catch { routeErrors.push('Route fetch/fulfill failed'); try { await route.abort(); } catch {} }
      });
      const count = sample.plan === 'smoke' ? Math.min(8, config.routeRequests) : config.routeRequests;
      const start = Date.now();
      out.interception = await page.evaluate(async count => {
        let good = 0; const errors = [];
        for (let start = 0; start < count; start += 8) {
          await Promise.all(Array.from({ length: Math.min(8, count - start) }, (_, i) => {
            const id = start + i;
            return fetch(`/api/data?id=${id}`, { signal: AbortSignal.timeout(15000) }).then(r => r.json()).then(x => {
              if (x.intercepted && x.id === String(id)) good++; else errors.push('Unexpected response');
            }).catch(() => errors.push('Fetch failed'));
          }));
        }
        return { requested: count, good, errors };
      }, count);
      Object.assign(out.interception, { handled, routeErrors, wallMs: Date.now() - start });
      await page.unrouteAll({ behavior: 'wait' });
    }
    if (sample.plan === 'local') {
      signal.throwIfAborted();
      await page.goto(fixtures.origin); await sleep(1500, signal);
      let cpu = cpuUsage(); let start = Date.now();
      await sleep(config.performanceSampleMs, signal);
      out.idle = { cpuUsec: cpuDelta(cpu, cpuUsage()), wallMs: Date.now() - start, scope: 'whole-container-cgroup-v2' };
      await page.goto(`${fixtures.origin}/animation`); await page.bringToFront(); await sleep(1500, signal);
      const frames = await page.evaluate(() => window.framesDrawn);
      cpu = cpuUsage(); start = Date.now();
      await sleep(config.performanceSampleMs, signal);
      out.animation = { cpuUsec: cpuDelta(cpu, cpuUsage()), wallMs: Date.now() - start, frames: (await page.evaluate(() => window.framesDrawn)) - frames, scope: 'whole-container-cgroup-v2' };
    }
    return out;
  } finally {
    await withSignal(page.close().catch(() => {}), AbortSignal.timeout(5000)).catch(() => {});
  }
}
