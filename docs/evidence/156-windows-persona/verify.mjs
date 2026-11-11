import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
for (const [name, count] of [['system-fonts', 12], ['mac-font-control', 2]]) {
  const rows = read(`./${name}/results.json`);
  const manifest = read(`./${name}/manifest.json`);
  assert.equal(rows.length, count);
  assert.equal(manifest.status, 'finished');
  assert.equal(manifest.environment.binaries[0].version, '156.0.8078.47.1');
  assert.equal(manifest.environment.binaries[0].executableSHA256, '37c2b771b87cdbf171c2c8021fc7f7900667e2363ccfc8e5d7904ef7e9dbc74a');
  for (const r of rows) {
    assert.equal(r.status, 'complete');
    assert.equal(r.forcedStop, false);
    assert.equal(r.argvMatches, true);
    assert.equal(r.persona, 'windows');
    assert.deepEqual(r.actualArgv.slice(1), r.args);
    const f = r.detectors.fingerprint;
    assert.equal(f.status, 'complete');
    assert.equal(f.signals.bot, 'not_detected');
    assert.equal(f.signals.virtual_machine, false);
    assert.equal(f.signals.tampering, true);
    assert.equal(f.signals.anti_detect_browser, true);
    assert.ok(r.local.main.gl.webgl && r.local.main.gl.webgl2);
  }
}
assert.equal(read('./system-fonts/provenance.json').evaluationImageID, read('./mac-font-control/provenance.json').evaluationImageID);
assert.equal(read('./system-fonts/manifest.json').environment.fonts.windows.file, null);
assert.equal(read('./mac-font-control/manifest.json').environment.fonts.windows.file, '/app/macos-fonts.conf');
const mac = read('./macos-suite-smoke/results.json');
assert.equal(mac.length, 1);
assert.equal(mac[0].persona, 'macos');
assert.equal(mac[0].status, 'complete');
for (const d of Object.values(mac[0].detectors)) assert.equal(d.status, 'complete');
for (const signal of ['virtual_machine', 'tampering', 'anti_detect_browser']) assert.equal(mac[0].detectors.fingerprint.signals[signal], false);
console.log('Verified 12 + 2 Windows observations (VM false; tampering/anti-detect true), and one separate macOS smoke (all three false).');
