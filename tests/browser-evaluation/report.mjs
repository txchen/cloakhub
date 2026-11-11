export function median(values) {
  const sorted = values.filter(v => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
export function summarize(records, planned) {
  const groups = new Map();
  for (const r of records) {
    const label = [r.plan, r.binaryId, r.persona, r.mode, r.variant].join(' / ');
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(r);
  }
  return {
    schemaVersion: 1, planned, recorded: records.length,
    infrastructureErrors: records.filter(r => r.status !== 'complete' || r.forcedStop).map(r => ({ id: r.id, status: r.status, forcedStop: Boolean(r.forcedStop) })),
    detectorGaps: records.flatMap(r => Object.entries(r.detectors ?? {}).filter(([, d]) => d.status !== 'complete').map(([name, d]) => ({ id: r.id, name, status: d.status }))),
    groups: [...groups].map(([label, rs]) => {
      const fp = rs.map(r => r.detectors?.fingerprint).filter(d => d?.status === 'complete');
      const cpu = rs.map(r => r.local?.animation?.cpuUsec).filter(v => typeof v === 'number');
      const gl = rs.filter(r => r.local?.main?.gl);
      const pixels = gl.flatMap(r => Object.values(r.local.main.gl)).filter(g => g === null || Array.isArray(g?.pixel));
      const sanny = rs.map(r => r.detectors?.sannysoft).filter(d => d?.status === 'complete');
      const scan = rs.map(r => r.detectors?.browserscan).filter(d => d?.status === 'complete');
      return {
        label, records: rs.length, completed: rs.filter(r => r.status === 'complete').length,
        webgl: { valid: gl.length, available: gl.filter(r => r.local.main.gl.webgl && r.local.main.gl.webgl2).length },
        webglDraw: { valid: pixels.length, successful: pixels.filter(g => g?.error === 0 && g.pixel.length === 4 && g.pixel.every((v, i) => Math.abs(v - [51, 102, 153, 255][i]) <= 1)).length },
        sannysoft: { valid: sanny.length, failures: sanny.filter(d => d.failedOrWarn?.length).length },
        browserscan: { valid: scan.length, normal: scan.filter(d => d.verdict === 'Normal').length },
        fingerprint: { valid: fp.length, botNotDetected: fp.filter(d => d.signals.bot === 'not_detected').length, vmPositive: fp.filter(d => d.signals.virtual_machine === true).length, tamperingPositive: fp.filter(d => d.signals.tampering === true).length, antiDetectValid: fp.filter(d => typeof d.signals.anti_detect_browser === 'boolean').length, antiDetectPositive: fp.filter(d => d.signals.anti_detect_browser === true).length },
        iphey: { observed: rs.filter(r => r.detectors?.iphey).length, completed: rs.filter(r => r.detectors?.iphey?.status === 'complete').length, verdicts: [...new Set(rs.filter(r => r.detectors?.iphey?.status === 'complete').map(r => r.detectors.iphey.verdict))], scores: rs.filter(r => r.detectors?.iphey?.status === 'complete').map(r => r.detectors.iphey.score) },
        cpu: { valid: cpu.length, medianSeconds: median(cpu.map(v => v / 1e6)), frames: rs.map(r => r.local?.animation?.frames).filter(v => typeof v === 'number') },
        interception: { requested: rs.reduce((n, r) => n + (r.local?.interception?.requested ?? 0), 0), successful: rs.reduce((n, r) => n + (r.local?.interception?.good ?? 0), 0) },
        contextMismatches: rs.filter(r => r.local?.contextChecks && Object.values(r.local.contextChecks).some(c => Object.values(c).some(v => v === false))).map(r => r.id),
        popupOpened: rs.filter(r => r.local?.popup).map(r => r.local.popup.opened),
        gpuVendors: [...new Set(rs.map(r => r.local?.main?.gl?.webgl?.vendor).filter(Boolean))],
        touchPoints: [...new Set(rs.map(r => r.local?.main?.identity?.maxTouchPoints).filter(v => v !== undefined))],
      };
    }),
    interpretation: 'Measurement completion is not an anti-detection pass. Do not aggregate heterogeneous detectors into a pass rate. Missing and rate-limited results are not false or zero. Compare only matched environment, mode, persona, seed and graphics configuration.',
  };
}
const fraction = (n, d) => d ? `${n}/${d}` : '—';
export function markdown(summary, manifest) {
  const lines = ['# Browser version evaluation', '', `Run: ${manifest.runId}`, `Environment: ${manifest.config.environmentLabel}`, '',
    `Recorded ${summary.recorded}/${summary.planned}; infrastructure errors ${summary.infrastructureErrors.length}; detector gaps ${summary.detectorGaps.length}.`, '',
    '**This is an observation report, not a universal stealth score.** CPU is whole-cgroup time; use only matched workloads and check frame counts. Font provenance is in manifest.json. A reference browser in Docker/CDP is not a real-human or native-Mac baseline.', '',
    '| Plan / binary / persona / mode / variant | Completed | WebGL/2 | FP VM + / valid | FP tampering + / valid | IPHey completed | Median animation CPU seconds |',
    '|---|---:|---:|---:|---:|---:|---:|'];
  for (const g of summary.groups) lines.push(`| ${g.label} | ${g.completed}/${g.records} | ${fraction(g.webgl.available, g.webgl.valid)} | ${fraction(g.fingerprint.vmPositive, g.fingerprint.valid)} | ${fraction(g.fingerprint.tamperingPositive, g.fingerprint.valid)} | ${fraction(g.iphey.completed, g.iphey.observed)} | ${g.cpu.medianSeconds === null ? '—' : g.cpu.medianSeconds.toFixed(3)} |`);
  lines.push('', '## Binary and font provenance', '');
  for (const b of manifest.environment?.binaries ?? []) lines.push(`- ${b.id}: ${b.version} (${b.kind}), SHA-256 ${b.executableSHA256}.`);
  for (const [persona, font] of Object.entries(manifest.environment?.fonts ?? {})) lines.push(`- ${persona}: ${font.file ?? 'system fontconfig'}, ${font.families?.length ?? 'unknown'} font-family entries. ${font.note}`);
  lines.push('', '## Detector details (positive or missing is not an execution failure)', '', '| Group | FP bot not detected | FP anti-detect positive | SannySoft failure/warning observations | BrowserScan Normal | IPHey verdicts / scores |', '|---|---:|---:|---:|---:|---|');
  for (const g of summary.groups.filter(g => g.label.startsWith('detectors'))) lines.push(`| ${g.label} | ${fraction(g.fingerprint.botNotDetected, g.fingerprint.valid)} | ${fraction(g.fingerprint.antiDetectPositive, g.fingerprint.antiDetectValid)} | ${fraction(g.sannysoft.failures, g.sannysoft.valid)} | ${fraction(g.browserscan.normal, g.browserscan.valid)} | ${JSON.stringify(g.iphey.verdicts)} / ${JSON.stringify(g.iphey.scores)} |`);
  lines.push('', '## Local rendering and workload checks', '', '| Group | GL create/draw/readback success | Routed requests | Context mismatches | Animation frames |', '|---|---:|---:|---:|---|');
  for (const g of summary.groups) lines.push(`| ${g.label} | ${fraction(g.webglDraw.successful, g.webglDraw.valid)} | ${fraction(g.interception.successful, g.interception.requested)} | ${g.contextMismatches.length} | ${JSON.stringify(g.cpu.frames)} |`);
  lines.push('', '## Feature and consistency observations', '');
  for (const g of summary.groups) if (g.label.startsWith('features') || g.contextMismatches.length) lines.push(`- ${g.label}: popup opened=${JSON.stringify(g.popupOpened)}, GPU vendors=${JSON.stringify(g.gpuVendors)}, touch points=${JSON.stringify(g.touchPoints)}, context mismatches=${g.contextMismatches.length}. Geometry is retained per case.`);
  lines.push('', '## Coverage gaps', '', 'Proxy DNS/WebRTC UDP, actual audio hardware, native OS realism, license fault injection and per-CVE security review require separately provisioned labs; they are not certified by this suite.', '');
  for (const gap of [...(manifest.skipped ?? []), ...summary.infrastructureErrors, ...summary.detectorGaps]) lines.push(`- ${JSON.stringify(gap)}`);
  return lines.join('\n') + '\n';
}
export function resultExitCode(summary, interrupted = false) {
  if (interrupted) return 130;
  if (summary.infrastructureErrors.length || summary.recorded !== summary.planned) return 1;
  return summary.detectorGaps.length ? 2 : 0;
}
