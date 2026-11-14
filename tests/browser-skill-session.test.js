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

test('execution progress, IDs and bounded outcomes survive lost replies without replay', async () => {
  let release;
  const execute = createExecutor({ wait: () => new Promise(resolve => { release = resolve; }) }, 'private-token', { timeoutMs: 5000 });
  const first = execute(`execution.reportProgress({completed: 2, label: 'private-token'}); await wait(); state.writes = 1;`);
  expect(execute.status().currentExecution).toMatchObject({ executionId: 1, progress: { completed: 2, label: '***' } });
  expect(execute.status().executionTimeoutMs).toBe(5000);
  release();
  expect((await first).executionId).toBe(1);
  expect(execute.status().lastExecution).toMatchObject({ executionId: 1, ok: true });
  const failed = await execute(`throw new Error('locator.click: Timeout 20000ms exceeded. private-token');`);
  expect(failed.executionId).toBe(2);
  expect(failed.hint).toContain('bringToFront');
  expect(execute.status().lastExecution.error).not.toContain('private-token');
  for (let i = 0; i < 12; i++) await execute('state.n = execution.remainingMs();');
  expect(execute.status().recentExecutions).toHaveLength(10);
  expect(execute.status().currentExecution).toBeNull();
  expect((await execute('console.log(state.writes)')).output).toBe('1\n');
});

test('progress is explicit, bounded JSON and does not expose implicit state', async () => {
  const execute = createExecutor({});
  expect((await execute(`execution.reportProgress('x'.repeat(3000))`)).ok).toBe(false);
  expect((await execute(`execution.reportProgress(undefined)`)).ok).toBe(false);
  await execute(`state.account = {secret: 'hidden'}; execution.reportProgress({completed: 3})`);
  expect(JSON.stringify(execute.status())).not.toContain('hidden');
});

test('progress redaction preserves numbers and handles escaped secrets in strings and keys', async () => {
  const numeric = createExecutor({}, '123');
  expect((await numeric('execution.reportProgress({total: 123, label: "123"})')).ok).toBe(true);
  expect(numeric.status().lastExecution.progress).toEqual({ total: 123, label: '***' });
  const token = 'sec"ret\\value';
  const escaped = createExecutor({token}, token);
  expect((await escaped('execution.reportProgress({[token]: [token, {label: token}]})')).ok).toBe(true);
  expect(escaped.status().lastExecution.progress).toEqual({'***': ['***', {label: '***'}]});
});

test('returned errors are bounded as well as retained outcomes', async () => {
  const execute = createExecutor({});
  const result = await execute('throw new Error("x".repeat(1000000))');
  expect(result.error).toHaveLength(2000);
  expect(result.errorTruncated).toBe(true);
  expect(execute.status().lastExecution.errorTruncated).toBe(true);
});

test('saved checkpoint functions bind automatic progress to each current execution', async () => {
  const executor = createExecutor({ checkpointBatch: async options => {
    options.onProgress({ completed: options.count, total: 20 });
    return { completed: options.count };
  } });
  expect((await executor('state.run = count => checkpointBatch({ count }); await state.run(1);')).ok).toBe(true);
  expect(executor.status().lastExecution.progress).toEqual({ completed: 1, total: 20 });
  expect((await executor('await state.run(2);')).ok).toBe(true);
  expect(executor.status().lastExecution.progress).toEqual({ completed: 2, total: 20 });
  expect(executor.status().recentExecutions[0].progress).toEqual({ completed: 1, total: 20 });
});
