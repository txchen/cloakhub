import { describe, expect, test } from "bun:test";

import { createApp, type CloakHubUpgradeServer, type CloakHubWebSocketData } from "../src/app";
import type { CdpGateway } from "../src/cdp-gateway";
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
    expect(await response?.json()).toEqual({ error: "failed for ***" });
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
