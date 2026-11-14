# Scoped adapters and recovery under client disconnect

The checkpoint skill now has an explicit v2 adapter contract. It binds the complete
site scope and write mapping, proves fresh paginated reads, distinguishes business
terminal states, and separates a live proven no-send from an uncertain submission.
The implementation is entirely in the client skill; no Hub deployment is required.
The [adapter reference](../skills/cloakhub-browser/references/batch-work.md) contains
the executable shape and recovery instructions.

## Complete real-agent matrix: adapter-v7

The frozen seven-case run passed **7/7**: four exact completions and three correct
stops, across **11 actual agent phases**. The server independently checked the disk
checkpoint before **13/13 submission attempts**. No wrong-scope write occurred.
Attempts include the intentionally unknown and asynchronously rejected requests;
they are not all successful business records.

| Case | Outcome | Server-received submissions | Replacement-agent submissions |
| --- | --- | ---: | ---: |
| Stale ready marker + pagination | Preserve existing beta ID; complete three intended records | 2 | 0 |
| Scope changes at click | Gate blocks; no request reaches server | 0 | 0 |
| Processing → rejected | Stop; preserve pending/completed exactly | 1 | 0 |
| Unknown outcome | Stop; preserve pending/completed exactly | 1 | 0 |
| Preparation failure | Fix injected error; finish same checkpoint | 3 | 0 |
| Browser + client terminated | Reconcile first commit; complete exactly | 3 | 2 |
| Client terminated, browser survives | Reconcile first commit; complete exactly | 3 | 2 |

All site submissions in the final adapters use the ordinary Save button. The cold
agents receive task artifacts and the original task, not prior transcripts. Manual
review confirmed the injected preparation error was actually observed before repair;
blocked final summaries describe rejection, unknown outcome or scope failure.
The scope summary also exposed an audit-label ambiguity, addressed by the targeted
follow-up below rather than quietly changing this frozen result.

Evidence: [results and per-write audits](evidence/skill-agent-evaluation/adapter-v7/results.json),
[summary](evidence/skill-agent-evaluation/adapter-v7/summary.json),
[frozen hashes](evidence/skill-agent-evaluation/adapter-v7/metadata.json),
[boundary assessment](evidence/skill-agent-evaluation/adapter-v7/assessment.json).
Estimated model cost was $0.02890324; median case duration was 92.643 seconds. Runs
were not a paired speed benchmark; these are diagnostic usage/timing counters.

## Current-source follow-up: adapter-v8

The current skill matches **every hash** in the frozen
[adapter-v8 manifest](evidence/skill-agent-evaluation/adapter-v8/metadata.json).
Relative to v7, only `checkpoint.mjs` and the batch reference changed: the proven
no-send audit now says `stage: not_sent` and keeps `priorStage: sent` separately.
This is a reporting clarification, not a relaxation of the no-replay rule.

The targeted follow-up passed **2/2**, with **3/3 audited submissions**:

- Scope-flip again reached the gate and produced a no-send audit, with zero server
  submissions and no pending record.
- Submit-retry threw before the click, after pending had been armed. The helper
  recorded no-send. The real agent removed the injected error and completed all
  three records using the same checkpoint, without manual clearing or replacement.

Manual review confirmed the actual pre-click error output and the agent's successful
same-checkpoint continuation. The latest source also passed the 22 checkpoint unit
tests and all 15 Node-driven browser cases after the audit-label change. This is a
**targeted follow-up**, not a claim that the complete seven-case matrix was rerun on
v8. See [case results](evidence/skill-agent-evaluation/adapter-v8/results.json),
[assessment](evidence/skill-agent-evaluation/adapter-v8/assessment.json), and
[summary](evidence/skill-agent-evaluation/adapter-v8/summary.json).

All evaluation profiles were deleted, the Hub profile inventory was empty, and the
owned Docker container was stopped/removed. No production browser profile was used.

## Changes

| Previous weakness | Implemented behavior |
| --- | --- |
| Old visible “complete” marker accepted as fresh data | `checkpointRead` accepts only responses to requests initiated during this read; evidence is single-use and bound to the request/page/origin. |
| Pagination or hidden scope omitted | Helper traverses cursor chains, checks total and stable revision, and binds explicit account/workspace/collection IDs. Unknown destination fields fail validation. |
| Visible processing record mistaken for success | Separate `fields`, durable `recordId`, and `confirmed/processing/rejected`; only confirmed completes. Processing/rejected never authorize replay. |
| Target switches between read and click | Declarative paths validate actual JSON body, exact endpoint/method, scope and fields inside the document before native fetch. |
| Pre-click failure creates permanent unknown pending | Prepare precedes pending; live no-send proof cancels reserved validation, closes the owned tab and records an audited `not_sent` rollback (with its prior stage kept separately). Reuse the same checkpoint. |
| Every row requires another full scan | Full scans at invocation entry/exit, exact-key paginated reads around each write. No timing improvement is claimed. |
| Client disconnect releases an intercepted request | Document gate is installed before application code, survives CDP detach, admits one native fetch, and forbids redirect forwarding. |

Pending is fsynced before the document is armed. A possibly sent request never
replays merely because a fresh listing omits it. A new document cannot prove the
old document admitted no request. A process crash leaves pending for reconciliation,
even if its stage is only prepared. Local locking and atomic checkpoint replacement
remain; legacy checkpoint identities are rejected, not silently upgraded.

The helper owns a disposable `checkpointPage(context, url)` for each invocation and
closes it after success/error. Existing user tabs must not be passed in. Normal
session progress still attaches to the current execution, including saved functions.

## A failure that changed the design

