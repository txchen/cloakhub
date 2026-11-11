import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const metadata = read('./metadata.json');
const compact = read('./compact-events.json');
const expected = [43, 19, 25];
const keys = (object, names) => assert.deepEqual(Object.keys(object).sort(), [...names].sort());
assert.deepEqual(metadata.paired_seeds, [810, 811, 812]);
assert.equal(compact.schema_version, 1);
assert.equal(compact.runs.length, 13);
assert.equal(new Set(compact.runs.map(r => r.source)).size, 13);
for (const r of compact.runs) {
  keys(r, ['source', 'raw_sha256', 'raw_bytes', 'assistant_calls', 'tool_completions', 'non_json_lines', 'has_result']);
  assert.match(r.source, /^(?:(?:foreground|infra-failure)\/)?(?:cloakhub|browser-use)-[0-2]\.jsonl$/);
  assert.match(r.raw_sha256, /^[a-f0-9]{64}$/);
  assert.ok(r.raw_bytes > 0);
  for (const c of r.assistant_calls) {
    keys(c, ['usage', 'tools']);
    keys(c.usage, ['input', 'output', 'cacheRead', 'reasoning', 'estimated_cost_usd']);
    for (const v of Object.values(c.usage)) assert.ok(typeof v === 'number' && Number.isFinite(v) && v >= 0);
    for (const t of c.tools) assert.ok(['read', 'bash', 'other'].includes(t));
  }
  for (const t of r.tool_completions) {
    keys(t, ['tool', 'is_error']);
    assert.ok(['read', 'bash', 'other'].includes(t.tool));
    assert.ok(t.is_error === null || typeof t.is_error === 'boolean');
  }
}
const all = [];
for (const [prefix, count] of [['', 6], ['foreground/', 3], ['infra-failure/', 3]]) {
  const rows = read(`./${prefix}results.json`);
  assert.equal(rows.length, count);
  for (const r of rows) {
    assert.equal(r.expected, expected[r.repeat]);
    const body = { reference: `REVIEW-${r.repeat}`, total: r.expected, confirmed: true };
    assert.equal(r.passed, isDeepStrictEqual(r.submissions, [body]));
    const trace = compact.runs.find(t => t.source === `${prefix}${r.arm}-${r.repeat}.jsonl`);
    assert.ok(trace?.has_result);
    assert.equal(r.model_calls, trace.assistant_calls.length);
    assert.equal(r.tool_calls, trace.assistant_calls.reduce((n, c) => n + c.tools.length, 0));
    for (const key of Object.keys(r.usage)) {
      const sum = trace.assistant_calls.reduce((n, c) => n + c.usage[key], 0);
      assert.ok(Math.abs(sum - r.usage[key]) < 1e-10, `Usage mismatch: ${trace.source} ${key}`);
    }
    all.push({ ...r, condition: prefix });
  }
}
assert.equal(compact.runs.filter(r => !r.has_result).length, 1);
assert.equal(compact.runs.find(r => !r.has_result).source, 'infra-failure/cloakhub-1.jsonl');
const cases = [
  { condition: '', arm: 'cloakhub', pass: 3, seconds: 42.56, median: 42.15, calls: 8, cost: 0.002353 },
  { condition: '', arm: 'browser-use', pass: 0, seconds: 69.16, median: 72.55, calls: 14.33, cost: 0.003721 },
  { condition: 'foreground/', arm: 'browser-use', pass: 2, seconds: 58.60, median: 54.30, calls: 11.33, cost: 0.002457 },
];
const mean = values => values.reduce((a, b) => a + b, 0) / values.length;
for (const c of cases) {
  const rows = all.filter(r => r.condition === c.condition && r.arm === c.arm);
  assert.equal(rows.length, 3);
  assert.equal(rows.filter(r => r.passed).length, c.pass);
  assert.ok(Math.abs(mean(rows.map(r => r.seconds)) - c.seconds) < 0.005);
  assert.equal(rows.map(r => r.seconds).sort((a, b) => a - b)[1], c.median);
  assert.ok(Math.abs(mean(rows.map(r => r.model_calls)) - c.calls) < 0.005);
  assert.ok(Math.abs(mean(rows.map(r => r.usage.estimated_cost_usd)) - c.cost) < 0.0000005);
}
assert.ok(all.filter(r => r.condition === 'infra-failure/').every(r => !r.passed));
console.log('Verified 6 default + 3 foreground diagnostic results, 3 excluded infrastructure results, aggregate figures and compact-event usage/counts. One further infrastructure log remains unscored. No live agent/browser was invoked.');
