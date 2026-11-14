# Final checkpoint/session integration validation

A v3 task also retained a function whose custom progress callback captured an old
execution. It safely persisted two new records but then abandoned work after the
stale-progress error. The final session API binds checkpoint progress to the
invoking execution automatically using AsyncLocalStorage. The guide omits custom
onProgress from the standard recipe and stale-execution errors explain recovery.
The checkpoint state machine is unchanged from v4.

Repeat all six scenarios with fresh seeds 1410–1415 and a new frozen snapshot,
not just the previously failing cases. Preserve v3/v4 results separately. v4 and
this final run may overlap on separate synthetic profiles; no speed comparison
is claimed. All original write-audit, complete/block and cold-agent criteria apply.
