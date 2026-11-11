import { describe, test, expect } from 'bun:test';
import { PNG } from 'pngjs';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, access, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EvaluationEngine } from './browser-evaluation/engine.mjs';
import { auditRenderedFonts, FONT_AUDIT_FAMILIES } from './browser-evaluation/fonts.mjs';
import { validateConfig, publicConfig, makePlan, launchArgs } from './browser-evaluation/config.mjs';
import { parseCli } from './browser-evaluation/run.mjs';
import { fingerprintSignals, fingerprintComplete, parseDetectorText, runDetectors } from './browser-evaluation/detectors.mjs';
import { summarizeSurface, contextChecks } from './browser-evaluation/measurements.mjs';
import { summarize, median, markdown, resultExitCode } from './browser-evaluation/report.mjs';
import { redactor, browserEnv, cpuDelta, withSignal, stopOwned, sleep } from './browser-evaluation/util.mjs';

const input = () => ({ binaries: [
  { id: 'baseline', executable: '/bin/baseline', expectedVersion: '152.0.7977.82.1' },
  { id: 'candidate', executable: '/bin/candidate', expectedVersion: '157.0.8100.1.1' },
], personas: ['macos'], modes: ['headed', 'headless'], seeds: [11, 22], rounds: 2 });
const record = overrides => ({ id: 'sample', plan: 'detectors', binaryId: 'candidate', persona: 'windows', mode: 'headed', variant: 'configured', status: 'complete', ...overrides });

