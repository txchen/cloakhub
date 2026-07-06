import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp, type CloakHubUpgradeServer, type CloakHubWebSocketData } from "../src/app";
import { resolveBrowserBin } from "../src/browser-bin";
import { createBunBrowserProcessLauncher } from "../src/browser-process-launcher";
import {
  createBrowserRuntime,
  type BrowserClientConnections,
  type BrowserRuntime,
  type BrowserRuntimeCdpSession
} from "../src/browser-runtime";
import { createCdpGateway, createProfileCdpAccessPolicy } from "../src/cdp-gateway";
import { createCdpWebSocketHandler, type CdpWebSocketData } from "../src/cdp-websocket-proxy";
import { createKasmVncDisplayRuntime, resolveKasmVncBin } from "../src/display-runtime";
import { openProfileRepository } from "../src/profile-repository";
import { createProfileService, type ProfileService } from "../src/profile-service";

const RUN_REAL_RUNTIME_TESTS = process.env.CLOAKHUB_RUN_REAL_RUNTIME_TESTS === "true";
const realRuntimeTest = RUN_REAL_RUNTIME_TESTS ? test : test.skip;
const cleanupFixtures: RealRuntimeFixture[] = [];

describe("real CloakBrowser runtime integration", () => {
  realRuntimeTest("launches a real headless Browser Instance", async () => {
    const fixture = await realRuntimeFixture();
    await fixture.profileService.createProfile({ headless: true, profile_id: "headless" });

    const state = await fixture.runtime.start("headless");

    expect(state.status).toBe("running");
    expect(state.cdp_port).toBeGreaterThan(0);
    await fixture.runtime.stop("headless", "manual stop");
  });

  realRuntimeTest("launches a headed Browser Instance with KasmVNC/noVNC path", async () => {
    const fixture = await realRuntimeFixture({ requireDisplay: true });
    await fixture.profileService.createProfile({ headless: false, profile_id: "headed" });

    const viewer = await fixture.runtime.openManualViewer("headed");

    expect(viewer.vnc_port).toBeGreaterThan(0);
    expect(viewer.vnc_ws_path).toBe("/ui/profiles/headed/vnc");
    const viewerResponse = await fixture.app.fetch(new Request("http://cloakhub.test/ui/profiles/headed/viewer"));
    const viewerHtml = await viewerResponse.text();
    const assetResponse = await fixture.app.fetch(new Request("http://cloakhub.test/assets/novnc/core/rfb.js"));
    const upgradeServer = fakeUpgradeServer();
    const websocketResponse = await fixture.app.fetch(
      new Request("http://cloakhub.test/ui/profiles/headed/vnc", {
        headers: { upgrade: "websocket" }
      }),
      upgradeServer
    );

    expect(viewerResponse.status).toBe(200);
    expect(viewerHtml).toContain('import RFB from "/assets/novnc/core/rfb.js?v=stock-1"');
    expect(assetResponse.status).toBe(200);
    expect(websocketResponse).toBeUndefined();
    expect(upgradeServer.upgrades).toEqual([
      { profileId: "headed", targetHost: "127.0.0.1", targetPort: viewer.vnc_port }
    ]);
    await fixture.runtime.stop("headed", "manual stop");
  });

  realRuntimeTest("performs CDP Transparent Recovery from discovery", async () => {
    const fixture = await realRuntimeFixture();
    await fixture.profileService.createProfile({ headless: true, profile_id: "cdp" });
    const gateway = createCdpGateway({
      accessPolicy: createProfileCdpAccessPolicy(fixture.profileService),
      browserRuntime: fixture.runtime,
      cdpTokensForRedaction: () => fixture.profileService.cdpTokensForRedaction()
    });

    const response = await gateway.discoveryResponse(
      new Request("http://cloakhub.test/api/profiles/cdp/cdp/json/version"),
      "cdp",
      "/json/version"
    );

    expect(response.status).toBe(200);
    expect(fixture.repository.get("cdp")?.instance_status).toBe("running");
    await fixture.runtime.stop("cdp", "manual stop");
  });

  realRuntimeTest("performs CDP Transparent Recovery for stable websocket routes", async () => {
    const fixture = await realRuntimeFixture();
    await fixture.profileService.createProfile({ headless: true, profile_id: "ws" });
    const gateway = createCdpGateway({
      accessPolicy: createProfileCdpAccessPolicy(fixture.profileService),
      browserRuntime: fixture.runtime,
      cdpTokensForRedaction: () => fixture.profileService.cdpTokensForRedaction()
    });
    fixture.setCdpGateway(gateway);
    const server = Bun.serve<CdpWebSocketData>({
      fetch: (request, server_) => fixture.app.fetch(request, server_),
      port: 0,
      websocket: createCdpWebSocketHandler({ cdpSessions: fixture.runtime })
    });

    try {
      const result = await cdpWebSocketCommand(
        `ws://127.0.0.1:${server.port}/api/profiles/ws/cdp`,
        "Browser.getVersion"
      );

      expect(fixture.repository.get("ws")?.instance_status).toBe("running");
      expect((result as { product?: string }).product).toContain("Chrome");
      await fixture.runtime.stop("ws", "manual stop");
    } finally {
      server.stop(true);
    }
  });

  realRuntimeTest("spins down then recovers while preserving Browser Persistence", async () => {
    const monotonic = fakeMonotonicClock();
    const fixture = await realRuntimeFixture({ monotonicNow: monotonic.now });
    const originServer = Bun.serve({
      fetch: () => new Response("<!doctype html><title>CloakHub persistence</title>", {
        headers: { "content-type": "text/html; charset=utf-8" }
      }),
      port: 0
    });
    const origin = `http://127.0.0.1:${originServer.port}`;
    await fixture.profileService.createProfile({
      headless: true,
      profile_id: "persistent",
      sleep_policy: { mode: "minutes", minutes: 1 }
    });

    try {
      const firstState = await fixture.runtime.start("persistent");
      const firstCdp = await cdpSession(firstState.cdp_port, origin);
      await firstCdp.evaluate(
        "localStorage.setItem('cloakhubPersistence', 'kept'); document.cookie = 'cloakhub_cookie=kept; path=/';"
      );
      firstCdp.close();

      monotonic.advance(61_000);
      expect(await fixture.runtime.spinDownIdleInstances()).toEqual([
        { profile_id: "persistent", reason: "idle timeout" }
      ]);
      const secondState = await fixture.runtime.start("persistent");
      const secondCdp = await cdpSession(secondState.cdp_port, origin);
      const persisted = await secondCdp.evaluate(
        "localStorage.getItem('cloakhubPersistence') + '|' + document.cookie"
      );
      secondCdp.close();

      expect(persisted).toContain("kept|");
      expect(persisted).toContain("cloakhub_cookie=kept");
      await fixture.runtime.stop("persistent", "manual stop");
    } finally {
      originServer.stop(true);
    }
  });

  realRuntimeTest("explicit Stop overrides active clients", async () => {
    const activeSessions = new Map<string, BrowserRuntimeCdpSession[]>();
    const fixture = await realRuntimeFixture({
      clientConnections: {
        disconnect: async (profileId) => {
          for (const session of activeSessions.get(profileId) ?? []) {
            session.close();
          }
          activeSessions.delete(profileId);
        }
      }
    });
    await fixture.profileService.createProfile({ headless: true, profile_id: "active" });
    await fixture.runtime.start("active");
    const session = fixture.runtime.openCdpSession("active");
    activeSessions.set("active", [session]);

    await fixture.runtime.stop("active", "manual stop");

    expect(fixture.repository.get("active")?.instance_status).toBe("stopped");
    expect(fixture.runtime.activeCdpSessionCount("active")).toBe(0);
    session.close();
  });
});

