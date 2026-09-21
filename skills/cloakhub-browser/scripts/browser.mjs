import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const usage = "Usage: node browser.mjs targets | check [--target ALIAS] | run [--target ALIAS] < script.js";

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function readConfig(env = process.env) {
  const path = resolve(env.CLOAKHUB_CLIENT_CONFIG || join(homedir(), ".config", "cloakhub", "client.json"));
  let config;
  try {
    config = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error("Cannot read CloakHub client configuration. See references/setup.md; set CLOAKHUB_CLIENT_CONFIG for a custom path.");
  }
  if (!record(config) || config.version !== 1 || !record(config.targets)) {
    throw new Error("Client configuration requires version: 1 and a targets object.");
  }
  return { config, path };
}

function describeTarget(name, target) {
  if (!record(target)) throw new Error("Each target must be an object.");
  let url;
  try { url = new URL(target.url); } catch { throw new Error("Target url must be an HTTP(S) origin."); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Target url must be an HTTP(S) origin without credentials, path, query, or fragment.");
  }
  if (typeof target.profile !== "string" || !/^[a-z][a-z0-9_]*$/.test(target.profile)) {
    throw new Error("Target profile must be an exact CloakHub profile ID.");
  }
  const sources = [target.tokenFile !== undefined, target.tokenEnv !== undefined, target.auth === "none"];
  if (sources.filter(Boolean).length !== 1 || (target.auth !== undefined && target.auth !== "none")) {
    throw new Error("Configure exactly one of tokenFile, tokenEnv, or auth: none per target.");
  }
  if (target.tokenFile !== undefined && (typeof target.tokenFile !== "string" || !target.tokenFile.trim())) {
    throw new Error("tokenFile must be a nonempty path.");
  }
  if (target.tokenEnv !== undefined && (typeof target.tokenEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(target.tokenEnv))) {
    throw new Error("tokenEnv must name an environment variable.");
  }
  return { name, url: url.origin, profile: target.profile, auth: target.auth === "none" ? "none" : "cdp_token" };
}

export function listTargets(config) {
  return Object.entries(config.targets).map(([name, target]) => ({
    ...describeTarget(name, target), default: name === config.defaultTarget
  }));
}

export async function resolveTarget({ config, path }, explicitTarget, env = process.env) {
  const name = explicitTarget ?? env.CLOAKHUB_TARGET ?? config.defaultTarget;
  if (typeof name !== "string" || !name || !Object.hasOwn(config.targets, name)) {
    throw new Error("No configured target selected. Use targets, set defaultTarget, or pass --target ALIAS.");
  }
  const target = config.targets[name];
  const metadata = describeTarget(name, target);
  let token;
  if (target.tokenFile !== undefined) {
    const tokenPath = target.tokenFile.startsWith("~/")
      ? join(homedir(), target.tokenFile.slice(2)) : resolve(dirname(path), target.tokenFile);
    try { token = (await readFile(tokenPath, "utf8")).trim(); }
    catch { throw new Error("Cannot read the selected target's CDP token file."); }
  } else if (target.tokenEnv !== undefined) {
    token = env[target.tokenEnv]?.trim();
  }
  if (metadata.auth !== "none" && (!token || /\s/.test(token))) {
    throw new Error("The selected target's CDP token is missing or invalid. No connection was attempted.");
  }
  // A stable WebSocket endpoint avoids discovery redirects and browser-lifetime UUIDs.
  const endpoint = `${metadata.url.replace(/^http/, "ws")}/api/profiles/${metadata.profile}/cdp`;
  return { metadata, endpoint, token };
}

export function safeError(error, token) {
  const message = error instanceof Error ? error.message : String(error);
  if (!token) return message;
  return [token, encodeURIComponent(token)].reduce((text, secret) => text.split(secret).join("***"), message);
}

export async function withBrowser(target, action, connect) {
  if (!connect) {
    let chromium;
    try { ({ chromium } = await import("playwright-core")); }
    catch { throw new Error("Missing playwright-core. Run npm install inside the installed cloakhub-browser skill directory."); }
    connect = chromium.connectOverCDP.bind(chromium);
  }
  let browser;
  try {
    browser = await connect(target.endpoint, {
      headers: target.token ? { Authorization: `Bearer ${target.token}` } : {},
      timeout: 60_000,
      noDefaults: true
    });
    const context = browser.contexts()[0];
    if (!context) throw new Error("The remote profile has no default browser context.");
    context.setDefaultTimeout(20_000);
    context.setDefaultNavigationTimeout(60_000);
    const tabId = async (page) => {
      const session = await context.newCDPSession(page);
      try { return (await session.send("Target.getTargetInfo")).targetInfo.targetId; }
      finally { await session.detach(); }
    };
    const tabs = async () => Promise.all(context.pages().map(async (page) => ({
      id: await tabId(page), url: page.url()
    })));
    const tab = async (id) => {
      for (const page of context.pages()) if (await tabId(page) === id) return page;
      throw new Error("Tab no longer exists. List tabs again; browser restart changes tab IDs.");
    };
    return await action({ browser, context, tabs, tab, tabId });
  } finally {
    // Playwright's attached-browser close disconnects, not CDP Browser.close.
    if (browser) await browser.close();
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!["targets", "check", "run"].includes(command) ||
      (args.length && (command === "targets" || args.length !== 2 || args[0] !== "--target" || !args[1]))) {
    throw new Error(usage);
  }
  const loaded = await readConfig();
  if (command === "targets") {
    console.log(JSON.stringify(listTargets(loaded.config), null, 2));
    return;
  }
  // Parse before connecting: a missing/invalid script must not wake a browser.
  let action;
  if (command === "run") {
    if (process.stdin.isTTY) throw new Error("Pass an async JavaScript body on stdin.");
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const source = Buffer.concat(chunks).toString("utf8");
    if (!source.trim()) throw new Error("Pass a nonempty JavaScript body on stdin.");
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const execute = new AsyncFunction("browser", "context", "tabs", "tab", "tabId", source);
    action = ({ browser, context, tabs, tab, tabId }) => execute(browser, context, tabs, tab, tabId);
  }
  const target = await resolveTarget(loaded, args[1]);
  try {
    await withBrowser(target, action ?? (async () => {
      console.log(JSON.stringify({ ok: true, ...target.metadata }));
    }));
  } catch (error) {
    throw new Error(safeError(error, target.token));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
