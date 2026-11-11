import { resolve, isAbsolute } from 'node:path';

export const SCHEMA_VERSION = 1;
export const GRAPHICS_FLAGS = ['--disable-gpu', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
export const DETECTORS = ['fingerprint', 'sannysoft', 'browserscan', 'iphey'];
export const PLANS = ['smoke', 'local', 'flags', 'features', 'detectors', 'all'];
const PERSONAS = ['macos', 'windows', 'linux'];
function object(value, name, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw Error(`Unknown ${name} field: ${key}`);
}
function integer(value, fallback, name, min, max) {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n < min || n > max) throw Error(`${name} must be an integer in ${min}..${max}`);
  return n;
}
function choices(value, fallback, name, allowed) {
  const list = value ?? fallback;
  if (!Array.isArray(list) || !list.length || new Set(list).size !== list.length || list.some(x => !allowed.includes(x))) throw Error(`Invalid ${name}`);
  return [...list];
}
function path(value, name, base, required = false) {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/.test(value)) throw Error(`Invalid ${name}`);
  return isAbsolute(value) ? value : resolve(base, value);
}
export function validateConfig(input, base = process.cwd()) {
  object(input, 'config', ['binaries', 'licenseKeyFile', 'personas', 'modes', 'seeds', 'rounds', 'graphics', 'fontconfigFiles', 'fontNotes', 'detectors', 'cooldownMs', 'caseTimeoutMs', 'performanceSampleMs', 'routeRequests', 'xvnc', 'display', 'environmentLabel']);
  if (!Array.isArray(input.binaries) || !input.binaries.length || input.binaries.length > 5) throw Error('binaries must contain 1..5 entries');
  const binaries = input.binaries.map(b => {
    object(b, 'binary', ['id', 'executable', 'expectedVersion', 'kind', 'licenseKeyFile']);
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(b.id ?? '')) throw Error('Invalid binary id');
    if (!/^\d{3}\.\d+\.\d+\.\d+(?:\.\d+)?$/.test(b.expectedVersion ?? '')) throw Error('Each binary needs an exact expectedVersion');
    if (b.kind !== undefined && !['cloakbrowser', 'reference'].includes(b.kind)) throw Error('Invalid binary kind');
    return { id: b.id, executable: path(b.executable, 'executable', base, true), expectedVersion: b.expectedVersion, kind: b.kind ?? 'cloakbrowser', licenseKeyFile: path(b.licenseKeyFile, 'licenseKeyFile', base) };
  });
  if (new Set(binaries.map(b => b.id)).size !== binaries.length) throw Error('Duplicate binary id');
  const seeds = input.seeds ?? [20260909, 20260910, 20260911];
  if (!Array.isArray(seeds) || !seeds.length || seeds.length > 20 || new Set(seeds).size !== seeds.length || seeds.some(s => !Number.isSafeInteger(s) || s < 1 || s > 2147483647)) throw Error('Invalid seeds');
  const graphics = input.graphics ?? {};
  object(graphics, 'graphics', ['headed', 'headless']);
  for (const flags of Object.values(graphics)) if (!Array.isArray(flags) || new Set(flags).size !== flags.length || flags.some(f => !GRAPHICS_FLAGS.includes(f))) throw Error('graphics accepts only documented graphics flags, not arbitrary launch overrides');
  const fontconfigFiles = input.fontconfigFiles ?? {};
  object(fontconfigFiles, 'fontconfigFiles', [...PERSONAS, 'native']);
  const fontNotes = input.fontNotes ?? {};
  object(fontNotes, 'fontNotes', [...PERSONAS, 'native']);
  for (const note of Object.values(fontNotes)) if (typeof note !== 'string' || note.length > 500) throw Error('Invalid font note');
  if (input.display !== undefined && !/^:\d+(?:\.\d+)?$/.test(input.display)) throw Error('display must be an explicit X display such as :99');
  if (input.environmentLabel !== undefined && (typeof input.environmentLabel !== 'string' || input.environmentLabel.length > 500)) throw Error('Invalid environmentLabel');
  return {
    binaries, licenseKeyFile: path(input.licenseKeyFile, 'licenseKeyFile', base),
    personas: choices(input.personas, PERSONAS, 'personas', PERSONAS),
    modes: choices(input.modes, ['headed', 'headless'], 'modes', ['headed', 'headless']),
    seeds: [...seeds], rounds: integer(input.rounds, 2, 'rounds', 1, 5),
    graphics: { headed: graphics.headed ?? [], headless: graphics.headless ?? ['--use-gl=angle'] },
    fontconfigFiles: Object.fromEntries(Object.entries(fontconfigFiles).map(([k, v]) => [k, path(v, 'fontconfig', base, true)])), fontNotes,
    detectors: choices(input.detectors, DETECTORS, 'detectors', DETECTORS),
    cooldownMs: integer(input.cooldownMs, 45000, 'cooldownMs', 10000, 300000),
    caseTimeoutMs: integer(input.caseTimeoutMs, 300000, 'caseTimeoutMs', 10000, 900000),
    performanceSampleMs: integer(input.performanceSampleMs, 5000, 'performanceSampleMs', 250, 60000),
    routeRequests: integer(input.routeRequests, 200, 'routeRequests', 1, 10000),
    xvnc: path(input.xvnc ?? '/usr/bin/Xvnc', 'xvnc', base, true), display: input.display,
    environmentLabel: input.environmentLabel ?? 'Unspecified; record host/image and font provenance before interpreting comparisons',
  };
}
export function publicConfig(config) {
  const { licenseKeyFile, ...rest } = config;
  return { ...rest, licenseConfigured: Boolean(licenseKeyFile), binaries: config.binaries.map(({ licenseKeyFile: file, ...b }) => ({ ...b, licenseConfigured: b.kind !== 'reference' && Boolean(file || licenseKeyFile) })) };
}