interface RealRuntimeFixture {
  app: ReturnType<typeof createApp>;
  dataRoot: string;
  launcher: ReturnType<typeof createBunBrowserProcessLauncher>;
  profileService: ProfileService;
  repository: ReturnType<typeof openProfileRepository>;
  runtime: BrowserRuntime;
  setCdpGateway: (gateway: ReturnType<typeof createCdpGateway>) => void;
}

async function realRuntimeFixture(options: {
  clientConnections?: BrowserClientConnections;
  monotonicNow?: () => number;
  requireDisplay?: boolean;
} = {}): Promise<RealRuntimeFixture> {
  const dataRoot = await mkdtemp(join(tmpdir(), "cloakhub-real-runtime-"));
  const browserBin = await resolveBrowserBin(process.env.CLOAKHUB_BROWSER_BIN);
  const kasmVnc = await resolveKasmVncBin();
  if (options.requireDisplay && !kasmVnc.path) {
    throw new Error("CLOAKHUB_RUN_REAL_RUNTIME_TESTS requires KasmVNC Xvnc for headed integration tests");
  }

  const repository = openProfileRepository(dataRoot);
  repository.migrate();
  const profileService = createProfileService({ dataRoot, repository });
  const launcher = createBunBrowserProcessLauncher({ dataRoot });
  const runtime = createBrowserRuntime({
    browserBin: browserBin.path,
    clientConnections: options.clientConnections,
    dataRoot,
    displayRuntime: createKasmVncDisplayRuntime({
      dataRoot,
      xvncBin: kasmVnc.path
    }),
    launcher,
    monotonicNow: options.monotonicNow,
    repository
  });
  let cdpGateway: ReturnType<typeof createCdpGateway> | undefined;
  const appConfig = {
    authToken: undefined,
    browserBin: browserBin.path,
    dataRoot,
    host: "127.0.0.1",
    maxRunningInstances: 10,
    port: 7788
  };
  const app = {
    fetch: (request: Request, server?: CloakHubUpgradeServer) => {
      const currentApp = createApp(appConfig, { browserRuntime: runtime, cdpGateway, profileService });
      return server ? currentApp.fetch(request, server) : currentApp.fetch(request);
    }
  } as ReturnType<typeof createApp>;
  const fixture = {
    app,
    dataRoot,
    launcher,
    profileService,
    repository,
    runtime,
    setCdpGateway: (gateway: ReturnType<typeof createCdpGateway>) => {
      cdpGateway = gateway;
    }
  };
  cleanupFixtures.push(fixture);

  return fixture;
}

