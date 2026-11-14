import { test, expect } from 'bun:test';
import { EventEmitter } from 'node:events';
import { captureResponses, expectChange } from '../skills/cloakhub-browser/scripts/helpers.mjs';

function response(json, options = {}) {
  return {
    request: () => ({ resourceType: () => 'fetch', method: () => 'GET', postData: () => null }),
    url: () => 'https://fixture.test/api/items', status: () => 200,
    headers: () => ({ 'content-type': 'application/json', ...options.headers }),
    body: options.body ?? (async () => Buffer.from(JSON.stringify(json)))
  };
}
const emit = (page, value) => page.emit('response', value);

test('projects complete large JSON without going through truncated previews', async () => {
  const page = new EventEmitter();
  const items = Array.from({ length: 1000 }, (_, id) => ({ id, amount: id + 1, unused: 'x'.repeat(20) }));
  const result = await captureResponses(page, '/api/items', async () => emit(page, response({ items })), {
    quiet: 0, report: true, preview: 10,
    project: ({ json }) => ({ count: json.items.length, total: json.items.reduce((n, item) => n + item.amount, 0) })
  });
  expect(result.complete).toBe(true);
  expect(result.responses[0].data).toEqual({ count: 1000, total: 500500 });
  expect(result.responses[0].preview).toBeUndefined();
  expect(page.listenerCount('response')).toBe(0);
});

test('bounds trigger, body and projection waits and removes listeners', async () => {
  for (const kind of ['trigger', 'body', 'project']) {
    const page = new EventEmitter();
    const never = () => new Promise(() => {});
    const started = Date.now();
    const result = await captureResponses(page, null, async () => {
      emit(page, response({}, kind === 'body' ? { body: never } : {}));
      if (kind === 'trigger') await never();
    }, { timeout: 40, quiet: 0, report: true, ...(kind === 'project' ? { project: never } : {}) });
    expect(result.complete).toBe(false);
    expect(result.reasons.join(',')).toContain('deadline');
    expect(Date.now() - started).toBeLessThan(500);
    expect(page.listenerCount('response')).toBe(0);
  }
});

test('incomplete captures cannot silently look like complete arrays', async () => {
  const page = new EventEmitter();
  await expect(captureResponses(page, null, async () => {}, { timeout: 20, quiet: 0 })).rejects.toThrow('Incomplete');
  const limits = await captureResponses(page, null, async () => {
    emit(page, response({ value: 'too long' }));
    emit(page, response({ value: 'another' }));
  }, { quiet: 0, report: true, maxResponses: 1, maxBodyBytes: 4 });
  expect(limits.complete).toBe(false);
  expect(limits.reasons).toContain('response-limit');
  expect(limits.reasons).toContain('body-limit');
  const broken = await captureResponses(page, null, async () => emit(page, response({})), {
    quiet: 0, report: true, project: () => { throw new Error('private response content'); }
  });
  expect(broken.reasons).toContain('projection-error');
  expect(JSON.stringify(broken)).not.toContain('private response content');
});

test('bounds cumulative bodies and reports unavailable bodies', async () => {
  const page = new EventEmitter();
  const result = await captureResponses(page, null, async () => {
    emit(page, response({ x: '123456789' }));
    emit(page, response({ x: '123456789' }));
    emit(page, response({}, { body: async () => { throw new Error('evicted'); } }));
  }, { quiet: 0, report: true, maxTotalBytes: 20 });
  expect(result.complete).toBe(false);
  expect(result.reasons).toContain('total-byte-limit');
  expect(result.reasons).toContain('body-unavailable');
});

test('trigger errors propagate and do not leak listeners', async () => {
  const page = new EventEmitter();
  await expect(captureResponses(page, null, async () => {
    emit(page, response({}, { body: () => new Promise(() => {}) }));
    throw new Error('action failed');
  })).rejects.toThrow('action failed');
  expect(page.listenerCount('response')).toBe(0);
});

