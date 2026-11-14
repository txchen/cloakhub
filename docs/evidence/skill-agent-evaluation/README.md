# Skill evaluation evidence

- `protocol.md`: declared original 18-trial paired design.
- `v1/`: all original results, summaries, numeric usage events, frozen file hashes,
  and a limited behavioral audit. The single candidate failure is included.
- `recovery-followup-protocol.md`: separately declared three-seed post-fix regression.
- `recovery-v2/`: all three follow-up results, summaries, numeric usage and hashes.

The report is [../../skill-agent-evaluation.md](../../skill-agent-evaluation.md).
The runner and fixture are in `scripts/agent-skill-evaluation/` at repository root.
Raw Pi transcripts and task files stay private in ignored `.cloakhub/` directories.
SHA-256 hashes permit comparison with the originals without publishing their content.
Hashes are provenance, not an independent proof that transcripts were scored correctly.

Both experiments use release image `ghcr.io/txchen/cloakhub:1.2.0`, digest
`sha256:40203496a404bd71a1416fb5a634d3976f48361274a0315c32a24617d4180dcf`,
CloakBrowser 156.0.8078.47.1 and pinned Playwright 1.63.0. A disposable loopback Hub
and synthetic profiles isolate all writes. Default `noDefaults:true` remains in use.

`v1/runner.py.txt` is the exact original runner (hash verified against metadata).
The maintained runner adds task/arm/seed selection for targeted follow-ups; default
selection preserves the original design. To reproduce the old source exactly, copy
that archived text into the script location in an isolated checkout. The fixture hash
is unchanged. The candidate files changed after v1 are archived as `SKILL.md.txt`
and `references-recovery.md.txt`; additional later changes are preserved under each run's `snapshot-overrides/` (strip the `.txt` suffix when restoring). The original
candidate manifest defines which files belong to that snapshot; omit newer files
absent from it. Baseline files are available from the recorded git commit. Later outcomes
will vary because model sampling, cache use and latency are not deterministic.

Verify metric consistency without model access:

```sh
python scripts/agent-skill-evaluation/verify.py docs/evidence/skill-agent-evaluation/v1
```

The checker verifies trial completeness, aggregate values, completed-message usage,
raw-log hash references and outcome flags. Independent business scoring happens in
the runner's server, with scorer unit tests; exported metrics are not full raw server
ledgers. The behavioral audit identifies observed calls, not exhaustive compliance.

## Executable checkpoint follow-up

See [../../checkpoint-recovery-evaluation.md](../../checkpoint-recovery-evaluation.md).
`checkpoint-protocol.md`, `checkpoint-followup-protocol.md` and
`checkpoint-final-protocol.md` declare the successive frozen runs. `checkpoint-v3/`
retains the initial task failures; `checkpoint-v4/` contains the interface follow-up; `checkpoint-v5/` contains the
final full matrix with automatic session progress.
Each publishes per-case/per-phase metrics, usage events and per-submission disk audits.
The `writes` counter counts submission attempts, including the unknown-outcome
request that does not commit. It is not an accepted-record count.

For old candidates, `snapshot-overrides/` contains files differing from the final
skill (strip `.txt` to restore). Use the manifest to exclude files absent from that
snapshot. v3 also preserves its exact runner source: the later scorer accepts both
the raw tenant key and its observed Account label, representing the same tenant.

The current runner is `scripts/agent-skill-evaluation/recovery.py`, with the separate
`recovery-fixture.html`. Reproduction and publication commands are in that directory's
README. Verify published case/audit/usage consistency with:

```sh
python scripts/agent-skill-evaluation/publish_recovery.py \
  docs/evidence/skill-agent-evaluation/checkpoint-v4 --verify
```