export function makePlan(config, selected, external = false) {
  if (!PLANS.includes(selected)) throw Error(`Unknown plan: ${selected}`);
  if (selected === 'detectors' && !external) throw Error('Detector visits require --external');
  const plans = selected === 'all' ? ['local', 'flags', 'features', ...(external ? ['detectors'] : [])] : [selected];
  const cases = [];
  const add = (binary, persona, mode, seed, round, plan, variant, graphics, extra = []) => {
    const effectivePersona = binary.kind === 'reference' ? 'native' : persona;
    const id = `${plan}-${binary.id}-${effectivePersona}-${mode}-${seed}-r${round}-${variant}`;
    if (!cases.some(c => c.id === id)) cases.push({ id, binaryId: binary.id, persona: effectivePersona, mode, seed, round, plan, variant, graphics, extra });
  };
  for (const plan of plans) {
    const rounds = ['local', 'detectors'].includes(plan) ? config.rounds : 1;
    const seeds = ['local', 'detectors'].includes(plan) ? config.seeds : config.seeds.slice(0, 1);
    const personas = plan === 'smoke' ? config.personas.slice(0, 1) : config.personas;
    for (let round = 1; round <= rounds; round++) for (const seed of seeds) for (const persona of personas) for (const mode of config.modes) {
      const binaries = round % 2 ? config.binaries : [...config.binaries].reverse();
      const variants = plan === 'flags'
        ? [['clean', [], []], ['legacy-combination', GRAPHICS_FLAGS.slice(0, 4), []], ...GRAPHICS_FLAGS.slice(0, 4).map((f, i) => [`single-${i}`, [f], []])]
        : plan === 'features'
          ? [['popup-default', config.graphics[mode], []], ['popup-disabled', config.graphics[mode], ['--disable-popup-blocking']], ['maximized', config.graphics[mode], ['--start-maximized']], ['offscreen-window', config.graphics[mode], []], ...(persona === 'windows' ? [['gpu-short-vendor', config.graphics[mode], ['--fingerprint-gpu-vendor=intel']], ['touch-override', config.graphics[mode], ['--fingerprint-max-touch-points=5']]] : [])]
          : [['configured', config.graphics[mode], []]];
      for (const [variant, graphics, extra] of variants) for (const binary of binaries) {
        if (binary.kind === 'reference' && ['gpu-short-vendor', 'touch-override'].includes(variant)) continue;
        add(binary, persona, mode, seed, round, plan, variant, [...graphics], [...extra]);
      }
    }
  }
  return { cases, skipped: selected === 'all' && !external ? [{ plan: 'detectors', reason: 'External sites are opt-in; add --external' }] : [] };
}
export function launchArgs(sample, profile) {
  return ['--no-sandbox', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    ...(sample.variant === 'maximized' ? [] : [`--window-size=${sample.variant === 'offscreen-window' ? '900,500' : '1366,768'}`, `--window-position=${sample.variant === 'offscreen-window' ? '4000,3000' : '0,0'}`]),
    ...(sample.persona === 'native' ? [] : [`--fingerprint=${sample.seed}`, `--fingerprint-platform=${sample.persona}`, '--fingerprint-hardware-concurrency=4', '--fingerprint-timezone=America/Los_Angeles', '--fingerprint-locale=en-US']),
    '--lang=en-US', '--accept-lang=en-US', ...(sample.mode === 'headless' ? ['--headless=new'] : []), ...sample.graphics, ...sample.extra, 'about:blank'];
}
