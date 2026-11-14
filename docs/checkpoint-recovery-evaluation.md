# Durable checkpoints and cold-agent recovery

Historical v1 checkpoint-contract evaluation. The current v2 contract and later
client-disconnect findings are documented in [adapter recovery](adapter-recovery-evaluation.md).

Evaluated 2026-11-13. The final frozen skill (v5) passed **6/6 real-agent cases**:
three exact completions and three correct stops, with **75/75 submission attempts**
backed by a matching durable pending checkpoint before the server handled them.
This replaces the earlier document-only checkpoint workflow. No Hub upgrade is
needed; the implementation is in the client skill.

## Change and contract

The previous real-agent evaluation found no durable checkpoint adoption, despite a
long recipe, and one duplicate write during recovery. The new
`checkpointBatch` is injected into both `run` and task sessions. The agent supplies
site-specific read/submit callbacks; the helper owns durable state transitions.

- Bind canonical input digest, operation version, actual connected Hub/profile and
  freshly observed site origin/account.
- Persist and fsync pending before calling the UI submission callback. Atomically
  replace the checkpoint and fsync its directory; local files are private.
- Refresh and compare all relevant saved records, exact fields and unique keys,
  including previously confirmed durable IDs. Reject missing/changed confirmations.
- Reconcile a committed pending row without repeating its submission. A missing
  pending row remains uncertain and blocks all subsequent writes.
- Fail closed on duplicates, wrong fields, incomplete reads, changed identity,
  invalid checkpoint data or checkpoint storage errors.
- Reject a concurrent writer to the same path. Reclaim a dead owner's lock on the
  same host; uncertain/incomplete ownership requires inspection.

The [batch reference](../skills/cloakhub-browser/references/batch-work.md) now asks
agents to save the adapter and input before the first submission, and use this
helper even for the first calibration record. A replacement agent reruns the same
adapter/path instead of rebuilding a resume index or editing checkpoint internals.
The [recovery reference](../skills/cloakhub-browser/references/recovery.md) routes
helper tasks through this contract and preserves blocked work for reconciliation.

## Test design

The [declared protocol](evidence/skill-agent-evaluation/checkpoint-protocol.md) uses
six cases with actual Pi/gpt-6-luna medium agents and a disposable release Hub 1.2.0,
CloakBrowser 156 and pinned Playwright 1.63.0. The fixture has 20 intended records,
two pre-existing non-prefix records, and reversed record display order.

At the seventh attempted new submission, the harness reads disk independently,
checks the matching pending key, destination/input identity, prior confirmed IDs,
stable checkpoint path and increasing revision. It repeats that check for **every**
submission. It then loses the reply, stops the browser and terminates the original
agent. A new process/conversation gets the original task, workspace and current
site, but no prior transcript, count or record IDs. Old logs are disallowed.

The cases are two ordinary restarts, delayed/incomplete reads, an injected duplicate,
a changed field and a pending request with no committed record. Success for the
last three means **zero further writes**, preserved pending state, unchanged remote
records and an accurate blocked report. Forced completion would be a failure.
Each phase has a 300-second deadline. No model outputs are used as evidence of
successful writes; the server scores fields and independently audits checkpoints.

## Final results (v5)

| Scenario / seed | Expected behavior | Result | Submission attempts | Writes by replacement agent |
| --- | --- | --- | --- | --- |
| Restart / 1410 | Complete exactly 20 records | Pass | 18 | 11 |
| Restart / 1411 | Complete exactly 20 records | Pass | 18 | 11 |
| Delayed read / 1412 | Wait, reconcile, complete | Pass; 12 incomplete reads | 18 | 11 |
| Duplicate / 1413 | Stop and preserve pending | Pass | 7 | 0 |
| Wrong field / 1414 | Stop and preserve pending | Pass | 7 | 0 |
| Unknown outcome / 1415 | Stop without replay | Pass | 7 | 0 |

Each completion includes two pre-existing exact records and 18 newly submitted
records. All 20 final IDs/fields match the complete checkpoint. Every replacement
runs in a fresh conversation without the old transcript. All final post-agent CDP
session counts are zero. Temporary profiles were deleted, and the owned test Hub
container was stopped/removed; no production data was changed.

For the three blocks, the independent scorer verifies unchanged remote records,
zero replacement writes and unchanged pending/completed checkpoint state. The final
reports accurately name the duplicate, the one-cent field mismatch or the absent
pending key. The duplicate is injected by the fixture, not created by replay.
The 75-attempt total includes the unknown request that never committed; it is not
an accepted-record count. Raw final reports were inspected in addition to automated
keyword screening. No previous-log reads or direct API writes were observed.

