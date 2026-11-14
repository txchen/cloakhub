# Durable batches (adapter contract v2)

Use `checkpointBatch` for authorized repeated creation of records, including the
first record. Supported intent is **ensure_exists**: exactly matching, already
confirmed records satisfy the task. This is not a payment or message-delivery API.

Save input and an executable adapter script in a private task directory before
writing. Reuse one absolute checkpoint path, operation and adapterVersion. A cold
agent must inspect these artifacts first, never start a fresh checkpoint to bypass
pending work. v1 checkpoints require explicit reconciliation; no automatic migration.

## Required adapter capabilities

The site must expose fresh authoritative JSON reads with a stable dataset revision,
exact-key filtering, total count and cursor pagination. Records must expose durable
IDs and a business terminal status. A successful HTTP response or a visible row is
not necessarily business success. If these capabilities cannot be established from
observed site behavior, stop and report the unsupported capability. Do not invent a
revision, total, account identity or terminal status to satisfy the schema.

The helper owns and closes a **new dedicated task page on every call**, including
failure. Never pass an existing user tab. Use `await checkpointPage(context, taskUrl)` to install the document gate BEFORE
navigation to the same task URL for each bounded call or recovery. It retains the profile's cookies.
Do not open popups or use service-worker-controlled pages. Read operations must use
GET/HEAD. Writes must be a single JSON `fetch` with identity and input fields
extractable from its body. Native form POSTs, XHR writes, POST queries, autosaving
forms, workers, WebSockets, mutating GET endpoints and multi-request commits are
unsupported. The gate blocks these transport paths in the task document; it is not
a universal interceptor for arbitrary websites. Detect these before using this workflow.
The request gate is an accidental-error guard, not a sandbox for untrusted adapters.

Bind the entire destination, not just account:

```js
const destination = {
  siteOrigin: 'https://example.test', accountKey: 'observed-account-id',
  scope: { workspaceId: 'observed-workspace-id', collectionId: 'observed-list-id' }
};
```

Include every scope dimension affecting writes. For genuinely account-wide data,
use an explicit `{ resource: 'observed-resource-name' }`. Unknown top-level fields
are rejected. Keep the same representation in reads and outbound request parsing.

## Establish capabilities before declaring unsupported

An empty list is not a reason to stop before inspecting its response. First capture a
fresh response from Refresh/navigation, or issue a browser-side GET to the observed
read endpoint. Inspect the envelope's destination, revision, total and cursors, then
check exact-key filtering with a known input key. This is read-only discovery; it
needs no checkpoint and no write permission beyond the existing task.

If capture missed the initial response, attach the listener and trigger Refresh again.
Do not conclude that a response/schema is unavailable just because the first UI
snapshot did not include it. Use observed application documentation for record ID,
field and business-status mappings; an empty response cannot provide sample records.
For an empty collection, an explicit application/API response schema is sufficient
to choose record-field/ID/status mappings. **Do not require a preexisting sample row
before the first authorized write when that schema is documented.** Use the schema
for the adapter, then verify the actual first saved record through the helper.
When the schema and read capabilities are established, run the first authorized
record with `maxItems: 1` and inspect the authoritative result before continuing.
If actual inspection shows missing capabilities, report specifically what is missing
and what read was attempted. Do not invent metadata to continue.

## Adapter shape

These functions are injected into `run` and session scripts: `checkpointBatch`,
`checkpointPage` and `checkpointRead`. Do not import internal modules or provide target metadata.
The example shows structure; replace selectors and response mappings with observed
site semantics. Keep all callbacks bounded with operation timeouts.

```js
const page = await checkpointPage(context, taskUrl); // gate installed before app code
const result = await checkpointBatch({
  path: checkpointPath, operation: 'catalog-entry', adapterVersion: 'site-api-v1',
  intent: 'ensure_exists', page, rows, destination, maxItems: 10,
  read: async request => {
    // request: { key: null|string, cursor: null|string, nonce }
    // key=null requests the full scope; otherwise exact-key lookup, still paginated.
    const url = new URL('/api/records', taskUrl);
    if (request.key !== null) url.searchParams.set('key', request.key);
    if (request.cursor !== null) url.searchParams.set('cursor', request.cursor);
    const captured = await checkpointRead(page, request, {
      match: response => response.url() === url.href,
      // Browser-side read of an observed endpoint; writes remain ordinary UI actions.
      trigger: () => page.evaluate(url => fetch(url).then(r => r.json()), url.href)
    });
    const data = captured.json;
    return {
      evidence: captured.evidence,
      destination: data.destination, // server-observed identity on EVERY read
      cursor: data.cursor, nextCursor: data.nextCursor,
      total: data.total, revision: data.revision,
      records: data.records.map(r => ({
        recordId: r.id, fields: { key: r.key, name: r.name },
        status: r.status // map observed business states to confirmed/processing/rejected
      }))
    };
  },
  prepare: async row => {
    await page.getByLabel('Key', { exact: true }).fill(row.key);
    await page.getByLabel('Name', { exact: true }).fill(row.name);
  },
  // Declarative JSON paths, evaluated inside the document against the ACTUAL body.
  // No closures or cached DOM identities. Include every input field and scope ID.
  write: {
    url: new URL('/api/records', taskUrl).href, method: 'POST',
    accountKey: ['accountId'],
    scope: { workspaceId: ['workspaceId'], collectionId: ['collectionId'] },
    fields: { key: ['key'], name: ['name'] }
  },
  submit: async () => {
    // Await the actual request/response so delayed UI work remains within commit.
    await Promise.all([
      page.waitForResponse(r => r.request().method() === 'POST'),
      page.getByRole('button', { name: 'Save', exact: true }).click()
    ]);
  }
});
console.log(result);
```

