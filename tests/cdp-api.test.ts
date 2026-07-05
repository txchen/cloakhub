import { describe, expect, test } from "bun:test";

import { createApp, type CloakHubUpgradeServer } from "../src/app";
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
        headers: { upgrade: "websocket" }
      }),
      server
    );

    expect(response).toBeUndefined();
    expect(cdpGateway.websocketCalls).toEqual([{ cdpPath: "/devtools/page/page-1", profileId: "work" }]);
    expect(server.upgrades).toEqual([
      {
        profileId: "work",
        targetUrl: "ws://127.0.0.1:5100/devtools/page/page-1"
      }
    ]);
  });
});

function fakeCdpGateway(): CdpGateway & {
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
      return { profileId, targetUrl: `ws://127.0.0.1:5100${cdpPath}` };
    }
  };
}

function fakeUpgradeServer(): CloakHubUpgradeServer & { upgrades: CdpWebSocketData[] } {
  const upgrades: CdpWebSocketData[] = [];

  return {
    upgrades,
    upgrade: (_request, options) => {
      upgrades.push(options.data);
      return true;
    }
  };
}