describe('browser evaluation configuration and deterministic matrices', () => {
  test('exact binary versions are data, not hard-coded comparison logic', () => {
    const config = validateConfig(input());
    expect(config.binaries[1].expectedVersion).toBe('157.0.8100.1.1');
    expect(config.graphics.headed).toEqual([]);
    expect(config.graphics.headless).toEqual(['--use-gl=angle']);
    expect(config.fontconfigFiles.windows).toBeUndefined();
  });
  test('rejects typo fields, inline secrets, duplicate labels, invalid versions/seeds and arbitrary flags', () => {
    expect(() => validateConfig({ ...input(), licenseKey: 'secret' })).toThrow('Unknown config field');
    expect(() => validateConfig({ ...input(), binaries: [input().binaries[0], input().binaries[0]] })).toThrow('Duplicate');
    expect(() => validateConfig({ ...input(), binaries: [{ ...input().binaries[0], expectedVersion: 'latest' }] })).toThrow('exact');
    expect(() => validateConfig({ ...input(), seeds: [1, 1] })).toThrow('seeds');
    expect(() => validateConfig({ ...input(), graphics: { headed: ['--user-data-dir=/production'] } })).toThrow('graphics');
    expect(() => validateConfig({ ...input(), cooldownMs: 0 })).toThrow('cooldownMs');
  });
  test('resolves relative paths against config location and omits secret-file paths from public config', () => {
    const config = validateConfig({ ...input(), binaries: [{ ...input().binaries[0], executable: './chrome', licenseKeyFile: './per-binary.key' }], licenseKeyFile: './private.key' }, '/lab');
    expect(config.binaries[0].executable).toBe('/lab/chrome');
    expect(config.licenseKeyFile).toBe('/lab/private.key');
    const published = JSON.stringify(publicConfig(config));
    expect(published).not.toContain('private.key');
    expect(published).not.toContain('per-binary.key');
    expect(publicConfig(config).licenseConfigured).toBe(true);
    const reference = validateConfig({ ...input(), binaries: [{ ...input().binaries[0], kind: 'reference' }], licenseKeyFile: '/unused.key', fontconfigFiles: { native: '/native.conf' } });
    expect(publicConfig(reference).binaries[0].licenseConfigured).toBe(false);
    expect(reference.fontconfigFiles.native).toBe('/native.conf');
  });
  test('external sites require explicit consent; all without opt-in visibly skips them', () => {
    const config = validateConfig(input());
    expect(() => makePlan(config, 'detectors')).toThrow('--external');
    const all = makePlan(config, 'all');
    expect(all.cases.some(c => c.plan === 'detectors')).toBe(false);
    expect(all.skipped[0].plan).toBe('detectors');
    expect(makePlan(config, 'all', true).cases.some(c => c.plan === 'detectors')).toBe(true);
  });
  test('pairs seeds/modes and reverses binary order in the second round', () => {
    const plan = makePlan(validateConfig(input()), 'local').cases;
    expect(plan).toHaveLength(16);
    expect(new Set(plan.map(c => c.id)).size).toBe(16);
    expect(plan.slice(0, 2).map(c => c.binaryId)).toEqual(['baseline', 'candidate']);
    expect(plan.filter(c => c.round === 2).slice(0, 2).map(c => c.binaryId)).toEqual(['candidate', 'baseline']);
    expect(launchArgs(plan[0], '/owned/a').filter(a => !a.startsWith('--user-data-dir'))).toEqual(launchArgs(plan[1], '/owned/b').filter(a => !a.startsWith('--user-data-dir')));
  });
  test('reference builds have native identity and are not repeated for every fake persona', () => {
    const config = validateConfig({ ...input(), personas: ['macos', 'windows', 'linux'], binaries: [{ ...input().binaries[0], kind: 'reference' }] });
    const cases = makePlan(config, 'local').cases;
    expect(cases).toHaveLength(8);
    expect(cases.every(c => c.persona === 'native')).toBe(true);
    expect(launchArgs(cases[0], '/owned').some(a => a.startsWith('--fingerprint'))).toBe(false);
  });
  test('flag plan includes six distinct configurations and private ephemeral CDP ports', () => {
    const cases = makePlan(validateConfig(input()), 'flags').cases;
    expect(cases).toHaveLength(24);
    expect(new Set(cases.map(c => c.variant)).size).toBe(6);
    const args = launchArgs(cases[0], '/owned');
    expect(args).toContain('--remote-debugging-port=0');
    expect(args).not.toContain('--enable-automation');
    expect(args).not.toContain('--disable-gpu');
  });
  test('feature-specific flags and window geometry are explicit', () => {
    const config = validateConfig({ ...input(), personas: ['windows'] });
    const cases = makePlan(config, 'features').cases;
    const touch = cases.find(c => c.variant === 'touch-override');
    expect(launchArgs(touch, '/owned')).toContain('--fingerprint-max-touch-points=5');
    const max = launchArgs(cases.find(c => c.variant === 'maximized'), '/owned');
    expect(max).toContain('--start-maximized');
    expect(max.some(a => a.startsWith('--window-size='))).toBe(false);
    expect(launchArgs(cases.find(c => c.variant === 'offscreen-window'), '/owned')).toContain('--window-position=4000,3000');
  });
  test('CLI defaults to smoke, validates options and supports dry-run without launch', () => {
    expect(parseCli(['--config', 'input.json', '--dry-run']).dryRun).toBe(true);
    expect(parseCli(['--config', 'input.json']).plan).toBe('smoke');
    expect(parseCli(['--help']).help).toBe(true);
    expect(() => parseCli(['--config'])).toThrow('requires a value');
    expect(() => parseCli(['--unknown'])).toThrow('Unknown');
  });
});

