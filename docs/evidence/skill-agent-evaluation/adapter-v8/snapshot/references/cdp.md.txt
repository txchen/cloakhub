# Direct CDP access

Use when a needed browser capability is not exposed by the high-level helper, or when
diagnosing frames, rendering, or protocol events. Ordinary locator and network APIs
remain available without a wrapper. The skill pins Playwright; check that an API exists
in that installed version before copying an example from newer documentation.

```js
const cdp = await context.newCDPSession(state.page);
try {
  const { frameTree } = await cdp.send('Page.getFrameTree');
  console.log({ frame: frameTree.frame.id, children: frameTree.childFrames?.length ?? 0 });
} finally {
  await cdp.detach();
}
```

A page CDPSession targets one page. Browser-level sessions address shared browser state;
use them only when the requested task requires that scope. Detach sessions and remove
listeners when done. Raw `Browser.close`, context disposal and profile restarts affect
other clients; ordinary task cleanup closes only its own intermediate tabs.

Keep task-specific helpers in `state` or a task module. Change installed shared helpers
only as an explicit development task. Inspect screenshots for coordinate work; access
to a protocol does not make inferred coordinates or hidden app state reliable.

Official references: [CDPSession](https://playwright.dev/docs/api/class-cdpsession),
[protocol domains](https://chromedevtools.github.io/devtools-protocol/).
