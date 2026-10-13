# Browser operations

Run these snippets inside `browser.mjs run`, using the tab ID from this task.
Playwright API reference: https://playwright.dev/docs/api/class-page

## Helper reference

All helpers read pages through Playwright locators, network events, or CDP isolated
worlds, never through the page's own JavaScript world.

- `tabs()` → `[{ id, url, title, visible }]`. `visible` is the foreground tab;
  `null` when unknown (for example `chrome://` pages).
- `observe(page, { scope, maxChars = 12000 })` → string. Aria snapshot of `scope`
  (CSS selector or Locator, default `body`), then **Page notices**: visible alerts,
  status regions, toasts, error messages, and invalid fields. Text is wrapped in
  `<page-content untrusted>`, credential-looking line groups are redacted, and long
  output is truncated with a hint. Warnings for challenges and credential pages come first.
- `expectChange(page, target, action, { scope, timeout = 3000, until })` →
  `{ changed, changes, notices, url, met?, hint? }`. Compares the target's aria
  snapshot (value, checked, expanded, disabled, text), the optional `scope`, the URL,
  and new notices before and after `action`. `until` is an async predicate for the
  expected state; `met` reports it. Target removal is a change.
- `captureResponses(page, filter, trigger, { types, quiet = 1000, timeout = 15000, min = 1, preview = 1500, save })`
  → `[{ url, method, status, type, contentType, bytes, keys?, preview }]`. `filter` is a
  URL substring, RegExp, function, or `null`. `types` defaults to `['xhr', 'fetch']`;
  pass `'all'` for documents and scripts. `save` writes full request and response bodies
  as JSONL on the client.
- `detectChallenge(page)` → `null` or `{ kind: 'challenge' | 'blocked', evidence }`, from
  challenge iframes (Cloudflare, hCaptcha, reCAPTCHA, GeeTest, DataDome, ...) and page text.

## Effect evidence

```js
const page = await tab('ID_FROM_PREVIOUS_OUTPUT');
const save = page.getByRole('button', { name: 'Save' });
console.log(await expectChange(page, page.getByLabel('Email'), () => save.click(), {
  scope: page.locator('form'),
  until: async () => await page.getByText('Saved').isVisible()
}));
```

Read `notices` first: a validation error often appears far from the button. On
`changed: false`, the element may be a wrapper (try its inner control), the effect may
be asynchronous elsewhere (widen `scope`), or the site ignored the input.

## Data from the network

```js
const page = await tab('ID_FROM_PREVIOUS_OUTPUT');
const responses = await captureResponses(page, null, () => page.reload());
console.log(responses.map(({ url, status, bytes, keys }) => ({ url, status, bytes, keys }))
  .sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0)).slice(0, 15));
```

- First list everything without a filter and sort by size. Endpoint names from
  memory are often wrong; the large JSON response is usually the data.
- Each `run` is a new connection: listeners never carry over, so capture inside the
  same script as the navigation, click, or scroll that triggers the requests.
- To page through results, prefer replaying the endpoint in the page context so cookies
  apply: `page.evaluate(u => fetch(u).then(r => r.json()), url)` (page-visible, see below).
  Check the pagination fields in the response: servers silently cap page sizes.
- Signed or tokenised APIs (403/406 on replay): drive the UI instead (click next page,
  scroll) inside `captureResponses` and read what the page itself requested.
- The same data often has another entry point on the site with a cleaner API; look
  before fighting one page.
- Use `save` for large or multi-page text/JSON bodies, then process the file locally.
- `page.request` and `context.request` send from the client machine, not from the
  server browser: a different IP, TLS fingerprint, and proxy than the profile. Keep
  site traffic inside the browser.

## Page-visible operations

Observed through CloakHub on 2026-10-01 against Rebrowser's detector:
connecting, navigating, locator reads, and the helpers left no detectable trace.
These do:

- `page.evaluate()` runs in the page's main world. A site that hooks DOM APIs sees
  calls such as `getElementById` made from it (`mainWorldExecution`).
- `page.exposeFunction()` leaves `__playwright__binding__` in the main world.
- `page.addInitScript()` runs in the page; anything it writes is readable by the site.

