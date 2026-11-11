# Pi browser-client pilot: published evidence

Historical experiment: 2026-11-10. See [the report](../../pi-browser-comparison.md).
This compares two CLI/skill paths under the same Pi/model, **not** the full Browser
Use Agent engine. One synthetic task family and three data variants are not a
representative web-agent benchmark.

## What is published

- `results.json`: six default-condition runs, including all three BU failures.
- `foreground/results.json`: three subsequent BU runs with a foreground hint;
  this is a post-hoc diagnostic, not a preregistered independent comparison.
- `infra-failure/results.json`: three recorded, excluded infrastructure failures.
  One further private infrastructure log has no result row; the compact export
  marks it `has_result: false` and does not invent an outcome.
- `metadata.json`: versions, logical source labels and historical file hashes.
  Installed skill hashes are not necessarily those of current repository HEAD.
- `compact-events.json`: allowlisted final-message usage, tool-name counts and
  completion error flags, plus raw-log byte counts and SHA-256. Repeated streaming
  deltas are omitted. No reasoning text, prompts, commands, tool outputs or account
  data are included. This is enough to cross-check counts, not to audit every action.
- `summarize-private-logs.py`: offline exporter for custodians of the original logs.
  It refuses to replace the export when no private logs are present.
- `run.py`, `fixture.html`, `bridge.js`: a **subsequently parameterized** replay
  harness. These were not used byte-for-byte in the historical experiment and
  have not been rerun against live agents during this publication cleanup.

The original raw JSONL transcripts (~5 MB), local harness copies and third-party
`browser-use-skill.txt` snapshot remain private and Git-ignored. The snapshot hash
is retained, but redistribution permission was not established in this cleanup.
Do not reconstruct or publish private logs just to make the directory look complete.
No claim is made that the compact export proves all prompt constraints were obeyed.

The historical report's costs are Pi model-catalog estimates, not provider invoices.
The historical skill's SKILL.md, session.mjs and sessions reference differ from the
current repository by hash; the results are not a performance claim for current HEAD.

## Offline checks — no Pi, model, browser or external network

```sh
node docs/evidence/pi-browser-comparison/verify.mjs
python3 docs/evidence/pi-browser-comparison/test_runner.py
```

The verifier recomputes pass/fail from synthetic submissions, checks usage and call
counts against compact events, checks the published aggregate numbers, and keeps
infrastructure failures out of the main denominator. It does not authenticate the
provider, certify UI actions, or replace an independent benchmark replication.

## Replaying deliberately

Prerequisites: a POSIX host (Linux/macOS), Python 3, Node, an authenticated Pi installation, the configured
CloakHub skill/client, and an explicitly installed Browser Use CLI plus an authorized
skill file. Pin the historical versions if comparing with this pilot; record actual
versions/hashes for every new experiment. Do not assume today's upstream skill is
identical to the recorded snapshot.

Use a **dedicated disposable browser profile with no real account data**, not a
personal/main profile. Configure a CloakHub target and a BU CDP endpoint for that
same profile. The script requires an acknowledgement but cannot prove the two
references resolve to the same profile or that the operator isolated it correctly.

Example setup (replace placeholders; do not commit credentials):

```sh
export COMPARISON_CLOAKHUB_SKILL_DIR="$PWD/skills/cloakhub-browser"
export COMPARISON_BU_BIN="/absolute/path/to/venv/bin/browser-use"
export COMPARISON_BU_SKILL="/absolute/path/to/authorized-fixed-version-skill.md"
export COMPARISON_TARGET="dedicated-comparison"
export COMPARISON_CDP_WS="wss://YOUR-HUB/api/profiles/YOUR-TEST-PROFILE/cdp"
export COMPARISON_CONFIRM_ISOLATED_PROFILE=yes
export COMPARISON_BROWSER_ORIGIN="http://browser-evaluation.test:18765"
export COMPARISON_LOCAL_ORIGIN="http://127.0.0.1:18765"
export COMPARISON_LOCAL_PORT=18765

# Only validates configuration and prints a redacted plan; no model or CDP calls.
python3 docs/evidence/pi-browser-comparison/run.py
```

Provide the endpoint's required authentication privately as appropriate to your
installation. Never paste a token-bearing endpoint into a public result or report.
In a separate terminal with the same environment, keep the restricted bridge alive:

```sh
node "$COMPARISON_CLOAKHUB_SKILL_DIR/scripts/browser.mjs" run \
  --target "$COMPARISON_TARGET" < docs/evidence/pi-browser-comparison/bridge.js
```

Then explicitly authorize model calls and browser actions:

```sh
python3 docs/evidence/pi-browser-comparison/run.py --execute
```

This can incur model charges. The agent has normal user-level code execution;
prompt restrictions are **not a sandbox**. Do not run on a machine/profile where
those permissions are inappropriate. The fixture binds only loopback, and the
bridge only accepts a reserved `.test` or loopback browser origin and a loopback
upstream; neither is intended as an exposed network service.

Defaults: three paired repeats, alternating arm order, 180-second trial budget,
`openai/gpt-6-luna`, medium thinking, and a fresh ignored output directory under
`.cloakhub/pi-browser-comparison/`. Overrides include `COMPARISON_REPEATS`,
`COMPARISON_ARMS=browser-use`, `COMPARISON_EXTRA_PROMPT`, `COMPARISON_PROVIDER`,
`COMPARISON_MODEL`, `COMPARISON_PI_BIN`, and `COMPARISON_OUTPUT` (must not exist or
point inside this evidence archive). If changing the local port, also change the
bridge's `COMPARISON_LOCAL_ORIGIN`.

New runs keep raw logs private, do not publish free-form model final messages or
submitted text, and stop the matrix on timeout. A timed-out operation may already
have changed browser state; inspect before doing anything else. The local BU daemon
uses a per-run name; cleanup is not proof that all remote tabs/session workers are
gone. Stop the bridge, inspect and close only your test tabs/sessions, and verify
profile idleness afterwards. Do not automatically replay writes or kill unrelated
profiles. Re-score and privacy-review new evidence before publishing it.