An additional real Chromium probe killed only the CDP client, leaving the browser
running. With Playwright routing paused before validation, the server saw **0 writes
before kill and 1 afterward**. With `route.fetch` already used, it saw **1 before kill
and 2 afterward**. A paused browser request is not a durable write barrier. The
intermediate routing implementation was therefore replaced, not presented as safe.

The final document gate reserves one approval before asynchronous JSON parsing.
Disarming cancels an unfinished reservation; a denied second fetch cannot erase that
cancellation. Native fetch is called once, with `redirect: 'error'`. Two regression
cases kill the client while keeping the browser alive: a delayed wrong-scope request
stays blocked; a committed request stays single and a new client reconciles it.

Actual CloakBrowser testing also caught a non-secure-context failure: `crypto.randomUUID`
is unavailable on the Docker gateway's HTTP origin. The gate now uses `getRandomValues`
and validates initialization during page creation. The isolated Hub probe confirmed
`isSecureContext=false`, no randomUUID, and successful gate initialization.

## Supported adapters and limits

This is a deliberately bounded adapter contract, not universal website recovery:

- Authoritative same-origin JSON reads must expose explicit identity, total, cursor,
  revision, durable IDs and meaningful business status. DOM-only tables without
  equivalent evidence are unsupported; neither the helper nor agent may invent it.
- Writes must use one JSON fetch with identity and all intended fields available in
  the body. The declarative mapping is hashed into checkpoint identity. Native form
  POST, XHR writes, workers, service workers, WebSockets, POST queries, mutating GETs,
  autosave and multi-request commits are outside this contract.
- Instrumentation is an accidental-error guard, not a sandbox against hostile site
  scripts or arbitrary agent code. It does not control other clients or independent
  profiles. Cookie principal changes still require backend authorization and stable
  task login; body identifiers alone cannot prove authentication identity.
- Client-side checks do not provide global exactly-once semantics. Concurrent writers
  need server uniqueness/idempotency. An unknown outcome may remain blocked until
  authoritative reconciliation is possible.
- Read-only discovery is part of adaptation: inspect the actual response and query
  behavior before declaring unsupported. Empty results do not mean absent capability.

The real-agent environment uses a deterministic local website in an isolated release
Hub, not a third-party authenticated production site. These tests establish behavior
for specified boundary cases, not universal website coverage or a population success rate.

## Verification environment

The actual-agent runs use Pi 1.5.0, `openai/gpt-6-luna`, medium thinking, release Hub
1.2.0 and CloakBrowser **156.0.8078.47**, with skill-pinned Playwright **1.63.0**.
The deterministic local browser regressions and routing-disconnect probe use Google
Chrome for Testing **158.0.8127.18**, not CloakBrowser. The separate stock-browser and
release-Hub evidence must not be conflated.

The [protocol](evidence/skill-agent-evaluation/adapter-protocol.md) defines the case
expectations and records scorer/fixture corrections. The
[routing probe source and counters](evidence/skill-agent-evaluation/route-disconnect-probe/results.json)
preserve the failure that motivated the document gate. Private transcripts remain
under ignored `.cloakhub` directories. Published source snapshots and per-write audits
are synthetic fixture data; no production records or credentials were used.

Final source checks: **110 ordinary JS tests passed** (four opt-in skips), **15 browser
boundary scenarios passed** through the Node driver, both explicitly enabled CDP
skill integrations passed (60 assertions), TypeScript checking and skill validation
passed. The Bun wrapper adds one assertion for the Node driver. The separate server
CDP integration was not rerun. Twenty-two checkpoint unit tests include a 20-record
bounded continuation, dead-owner recovery and rejection without closing user-owned tabs. Existing seven Python evaluation tests passed.

## Diagnostic runs retained

| Frozen run | Raw passes | Accepted exercised cases | Main issue identified |
| --- | ---: | ---: | --- |
| [adapter-v1](evidence/skill-agent-evaluation/adapter-v1/results.json) | 4/5 | 4/5 | Early capability refusal; later review found a bad relative read URL in the fixture. |
| [adapter-v2](evidence/skill-agent-evaluation/adapter-v2/results.json) | 2/6 | 1/6 | Bad read URL, schema mapping/refusal; zero-attempt scope refusal was overcounted. |
| [adapter-v3](evidence/skill-agent-evaluation/adapter-v3/results.json) | 3/6 | 3/6 | Same fixture issue and cold-agent adoption failures. Routing design was then discarded after the disconnect probe. |
| [adapter-v4](evidence/skill-agent-evaluation/adapter-v4/results.json) | 1/7 | 0/7 | Corrected fixture, but document gate failed on insecure HTTP; raw scope refusal was not gate adoption. |
| [adapter-v5](evidence/skill-agent-evaluation/adapter-v5/results.json) | 6/7 | 6/7 | Gate works; agent misread opaque `{}` evidence as no capture. |
| [adapter-v6](evidence/skill-agent-evaluation/adapter-v6/results.json) | 5/7 | 5/7 | One agent demanded a sample from an empty collection; one cold adapter had invalid record mapping. |
| [adapter-v7](evidence/skill-agent-evaluation/adapter-v7/results.json) | 7/7 | 7/7 | Full declared matrix exercised successfully. |

These are development diagnostics with changing code, instructions, fixture and
scorer, not comparable success-rate samples or a causal ablation. No failed case
was dropped or merged into the successful final matrix. Raw scoring is preserved;
`assessment.json` additionally prevents an unexercised refusal from counting as an
accepted gate test. Each directory contains restorable skill/runner source snapshots
and verified hashes. One success per boundary is not a reliability population estimate.