Use separate `fields` to avoid collisions between input fields and record metadata.
Exact types matter. The helper traverses and validates pagination, counts, revisions,
unique keys/IDs and prior confirmed records. It captures only responses to requests
started during this particular read, rejecting reused evidence and old UI markers.
Pass `captured.evidence` directly to the read result in the same invocation. It is
an in-memory receipt (kind: fresh-response), not a JSON dataset to inspect for records.
Its hidden binding is checked by the helper; do not clone/serialize it, save it for
later, rebuild it from displayed metadata, or declare capture unsupported because
the receipt contains no record fields. Inspect `captured.json` for site capabilities.
It cannot prove the semantic accuracy of an adapter's JSON mapping or backend data.

Save the adapter as a script body and execute on stdin:

```sh
node /absolute/skill/scripts/browser.mjs run --target ALIAS < /private/task/adapter.js
# Or within a task session (context is already injected):
node /absolute/skill/scripts/browser.mjs session exec SOCKET < /private/task/adapter.js
```

A separately imported module does not inherit injected variables. Task sessions
report progress automatically; omit callbacks capturing a stale `execution` object.

## Recovery transitions

The helper writes private, fsynced, atomically replaced v2 checkpoints. It holds a
per-path single-writer lock, reclaiming only a provably dead same-host owner.
It records `pending.stage=prepared` before submit and `sent` before arming a single request inside the document. The gate validates the actual
JSON body/endpoint synchronously before native fetch is admitted, rejects wrong
scope/fields and multiple writes, and forces redirect:error. It stays installed when
the CDP client disconnects. It closes the dedicated tab on normal return/failure.
Playwright route interception is deliberately not used for writes: Chromium can
release paused requests on client disconnect, causing unvalidated or duplicate writes.

- `complete`: full final scan confirmed every intended record and durable ID.
- `active`: batch bound reached; rerun the same adapter/path with a fresh task tab.
- `PROCESSING`: preserve pending and perform later read-only reconciliation by
  rerunning the helper. Do not convert processing into success or retry creation.
- `REJECTED`, `MISMATCH`, `DUPLICATE`, changed identity: stop and report the conflict.
- `PENDING`: absent record after a possibly sent request is unknown; no replay.
- `NOT_SENT` or a submit error with a `notSent` audit entry and null pending:
  the live document gate admitted no request, cancelled any reserved validation, and closed the tab. Its audit entry has `stage: "not_sent"`; `priorStage: "sent"` means the gate
  had been armed, not that a request reached the server. Fix the adapter and rerun
  the same path. No manual checkpoint edits are needed.

A process crash while pending (even `prepared`) remains uncertain. Only the live
helper can establish no-send; a replacement agent may not infer it from an absent
record. Pre-commit preparation errors have no pending write. Durable `sent` means
possibly sent, not receipt or success. A network failure can remain blocked forever
without authoritative reconciliation; this is intentional.

The helper performs full scans at entry/exit and exact-key lookups per submission.
`maxItems` defaults to 10, maximum 100; `budgetMs` defaults to 120000, checked before
reads/writes but cannot cancel arbitrary callback code. Use finite callback timeouts.
A stable paginated revision can change between scans; the site still needs uniqueness
or idempotency against concurrent writers. Separate checkpoint paths and other clients
are not coordinated. No exactly-once promise; no new action authorization.

Account IDs in request data still rely on the site's authentication semantics; the
gate cannot prove which principal a concurrently changed cookie will authenticate.
Use an isolated task profile with stable login and backend authorization/uniqueness.
If those assumptions do not hold, the adapter cannot claim this recovery guarantee.

The `write` mapping is part of checkpoint identity. Use exact URL without query
parameters/credentials, HTTP method, JSON path arrays for accountKey, each scope ID
and every input field. A request body with nested destination/fields uses paths like
`['destination','accountKey']`, `['destination','scope','collectionId']`, and
`['fields','key']`. Read the actual request schema before choosing paths.
The runtime fetch wrapper is helper instrumentation, not permission to alter site
business state or rewrite a mismatched request. Do not substitute a plain newPage,
overwrite the wrapper, or use raw Playwright routing to bypass the gate.
