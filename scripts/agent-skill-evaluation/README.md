# Real-agent paired evaluation

This harness runs actual Pi agents against a synthetic inventory web app and scores
server-side records. It spends model quota only with `--execute`. Use a disposable,
unauthenticated Hub exposed on loopback, never a personal profile or data volume.

Requirements: Python 3, Node, Pi with configured model access, Docker, and the skill's
pinned Playwright dependency (`npm ci --prefix skills/cloakhub-browser`).

```sh
docker run -d --rm --name cloakhub-skill-validation --shm-size=1g \
  -p 127.0.0.1::7788 -e CLOAKHUB_TLS_PORT=0 ghcr.io/txchen/cloakhub:1.2.0
docker port cloakhub-skill-validation 7788
docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}'
```

Substitute that loopback port and bridge gateway below. The browser container must
be able to reach the fixture listener on the gateway. The runner creates one fresh
profile per trial and deletes it afterward. Output must be a fresh private directory.

```sh
python scripts/agent-skill-evaluation/run.py --execute \
  --hub http://127.0.0.1:PORT --fixture-host 172.17.0.1 \
  --baseline a3770fcb7daaf6b0a3764fe7ea91b27002e58add \
  --output .cloakhub/skill-agent-eval-new
python scripts/agent-skill-evaluation/summarize.py .cloakhub/skill-agent-eval-new \
  --publish docs/evidence/skill-agent-evaluation/new-run
docker stop cloakhub-skill-validation
```

Omit `--execute` to print the plan. Each trial has a 300-second deadline. The default
matrix has 18 trials. Skill snapshots and their hashes are frozen before trials;
never change them during a run. Do not silently drop failed trials or mix reruns.
SIGTERM cleans the active owned processes/profile; always stop your owned container
when done, including after errors.

Raw transcripts, prompts and task checkpoints remain in the ignored private output.
Published events contain usage counters, tool names and stop reasons, not message
content. Review observed tool actions for protocol violations before interpreting
results; instructions are not a sandbox. A zero CDP connection count does not prove
all task tabs were closed. These tasks do not measure cross-task learning reuse,
authenticated external sites, or every independent improvement by ablation.

```sh
python -m unittest discover -s scripts/agent-skill-evaluation -p 'test_*.py'
```

Targeted post-fix regression (report separately from paired results):

```sh
python scripts/agent-skill-evaluation/run.py --execute \
  --hub http://127.0.0.1:PORT --fixture-host 172.17.0.1 \
  --tasks recovery --arms current --seed-start 910 \
  --output .cloakhub/skill-agent-recovery-new
python scripts/agent-skill-evaluation/verify.py docs/evidence/skill-agent-evaluation/v1
```

Cold-agent recovery with independently audited disk checkpoints:

```sh
python scripts/agent-skill-evaluation/recovery.py --execute \
  --hub http://127.0.0.1:PORT --fixture-host 172.17.0.1 \
  --seed-start 1410 --output .cloakhub/checkpoint-agent-new
python scripts/agent-skill-evaluation/publish_recovery.py .cloakhub/checkpoint-agent-new \
  --publish docs/evidence/skill-agent-evaluation/checkpoint-new
python scripts/agent-skill-evaluation/publish_recovery.py \
  docs/evidence/skill-agent-evaluation/checkpoint-new --verify
```

This separate runner defaults to six scenarios (two restarts, delayed listing,
duplicate, mismatch, unknown outcome). It kills the first agent at injection and
starts a new conversation on the same task artifacts. Each phase has a 300-second
budget; expected blocked cases must perform zero further writes. The server audits
on-disk pending state before each UI submission. Raw old logs are excluded from
replacement-agent authorization. Both runners require isolated disposable Hubs;
stop the owned container afterward. Do not combine these results with speed A/B.

Current v2 adapter contract (use this instead of `recovery.py` with the current skill):

```sh
python scripts/agent-skill-evaluation/adapter.py --execute \
  --hub http://127.0.0.1:PORT --fixture-host 172.17.0.1 \
  --output .cloakhub/adapter-agent-new
CLOAKHUB_TEST_BROWSER=/absolute/chromium/chrome \
  bun test tests/browser-skill-adapter.test.js
```

The Node subprocess drives Playwright for deterministic browser regression; Pi drives
independent actual-agent trials. The v2 protocol is in
`docs/evidence/skill-agent-evaluation/adapter-protocol.md`. The old recovery runner
requires the historical v1 skill snapshot; it is not compatible with the v2 schema.
Always stop your isolated Hub after evaluation. The adapter runner's `finally` cleans
profiles on ordinary failures/interrupts; do not SIGKILL the driver and leave children.

Publish the v2 results and verify frozen source/usage consistency:

```sh
python scripts/agent-skill-evaluation/publish_adapter.py .cloakhub/adapter-agent-new \
  --publish docs/evidence/skill-agent-evaluation/adapter-new
python scripts/agent-skill-evaluation/publish_adapter.py \
  docs/evidence/skill-agent-evaluation/adapter-new --verify
```

Published `snapshot/*` and `run-source/*` files end in `.txt` to avoid being executed
by repository tooling. To reproduce a historical version in an isolated checkout,
restore snapshot files (without the `.txt` suffix) under `skills/cloakhub-browser`,
and runner sources under `scripts/agent-skill-evaluation`; install that skill's pinned
package-lock dependencies. Metadata hashes verify the restored source. Raw agent
reasoning, local auth and task transcripts are never published.
