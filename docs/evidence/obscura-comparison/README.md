# Obscura v0.2.6 vs CloakBrowser 156 evidence

Measured 2026-11-11 UTC. See [source review](../../obscura-source-review.md) and [comparison](../../obscura-vs-cloakbrowser.md).

`run.mjs` imports the existing fixture, surface, Canvas decoder, smoke measurement,
request/identity logic, detector parsers, time windows and process utilities. No
production launcher or existing suite module was changed. It adapts Obscura's
`serve --ready-file` JSON to CDP instead of pretending it accepts Chromium flags.
Independent diagnostics continue after a strict smoke failure. Diagnostic routing
uses eight sequential requests; original smoke uses its existing concurrency.

The original CLI is Chromium-specific (version syntax, argv, DevToolsActivePort),
so this is reuse of suite probes, not a claim that the unchanged CLI supports Obscura.
The strict smoke is bounded at 50 s, frame diagnostic at 30 s. A timeout does not
prove every possible iframe use is unsupported.

Artifacts:

- `manifest.json`: release/source, image, suite hashes, limits, client version.
- `stealth-r1.json`: initial strict run, no bringToFront adaptation, before adding
  Worker-global and second-connection diagnostics.
- `cloak-official-no-key.json`: preflight startup failure (exit 77) with official
  licensed binary and no key. Not counted as a browser compatibility result.
- `cloak-r1.json`: current repository license-free 156 baseline; original detectors.
- `stealth-adapted.json`: render+stealth archive, runtime `--stealth`; detector-only
  `Page.bringToFront` no-op, explicitly recorded. Other probes unchanged.
- `default-adapted.json`: render default archive, no runtime stealth; same adapter.

The diagnostic `status: complete` means collection completed, not that the measured
behavior passed. Read null contexts, errors embedded in Worker values, detector
statuses, and request counts. Detector incomplete/error is never a stealth pass.
Worker results use the original surface, whose `typeof document` branch also reveals
whether the worker actually lacks Window globals.

All processes use fresh temporary HOME/storage and are destroyed after collection.
Docker: pinned existing local image, 4 CPUs, 4 GiB RAM, 2 GiB shm, no host GPU,
no published ports, shared host egress. Builds run serially. Obscura randomly chooses
identity; baseline uses Linux persona + seed 20260909. This is a product configuration
comparison, not a matched-persona causal experiment. CPU/RSS/throughput were not
benchmarked. No external service challenges were solved.

## Reproduction

Download and extract official v0.2.6 `obscura-x86_64-linux.tar.gz` and
`obscura-x86_64-linux-stealth.tar.gz` under `.cloakhub/obscura/default` and
`.cloakhub/obscura/stealth`. Verify the archive hashes in manifest.json.
Keep both shipped executables in their directories. Build the repository's documented
browser evaluation Docker image if it is absent; its image ID can differ from this
run and should be recorded.

```bash
docker run --rm --cpus 4 --memory 4g --shm-size 2g \
  --security-opt label=disable -v "$PWD:/work" -w /work \
  --entrypoint /usr/local/bin/node cloakhub-browser-evaluation:local \
  docs/evidence/obscura-comparison/run.mjs stealth \
  /work/.cloakhub/obscura/stealth/obscura /work/.cloakhub/stealth-new.json
```

For default, change both `stealth` arguments to `default`. An optional fourth argument
`local` skips external detectors; by default this comparison runner explicitly visits
the four public detectors, unlike the production suite CLI's opt-in default. Use new
output names; do not overwrite archived observations. For CloakBrowser, pass `cloak`
and its full bundle executable path (use the exact hash/source from this run for
reproduction). Mount its companion files and the existing repository 156 executable;
do not confuse it with the separately licensed official executable. Allow at least
45 seconds between successive external comparison runs; do not retry a rate-limited
site. Results describe this date and client version only.
