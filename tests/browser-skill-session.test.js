import { test, expect } from 'bun:test';
import { createExecutor } from '../skills/cloakhub-browser/scripts/session.mjs';
test('session preserves explicit state, bounds output, and redacts credentials', async () => {
  const execute = createExecutor({}, 'secret-value');
  expect((await execute('state.n = 40; state.add = n => n + 2;')).ok).toBe(true);
  expect((await execute('console.log(state.add(state.n))')).output).toBe('42\n');
  expect((await execute('throw new Error("secret-value")')).error).not.toContain('secret-value');
  const large = await execute('console.log("x".repeat(100000))');
  expect(large.truncated).toBe(true);
  expect(large.output.length).toBe(65536);
  expect((await execute('console.log(state.n)')).output).toBe('40\n');
});
test('concurrent execution is rejected without replay', async () => {
  let release;
  const execute = createExecutor({ wait: () => new Promise(resolve => { release = resolve; }) });
  const first = execute('await wait(); state.done = true;');
  expect((await execute('state.done = false')).ok).toBe(false);
  release(); await first;
  expect((await execute('console.log(state.done)')).output).toBe('true\n');
});

test('status describes reusable state without evaluating getters or leaking values', async () => {
  const execute = createExecutor({}, 'known-secret');
  await execute(`
    state.page = { password: 'private-value' };
    state.rows = [1, 2]; state.sum = x => x + 1;
    state['known-secret'] = 'private-value';
    Object.defineProperty(state, 'lazy', { get() { throw new Error('must not execute'); } });
  `);
  const status = execute.status();
  expect(status.completedExecutions).toBe(1);
  expect(status.lastExecution.ok).toBe(true);
  expect(status.state).toContainEqual({ name: 'lazy', type: 'accessor' });
  expect(status.state).toContainEqual({ name: 'sum', type: 'function' });
  expect(JSON.stringify(status)).not.toContain('private-value');
  expect(JSON.stringify(status)).not.toContain('known-secret');
  await execute('for(let i=0;i<60;i++) state["row"+i] = i;');
  expect(execute.status().state).toHaveLength(50);
  expect(execute.status().stateTruncated).toBe(true);
});

test('locals do not survive, errors retain partial state, separate sessions isolate state', async () => {
  const first = createExecutor({}); const second = createExecutor({});
  await first('const temporary = 1; state.rows = [2]; state.add = x => state.rows.push(x);');
  const failed = await first('state.add(3); console.log(temporary);');
  expect(failed.ok).toBe(false);
  expect(failed.hint).toContain('state');
  expect(first.status().lastExecution.ok).toBe(false);
  expect((await first('console.log(JSON.stringify(state.rows));')).output).toBe('[2,3]\n');
  expect((await second('console.log(state.rows);')).output).toBe('undefined\n');
  expect(first.status().completedExecutions).toBe(3);
});
