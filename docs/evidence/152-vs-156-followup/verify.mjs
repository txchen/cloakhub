import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = name => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'));
const rows = read('./results.json');
const summary = read('./summary.json');
assert.equal(rows.length, 54);
assert.equal(summary.profiles, 54);
assert.equal(new Set(rows.map(r => r.id)).size, 54);
assert.deepEqual(summary.errors, []);
for (const r of rows) {
  assert.equal(r.error, undefined, r.id);
  assert.ok(!r.forcedStop, r.id);
  assert.equal(r.argvMatches, true, r.id);
  assert.deepEqual(r.actualArgv.slice(1), r.args, r.id);
  for (const context of ['main', 'worker', 'frame']) {
    assert.equal(r[context].canvas.bytes, 76800);
    assert.equal('pixel1' in r[context].canvas, false);
    assert.equal('png' in r[context].canvas, false);
  }
}
const main = rows.filter(r => [1, 2].includes(r.round));
assert.equal(main.length, 24);
assert.equal(main.reduce((n, r) => n + r.interception.good, 0), 4800);
for (const r of main) {
  assert.equal(r.interception.good, 200);
  assert.equal(r.interception.handled, 200);
  assert.deepEqual(r.interception.errors, []);
  for (const c of Object.values(r.contextChecks)) assert.ok(Object.values(c).every(Boolean), r.id);
  assert.ok(Object.values(r.headerChecks).every(Boolean), r.id);
  assert.equal(r.main.canvas.repeatDiffBytes, 0);
  assert.ok([10, 12].includes(r.main.canvas.exportDiffBytes));
}
for (const a of main.filter(r => r.v === 152)) {
  const b = main.find(r => r.v === 156 && ['seed', 'mode', 'round'].every(k => a[k] === r[k]));
  assert.ok(b);
  for (const c of ['main', 'worker', 'frame']) assert.deepEqual(a[c].canvas, b[c].canvas, a.id);
}
const median = xs => { const a = [...xs].sort((a,b) => a-b); return (a[a.length/2-1] + a[a.length/2])/2; };
for (const s of summary.performance) {
  const rs = main.filter(r => r.v === s.v && r.mode === s.mode);
  assert.equal(rs.length, 6);
  assert.equal(median(rs.map(r => r.animation.cpuUsec/1e6)), s.animationCpuSeconds.median);
  assert.equal(rs.reduce((n,r) => n+r.interception.good,0), 1200);
}
const perf = (v, mode) => summary.performance.find(s => s.v === v && s.mode === mode);
assert.ok(perf(152,'headed').animationCpuSeconds.median / perf(156,'headed').animationCpuSeconds.median > 7);
for (const v of [152,156]) {
  const popup = rows.filter(r => r.round === 3 && r.v === v);
  assert.equal(popup.find(r => !r.popupFlag).popup.opened, false);
  assert.equal(popup.find(r => r.popupFlag).popup.opened, v === 152);
  const vendor = rows.find(r => r.round === 7 && r.v === v && r.gpuVendor);
  assert.equal(vendor.main.gl.webgl.vendor, v === 152 ? 'intel' : 'Google Inc. (Intel)');
  const touch = rows.find(r => r.round === 7 && r.v === v && r.touch === 5);
  assert.equal(touch.main.identity.maxTouchPoints, v === 152 ? 0 : 5);
}
const sites = rows.filter(r => r.fingerprint);
assert.equal(sites.length, 8);
assert.ok(sites.every(r => r.fingerprint.complete && !r.fingerprint.rateLimited && r.fingerprint.statuses.every(s => s === 200)));
const personas = sites.filter(r => r.round === 6);
assert.equal(personas.length, 4);
for (const r of personas) {
  assert.equal(r.fingerprint.signals.virtual_machine, r.v === 156 && r.persona === 'macos');
  assert.equal(r.fingerprint.signals.tampering, r.persona === 'linux');
}
const stock = sites.filter(r => r.v === 'reference');
assert.equal(stock.length, 4);
assert.ok(stock.every(r => r.main.gl.webgl === null && r.main.gl.webgl2 === null));
assert.ok(stock.every(r => r.fingerprint.signals.virtual_machine === false));
console.log('Verified 54 profiles, 24 matched surface/performance runs, 4,800 intercepted requests, 8 detector references, and reported feature differences.');
