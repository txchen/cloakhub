import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import {
  createCdpWebSocketHandler,
  type CdpWebSocketData
} from "../src/cdp-websocket-proxy";

const realTest =
  process.env.CLOAKHUB_RUN_CDP_TESTS === "true" ? test : test.skip;
realTest(
  "real Playwright clients close tabs concurrently, preserve a blank, and can still stop the browser",
  async () => {
    const root = await mkdtemp("/tmp/cloakhub-cdp-browser-");
    const process = Bun.spawn(
      [
        globalThis.process.env.CLOAKHUB_TEST_BROWSER ??
          "/opt/google/chrome/chrome",
        `--user-data-dir=${root}`,
        "--remote-debugging-port=0",
        "--headless=new",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "about:blank"
      ],
      { stdout: "ignore", stderr: "ignore" }
    );
    await until(
      async () => Bun.file(`${root}/DevToolsActivePort`).exists(),
      true
    );
    const [port, path] = (await readFile(`${root}/DevToolsActivePort`, "utf8"))
      .trim()
      .split("\n");
    const browserUrl = `ws://127.0.0.1:${port}${path}`;
    let protections = 0;
    const server = Bun.serve<CdpWebSocketData>({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, server) {
        const path = new URL(request.url).pathname;
        const targetUrl = path.startsWith("/devtools/page/")
          ? `ws://127.0.0.1:${port}${path}`
          : browserUrl;
        if (
          server.upgrade(request, {
            data: { profileId: "work", targetUrl, browserTargetUrl: browserUrl }
          })
        )
          return;
        return new Response("Websocket required", { status: 400 });
      },
      websocket: createCdpWebSocketHandler({ onBlankTab: () => protections++ })
    });
    try {
      // Playwright runs under Node; Bun owns the real proxy websocket server.
      const client = Bun.spawn(
        [
          "node",
          "tests/helpers/cdp-playwright-client.mjs",
          `ws://127.0.0.1:${server.port}/`
        ],
        { stdout: "pipe", stderr: "pipe" }
      );
      const output = await new Response(client.stderr).text();
      expect(await client.exited, output).toBe(0);
      expect(protections).toBe(4);
    } finally {
      server.stop(true);
      process.kill();
      await process.exited;
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000
);

async function until<T>(read: () => T | Promise<T>, expected: T) {
  for (let i = 0; i < 100; i++) {
    if ((await read()) === expected) return;
    await Bun.sleep(50);
  }
  expect((await read()) === expected).toBe(true);
}
