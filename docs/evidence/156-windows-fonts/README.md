# Windows font intervention evidence

See [the report](../../156-windows-fonts.md). Twelve profiles, one seed (20260909),
headed/headless, three font conditions, two reversed condition-order replicates;
then four additional profiles checking strong generic-font bindings (16 total).
All observations used the same binary, evaluation image and suite-source hash.

- `r1-system`, `r1-added`, `r1-only`, `r2-only`, `r2-added`, `r2-system` contain the
  unmodified runner manifest, results, summary and report.
- `defaults/` contains the subsequent four-profile check: the same isolated files
  and rendering rules, but strong generic aliases so monospace actually resolves
  to Courier New and sans-serif to Arial. This later check was not interleaved with
  the original three conditions. Its one invocation uses raw rounds 1 and 2.
- The original two replicates are separate CLI invocations; each raw case's `round` is 1.
  Replicate identity and execution order are recorded in `provenance.json` and
  `environmentLabel`, not silently rewritten in the raw cases.
- `summary.json` aggregates the three conditions. Counts were checked against raw
  cases; the ML numbers are detector output, not calibrated blocking probabilities.
- `font-files.json` lists the 34 actual files and SHA-256 values.
- `cabfiles.sha256sums` is the reference list from Debian's 3.8.1 installer package;
  package URL/hash and font archive base URL are in `provenance.json`.
- `configs/` and `run.sh` are the actual local experiment inputs. The key field is
  only a fixed container file path, never a key value. Font binaries, raw visitor
  IDs, raw page bodies, cookies and external IP addresses are not published.

## Replaying the experiment

Use the [suite guide](../../browser-evaluation.md) to build the evaluation image.
Prepare a private experiment directory with `files/`, `configs/` and the archived
`run.sh`. Keep the same font versions when reproducing this exact intervention.

For the old Core Fonts, obtain the original 11 archive names listed in
`cabfiles.sha256sums` from `https://downloads.sourceforge.net/corefonts/`, inspect
and comply with their EULA, verify the archives with `sha256sum -c`, then use
`cabextract` to extract them into `files/`. Do not execute their EXE installers.
The four additional files are the existing repository's `Tahoma.ttf`,
`Tahoma Bold.ttf`, `micross.ttf`, and `wingding.ttf`, copied unchanged. Verify all
font-file hashes against `font-files.json`. Do not rename substitute fonts.

Mount the experiment directory read-only at `/opt/evaluation/windows-fonts`,
the candidate directory at `/binaries/candidate`, and the key file read-only at
`/run/browser-license.key`. Mount an owned results directory at `/results`.
Run the archived shell script through `tini` in one container, with the same CPU,
memory and shm limits as the guide. Afterwards the supplemental check uses the
same suite with `--config /opt/evaluation/windows-fonts/configs/defaults.json
--plan detectors --external` and a separate output directory. It runs all six invocations serially and stops
on a nonzero suite exit code. Do not run competing browser evaluations at the same
time. As with any live detector, current outputs need not equal historical ones.

The `system` condition deliberately does not search the mounted font directory.
The `added` condition adds that directory; the `only` condition resets directories
while retaining system rendering rules and supplying weak generic-family aliases.
The supplemental `defaults` condition changes those aliases to strong bindings,
without aliasing absent modern Windows families to substitute fonts. These changes do not turn FreeType/Linux into DirectWrite/Windows.

**This font collection is not a complete Windows 10/11 installation.** In particular,
Segoe UI, Calibri, Cambria and Consolas remain unavailable, and Core Fonts are older
versions. Supplying an authorized modern font set is a distinct next experiment.
Check applicable font redistribution terms before publishing a Docker image;
this archive does not grant redistribution rights to the fonts.

Offline verification:

```sh
node docs/evidence/156-windows-fonts/verify.mjs
```
