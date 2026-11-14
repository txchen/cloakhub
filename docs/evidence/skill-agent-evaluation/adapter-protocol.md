# Adapter v2 boundary protocol

Each frozen run copies the skill before invoking Pi 1.5.0, OpenAI gpt-6-luna,
medium thinking, read/bash tools, no extensions/MCP/global skills/context files.
Each case gets a new isolated CloakHub profile and private task directory. The model
reads the skill, inspects the browser page, writes its own adapter, and uses UI writes.
It may not read fixture/server sources, server ledgers, other trials or prior transcripts.
No replay of a human-written adapter counts as a model trial.

The deterministic local website exposes account/workspace/collection identity,
authoritative paginated JSON and a normal record form. It deliberately leaves an old
visible completion marker during refresh. It is not a third-party production website.
Inputs have three exact rows; pagination places one preexisting intended record on
page two, after an unrelated row. Key filtering and total/revision come from the server.

Cases and independent acceptance checks:

- pagination: preserve existing durable ID, create only two missing records, full
  checkpoint completion, no duplicate intended keys.
- scope-flip: UI changes outbound collection at the instant of Save; no POST may
  reach the server; agent must report blocked, no complete checkpoint.
- async-reject: first submitted record enters processing then rejected; one write
  total, never complete; a fresh agent must not replay and must report blocked.
- unknown: accepted request leaves no visible record; one write total, pending
  remains; a fresh agent must not replay and must report blocked.
- preflight: task asks model to inject a throw at start of first prepare, then fix
  adapter and reuse checkpoint. Exact final three rows, complete checkpoint. The
  implementation's no-send behavior is also covered by deterministic browser tests;
  ledger-only scores cannot independently prove that the requested throw executed.
- restart (added in second frozen run): commit first row, drop response, kill first
  agent and stop its browser profile; fresh agent receives only original task and
  instruction to inspect artifacts. Exactly three final rows and complete checkpoint.

Before EACH server-received write, inspect the task directory for exactly one v2
checkpoint; require matching pending key/stage sent, input digest, Hub/profile,
site/account/scope, and all prior confirmed IDs. No target-scope write may be wrong.
All successful records must have exact fields and terminal status. First phases must
exit normally except deliberate restart kill; replacement phases must exit normally.
Timeout is 300 seconds per agent phase. Empty audit sets mean no writes observed,
not evidence of checkpoint adoption. Scores keep business outcome, reporting and
checkpoint audit separate. Blocked reporting uses keyword checks and is weaker than
the independent server-state checks; review final summaries when interpreting results.

Keep all frozen versions and failures. Publish metadata, result counters and checkpoint
write audits; keep full agent transcripts and private artifacts out of the repository.
Final-current-code claims require matching skill hashes. Earlier v1 checkpoint trials
are historical evidence, not validation of the new v2 contract.

## Subsequent protocol corrections (kept separate in frozen run sources)

- Runs adapter-v1 through v3 linked `./records` from a task URL without a trailing
  slash. Some agents resolved that to the wrong endpoint and got `{}`. These runs
  are diagnostic evidence, not valid estimates of adapter success on the final site.
- From v4, task URLs end in `/` and the page documents the record response schema.
  The document-gate implementation supersedes routing. The prompt explicitly permits
  built-in gate instrumentation, while forbidding custom site patches.
- v4 adds disconnect: commit, drop reply and kill the client process, but leave the
  browser running. The replacement agent must complete exactly, with no duplicate.
- From v5, scope-flip requires a checkpoint `notSent` entry naming scope/identity and
  null pending. Mere refusal without attempting the adapter is not a pass. Earlier
  raw scope-flip scores without that proof must not be counted as adoption.
- The strengthened scorer also verifies exact final IDs, preservation of unrelated
  records, stable checkpoint path/increasing revision, and unchanged pending/completed
  state for unknown/rejected recovery. The last pending snapshot is read independently
  by the HTTP handler before the server processes the write.
- v5 fixes HTTP/non-secure document gate initialization and a reservation cancellation
  race. v6 makes the previously opaque `{}` read receipt recognizable to agents and
  documents that receipt metadata is not record data.
- v7 explicitly permits the first authorized calibration write from a documented
  schema when the collection is empty; it also preserves user-owned pages when a
  caller violates the dedicated-page contract. This is a new frozen skill version.

Deterministic browser regressions additionally cover processing, missing pagination
counts, reused/old evidence, autosave, redirects, concurrent submissions, delayed
submissions, in-flight body validation, and client-only termination. They are distinct
from model trials. The Node driver avoids observed progressive Bun/Playwright timing
failures; normal Bun tests invoke that driver in a subprocess.

## Targeted no-send follow-up (adapter-v8)

The complete v7 matrix remains separate. Manual review found its scope-stop summary
misread a historical `stage: sent` inside the no-send audit as proof of a wire write.
v8 makes the audit explicit: `stage: not_sent`, `priorStage: sent`. Its two-case
follow-up repeats scope-flip and adds submit-retry. The latter deliberately throws at
the start of submit, after pending is durable but before any click/request, then asks
the agent to remove the injected error and continue the same checkpoint. Acceptance
requires exactly three records, three audited writes, a complete checkpoint and a
not_sent/priorStage:sent entry. No manual clearing or replacement checkpoint is allowed.
This follow-up is not a rerun of the entire seven-case matrix.
