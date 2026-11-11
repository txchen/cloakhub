import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const rows = JSON.parse(readFileSync(new URL('./results.json', import.meta.url), 'utf8'));
assert.equal(rows.length, 62);
assert.equal(new Set(rows.map(r => r.id)).size, 62);
assert.equal(rows.filter(r => r.fingerprint).length * 4, 152);
for (const row of rows) {
  assert.equal(row.argv_matches_requested, true, row.id);
  assert.deepEqual(row.actualArgv.slice(1), row.args, row.id);
  assert.equal(row.forcedStop, false, row.id);
  assert.equal(row.error, undefined, row.id);
  assert.equal(row.local.hardwareConcurrency, 4, row.id);
  assert.equal(row.local.platform, 'MacIntel', row.id);
  assert.equal(row.local.timezone, 'America/Los_Angeles', row.id);
  if (row.fingerprint) {
    assert.equal('visitorHash' in row.fingerprint.signals, false);
    assert.deepEqual(row.siteErrors, {});
    if (!row.iphey.completed) assert.equal(row.iphey.score, null);
  }
}
const select = (v, mode, rounds) => rows.filter(r => r.v === v && r.mode === mode && rounds.includes(r.round));
for (const v of [152, 156]) {
  for (const [mode, rounds] of [['headed', [1, 2]], ['headless', [5, 6]]]) {
    const rs = select(v, mode, rounds);
    assert.equal(rs.length, 6);
    for (const r of rs) {
      assert.ok(r.local.gl.webgl && r.local.gl.webgl2);
      assert.equal(r.fingerprint.complete, true);
      assert.equal(r.fingerprint.signals.bot, 'not_detected');
      assert.equal(r.fingerprint.signals.virtual_machine, v === 156);
      assert.equal(r.sannysoft.completed, true);
      assert.deepEqual(r.sannysoft.failedOrWarn, []);
      assert.equal(r.browserscan.verdict, 'Normal');
      assert.equal(r.iphey.completed, true);
      assert.equal(r.iphey.score, 100);
      assert.equal(r.iphey.verdict, 'Trustworthy');
    }
    const positives = rs.filter(r => r.fingerprint.signals.tampering);
    assert.equal(positives.length, v === 156 && mode === 'headless' ? 2 : 0);
    for (const p of positives) assert.equal(p.seed, 20260909);
  }
}
const broken = select(156, 'headless', [1, 2]);
assert.equal(broken.length, 6);
assert.equal(broken.filter(r => r.fingerprint.complete).length, 3);
assert.equal(broken.filter(r => r.fingerprint.http429).length, 3);
assert.ok(broken.every(r => !r.local.gl.webgl && !r.local.gl.webgl2 && !r.iphey.completed));
// Across versions, actual non-path launch arguments must be identical in each matched pair.
for (const r of rows.filter(r => r.v === 152)) {
  const other = rows.find(o => o.v === 156 && o.mode === r.mode && o.seed === r.seed && o.variant === r.variant && o.round === r.round);
  assert.ok(other, r.id);
  const normalize = args => args.filter(a => !a.startsWith('--user-data-dir='));
  assert.deepEqual(normalize(r.args), normalize(other.args), r.id);
}
console.log('Saved evidence verified: 62 profiles, 152 site visits; argv, missing-data handling and report counts match.');
