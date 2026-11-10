# Real profile verification

Run explicitly against a configured profile (creates and cleans up test tabs; holds
CDP connections for about five minutes). The synchronous-loop test can stall other
clients on the same profile until its 121-second watchdog fires. Use a profile that
is not doing other work.

```sh
CLOAKHUB_VERIFY_HELPER=/absolute/installed/skill/scripts/browser.mjs \
CLOAKHUB_TARGET=your_target node docs/evidence/skill-sessions/verify.mjs
```

`results.json` records assertions from the completed run. This uses the actual remote
browser, CLI processes, sockets and default deadlines; the page fixture is a data URL,
not a mocked Playwright connection. It checks state/functions/page reuse, recovery
from script errors, concurrent-call rejection, bounded output, a rendered button click,
retention of a task tab after session end, asynchronous and synchronous execution
limits, idle expiry despite status polling, and reconnecting to the remote profile.

Exploratory failures on 2026-11-10:

- Running a synchronous infinite loop while navigating from another client stalled
  navigation on the shared profile, including a data URL. Sequential browser tests
  passed after terminating the blocked client. Session documentation now explains
  this shared-profile limitation.
- `setContent` waiting for the full load event timed out. The final fixture navigates
  with `waitUntil: 'domcontentloaded'` and verifies the DOM effect of a real click.
- Public example.com navigation timed out in the first attempt; a later attempt
  returned from navigation but could not find the expected heading. The fixture checks do not establish
  public-site compatibility or comparative performance.

These tests do not stop/restart the shared browser, test server-side idle shutdown,
validate a protected CDP token handshake, or measure model cost/speed improvements.
