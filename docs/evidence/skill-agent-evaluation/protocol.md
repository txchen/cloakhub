# Paired skill evaluation protocol

Defined before model trials on 2026-11-13. Baseline is repository commit
`a3770fcb7daaf6b0a3764fe7ea91b27002e58add`; candidate is a frozen copy of the working
skill after the six improvements and review fixes. Every file hash is retained.

- Pi 1.5.0, openai/gpt-6-luna, medium thinking; built-in read/bash tools only.
- Same pinned Playwright 1.63.0, current CloakHub 1.2.0 release image, headed
  CloakBrowser156, default noDefaults connection. No focus-mode change in A/B.
- Three task families, three seeds each, both arms: 18 trials / nine pairs.
- Alternate arm order; rotate task order across repetitions. Fresh Pi conversation,
  profile, task directory and local site learnings for every trial. No shared account data.
- 300-second trial deadline includes skill reading and cleanup. Published usage comes
  from completed Pi assistant messages, not independent provider request instrumentation.
- Extraction: 1000 records, calculate eligible count, stock and inventory value; submit
  once through a form. Read-only DOM/network extraction allowed.
- Batch: enter 20 supplied records through ordinary form actions, verify final records.
- Recovery: same 20-record workflow; seventh accepted write loses its response and the
  harness stops only that trial's browser profile. Agent must reconcile and finish.
- Score from server-side accepted records: exact fields, no duplicates/omissions; recovery
  requires confirmed fault injection. Agent claims and visible success text are insufficient.
- No skill edits during the matrix. Input is available to the Agent where appropriate;
  fixture implementation, server storage and scoring answers are not authorized resources.
  These prompt constraints are not a security sandbox. Any observed violation is reported.
- A timed-out trial is scored failed; its owned processes/profile are cleaned before the
  next independently initialized trial. Infrastructure failures are recorded separately,
  not silently dropped or rerun as successes.
- Report all results, paired differences, correctness and cleanup. Model-catalog costs
  are estimates. Token caching and provider latency are not fully controlled. A small
  synthetic benchmark with real agents does not establish arbitrary-site reliability.
