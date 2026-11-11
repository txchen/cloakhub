import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const provenance = read('./provenance.json');
const summary = read('./summary.json');
assert.equal(provenance.runs.length, 7);
assert.equal(read('./font-files.json').length, 34);
const counts = {};
const fontCounts = { system: 29, added: 43, only: 14, defaults: 14 };
for (const { arm, replicate, runId } of provenance.runs) {
  const prefix = arm === 'defaults' ? './defaults' : `./r${replicate}-${arm}`;
  const manifest = read(`${prefix}/manifest.json`);
  const rows = read(`${prefix}/results.json`);
  assert.equal(manifest.runId, runId);
  assert.equal(manifest.status, 'finished');
  assert.equal(manifest.suiteSourceSHA256, provenance.suiteSourceSHA256);
  assert.equal(manifest.environment.binaries[0].version, '156.0.8078.47.1');
  assert.equal(manifest.environment.binaries[0].executableSHA256, '37c2b771b87cdbf171c2c8021fc7f7900667e2363ccfc8e5d7904ef7e9dbc74a');
  assert.equal(manifest.environment.fonts.windows.families.length, fontCounts[arm]);
  if (arm === 'system') assert.equal(manifest.environment.fonts.windows.file, null);
  else {
    const file = readFileSync(new URL(`./configs/windows-${arm}.conf`, import.meta.url));
    assert.equal(manifest.environment.fonts.windows.sha256, createHash('sha256').update(file).digest('hex'));
  }
  assert.equal(rows.length, arm === 'defaults' ? 4 : 2);
  assert.deepEqual(rows.map(r => r.mode).sort(), arm === 'defaults' ? ['headed', 'headed', 'headless', 'headless'] : ['headed', 'headless']);
  for (const r of rows) {
    assert.equal(r.seed, 20260909);
    assert.equal(r.persona, 'windows');
    assert.equal(r.status, 'complete');
    assert.equal(r.forcedStop, false);
    assert.equal(r.argvMatches, true);
    assert.deepEqual(r.actualArgv.slice(1), r.args);
    const d = r.detectors.fingerprint;
    assert.equal(d.status, 'complete');
    assert.equal(d.signals.virtual_machine, false);
    assert.equal(d.signals.tampering, true);
    assert.equal(d.signals.anti_detect_browser, true);
    assert.equal(d.signals.bot, 'not_detected');
    const used = name => r.local.renderedFonts.rows.find(f => f.requested === name).fonts.map(f => f.familyName);
    assert.deepEqual(used('Arial'), [arm === 'system' ? 'Liberation Sans' : 'Arial']);
    assert.deepEqual(used('Tahoma'), [arm === 'system' ? 'Nimbus Mono PS' : 'Tahoma']);
    for (const missing of ['Segoe UI', 'Calibri', 'Cambria', 'Consolas']) assert.ok(!used(missing).includes(missing));
    if (arm === 'defaults') assert.deepEqual(used('Segoe UI'), ['Courier New']);
    counts[arm] = (counts[arm] ?? 0) + 1;
  }
}
for (const arm of Object.keys(fontCounts)) {
  assert.equal(counts[arm], 4);
  assert.equal(summary[arm].observations, 4);
  assert.equal(summary[arm].vmPositive, 0);
  assert.equal(summary[arm].tamperingPositive, 4);
  assert.equal(summary[arm].antiDetectPositive, 4);
}
console.log('Verified 12 matched observations + 4 supplemental generic-default checks, actual Arial/Tahoma use, remaining modern-font fallbacks, and unchanged positive tampering/anti-detect verdicts.');