Use them only when the task needs page-world state (an in-page `fetch` with cookies,
an app's JS object). None of this makes a profile anonymous or untrackable.

## Background tabs

Observed on CloakHub's headed browser on 2026-10-01: only the frontmost tab of the
frontmost window renders. In other tabs, and in tabs of separate windows,
`document.visibilityState` is `hidden` and `requestAnimationFrame` and
`IntersectionObserver` never fire. As a result:

- `click`, `hover`, and other pointer actions time out at "waiting for element to be stable".
- `fill`, `pressSequentially`, `selectOption`, `dispatchEvent`, aria snapshots,
  screenshots, and reloads still work.
- Lazy lists and some SPAs (React rendering, request scheduling) stall until visible.

Call `await page.bringToFront()` before pointer work or infinite scrolling. It changes
what the user sees in the viewer, and concurrent clients on one profile compete for the
foreground: coordinate rather than flipping tabs repeatedly. `force: true` skips the
stability wait but also the visibility and hit-target checks; use it only for a target
you have already verified.

## Scrolling and lazy loading

Scroll the container that actually scrolls: on a visible tab, hover it and use
`await list.hover(); await page.mouse.wheel(0, 2000)`, which also wakes listeners
that watch wheel events. Count items before and after; stop only after two rounds
without growth. When nothing loads, check
whether the tab is in the background and whether the data is already in a network response.

## Rich text editors

Editors such as Draft.js, Lexical, or ProseMirror may ignore `fill`. Click the editor,
then try `page.keyboard.insertText(text)`; if the editor still does not update its
model, dispatch a paste (page-visible):

```js
await editor.click();
await editor.evaluate((el, text) => {
  const data = new DataTransfer();
  data.setData('text/plain', text);
  el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
}, 'Hello');
```

Verify the submit button became enabled and that the request succeeded.

## Observe and save a screenshot

```js
const page = await tab('ID_FROM_PREVIOUS_OUTPUT');
console.log(await observe(page, { scope: 'main' }));
// For a visual task instead:
await page.screenshot({ path: '/absolute/client/path/result.png', fullPage: true });
```

Screenshots are saved on the client. Inspect the image with the agent's image tool
before choosing coordinates. Scope snapshots or extracted text to relevant content
to avoid flooding the agent's context. Iframe content needs its own scope:
`observe(page, { scope: page.frameLocator('iframe#pay').locator('body') })`.

## Popups

```js
const page = await tab('ID_FROM_PREVIOUS_OUTPUT');
const pending = page.waitForEvent('popup');
await page.getByRole('link', { name: 'Open report' }).click();
const popup = await pending;
console.log({ taskTab: await tabId(popup) });
await popup.waitForLoadState('domcontentloaded');
console.log(await observe(popup));
```

A click that opens a new tab leaves the original page unchanged; check for popups
before concluding that a click did nothing.

## Files across two machines

The website runs on the server: `localhost` URLs point to the server, not the client.
Do not assume server file paths refer to client files. For uploads, explicitly send
client bytes rather than asking remote CDP to open a client path:

```js
const { readFile } = await import('node:fs/promises');
const page = await tab('ID_FROM_PREVIOUS_OUTPUT');
await page.getByLabel('Upload report').setInputFiles({
  name: 'report.csv', mimeType: 'text/csv',
  buffer: await readFile('/absolute/client/path/report.csv')
});
```

This transport is intended for ordinary files, not directory or large-file uploads.
CloakHub does not provide a file-transfer API. Remote CDP downloads may leave files
on the server; do not promise client-side `download.saveAs()` support without verifying
the deployment. Ask the operator for the server artifact if necessary. Do not change
global download settings on a shared profile as a workaround.

## Hand off to the user

Hand a step to the user for CAPTCHAs and bot challenges, login, MFA, QR codes,
payment approval, and anything outside the page: native file or save dialogs, browser
permission prompts, `chrome://` pages. Never retry or work around a challenge.

1. Leave the relevant tab open; call `bringToFront()` so the viewer shows it.
2. Tell the user the target alias/profile, the tab label, and exactly what to do in the
   CloakHub viewer, then let the current script finish, releasing its CDP connection.
3. After the user confirms, reconnect to the same target, find the tab with `tabs()`,
   and verify the result with `observe` before continuing. If the user declined, stop
   that line of work.

No automatic user/agent ownership mechanism is provided; coordinate instead of racing
the user's input.

## Recovery

Server sleep preserves cookies and browser storage, not JS variables, unfinished
forms, or in-flight operations. A later invocation automatically wakes the profile
with a single new tab; earlier tabs are not reopened. Navigate again and inspect the
intended website state.
Only retry a side effect after determining whether the first attempt completed.

## Completion

```js
const page = await tab('TASK_INTERMEDIATE_TAB_ID');
await page.close();
```

Close only tabs created for this task that are no longer needed. A last-tab close
may leave an `about:blank` tab because CloakHub protects the browser from exiting.
Do not close all context pages. Returning from the script disconnects the client
without stopping the server browser or deleting profile data.
