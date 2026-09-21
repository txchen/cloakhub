import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createCdpWebSocketHandler } from "../src/cdp-websocket-proxy";

const realTest = process.env.CLOAKHUB_RUN_CDP_TESTS === "true" ? test : test.skip;

realTest("skill CLI authenticates through CDP proxy, resumes a tab, and leaves the browser running", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloakhub-skill-browser-"));
  let processHandle;
  let server;
  try {
    processHandle = Bun.spawn([
      process.env.CLOAKHUB_TEST_BROWSER ?? chromium.executablePath(),
      `--user-data-dir=${join(root, "browser")}`, "--remote-debugging-port=0",
      "--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "about:blank"
    ], { stdout: "ignore", stderr: "ignore" });
    const activePort = join(root, "browser", "DevToolsActivePort");
    for (let i = 0; i < 100 && !(await Bun.file(activePort).exists()); i++) await Bun.sleep(50);
    const [port, path] = (await readFile(activePort, "utf8")).trim().split("\n");
    const browserUrl = `ws://127.0.0.1:${port}${path}`;
    let authenticated = 0;
    server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch(request, server) {
        if (request.headers.get("authorization") !== "Bearer test-profile-token") return new Response("Unauthorized", { status: 401 });
        if (new URL(request.url).pathname !== "/api/profiles/research/cdp") return new Response("Not found", { status: 404 });
        authenticated++;
        if (server.upgrade(request, { data: { profileId: "research", targetUrl: browserUrl, browserTargetUrl: browserUrl } })) return;
        return new Response("WebSocket required", { status: 400 });
      },
      websocket: createCdpWebSocketHandler()
    });
    const configPath = join(root, "client.json");
    await writeFile(configPath, JSON.stringify({
      version: 1, defaultTarget: "test",
      targets: { test: { url: `http://127.0.0.1:${server.port}`, profile: "research", tokenEnv: "SKILL_TEST_TOKEN" } }
    }));
    async function run(command, script = "") {
      const child = Bun.spawn(["node", "skills/cloakhub-browser/scripts/browser.mjs", command], {
        env: { ...process.env, CLOAKHUB_CLIENT_CONFIG: configPath, CLOAKHUB_TARGET: "test", SKILL_TEST_TOKEN: "test-profile-token" },
        stdin: "pipe", stdout: "pipe", stderr: "pipe"
      });
      child.stdin.write(script);
      child.stdin.end();
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited
      ]);
      expect(code, stderr).toBe(0);
      return JSON.parse(stdout);
    }
    expect(await run("targets")).toHaveLength(1);
    expect(authenticated).toBe(0);
    expect((await run("check")).ok).toBe(true);
    const first = await run("run", `
      const page = await context.newPage();
      await page.goto('data:text/html,<title>Skill test</title><button>Save</button>');
      console.log(JSON.stringify({ id: await tabId(page), snapshot: await page.locator('body').ariaSnapshot() }));
    `);
    expect(first.snapshot).toContain('button "Save"');
    const second = await run("run", `
      const page = await tab(${JSON.stringify(first.id)});
      console.log(JSON.stringify({ title: await page.title(), count: (await tabs()).length }));
      await page.close();
    `);
    expect(second).toEqual({ title: "Skill test", count: 2 });
    expect((await run("check")).ok).toBe(true);
    expect(authenticated).toBe(4);
  } finally {
    server?.stop(true);
    if (processHandle) { processHandle.kill(); await processHandle.exited; }
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
