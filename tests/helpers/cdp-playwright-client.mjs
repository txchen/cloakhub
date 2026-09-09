import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
const endpoint = process.argv[2];
const clients = [];
const until = async (read, expected) => {
  for (let i = 0; i < 100; i++) {
    if ((await read()) === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(await read(), expected);
};
try {
  const first = await chromium.connectOverCDP(endpoint, { timeout: 10_000 });
  clients.push(first);
  const second = await chromium.connectOverCDP(endpoint, { timeout: 10_000 });
  clients.push(second);
  const page = first.contexts()[0].pages()[0];
  await page.close();
  assert.equal(page.isClosed(), true);
  await until(() => first.contexts()[0].pages().length, 1);
  assert.equal(first.contexts()[0].pages()[0].url(), "about:blank");

  await first.contexts()[0].newPage();
  await until(() => second.contexts()[0].pages().length, 2);
  await Promise.all([
    first.contexts()[0].pages()[0].close(),
    second.contexts()[0].pages()[1].close()
  ]);
  await until(() => first.contexts()[0].pages().length, 1);

  const last = first.contexts()[0].pages()[0];
  await last.close({ runBeforeUnload: true });
  await until(() => last.isClosed(), true);
  await until(() => first.contexts()[0].pages().length, 1);
  const blank = first.contexts()[0].pages()[0];
  await blank.goto("data:text/html,<title>Still connected</title>");
  assert.equal(await blank.title(), "Still connected");

  // Direct page sockets also support Page.close without a flattened sessionId.
  const discovery = await first.newBrowserCDPSession();
  const { targetInfos } = await discovery.send("Target.getTargets");
  const target = targetInfos.find((entry) => entry.type === "page");
  const direct = new WebSocket(new URL(`/devtools/page/${target.targetId}`, endpoint));
  await new Promise((resolve, reject) => {
    direct.addEventListener("open", resolve, { once: true });
    direct.addEventListener("error", reject, { once: true });
  });
  direct.send(JSON.stringify({ id: 1, method: "Page.close" }));
  await until(() => blank.isClosed(), true);
  await until(() => first.contexts()[0].pages().length, 1);
  direct.close();

  const session = await first.newBrowserCDPSession();
  await session.send("Browser.close").catch(() => {});
  await until(() => first.isConnected(), false);
} finally {
  for (const client of clients) await client.close().catch(() => {});
}
