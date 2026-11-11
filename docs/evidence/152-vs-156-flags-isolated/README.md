# 152 / 156 flags-isolated evidence

See [the report](../../152-vs-156-flags-isolated.md) for interpretation and limits.

## Files

- `results.json`: 62 formal profiles, including 24 local-only flag probes. No raw IPs, keys, event IDs or visitor IDs. Missing Fingerprint signals and incomplete IPHey scores remain missing, not false/zero.
- `environment.txt`: versions, executable hashes, fontconfig hash, Node version, CPU quota and shm size.
- `run.mjs`: the actual harness used for the formal experiments. It launches binaries directly, records `/proc/<pid>/cmdline`, connects over CDP, then closes via `Browser.close`. It does not start CloakHub.
- `verify.mjs`: checks the saved evidence, actual argv and report counts. It does not rerun sites or certify detector accuracy.

`variant` mapping: `clean` = no extra graphics flags; `old` = all four; `0` = `--disable-gpu`; `1` = `--disable-dev-shm-usage`; `2` = `--use-gl=angle`; `3` = `--use-angle=swiftshader`.

Rounds 1/2 = clean matrix; round 3 = local flag isolation; round 4 = headed old-flags site comparison; rounds 5/6 = headless ANGLE-only matrix. Smoke round 0 is excluded. Raw page text is deliberately not included. Site completion records retain only the relevant verdicts; `gpuErrors` is a bounded excerpt, not the full browser log.

## Reproduction prerequisites

Use Linux x64 with Docker and sufficient disk space. Require an authorized 156 binary directory (including resources), a valid key file, and network access to the four public test sites and the official license server. Do not use an occupied free-tier key concurrently. Do not put the key in command-line arguments or source files.

Use a **fresh private work directory** per reproduction; otherwise the harness's deterministic sample IDs overwrite prior output. The private `results/` files may contain site page text and tracking identifiers; do not publish them directly.

Example preparation from repository root:

```bash
WORK="$PWD/.scratch/compare-152-156-reproduction"
mkdir -p "$WORK"
chmod 700 "$WORK"
cp docs/evidence/152-vs-156-flags-isolated/run.mjs "$WORK/run.mjs"
npm install --prefix "$WORK" playwright-core@1.64.1 --ignore-scripts --no-audit --no-fund

# Copy a Debian-compatible Node executable into the work directory.
# Do not substitute the Fedora host's Node executable or Bun.
docker pull node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9
NODE_CONTAINER=$(docker create node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9)
docker cp "$NODE_CONTAINER:/usr/local/bin/node" "$WORK/node"
docker rm "$NODE_CONTAINER"
```

Set `BINARY156` to the full browser directory and `KEY_FILE` to the secret file, then run **one mode at a time**, waiting for exit before starting another:

```bash
MODE=matrix  # smoke, matrix, flags, corrected, or legacy
BINARY156="$HOME/.cloakbrowser/chromium-156.0.8078.47.1-pro"
KEY_FILE="$HOME/.cloakbrowser/license.key"
docker run --rm --cpus 4 --memory 4g --shm-size 2g \
  --security-opt label=disable \
  -v "$WORK:/work" \
  -v "$BINARY156:/opt/browser156:ro" \
  -v "$KEY_FILE:/run/key:ro" \
  --entrypoint /work/node \
  ghcr.io/txchen/cloakhub_free:0.8.4@sha256:961f1ac4b12c2c15569e7765bc09cbb0ebdad77892f52496b025c67b121bec33 \
  /work/run.mjs "$MODE"
```

No ports or production data are exposed/mounted. SELinux label isolation is disabled only for this task container to permit these explicit mounts. No host GPU devices are mounted. `smoke` is a two-profile preflight; inspect failures before proceeding. `matrix` takes 24 profiles, `flags` 24 local probes, `corrected` 12 profiles with an extra 20-second gap, `legacy` 2 profiles. Allow cooldown and stop/reduce site visits if a site rate-limits requests; do not work around its access controls.

Site timing is bounded: navigation up to 35 seconds; post-navigation completion polling up to 15 seconds for Fingerprint, 6 for SannySoft, 8 for BrowserScan, 25 for IPHey. It exits early when the expected completion marker appears. IPHey placeholders at this deadline are **incomplete within the observation window**, not a score of zero or proof of a permanent hang.

The local probe reads page-world properties on an otherwise blank page. Site page text is read via locators. Fingerprint signals come from JSON network responses, not guessed from page wording. Different sites test different properties; do not combine them into a single pass percentage. No screenshots or full raw response bodies are retained in the public evidence.

Verify the **saved** evidence with:

```bash
node docs/evidence/152-vs-156-flags-isolated/verify.mjs
```
