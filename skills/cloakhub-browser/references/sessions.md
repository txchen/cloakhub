# Task sessions

Use a session for multi-round tasks that reuse pages, helpers or accumulated data.
Use ordinary `run` for a single script. Sessions require Unix domain sockets (Linux/macOS).

```sh
node /absolute/skill/scripts/browser.mjs session start --target work
# Save the returned session socket path as the task's session ID.
node /absolute/skill/scripts/browser.mjs session exec /tmp/cloakhub-session-EXAMPLE/control.sock <<'JS'
state.page = await context.newPage();
console.log({ taskTab: await tabId(state.page), label: 'research' });
await state.page.goto('https://example.com');
console.log(await observe(state.page));
JS
# Next round: same socket, same page and accumulated data. Initialize once.
node /absolute/skill/scripts/browser.mjs session exec /tmp/cloakhub-session-EXAMPLE/control.sock <<'JS'
state.rows ??= [];
state.record ??= async () => state.rows.push({ title: await state.page.title() });
await state.record();
console.log({ count: state.rows.length, last: state.rows.at(-1) });
JS
# A later round can call state.record() again without defining it or reopening the page.
# After a handoff, inspect retained names/types before deciding what to reuse.
node /absolute/skill/scripts/browser.mjs session status /tmp/cloakhub-session-EXAMPLE/control.sock
node /absolute/skill/scripts/browser.mjs session end /tmp/cloakhub-session-EXAMPLE/control.sock
```

Store cross-round values and functions on `state`. Local `const`/`let` declarations
belong to one call. Dynamic imports work. The target is fixed at start; repeat the
session ID and task tab ID in handoffs. Calls on a session execute one at a time;
a concurrent call is rejected, not queued. Different sessions still share profile tabs. Keep execution asynchronous: a CPU-bound
synchronous loop can block Playwright handling of CDP target events and stall other
clients on the same profile until that worker is terminated. Use separate profiles
for independent concurrent tasks, and run CPU-heavy work outside the browser executor.

`session status` returns `running`, `completedExecutions`, `executionTimeoutMs`,
`currentExecution` (ID, start/deadline and explicit progress), `lastExecution` and the last
ten `recentExecutions` (ID, `ok`, duration, progress and bounded error/hint), plus `state`
entries with `name` and `type`. These are execution outcomes, not independent business verification. It lists at
most 50 entries, with `stateCount` and `stateTruncated`. Values are not printed,
and getters are not invoked. Use short descriptive property names rather than
account data. Status does not verify that a retained page is still open.

Initialize state once, then append or update it; repeating `state.rows = []` discards
previous data. `delete state.rows` explicitly releases a saved value. Closing a tab
does not remove its saved reference: delete or replace that reference afterwards.
A script error does not roll back state mutations or browser effects. Inspect the
retained data/page before continuing; never repeat submissions merely to rebuild
local variables. A ReferenceError includes a reminder to use explicit `state`.

Results are JSON with `ok`, `executionId`, captured `output`, `truncated`, and optional `error`/`hint`. Errors are capped at 2000 characters with `errorTruncated: true`
when shortened.
Console output is credential-filtered and capped at 65,536 characters; save large datasets to a
client file and print counts, selected fields and a small sample. This is trusted local
code execution with the user's permissions, not a sandbox or a complete secret boundary.

Scripts also receive `execution.id`, `execution.deadlineAt`, `execution.remainingMs()` and
`execution.reportProgress(json)`. Progress is optional JSON under 2048 characters, exposed
by status even while asynchronous work runs; report counts/phase names, not account data.
Synchronous code can block status until the watchdog terminates the worker.

Sessions expire after five minutes without execution and default to a two-minute
execution deadline. `session start --target work --timeout-ms 240000` selects a different
budget (1000..600000 ms); client response waiting and the independent watchdog follow it.
Prefer [bounded batches](batch-work.md) and checkpoints before increasing this limit. `status` does not extend the lease. A disconnected browser ends
the session; there is no automatic reconnect or command replay. On timeout or lost
response, assume effects may have occurred: inspect the site through a new connection
before retrying. Variables disappear on termination; save durable checkpoints to files.

End the session in task cleanup, including failure/cancellation. End drops CDP but
preserves browser tabs and profile data. Close only task-created intermediate tabs
before ending. An open session prevents the server's idle sleep. For long human waits,
end the session and resume with fresh tab discovery afterwards. A hard-killed worker
can leave its private temporary directory; an unreachable socket is not a live session.

Batch predictable work into one call, returning when observations change the next decision.
Authorized repeated writes can share a call when each record has a verified business
postcondition and checkpoint; stop on unknown results. See [batch work](batch-work.md).
Use `observe(page, { scope })` on the relevant area; extract only required response
fields with `captureResponses`. Retain helpers and intermediate datasets in `state`
instead of printing or rebuilding them each round.

For lost replies and partial work, follow [recovery](recovery.md).
