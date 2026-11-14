# Paired skill evaluation with real agents

Follow-up: [durable checkpoints and cold-agent recovery](checkpoint-recovery-evaluation.md)
replaces the document-only checkpoint recipe with an executable helper and separately
tests process replacement, checkpoint adoption and blocked outcomes. The historical
measurements below remain unchanged.

Evaluated 2026-11-13. Actual Pi agents operate a synthetic inventory application
through released CloakHub 1.2.0 / CloakBrowser 156.0.8078.47.1. These are real
model-driven tasks, not scripted replays, but not a benchmark of external websites.

## Design and evidence

The [predeclared protocol](evidence/skill-agent-evaluation/protocol.md) compares
baseline commit `a3770fcb7daaf6b0a3764fe7ea91b27002e58add` with a frozen snapshot of
the six improvements and review fixes. Both include task sessions. Each arm gets
three seeds for each of three task families: 18 trials, nine pairs. The model is
`openai/gpt-6-luna`, medium thinking, Pi 1.5.0. Both arms share pinned Playwright
1.63.0 and the same released browser image. Arm order alternates; task order rotates.

Each run gets a new conversation, private workspace, browser profile and empty
site-learnings directory. No production account or data is used. Agents can read
DOM/network data but must write through UI forms. Server-side accepted records,
not model claims or success toasts, determine business correctness. There is a
300-second deadline including reading the skill and cleanup, excluding profile
startup. The full matrix retains failures.

- **Extraction:** load 1,000 inventory records, filter by stock/price, calculate
  count, total stock and exact cent value, submit exactly one summary.
- **Batch:** enter 20 distinct records through forms with exact fields and no
  duplicate or missing business keys.
- **Recovery:** after accepting the seventh write, lose its HTTP response and
  stop that trial's browser. Reconnect and finish with the same exact-set checks.

The [runner and reproduction instructions](../scripts/agent-skill-evaluation/README.md)
include the fixture, independent scorer and aggregation tests. Frozen file hashes
identify the tested skill; later fixes must be reported as separate runs. Raw
transcripts remain in the ignored private run directory. Published usage events
contain counters/tool names, not prompts, reasoning or account data.

## Original paired results

All 18 trials completed without timeout or fixture-stop errors. Baseline passed 9/9;
the frozen candidate passed 8/9. All profiles were deleted afterward; every measured
post-agent CDP session count was zero. The candidate failure is retained below.

| Task | Baseline → candidate correct | Median seconds | Mean model calls | Mean estimated USD/task |
| --- | --- | --- | --- | --- |
| Extraction | 3/3 → 3/3 | 61.618 → 51.217 | 12.67 → 8.67 | 0.003097 → 0.001974 |
| Batch | 3/3 → 3/3 | 64.374 → 59.686 | 11.33 → 8.67 | 0.003180 → 0.002369 |
| Recovery | 3/3 → 2/3 | 99.671 → 85.154 | 12.33 → 13.67 | 0.003839 → 0.003516 |

Time and cost include failed runs; they must not be interpreted independently of
correctness. Extraction improved in all three pairs (8.021–23.251 seconds faster).
Its median time was 16.9% lower and mean estimated cost 36.3% lower. All candidate
extraction runs used response projection; baseline runs saved captures and computed
from files. This supports keeping structured extraction as a first-class workflow.

Batch performance varied: candidate time differences were +6.658, −2.514 and
−51.233 seconds. One slow baseline run accounts for much of the average benefit.
Recovery's lower median does not establish an improvement because correctness fell.
Do not average these families into a single product “speedup”.

| Task | Mean input tokens, old → new | Mean cache-read tokens | Mean output tokens |
| --- | --- | --- | --- |
| Extraction | 14,245.67 → 9,648.33 | 80,341.33 → 34,517.33 | 1,737.33 → 1,328 |
| Batch | 15,033.33 → 12,684 | 73,856 → 36,224 | 1,876 → 1,477.33 |
| Recovery | 19,813 → 14,520.67 | 83,242.67 → 91,221.33 | 2,051 → 2,302.67 |

Inspect [per-trial results](evidence/skill-agent-evaluation/v1/results.json),
[paired differences](evidence/skill-agent-evaluation/v1/summary.json),
[usage events](evidence/skill-agent-evaluation/v1/events.json) and
[frozen hashes](evidence/skill-agent-evaluation/v1/metadata.json).

## Observed recovery failure

In candidate recovery seed 810, the agent read concatenated row `textContent` and
split on whitespace to infer business keys. Adjacent table cells have no guaranteed
separator: the actual text started `record-1ITEM-001商品 ...`. Its inferred set
therefore omitted already committed keys. It submitted ITEM-001 again, encountered
a strict-locator error from two matching cells, then switched to cell-level reads
and completed the remaining records. The server retained **21 records for 20 keys**.
This is a business failure even though the process exited successfully.

