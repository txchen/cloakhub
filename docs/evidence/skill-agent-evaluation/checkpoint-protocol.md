# Durable checkpoint and cold-agent protocol

Declared before the new trials. This is a new reliability/adoption experiment, not
an addition to the original speed comparison. Freeze the current skill and hashes.
Run actual Pi 1.5.0 / openai gpt-6-luna medium agents, isolated release Hub 1.2.0,
CloakBrowser 156, pinned Playwright 1.63.0, one private profile per case.

Six cases, seeds 1210–1215: restart twice, delayed read, duplicate record, changed
field, unknown submission. Each gets 20 intended records and two pre-existing
non-prefix records. Record presentation is reversed. Writes must use UI forms.
The ordinary task prompt requests persistent task artifacts, but does not name
checkpointBatch, prescribe a checkpoint filename or supply adapter code.

At the seventh agent submission, independently read disk checkpoints before the
server accepts the write. Require one checkpoint, matching destination/account/
input digest, pending key for that write, exact previously confirmed IDs, a stable
path and increasing revision. Audit every submission, not just the last file.

Accept the seventh write (except unknown), drop its response, stop the profile and
terminate the first Pi process. Start a completely fresh Pi conversation, same
workspace/profile, without its old transcript, count or record IDs. The replacement
may read task inputs, adapter and checkpoint; old logs/prompts are disallowed.

- Restart/delayed: exact 20 records, zero duplicate/wrong fields, all writes backed
  by a prior durable pending entry, final complete checkpoint with matching IDs.
- Delayed: at least one actual incomplete read; server returns complete:false for
  three seconds after the replacement's first records request. It must not trigger
  replay or false confirmation. The page polls until the result is complete.
- Duplicate/mismatch: inject the discrepancy after the seventh write. Replacement
  must make zero writes, preserve the pending checkpoint, leave the ledger unchanged,
  and report the block.
- Unknown: the seventh request does not commit, but its final outcome is not exposed
  to the agent. A missing pending row is not permission to replay; require a block.

Each phase has 300 seconds; first-phase termination at injection is expected.
Retain every failure and check tool actions for protocol violations. Final-agent
block-report keyword checks are only a screening signal, followed by inspection.
Raw transcripts remain private; publish per-write checkpoint audit, scores and hashes.
The helper's callbacks still supply completeness and site identity; this is no
security sandbox or proof of arbitrary-site exactly-once writes.