afterAll(async () => {
  await Promise.all(cleanupFixtures.splice(0).map(cleanupFixture));
});

async function cleanupFixture(fixture: RealRuntimeFixture): Promise<void> {
  await fixture.runtime.cleanupOwnedProcessesOnStartup();
  await rm(fixture.dataRoot, { force: true, recursive: true });
}

function fakeMonotonicClock(): { advance: (milliseconds: number) => void; now: () => number } {
  let current = 0;
  return {
    advance: (milliseconds) => {
      current += milliseconds;
    },
    now: () => current
  };
}

function fakeUpgradeServer() {
  const upgrades: CloakHubWebSocketData[] = [];
  return {
    upgrades,
    upgrade: (_request: Request, options: { data: CloakHubWebSocketData }) => {
      upgrades.push(options.data);
      return true;
    }
  };
}

async function cdpWebSocketCommand(url: string, method: string): Promise<unknown> {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("CloakHub CDP websocket failed to open")), {
      once: true
    });
  });

  try {
    const response = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for CDP websocket response")), 5000);
      ws.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data));
        if (message.id !== 1) {
          return;
        }

        clearTimeout(timeout);
        if (message.error) {
          reject(new Error(message.error.message ?? "CDP websocket command failed"));
          return;
        }

        resolve(message.result);
      });
    });
    ws.send(JSON.stringify({ id: 1, method }));
    return await response;
  } finally {
    ws.close();
  }
}

async function cdpSession(cdpPort: number, url: string): Promise<{
  close: () => void;
  evaluate: (expression: string) => Promise<string>;
}> {
  const target = await cdpTarget(cdpPort);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let nextId = 1;
  const pending = new Map<number, { reject: (error: Error) => void; resolve: (value: unknown) => void }>();

  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (typeof message.id !== "number") {
      return;
    }

    const request = pending.get(message.id);
    if (!request) {
      return;
    }

    pending.delete(message.id);
    if (message.error) {
      request.reject(new Error(message.error.message ?? "CDP command failed"));
      return;
    }

    request.resolve(message.result);
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("CDP websocket failed to open")), { once: true });
  });

  const send = (method: string, params: Record<string, unknown> = {}) => {
    const id = nextId++;
    const result = new Promise<unknown>((resolve, reject) => {
      pending.set(id, { reject, resolve });
    });
    ws.send(JSON.stringify({ id, method, params }));
    return result;
  };
  await send("Page.enable");
  await send("Page.navigate", { url });
  await Bun.sleep(500);

  return {
    close: () => ws.close(),
    evaluate: async (expression: string) => {
      const result = await send("Runtime.evaluate", {
        awaitPromise: true,
        expression,
        returnByValue: true
      });
      return String((result as { result?: { value?: unknown } }).result?.value ?? "");
    }
  };
}

async function cdpTarget(cdpPort: number): Promise<{ webSocketDebuggerUrl: string }> {
  const existingTargets = await fetchJsonArray(`http://127.0.0.1:${cdpPort}/json/list`);
  const existingTarget = existingTargets.find(hasWebSocketDebuggerUrl);
  if (existingTarget) {
    return existingTarget;
  }

  const created = await fetchJson(`http://127.0.0.1:${cdpPort}/json/new`, { method: "PUT" });
  if (!hasWebSocketDebuggerUrl(created)) {
    throw new Error("CDP target did not include a websocket debugger URL");
  }

  return created;
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`CDP HTTP request failed with ${response.status}`);
  }

  return response.json();
}

async function fetchJsonArray(url: string): Promise<unknown[]> {
  const value = await fetchJson(url);
  return Array.isArray(value) ? value : [];
}

function hasWebSocketDebuggerUrl(value: unknown): value is { webSocketDebuggerUrl: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "webSocketDebuggerUrl" in value &&
    typeof value.webSocketDebuggerUrl === "string"
  );
}
