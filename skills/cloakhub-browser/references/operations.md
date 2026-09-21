# Browser operations

Run these snippets inside `browser.mjs run`, using the tab ID from this task.
Playwright API reference: https://playwright.dev/docs/api/class-page

## Observe and save a screenshot

```js
const page = await tab('ID_FROM_PREVIOUS_OUTPUT');
console.log(await page.getByRole('main').ariaSnapshot());
// For a visual task instead:
await page.screenshot({ path: '/absolute/client/path/result.png', fullPage: true });
```

Screenshots are saved on the client. Inspect the image with the agent's image tool
before choosing coordinates. Scope snapshots or extracted text to relevant content
to avoid flooding the agent's context. Use `page.evaluate()` for extraction when
needed; evaluated code runs on the remote page, not in Node.

## Popups

```js
const page = await tab('ID_FROM_PREVIOUS_OUTPUT');
const pending = page.waitForEvent('popup');
await page.getByRole('link', { name: 'Open report' }).click();
const popup = await pending;
console.log({ taskTab: await tabId(popup) });
await popup.waitForLoadState('domcontentloaded');
console.log(await popup.locator('body').ariaSnapshot());
```

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

## Manual login and recovery

For user login, MFA, or a manual intervention, leave the relevant tab open and tell
the user the selected alias/profile and what to do in the CloakHub viewer. Let the
current script finish, releasing its CDP connection. Resume the same target after the
user confirms, list tabs, and verify the resulting page. No automatic user/agent
ownership mechanism is provided; coordinate instead of racing the user's input.

Server sleep preserves cookies and browser storage, not JS variables, unfinished
forms, or in-flight operations. A later invocation automatically wakes the profile,
but tab IDs may have changed. Freshly inspect the tabs and intended website state.
If multiple tabs are plausible, obtain enough context to identify the correct one.
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