describe('browser evaluation data integrity and missing-result handling', () => {
  test('exports decoded pixels without retaining raw images', () => {
    const pixels = [20, 40, 60, 255];
    const png = PNG.sync.write({ width: 1, height: 1, data: Buffer.from(pixels) });
    const result = summarizeSurface({ canvas: { pixel1: pixels, pixel2: pixels, png: [...png], textWidth: 10 } });
    expect(result.canvas.exportDiffBytes).toBe(0);
    expect(result.canvas.repeatDiffBytes).toBe(0);
    expect(result.canvas.pixelsHash).toBe(result.canvas.pngPixelsHash);
    expect(result.canvas.pixel1).toBeUndefined();
    expect(result.canvas.png).toBeUndefined();
    const altered = summarizeSurface({ canvas: { pixel1: pixels, pixel2: [21,40,60,255], png: [...png] } });
    expect(altered.canvas.repeatDiffBytes).toBe(1);
  });
  test('compares shared navigator fields without requiring Window-only properties in workers', () => {
    const a = { identity: { cpu: 4, maxTouchPoints: 0 }, canvas: { pixelsHash: 'a', pngPixelsHash: 'b' } };
    const b = { identity: { cpu: 4 }, canvas: { pixelsHash: 'a', pngPixelsHash: 'b' } };
    expect(contextChecks(a, b).sharedIdentityMatches).toBe(true);
    expect(contextChecks(a, { ...b, identity: { cpu: 8 } }).sharedIdentityMatches).toBe(false);
  });
  test('font audit records actual fallback without calling the requested family installed', async () => {
    let detached = false; const evaluations = [];
    const session = { async send(method) {
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (method === 'DOM.querySelector') return { nodeId: 2 };
      if (method === 'CSS.getPlatformFontsForNode') return { fonts: [{ familyName: 'Liberation Sans', glyphCount: 20, isCustomFont: false }] };
      return {};
    }, async detach() { detached = true; } };
    const result = await auditRenderedFonts({ newCDPSession: async () => session }, { evaluate: async (_fn, data) => { evaluations.push(data); } });
    expect(result.rows).toHaveLength(FONT_AUDIT_FAMILIES.length);
    expect(result.rows[0].requested).toBe('Arial');
    expect(result.rows[0].fonts[0].familyName).toBe('Liberation Sans');
    expect(result.note).toContain('may fall back');
    expect(evaluations.at(-1)).toBe('evaluation-font-audit');
    expect(detached).toBe(true);
  });
  test('font audit detaches its CDP session when inspection fails', async () => {
    let detached = false; let removed = false;
    const context = { newCDPSession: async () => ({ send: async () => { throw Error('inspection failed'); }, detach: async () => { detached = true; } }) };
    await expect(auditRenderedFonts(context, { evaluate: async (_fn, data) => { if (typeof data === 'string') removed = true; } })).rejects.toThrow('inspection failed');
    expect(detached).toBe(true); expect(removed).toBe(true);
  });
  test('Fingerprint keeps an allowlist and requires complete signals', () => {
    const signals = fingerprintSignals({ bot: 'not_detected', tampering: false, virtual_machine: true, tampering_details: { anti_detect_browser: false, secret: 'no' }, ip_address: '1.2.3.4', visitor_id: 'private-id', sealed_result: 'token', suspect_score: 11 });
    expect(fingerprintComplete(signals)).toBe(true);
    expect(signals.anti_detect_browser).toBe(false);
    expect(JSON.stringify(signals)).not.toContain('private-id');
    expect(JSON.stringify(signals)).not.toContain('1.2.3.4');
    expect(fingerprintComplete(fingerprintSignals({ suspect_score: 0 }))).toBe(false);
  });
  test('IPHey placeholder is missing, not score zero or a pass', () => {
    expect(parseDetectorText('iphey', 'Temporary value\n0\nMX SCORE').score).toBeNull();
    expect(parseDetectorText('iphey', 'Your Digital Identity Looks\nTrustworthy\n100\nMX SCORE')).toMatchObject({ complete: true, score: 100, verdict: 'Trustworthy' });
    expect(parseDetectorText('iphey', 'Your Digital Identity Looks Unreliable\n0\nMX SCORE')).toMatchObject({ complete: true, score: 0 });
  });
  test('does not count an empty or changed detector page as passed', () => {
    expect(parseDetectorText('sannysoft', 'Just a moment').complete).toBe(false);
    expect(parseDetectorText('browserscan', 'Test Results: Loading').complete).toBe(false);
    expect(parseDetectorText('browserscan', 'Test Results: Normal\nChrome DevTools Protocol Detection').complete).toBe(true);
  });
  test('rate-limited sites are skipped without opening a new page', async () => {
    const browser = { contexts() { throw Error('must not connect'); } };
    const result = await runDetectors(browser, ['fingerprint'], new AbortController().signal, new Set(['fingerprint']), x => x);
    expect(result.fingerprint.status).toBe('skipped');
  });
  test('a site-origin SDK 429 stops visits even without an event API response', async () => {
    const listeners = new Map(); let opened = 0; let closed = 0;
    const page = {
      setDefaultTimeout() {}, on(name, fn) { listeners.set(name, fn); }, off(name) { listeners.delete(name); },
      async goto() { listeners.get('response')({ url: () => 'https://demo.fingerprint.com/sdk', status: () => 429 }); return { status: () => 200 }; },
      async bringToFront() {}, async close() { closed++; },
    };
    const browser = { contexts: () => [{ newPage: async () => { opened++; return page; } }] };
    const limited = new Set(); const partial = {};
    await runDetectors(browser, ['fingerprint'], new AbortController().signal, limited, x => x, partial);
    expect(partial.fingerprint.status).toBe('rate_limited');
    expect(limited.has('fingerprint')).toBe(true);
    await runDetectors(browser, ['fingerprint'], new AbortController().signal, limited, x => x);
    expect(opened).toBe(1); expect(closed).toBe(1);
  });
  test('missing and rate-limited signals never enter valid denominators', () => {
    const rows = [record({ detectors: { fingerprint: { status: 'rate_limited', signals: {} } } }), record({ id: 'complete', detectors: { fingerprint: { status: 'complete', signals: { virtual_machine: true, tampering: false } } } })];
    const summary = summarize(rows, 2);
    expect(summary.groups[0].fingerprint).toMatchObject({ valid: 1, vmPositive: 1, tamperingPositive: 0 });
    expect(summary.groups[0].cpu.medianSeconds).toBeNull();
    expect(resultExitCode(summary)).toBe(2);
    expect(markdown(summary, { runId: 'test', config: { environmentLabel: 'test' } })).toContain('not a universal stealth score');
  });
  test('reports render failures, routing counts and each detector separately', () => {
    const r = record({ local: { main: { gl: { webgl: { pixel: [51, 102, 153, 255], error: 0 }, webgl2: null } }, interception: { requested: 2, good: 1 } }, detectors: {
      sannysoft: { status: 'complete', failedOrWarn: ['WARN'] },
      browserscan: { status: 'complete', verdict: 'Normal' },
      iphey: { status: 'complete', verdict: 'Trustworthy', score: 100 },
      fingerprint: { status: 'complete', signals: { bot: 'not_detected', virtual_machine: false, tampering: true, anti_detect_browser: true } },
    } });
    const summary = summarize([r]); const g = summary.groups[0];
    expect(g.webglDraw).toEqual({ valid: 2, successful: 1 });
    expect(g.interception).toEqual({ requested: 2, successful: 1 });
    expect(g.sannysoft).toEqual({ valid: 1, failures: 1 });
    expect(g.browserscan).toEqual({ valid: 1, normal: 1 });
    expect(g.fingerprint.botNotDetected).toBe(1);
    expect(g.iphey.verdicts).toEqual(['Trustworthy']);
    const report = markdown(summary, { config: {}, environment: {}, skipped: [], status: 'finished' });
    expect(report).toContain('Local rendering and workload checks');
    expect(report).toContain('FP anti-detect positive');
    expect(report).toContain('Trustworthy');
  });
  test('partial runs, forced cleanup and interruptions are not successful execution', () => {
    expect(resultExitCode(summarize([], 1))).toBe(1);
    expect(resultExitCode(summarize([record({ forcedStop: true })], 1))).toBe(1);
    expect(resultExitCode(summarize([], 1), true)).toBe(130);
    expect(resultExitCode(summarize([record({ detectors: { fingerprint: { status: 'complete', signals: { virtual_machine: true, tampering: true } } } })], 1))).toBe(0); // completed observations, NOT detector success
  });
  test('CPU absence remains null and medians ignore absent values', () => {
    expect(cpuDelta(null, 1)).toBeNull();
    expect(cpuDelta(1, null)).toBeNull();
    expect(cpuDelta(10, 30)).toBe(20);
    expect(median([null, undefined])).toBeNull();
    expect(median([8, null, 2, 4, 6])).toBe(5);
  });
  test('diagnostics redact keys and signed URLs; child env never inherits unrelated secrets', () => {
    const redact = redactor(['license-private']);
    expect(redact('license-private https://example.com/?token=private')).toBe('[REDACTED] [URL]');
    const env = browserEnv('/owned', { key: 'allowed-key', fontconfig: '/fonts.conf' });
    expect(env.CLOAKBROWSER_LICENSE_KEY).toBe('allowed-key');
    expect(env.FONTCONFIG_FILE).toBe('/fonts.conf');
    expect(Object.keys(env).some(k => /TOKEN|PASSWORD/.test(k))).toBe(false);
    expect(browserEnv('/owned').FONTCONFIG_FILE).toBeUndefined();
  });
  test('already-aborted deadlines also consume the underlying rejection', async () => {
    const controller = new AbortController(); controller.abort(Error('cancelled'));
    await expect(withSignal(Promise.reject(Error('late rejection')), controller.signal)).rejects.toThrow('cancelled');
  });
  test('case deadlines can reject stalled work', async () => {
    const controller = new AbortController();
    const pending = withSignal(new Promise(() => {}), controller.signal);
    controller.abort(Error('deadline'));
    await expect(pending).rejects.toThrow('deadline');
  });
});