The recovery guidance was read indirectly through the batch recipe, but the agent
did not establish a validated structured reconciliation gate or durable checkpoint.
The other successful recovery runs also show that eventual correctness does not
prove adoption of the intended checkpoint workflow. The failure is evidence that
instructions were insufficient for this execution, not proof that the new helpers
caused duplicate writes in general.

## Separate post-fix recovery regression

After freezing the original evidence, the recovery entrypoint and reference were
revised and three new current-only trials used seeds 910–912 under the
[follow-up protocol](evidence/skill-agent-evaluation/recovery-followup-protocol.md).
All three passed with exactly 20 accepted records, zero duplicates/omissions,
confirmed fault injection, no timeout and zero remaining CDP sessions. Times were
114.868, 96.620 and 81.550 seconds (median 96.620); mean model calls 13.67 and mean
estimated cost $0.003978. These unpaired new seeds are not a speed comparison.

[Results](evidence/skill-agent-evaluation/recovery-v2/results.json),
[summary](evidence/skill-agent-evaluation/recovery-v2/summary.json),
[usage](evidence/skill-agent-evaluation/recovery-v2/events.json) and
[hashes](evidence/skill-agent-evaluation/recovery-v2/metadata.json) remain separate
from v1. Every follow-up read the recovery reference. The first two visibly
checked structured cells, duplicate keys and fields before resuming. The third
used cell reads but still resumed by observed ordinal position without an equally
complete reconciliation gate. No durable checkpoint was written. Thus the observed
failure did not recur, but complete procedure adoption is **not established**.

Both matrices finished normally; trial profiles were deleted and the owned
loopback Hub container was stopped/removed. No production profile was modified.
The scorer/aggregation tests, published-metric consistency checks, skill validator,
JavaScript syntax checks and whitespace checks passed. This follow-up changed
instructions and evaluation tooling only; existing helper regression results are
not presented as a newly rerun suite.

## Product implications

Keep structured extraction and the corrected helper contracts. The new extraction
path consistently reduced work in this sample. Keep foreground behavior as-is;
the separate [156 background experiment](background-tabs-evaluation.md) supports
page-scoped opt-in research, not a default focus change.

The [behavior audit](evidence/skill-agent-evaluation/v1/behavior-audit.json) found
projection in all three candidate extraction runs and explicit progress reporting
in two candidate runs. No original trial wrote a durable checkpoint. Most did not
explicitly close their task page. Correct server outcomes therefore do not certify
full workflow adoption or cleanup.

The observed recovery failure prompted a narrow change in `SKILL.md` and
`references/recovery.md`: recovery is now a before-next-write gate with structured
field extraction, completeness, exact key/field comparison and duplicate detection.
No new runtime abstraction or browser default was added. The post-fix trials use
fresh data and are reported separately.

Next acceptance work should target behavior that this matrix did not establish:

1. **Checkpoint adoption:** exercise long batches with a second process losing all
   prior transcript context. Require destination/input identity, a durable pending
   key before submission, confirmed IDs and reconciliation after restart. Count
   actual checkpoint writes, not just final business success. If agents continue
   omitting the recipe, evaluate a small executable checkpoint primitive against
   the document-only approach before expanding skill prose.
2. **Recovery breadth:** add delayed record-list refresh, pagination, a pre-existing
   duplicate and an existing record with one wrong field. Expected behavior for
   ambiguity is stopping writes with an accurate report, not forcing task success.
3. **Cleanup and learning reuse:** measure remaining task-owned tabs before profile
   deletion; run a second distinct task with saved site recipes, including stale
   recipes. Keep correctness and context cost separate. This initial cold-start
   evaluation cannot establish reuse benefits.

## Interpretation limits

Three pairs per task are diagnostic, not statistically established reliability or
latency improvements. Model latency, prompt caching and response sampling vary.
Costs are Pi model-catalog estimates, not invoices. `model_calls` counts completed
assistant messages, not independently measured provider HTTP requests. Input,
cache-read and output tokens are reported separately.

The comparison measures the combined skill package; it does not isolate each of
six changes. Every run starts with empty learnings, so it does not establish
cross-task learning benefits. Recovery stops the browser, so in-memory execution
history cannot survive it. Session-history/timeout edge cases remain covered by
deterministic tests, not by attributing every recovery success to that mechanism.

The synthetic app has no pagination, authentication, challenges or competing users.
The fault deliberately makes a committed write uncertain; it is one recovery shape,
not all distributed-write failure modes. Agent restrictions are instructions, not
an operating-system sandbox. Review tool actions for violations. Zero remaining
CDP sessions establishes connection release only: task-tab closure was not
independently scored before profile deletion.