function fakePage() {
  const empty = { count: async () => 0 };
  return { empty, url: () => 'https://fixture.test', locator: () => empty };
}

test('explicit success without UI diff does not suggest retry; a diff is not business success', async () => {
  const page = fakePage();
  const success = await expectChange(page, page.empty, async () => {}, { timeout: 0, until: async () => true });
  expect(success).toMatchObject({ changed: false, met: true });
  expect(success.hint).toBeUndefined();
  let snapshot = 'button Save';
  const target = { count: async () => 1, first: () => ({ ariaSnapshot: async () => snapshot }) };
  const failure = await expectChange(page, target, async () => { snapshot = 'text Validation error'; }, { timeout: 0, until: async () => false });
  expect(failure).toMatchObject({ changed: true, met: false });
  expect(failure.hint).toContain('expected state was not reached');
});

test('freezes the response set at quiet boundary while earlier bodies finish', async () => {
  const page = new EventEmitter();
  let later;
  const result = await captureResponses(page, /api/g, async () => {
    emit(page, response({ a: 1 }, { body: async () => {
      await new Promise(resolve => setTimeout(resolve, 60));
      return Buffer.from('{"a":1}');
    } }));
    later = setTimeout(() => emit(page, response({ late: true })), 20);
  }, { quiet: 0, report: true, project: ({ json }) => json });
  clearTimeout(later);
  expect(result.complete).toBe(true);
  expect(result.responses).toHaveLength(1);
  expect(result.responses[0].data).toEqual({ a: 1 });
});

test('stateful regex flags do not skip matching responses', async () => {
  const page = new EventEmitter();
  const result = await captureResponses(page, /api/g, async () => {
    emit(page, response({ a: 1 })); emit(page, response({ a: 2 }));
  }, { quiet: 0, project: ({ json }) => json });
  expect(result.map(r => r.data.a)).toEqual([1, 2]);
});

test('every thrown trigger value propagates, including falsy values and deadline-like errors', async () => {
  for (const value of [false, 0, '', null, undefined, new Error('deadline')]) {
    const page = new EventEmitter();
    let caught = false;
    try {
      await captureResponses(page, null, async () => { emit(page, response({})); throw value; }, {quiet:0, min:0, report:true});
    } catch (error) { caught = true; expect(error).toBe(value); }
    expect(caught).toBe(true);
    expect(page.listenerCount('response')).toBe(0);
  }
});

test('async response predicates are rejected instead of capturing unrelated responses', async () => {
  for (const predicate of [async () => false, async () => { throw new Error('bad predicate'); }]) {
    const page = new EventEmitter();
    const result = await captureResponses(page, predicate, async () => emit(page, response({})), {quiet:0, report:true});
    expect(result.complete).toBe(false);
    expect(result.reasons).toContain('filter-error');
    expect(result.responses).toHaveLength(0);
  }
});

test('invalid capture options fail before executing a side effect', async () => {
  let called = false;
  await expect(captureResponses(new EventEmitter(), null, async () => {called = true;}, {types:123})).rejects.toThrow('types');
  expect(called).toBe(false);
});

test('postconditions accept sync results and bound an unresolved check after one action', async () => {
  const page = fakePage();
  expect((await expectChange(page, page.empty, async () => {}, {timeout:0, until:() => true})).met).toBe(true);
  let actions = 0;
  const started = Date.now();
  const result = await expectChange(page, page.empty, async () => { actions++; }, { timeout:30, until:() => new Promise(() => {}) });
  expect(Date.now() - started).toBeLessThan(500);
  expect(actions).toBe(1);
  expect(result).toMatchObject({met:false, verificationError:'observation-timeout'});
  expect((await expectChange(page, page.empty, async () => {}, {until:() => {throw false;}})).verificationError).toBe('postcondition-error');
  await expect(expectChange(page, page.empty, async () => {actions++;}, {timeout:NaN})).rejects.toThrow('timeout');
  expect(actions).toBe(1);
});