Evidence: [case results and per-write audit](evidence/skill-agent-evaluation/checkpoint-v5/results.json),
[summary](evidence/skill-agent-evaluation/checkpoint-v5/summary.json),
[frozen file hashes](evidence/skill-agent-evaluation/checkpoint-v5/metadata.json),
[numeric usage events](evidence/skill-agent-evaluation/checkpoint-v5/events.json).
At the time of this evaluation, all final skill hashes matched the tested v5 snapshot.
The current skill has since changed; archived snapshot overrides preserve those hashes. Aggregate estimated model cost
was $0.0364264; median two-phase case time was 135.36 seconds. These are diagnostic
costs/timings, not paired performance improvements or invoice amounts.

The supporting checks passed: **106 JS tests**, the **two explicitly enabled real
CDP integrations (60 assertions)**, TypeScript checking, skill validation, seven
Python scorer/aggregation tests, and published evidence consistency checks. The
normal JS run skips three opt-in integrations; two were then explicitly run above.
The other server CDP integration is not claimed as rerun. Eighteen checkpoint tests
cover pre-write disk state, commit/reply loss, strong process termination, duplicate/
wrong/incomplete/missing records, identity binding, concurrency, storage errors,
mutable input, and progress failures. A session test reproduces retained-function
reuse and confirms progress attaches to the current execution.

Reproduce with [the recovery runner](../scripts/agent-skill-evaluation/README.md)
on a dedicated loopback Hub. Protocols and intermediate failures remain separate;
passing final results do not overwrite earlier evidence.

## Iterations retained as evidence

The first frozen helper version (v3, seeds 1210–1215) passed 3/6 cases. Every one
of its 34 attempted writes had a valid prior on-disk pending entry, but three tasks
failed before the intended fault scenario could be completed:

- One adapter omitted `read().destination.siteOrigin`; a generic origin error led
  the agent to abandon work before any writes.
- One agent imported its saved script as a module, losing injected session names,
  then attempted synchronous `eval` on an async script; no writes occurred.
- One saved batch function captured an old execution in a custom progress callback.
  The second new record was durably confirmed, but stale progress threw and the
  agent abandoned the remaining work. One CDP connection remained until harness
  profile deletion; this is not claimed as successful agent cleanup.

These are task-completion failures, not silently excluded infrastructure failures.
The [v3 results](evidence/skill-agent-evaluation/checkpoint-v3/results.json) remain
published. The patch names the precise invalid callback field and shows stdin
script execution plus a complete return schema. The session now automatically
binds checkpoint progress to the invoking execution, including retained functions;
explicit stale callbacks get a recovery hint rather than suggesting the session
necessarily disappeared. Business checks still belong in the read callback.

The interface-corrected v4 matrix (seeds 1310–1315) passed **6/6**: three exact
completions and three correct blocks, **75/75 submission attempts** backed by valid prior pending
state. Delayed loading produced 12 actual incomplete reads. Its evidence is
[results](evidence/skill-agent-evaluation/checkpoint-v4/results.json) and
[summary](evidence/skill-agent-evaluation/checkpoint-v4/summary.json). A separate
final matrix includes automatic session progress; versions are not pooled.

The follow-ups used new seeds and all six cases rather than retrying only failures.
Some runs overlapped on independent synthetic profiles, so timing is diagnostic,
not a performance comparison. Raw transcripts remain private. Published records
include per-write revision/pending/confirmed-count audits, checkpoint hashes,
frozen skill hashes, per-phase usage and outcome flags. Block-report keywords are
only a screening check; actual final reports are inspected for correct explanations.
No prior-transcript reads or direct API-write attempts were found in the inspected
replacement-agent tool actions. Prompt restrictions are not a security boundary.

## Scope and remaining limits

This measures real model behavior on a synthetic application, not arbitrary-site
reliability. Six cases are diagnostic evidence, not a statistical reliability claim.
No production accounts or profiles are touched. Durability and lock tests here run
on Linux; other operating systems/filesystems are not validated by these results. The matrix is frozen before running;
all failures must remain in its evidence. Results must not be pooled with the older
speed comparison. A first-phase process termination at injection is intentional.

The helper cannot prove that an adapter's `complete:true` or account identity is
truthful. Site-specific pagination, refresh completion and field extraction remain
adapter responsibilities. The independent harness audits one synthetic site;
application-specific adapters still need testing. Prompt restrictions are not an
OS sandbox, and an agent can bypass the helper with arbitrary code.

A checkpoint path is a local single-writer boundary, not a distributed lock. Two
separate paths do not prevent the same external business operation. Callbacks need
finite timeouts; `budgetMs` is an inter-operation budget, not cancellation of an
in-flight action. The helper deliberately does not expose a clear-pending/retry
switch: an ambiguous absent submission remains blocked until its outcome is
established outside this automatic workflow. Exactly-once remote writes are not
promised without application support.
