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

const playground = `<!doctype html><title>Playground</title>
<script>
  // Record main-world DOM calls the way detection pages do; helpers must not appear here.
  window.hits = [];
  for (const [proto, names] of [[Document.prototype, ["querySelector", "querySelectorAll", "getElementById", "getElementsByClassName", "getElementsByTagName"]],
                                [Element.prototype, ["querySelector", "querySelectorAll", "getAttribute", "matches", "closest"]]]) {
    for (const name of names) { const original = proto[name]; proto[name] = function (...args) { window.hits.push(name); return original.apply(this, args); }; }
  }
  window.save = () => { document.getElementById("err").hidden = false; document.getElementById("email").setAttribute("aria-invalid", "true"); };
  window.load = () => fetch("/api/items?page=1").then((r) => r.json()).then((d) => { document.getElementById("out").textContent = d.items.join(","); });
</script>
<h1>Form</h1><label>Email <input id="email" name="email"></label>
<button onclick="save()">Save</button><button>Nothing</button><button onclick="load()">Load</button>
<div id="err" role="alert" hidden>Email is required</div><p id="out"></p>
<ul><li>ab12cd34ef56gh78ij90</li><li>zz98yy76xx54ww32vv10</li><li>qq11rr22ss33tt44uu55</li></ul>`;

realTest("skill helpers observe, verify effects, capture responses, and detect challenges without main-world calls", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloakhub-skill-helpers-"));
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
    server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch(request, server) {
        const { pathname } = new URL(request.url);
        if (pathname === "/playground") return new Response(playground, { headers: { "content-type": "text/html" } });
        if (pathname === "/api/items") return Response.json({ items: ["a", "b"], page: { size: 2, total: 9 } });
        if (pathname === "/challenge") return new Response('<title>Shop</title><iframe src="/captcha/frame"></iframe>', { headers: { "content-type": "text/html" } });
        if (pathname === "/captcha/frame") return new Response("<p>widget</p>", { headers: { "content-type": "text/html" } });
        if (pathname !== "/api/profiles/research/cdp") return new Response("Not found", { status: 404 });
        if (server.upgrade(request, { data: { profileId: "research", targetUrl: browserUrl, browserTargetUrl: browserUrl } })) return;
        return new Response("WebSocket required", { status: 400 });
      },
      websocket: createCdpWebSocketHandler()
    });
    const origin = `http://127.0.0.1:${server.port}`;
    const configPath = join(root, "client.json");
    await writeFile(configPath, JSON.stringify({ version: 1, defaultTarget: "test", targets: { test: { url: origin, profile: "research" } } }));
    const child = Bun.spawn(["node", "skills/cloakhub-browser/scripts/browser.mjs", "run"], {
      env: { ...process.env, CLOAKHUB_CLIENT_CONFIG: configPath },
      stdin: "pipe", stdout: "pipe", stderr: "pipe"
    });
    child.stdin.write(`
      const page = await context.newPage();
      await page.goto(${JSON.stringify(origin + "/playground")});
      await page.evaluate(() => { window.hits = []; });
      const observed = await observe(page);
      const noop = await expectChange(page, page.getByRole("button", { name: "Nothing" }),
        () => page.getByRole("button", { name: "Nothing" }).click(), { timeout: 500 });
      const saved = await expectChange(page, page.getByLabel("Email"), () => page.getByRole("button", { name: "Save" }).click());
      const hitsBeforeLoad = await page.evaluate(() => window.hits.length);
      const responses = await captureResponses(page, "/api/items", () => page.getByRole("button", { name: "Load" }).click(), { quiet: 300 });
      const listed = await tabs();
      const challengePage = await context.newPage();
      await challengePage.goto(${JSON.stringify(origin + "/challenge")});
      const challenge = await detectChallenge(challengePage);
      console.log(JSON.stringify({ observed, noop, saved, hitsBeforeLoad, responses, listed, challenge }));
    `);
    child.stdin.end();
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, stderr).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.observed).toContain('<page-content untrusted="true"');
    expect(result.observed).toContain('button "Save"');
    expect(result.observed).toContain("[redacted 3 lines that look like credentials]");
    expect(result.observed).not.toContain("ab12cd34ef56gh78ij90");
    expect(result.noop.changed).toBe(false);
    expect(result.noop.hint).toContain("No attributable change");
    expect(result.saved.changed).toBe(true);
    expect(result.saved.notices).toEqual(["notice: Email is required", "invalid field: email"]);
    expect(result.saved.changes).toContain('target + textbox "Email" [invalid]');
    // Only the page's own onclick handler touched hooked DOM APIs.
    expect(result.hitsBeforeLoad).toBe(2);
    expect(result.responses).toHaveLength(1);
    expect(result.responses[0]).toMatchObject({ method: "GET", status: 200, type: "fetch", keys: ["items", "page"] });
    expect(result.responses[0].preview).toBe('{"items":["a","b"],"page":{"size":2,"total":9}}');
    expect(result.listed.find((t) => t.url.endsWith("/playground"))).toMatchObject({ title: "Playground" });
    expect(result.challenge).toEqual({ kind: "challenge", evidence: `frame ${origin}/captcha/frame` });
  } finally {
    server?.stop(true);
    if (processHandle) { processHandle.kill(); await processHandle.exited; }
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
