import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  captureResponses, detectChallenge, errorHint, expectChange, installOutputFilter, observe, tabInfo
} from "./helpers.mjs";
import { appendLearning, formatLearnings, listLearnings, readLearnings } from "./learnings.mjs";

const usage = "Usage: node browser.mjs targets | check [--target ALIAS] | run [--target ALIAS] < script.js" +
  " | learnings [DOMAIN [--append < note.md]]";
// Names available to run scripts, in parameter order.
const SCRIPT_API = ["browser", "context", "tabs", "tab", "tabId", "observe", "expectChange", "captureResponses", "detectChallenge"];

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
  const sources = [target.token !== undefined, target.tokenFile !== undefined, target.tokenEnv !== undefined];
  if (sources.filter(Boolean).length > 1 || (target.auth !== undefined && target.auth !== "none") ||
      (target.auth === "none" && sources.some(Boolean))) {
    throw new Error("Configure at most one of token, tokenFile, or tokenEnv; omit all for open CDP access.");
  }
  if (target.token !== undefined && typeof target.token !== "string") {
    throw new Error("token must be a string.");
  }
  if (target.tokenFile !== undefined && (typeof target.tokenFile !== "string" || !target.tokenFile.trim())) {
    throw new Error("tokenFile must be a nonempty path.");
  }
  if (target.tokenEnv !== undefined && (typeof target.tokenEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(target.tokenEnv))) {
    throw new Error("tokenEnv must name an environment variable.");
  }
  return { name, url: url.origin, profile: target.profile, auth: sources.some(Boolean) ? "cdp_token" : "none" };
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
  if (target.token !== undefined) {
    token = target.token.trim();
  } else if (target.tokenFile !== undefined) {
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

const ACTIONS = {
  UNAUTHORIZED: "Check the selected target's CDP token. The admin password is a different credential.",
  PROFILE_NOT_FOUND: "Verify the exact profile ID with the operator. Connecting never creates a profile.",
  CAPACITY_UNAVAILABLE: "The running-instance limit is full. Retry with bounded backoff (at most three times) or ask the operator to free capacity.",
  DISPLAY_UNAVAILABLE: "The server's display runtime is unavailable. The operator must repair the deployment.",
  BROWSER_START_FAILED: "The browser failed to start. Ask the operator to check the profile error and event log; do not loop.",
  CDP_UNAVAILABLE: "The browser is not serving CDP. Ask the operator to inspect the profile state; retrying unchanged will not help."
};

/** After a failed connection, ask the HTTP discovery endpoint for a structured error. */
export async function diagnoseConnection(target, error, fetchImpl = fetch) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("<ws connected>")) {
    return "Diagnosis: authentication and the WebSocket upgrade succeeded, but an existing tab did not answer Playwright. See the connectOverCDP timeout entry in references/setup.md.";
  }
  const { url, profile } = target.metadata;
  let response;
  try {
    response = await fetchImpl(`${url}/api/profiles/${profile}/cdp/json/version`, {
      headers: target.token ? { Authorization: `Bearer ${target.token}` } : {},
      signal: AbortSignal.timeout(20_000)
    });
  } catch (cause) {
    const reason = cause?.cause?.code ?? cause?.name ?? "network error";
    return `Diagnosis: the hub at ${url} is unreachable from this client (${reason}). Check the address, server binding, TLS, and proxy.`;
  }
  if (response.ok) {
    return "Diagnosis: the HTTP discovery endpoint works, so the WebSocket connection failed. Check reverse-proxy WebSocket upgrade support.";
  }
  let body;
  try { body = await response.json(); } catch { body = null; }
  if (!body?.code) return `Diagnosis: the hub answered HTTP ${response.status} without a CloakHub error code. Check that the URL is the CloakHub origin.`;
  const action = ACTIONS[body.code] ?? "See the error table in references/setup.md.";
  return `Diagnosis: server reported ${body.code} (HTTP ${response.status}, retryable=${Boolean(body.retryable)}): ${body.message ?? ""} ${action}`.trim();
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
    try {
      browser = await connect(target.endpoint, {
        headers: target.token ? { Authorization: `Bearer ${target.token}` } : {},
        timeout: 60_000,
        noDefaults: true
      });
    } catch (error) {
      if (error && typeof error === "object") error.phase = "connect";
      throw error;
    }
    const context = browser.contexts()[0];
    if (!context) throw new Error("The remote profile has no default browser context.");
    context.setDefaultTimeout(20_000);
    context.setDefaultNavigationTimeout(60_000);
    const tabId = async (page) => {
      const session = await context.newCDPSession(page);
      try { return (await session.send("Target.getTargetInfo")).targetInfo.targetId; }
      finally { await session.detach(); }
    };
    // `visible` marks the foreground tab: only it renders, so pointer actions elsewhere stall.
    const tabs = async () => Promise.all(context.pages().map((page) => tabInfo(context, page)));
    const tab = async (id) => {
      for (const page of context.pages()) if (await tabId(page) === id) return page;
      throw new Error("Tab no longer exists. List tabs again; browser restart changes tab IDs.");
    };
    return await action({ browser, context, tabs, tab, tabId, observe, expectChange, captureResponses, detectChallenge });
  } finally {
    // Playwright's attached-browser close disconnects, not CDP Browser.close.
    if (browser) await browser.close();
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "learnings") return learningsCommand(args);
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
    const execute = new AsyncFunction(...SCRIPT_API, source);
    action = (api) => execute(...SCRIPT_API.map((name) => api[name]));
  }
  const target = await resolveTarget(loaded, args[1]);
  let restore = () => {};
  try {
    await withBrowser(target, async (api) => {
      if (!action) return console.log(JSON.stringify({ ok: true, ...target.metadata }));
      restore = installOutputFilter([target.token]);
      try { return await action(api); } finally { restore(); }
    });
  } catch (error) {
    restore();
    let message = error instanceof Error ? error.message : String(error);
    if (error?.phase === "connect") message += `\n${await diagnoseConnection(target, error)}`;
    const hint = errorHint(message);
    if (hint) message += `\n${hint}`;
    throw new Error(safeError(message, target.token));
  }
}

async function learningsCommand(args) {
  if (args.length === 0) {
    console.log(JSON.stringify(await listLearnings(), null, 2));
    return;
  }
  if (args.length > 2 || (args.length === 2 && args[1] !== "--append")) throw new Error(usage);
  if (args[1] === "--append") {
    if (process.stdin.isTTY) throw new Error("Pass the note on stdin.");
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const saved = await appendLearning(args[0], Buffer.concat(chunks).toString("utf8"));
    console.log(JSON.stringify({ ok: true, ...saved }));
    return;
  }
  console.log(formatLearnings(await readLearnings(args[0])));
}

// Skill installs are often symlinked; compare real paths so a symlinked invocation still runs main().
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