const linuxTest = process.platform === 'linux' ? test : test.skip;
describe('evaluation owned-process cleanup (no real browser or license)', () => {
  linuxTest('CLI dry-run never reads keys, accesses executables, or creates artifacts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cloakhub-evaluation-cli-'));
    try {
      const file = join(dir, 'config.json'); const output = join(dir, 'output');
      await writeFile(file, JSON.stringify({ ...input(), licenseKeyFile: join(dir, 'missing-secret.key') }));
      const { stdout } = await promisify(execFile)('node', [fileURLToPath(new URL('./browser-evaluation/run.mjs', import.meta.url)), '--config', file, '--output', output, '--dry-run']);
      expect(JSON.parse(stdout).status).toBe('planned-only');
      expect(stdout).not.toContain('missing-secret.key');
      await expect(access(output)).rejects.toThrow();
      await writeFile(file, '{"licenseKey":"must-not-echo-secret", invalid json');
      try {
        await promisify(execFile)('node', [fileURLToPath(new URL('./browser-evaluation/run.mjs', import.meta.url)), '--config', file, '--dry-run']);
        throw Error('Expected malformed config to fail');
      } catch (error) {
        expect(error.stderr).toContain('contents withheld');
        expect(error.stderr).not.toContain('must-not-echo-secret');
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  linuxTest('CLI preflight failure still writes a partial report and clears private state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cloakhub-evaluation-cli-'));
    try {
      const file = join(dir, 'config.json'); const output = join(dir, 'output');
      await writeFile(file, JSON.stringify({ ...input(), binaries: [{ ...input().binaries[0], executable: '/bin/false' }] }));
      await expect(promisify(execFile)('node', [fileURLToPath(new URL('./browser-evaluation/run.mjs', import.meta.url)), '--config', file, '--output', output])).rejects.toThrow();
      const run = join(output, (await readdir(output))[0]);
      const manifest = JSON.parse(await readFile(join(run, 'manifest.json'), 'utf8'));
      const summary = JSON.parse(await readFile(join(run, 'summary.json'), 'utf8'));
      expect(manifest.status).toBe('error');
      expect(manifest.suiteSourceSHA256).toMatch(/^[a-f0-9]{64}$/);
      expect(summary.recorded).toBe(0);
      expect(summary.infrastructureErrors).toHaveLength(1);
      await expect(access(join(run, '.private'))).rejects.toThrow();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  linuxTest('terminates its detached process group', async () => {
    const child = spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore' });
    try {
      await sleep(20);
      expect(await stopOwned(child, 100)).toBe(true);
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    } finally { await stopOwned(child, 100); }
  });
  linuxTest('cleans descendants even after their main process exited', async () => {
    const child = spawn('/bin/sh', ['-c', 'sleep 30 & exit 0'], { detached: true, stdio: 'ignore' });
    try {
      await new Promise(resolve => child.once('exit', resolve));
      expect(child.exitCode).toBe(0);
      expect(await stopOwned(child, 100)).toBe(true);
    } finally { await stopOwned(child, 100); }
  });
  linuxTest('failed browser startup is an infrastructure result and removes only its private profile', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cloakhub-evaluation-test-'));
    const config = validateConfig({ ...input(), binaries: [{ ...input().binaries[0], executable: '/bin/false' }] });
    const engine = new EvaluationEngine(config, dir, new AbortController().signal);
    const sample = makePlan(config, 'smoke').cases[0];
    try {
      await mkdir(engine.privateDir, { recursive: true });
      const result = await engine.run(sample);
      expect(result.status).toBe('error');
      expect(result.error).toContain('exited');
      expect(result.detectors).toBeUndefined();
      await expect(access(join(engine.privateDir, sample.id))).rejects.toThrow();
    } finally { await engine.close(); await rm(dir, { recursive: true, force: true }); }
  });
});
