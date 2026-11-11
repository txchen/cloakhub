#!/usr/bin/env node
import { readFile, readdir, mkdir, writeFile, rename } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { validateConfig, publicConfig, makePlan, PLANS } from './config.mjs';
import { summarize, markdown, resultExitCode } from './report.mjs';
import { sleep, redactor, hash } from './util.mjs';

export function parseCli(argv) {
  const options = { plan: 'smoke', output: '.cloakhub/browser-evaluation', external: false, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--external') options.external = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (['--config', '--output', '--plan'].includes(arg)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw Error(`${arg} requires a value`);
      options[arg.slice(2)] = value;
    } else throw Error(`Unknown option ${arg}`);
  }
  if (!PLANS.includes(options.plan)) throw Error('Unknown plan');
  if (!options.help && !options.config) throw Error('--config is required; use --help');
  return options;
}
const HELP = `Browser version evaluation (Node, Linux; opt-in, never run by bun test)
Usage: npm run test:browser-evaluation -- --config <file> [--plan smoke|local|flags|features|detectors|all]
       [--output <parent-directory>] [--external] [--dry-run]

smoke: first seed/persona, local surfaces and a small request-interception check
local: paired seed/persona/mode matrix, surfaces, interception and CPU
flags: clean, legacy combination and each individual graphics flag
features: popup policy, maximized/offscreen geometry, Windows vendor/touch flags
detectors: external Fingerprint/SannySoft/BrowserScan/IPHey (requires --external)
all: local + flags + features; includes detectors only with --external

--dry-run validates and prints the exact plan without reading keys, launching browsers,
visiting sites, or writing artifacts. Each real invocation creates a fresh output directory.
Exit 0 means observations completed, NOT that detection passed. Exit 1: infrastructure
failure/partial run; 2: detector observations missing/blocked/limited; 130: interrupted.
See docs/browser-evaluation.md for the pinned Docker environment and review checklist.
`;
async function atomicJson(file, value) {
  await writeFile(`${file}.tmp`, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(`${file}.tmp`, file);
}
export async function main(argv = process.argv.slice(2)) {
  const options = parseCli(argv);
  if (options.help) { console.log(HELP); return 0; }
  const configPath = resolve(options.config);
  const configText = await readFile(configPath, 'utf8');
  let input;
  try { input = JSON.parse(configText); } catch { throw Error('Invalid evaluation config JSON (contents withheld)'); }
  const config = validateConfig(input, dirname(configPath));
  const { cases, skipped } = makePlan(config, options.plan, options.external);
  if (options.dryRun) {
    console.log(JSON.stringify({ status: 'planned-only', config: publicConfig(config), cases, skipped }, null, 2));
    return 0;
  }
  if (process.versions.bun) throw Error('Run this command with Node, not Bun');
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const runDir = join(resolve(options.output), runId);
  await mkdir(join(runDir, 'cases'), { recursive: true, mode: 0o700 });
  const sourceDir = dirname(fileURLToPath(import.meta.url));
  const sources = (await readdir(sourceDir)).filter(name => name.endsWith('.mjs')).sort();
  const sourceBytes = await Promise.all(sources.map(async name => Buffer.concat([Buffer.from(name + '\0'), await readFile(join(sourceDir, name))])));
  const manifest = { schemaVersion: 1, suiteVersion: 1, suiteSourceSHA256: hash(Buffer.concat(sourceBytes)), runId, startedAt: new Date().toISOString(), status: 'starting', plan: options.plan, external: options.external, config: publicConfig(config), plannedCases: cases, skipped };
  const records = [];
  const controller = new AbortController();
  const interrupt = () => controller.abort(Error('Operator interrupted evaluation'));
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  let engine;
  let setupError;
  console.log(`Evaluation artifacts: ${runDir}`);
  await atomicJson(join(runDir, 'manifest.json'), manifest);
  try {
    const { EvaluationEngine } = await import('./engine.mjs');
    engine = new EvaluationEngine(config, runDir, controller.signal);
    manifest.environment = await engine.start(cases);
    manifest.status = 'running';
    await atomicJson(join(runDir, 'manifest.json'), manifest);
    for (let index = 0; index < cases.length; index++) {
      controller.signal.throwIfAborted();
      const record = await engine.run(cases[index]);
      records.push(record);
      await atomicJson(join(runDir, 'cases', `${record.id}.json`), record);
      await atomicJson(join(runDir, 'results.json'), records);
      console.log(`${index + 1}/${cases.length} ${record.id}: ${record.status}`);
      // Stop rather than potentially reusing an occupied seat or accumulating failed launches.
      if (record.status !== 'complete' || record.forcedStop) break;
      if (index + 1 < cases.length) await sleep(record.plan === 'detectors' ? config.cooldownMs : 1500, controller.signal);
    }
  } catch (error) {
    if (!controller.signal.aborted) setupError = (engine?.redact ?? redactor())(error.message);
  } finally {
    try { await engine?.close(); } catch (error) { setupError = (engine?.redact ?? redactor())(error.message); }
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    manifest.finishedAt = new Date().toISOString();
    manifest.status = controller.signal.aborted ? 'interrupted' : setupError ? 'error' : records.length === cases.length ? 'finished' : 'partial';
    if (setupError) manifest.error = setupError;
    const summary = summarize(records, cases.length);
    if (setupError) summary.infrastructureErrors.push({ id: 'setup-or-cleanup', status: 'error', error: setupError });
    await atomicJson(join(runDir, 'manifest.json'), manifest);
    await atomicJson(join(runDir, 'results.json'), records);
    await atomicJson(join(runDir, 'summary.json'), summary);
    await writeFile(join(runDir, 'report.md'), markdown(summary, manifest), { mode: 0o600 });
    if (setupError) console.error(setupError);
    console.log(`Report: ${join(runDir, 'report.md')}`);
    return resultExitCode(summary, controller.signal.aborted);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }).catch(error => { console.error(redactor()(error.message)); process.exitCode = 1; });
}
