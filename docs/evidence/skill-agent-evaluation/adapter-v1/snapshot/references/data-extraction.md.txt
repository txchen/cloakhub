# Structured data extraction

Use this for lists, calculations, pagination, or incomplete network captures. Prefer a
known DOM locator for a small visible value; network inspection is not a prerequisite
for every interaction. Validate units, currency, row identity and pagination semantics.

## Discover, then project

Listen around the UI action that loads the data. A known URL filter avoids unrelated
traffic. If the endpoint is unknown, capture a bounded sample and inspect URL/status/keys;
response size is only a clue. Capture completion means the selected observation window
finished, not that all application records or all pages were collected.

```js
const result = await captureResponses(state.page, '/api/orders', async () => {
  await state.page.bringToFront();
  await state.page.getByRole('button', { name: 'Next', exact: true }).click();
}, {
  report: true,
  project: ({ json, status }) => {
    if (status !== 200 || !Array.isArray(json?.items)) throw new Error('Unexpected orders schema');
    return { rows: json.items.map(({ id, amount, currency }) => ({ id, amount, currency })),
      nextCursor: json.nextCursor, total: json.total };
  }
});
if (!result.complete) {
  console.log({ complete: false, reasons: result.reasons });
  // Inspect current page/cursor before another action; the trigger may already have run.
} else {
  state.orderResponses ??= [];
  state.orderResponses.push(...result.responses.map(r => r.data));
  console.log({ captured: result.responses.length, pages: state.orderResponses.length });
}
```

`project` runs locally with `{ url, method, status, contentType, json?, text?, requestBody? }`.
It must return JSON-serializable data, at most `maxBodyBytes` when encoded. A thrown
projection marks the capture incomplete; it does not silently discard the response.
Without `project`, entries keep a truncated `preview`, useful for discovery, not arithmetic.
With `project`, each entry contains `data` instead of `preview`. Keep it in `state`;
printing the whole object needlessly sends the dataset back to the model.

## Bounds and failures

Options: `types` defaults to `['xhr', 'fetch']` (`'all'` includes documents/scripts),
`quiet: 1000`, `timeout: 15000`, `min: 1`, `preview: 1500`, `maxResponses: 100`,
`maxBodyBytes: 2000000`, `maxTotalBytes: 10000000`, optional `save` client path.
`filter` is a URL substring, synchronous response predicate, RegExp, or `null`.
An async predicate is rejected as `filter-error`, not treated as a truthy match.

The timeout covers waiting for the trigger, matching traffic, bodies and projection.
Once `min` responses have arrived and traffic has been quiet, the listener is removed
and captured bodies finish within the same deadline. Use an application-specific
response/cursor condition for delayed or multi-stage loading; quiet is not a business signal.
`min: 0` allows an empty capture. `report: true` returns `{ complete, reasons, responses }`;
otherwise an incomplete capture throws with that report on `error.result`.
Reasons include `deadline`, `trigger-deadline`, `body-unavailable`, `body-limit`,
`total-byte-limit`, `response-limit`, `filter-error`, and `projection-error`.
Trigger exceptions propagate. A deadline stops waiting, **not the underlying action**;
inspect its outcome before starting another browser operation. Synchronous callbacks
cannot be interrupted by a JavaScript timer; session watchdogs still bound the process.

Byte limits bound retained/processed bodies, not peak transport memory: Playwright
materializes `response.body()` before its actual size can be checked. Content-Length
can reject a known oversized body earlier. `save` writes collected request/response
bodies as JSONL, including per-entry errors, outside the network deadline. Treat files
as private task data, not site learnings; saved data can include account content.

## Pagination and remote networking

Follow returned cursor/page fields and verify distinct row IDs, expected counts and
server page-size caps. Capture the next UI action when replaying an endpoint fails.
An in-page `fetch` via `page.evaluate` uses the browser's network/login context but is
visible to the site; use only when the task needs it and validate its response.
`page.request` / `context.request` use the client machine's network, which can differ in
IP, TLS and proxy from the remote profile. Keep site traffic inside the remote browser.
Sessions retain listeners only if your script explicitly keeps them; this helper always
removes its listener when the capture returns or throws.
