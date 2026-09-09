import { describe, expect, test } from "bun:test";

import { createApp, type CloakHubUpgradeServer, type CloakHubWebSocketData } from "../src/app";
import type { CdpGateway } from "../src/cdp-gateway";
import { createCdpGateway } from "../src/cdp-gateway";
import { BrowserProfileNotFoundError, CapacityUnavailableError, type BrowserRuntime } from "../src/browser-runtime";
import type { CdpWebSocketData } from "../src/cdp-websocket-proxy";
import type { CloakHubConfig } from "../src/config";

const config: CloakHubConfig = {
  authToken: "admin-token",
  browserBin: undefined,
  dataRoot: "/sensitive/data-root",
  host: "127.0.0.1",
  maxRunningInstances: 10,
  port: 7788
};

describe("CDP API", () => {
  test("missing profiles and capacity failures have matching HTTP and websocket error semantics", async () => {
    for (const [error, status, code, retryable] of [
      [new BrowserProfileNotFoundError("missing"), 404, "PROFILE_NOT_FOUND", false],
      [new CapacityUnavailableError(), 503, "CAPACITY_UNAVAILABLE", true]
    ] as const) {
      const browserRuntime = { start: async () => { throw error; } } as unknown as BrowserRuntime;
      const app = createApp(config, {
        browserRuntime,
        cdpGateway: createCdpGateway({ browserRuntime })
      });
      for (const [path, headers] of [
        ["/api/profiles/missing/start", { authorization: "Bearer admin-token" }],
        ["/api/profiles/missing/cdp/json/version", {}],
        ["/api/profiles/missing/cdp", { upgrade: "websocket" }]
      ] as const) {
        const response = await app.fetch(new Request(`http://cloakhub.test${path}`, {
          method: path.endsWith("/start") ? "POST" : "GET", headers
        }), fakeUpgradeServer());
        expect(response?.status).toBe(status);
        expect(await response?.json()).toEqual({ code, retryable, message: error.message, error: error.message });
      }
    }
  });

  test("routes CDP discovery without admin auth so CDP auth can happen before wake", async () => {
    const cdpGateway = fakeCdpGateway();
    const app = createApp(config, { cdpGateway });

    const response = await app.fetch(
      new Request("http://cloakhub.test/api/profiles/work/cdp/json/version")
    );

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ ok: true });
    expect(cdpGateway.discoveryCalls).toEqual([{ cdpPath: "/json/version", profileId: "work" }]);
  });

  test("upgrades CDP websocket routes through the gateway", async () => {
    const cdpGateway = fakeCdpGateway();
    const server = fakeUpgradeServer();
    const app = createApp(config, { cdpGateway });

    const response = await app.fetch(
      new Request("http://cloakhub.test/api/profiles/work/cdp/devtools/page/page-1", {
        headers: { upgrade: "websocket", "user-agent": "Playwright" }
      }),
      server
    );

    expect(response).toBeUndefined();
    expect(cdpGateway.websocketCalls).toEqual([{ cdpPath: "/devtools/page/page-1", profileId: "work" }]);
    expect(server.upgrades).toEqual([
      {
        profileId: "work",
        requestUserAgent: "Playwright",
        targetUrl: "ws://127.0.0.1:5100/devtools/page/page-1"
      }
    ]);
  });

  test("redacts token values from CDP websocket errors", async () => {
    const cdpGateway = fakeCdpGateway({ websocketError: new Error("failed for profile-token") });
    const app = createApp(config, { cdpGateway });

    const response = await app.fetch(
      new Request("http://cloakhub.test/api/profiles/work/cdp/devtools/page/page-1?token=profile-token", {
        headers: { upgrade: "websocket" }
      }),
      fakeUpgradeServer()
    );

    expect(response?.status).toBe(503);
    expect(await response?.json()).toEqual({ error: "failed for ***", message: "failed for ***", code: "CDP_UNAVAILABLE", retryable: false });
  });
});

function fakeCdpGateway(options: { websocketError?: Error } = {}): CdpGateway & {
  discoveryCalls: Array<{ cdpPath: string; profileId: string }>;
  websocketCalls: Array<{ cdpPath: string; profileId: string }>;
} {
  const discoveryCalls: Array<{ cdpPath: string; profileId: string }> = [];
  const websocketCalls: Array<{ cdpPath: string; profileId: string }> = [];

  return {
    discoveryCalls,
    websocketCalls,
    discoveryResponse: async (_request, profileId, cdpPath) => {
      discoveryCalls.push({ cdpPath, profileId });
      return Response.json({ ok: true });
    },
    websocketData: async (_request, profileId, cdpPath) => {
      websocketCalls.push({ cdpPath, profileId });
      if (options.websocketError) {
        throw options.websocketError;
      }
      return { profileId, targetUrl: `ws://127.0.0.1:5100${cdpPath}` };
    }
  };
}

function fakeUpgradeServer(): CloakHubUpgradeServer & { upgrades: CloakHubWebSocketData[] } {
  const upgrades: CloakHubWebSocketData[] = [];

  return {
    upgrades,
    upgrade: (_request, options) => {
      upgrades.push(options.data);
      return true;
    }
  };
}
