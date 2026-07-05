import { describe, expect, test } from "bun:test";

import {
  CdpUnauthorizedError,
  createCdpGateway,
  createProfileCdpAccessPolicy,
  type CdpAccessPolicy,
  type CdpBrowserHttpClient
} from "../src/cdp-gateway";
import type { BrowserRuntime, BrowserRuntimeState } from "../src/browser-runtime";
import type { ProfileService } from "../src/profile-service";

describe("CdpGateway", () => {
  test("wakes a stopped Browser Instance and rewrites discovery websocket URLs through CloakHub", async () => {
    const runtime = fakeRuntime();
    const browserHttp = fakeBrowserHttp({
      "/json/version": {
        Browser: "CloakBrowser",
        webSocketDebuggerUrl: "ws://127.0.0.1:5100/devtools/browser/browser-1"
      }
    });
    const gateway = createCdpGateway({ browserHttp, browserRuntime: runtime });

    const response = await gateway.discoveryResponse(
      new Request("https://hub.example/api/profiles/work/cdp/json/version"),
      "work",
      "/json/version"
    );

    expect(runtime.calls).toEqual(["start:work", "discovery:work"]);
    expect(browserHttp.requests).toEqual([{ cdpPort: 5100, path: "/json/version" }]);
    expect(await response.json()).toEqual({
      Browser: "CloakBrowser",
      webSocketDebuggerUrl: "wss://hub.example/api/profiles/work/cdp/devtools/browser/browser-1"
    });
  });

  test("does not expose internal CDP ports in discovery responses", async () => {
    const gateway = createCdpGateway({
      browserHttp: fakeBrowserHttp({
        "/json": [
          {
            id: "page-1",
            type: "page",
            webSocketDebuggerUrl: "ws://127.0.0.1:5100/devtools/page/page-1"
          }
        ]
      }),
      browserRuntime: fakeRuntime()
    });

    const response = await gateway.discoveryResponse(
      new Request("http://cloakhub.test/api/profiles/work/cdp/json"),
      "work",
      "/json"
    );
    const body = JSON.stringify(await response.json());

    expect(body).toContain("ws://cloakhub.test/api/profiles/work/cdp/devtools/page/page-1");
    expect(body).not.toContain("5100");
    expect(body).not.toContain("127.0.0.1");
  });

  test("preserves query CDP Token in rewritten websocket URLs", async () => {
    const gateway = createCdpGateway({
      browserHttp: fakeBrowserHttp({
        "/json/version": {
          webSocketDebuggerUrl: "ws://127.0.0.1:5100/devtools/browser/browser-1"
        }
      }),
      browserRuntime: fakeRuntime()
    });

    const response = await gateway.discoveryResponse(
      new Request("https://hub.example/api/profiles/work/cdp/json/version?token=profile-token"),
      "work",
      "/json/version"
    );

    expect(await response.json()).toMatchObject({
      webSocketDebuggerUrl:
        "wss://hub.example/api/profiles/work/cdp/devtools/browser/browser-1?token=profile-token"
    });
  });

  test("auth policy runs before Transparent Recovery", async () => {
    const runtime = fakeRuntime();
    const accessPolicy: CdpAccessPolicy = {
      authorize: async () => false
    };
    const gateway = createCdpGateway({
      accessPolicy,
      browserHttp: fakeBrowserHttp({}),
      browserRuntime: runtime
    });

    await expect(
      gateway.discoveryResponse(
        new Request("http://cloakhub.test/api/profiles/work/cdp/json/version"),
        "work",
        "/json/version"
      )
    ).rejects.toThrow(CdpUnauthorizedError);
    expect(runtime.calls).toEqual([]);
  });

  test("profile CDP access policy is open without a token and enforces bearer or query token when configured", async () => {
    const openPolicy = createProfileCdpAccessPolicy(fakeProfileService({ profile_id: "work" }));
    const tokenPolicy = createProfileCdpAccessPolicy(
      fakeProfileService({ cdp_token: "profile-token", profile_id: "work" })
    );

    expect(await openPolicy.authorize(new Request("http://cloakhub.test"), "work")).toBe(true);
    expect(await tokenPolicy.authorize(new Request("http://cloakhub.test"), "work")).toBe(false);
    expect(
      await tokenPolicy.authorize(
        new Request("http://cloakhub.test", { headers: { authorization: "Bearer profile-token" } }),
        "work"
      )
    ).toBe(true);
    expect(await tokenPolicy.authorize(new Request("http://cloakhub.test?token=profile-token"), "work")).toBe(
      true
    );
  });

  test("failed recovery returns one clear retryable response", async () => {
    const gateway = createCdpGateway({
      browserHttp: fakeBrowserHttp({}),
      browserRuntime: fakeRuntime({ startError: new Error("launch failed") })
    });

    const response = await gateway.discoveryResponse(
      new Request("http://cloakhub.test/api/profiles/work/cdp/json/version"),
      "work",
      "/json/version"
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "launch failed" });
  });

  test("prepares websocket proxy target after Transparent Recovery", async () => {
    const runtime = fakeRuntime();
    const gateway = createCdpGateway({ browserHttp: fakeBrowserHttp({}), browserRuntime: runtime });

    const data = await gateway.websocketData(
      new Request("http://cloakhub.test/api/profiles/work/cdp/devtools/page/page-1"),
      "work",
      "/devtools/page/page-1"
    );

    expect(runtime.calls).toEqual(["start:work"]);
    expect(data.targetUrl).toBe("ws://127.0.0.1:5100/devtools/page/page-1");
  });

  test("root stable CDP websocket resolves through browser discovery", async () => {
    const gateway = createCdpGateway({
      browserHttp: fakeBrowserHttp({
        "/json/version": {
          webSocketDebuggerUrl: "ws://127.0.0.1:5100/devtools/browser/browser-1"
        }
      }),
      browserRuntime: fakeRuntime()
    });

    const data = await gateway.websocketData(
      new Request("http://cloakhub.test/api/profiles/work/cdp"),
      "work",
      "/json/version"
    );

    expect(data).toEqual({
      profileId: "work",
      targetUrl: "ws://127.0.0.1:5100/devtools/browser/browser-1"
    });
  });
});

function fakeRuntime(options: { startError?: Error } = {}): BrowserRuntime & { calls: string[] } {
  const calls: string[] = [];
  const state: BrowserRuntimeState = { cdp_port: 5100, profile_id: "work", status: "running" };

  return {
    calls,
    cleanupOwnedProcessesOnStartup: async () => undefined,
    activeCdpSessionCount: () => 0,
    cdpSessionObservations: () => [],
    openCdpSession: () => ({
      close: () => undefined,
      recordMessage: () => undefined
    }),
    recordCdpDiscovery: (profileId) => {
      calls.push(`discovery:${profileId}`);
    },
    restart: async (profileId) => {
      calls.push(`restart:${profileId}`);
      return state;
    },
    start: async (profileId) => {
      calls.push(`start:${profileId}`);
      if (options.startError) {
        throw options.startError;
      }

      return state;
    },
    stop: async (profileId) => {
      calls.push(`stop:${profileId}`);
      return { ...state, cdp_port: -1, status: "stopped" };
    },
    spinDownIdleHeadlessInstances: async () => []
  };
}

function fakeProfileService(profile: Record<string, unknown>): ProfileService {
  return {
    createProfile: async () => {
      throw new Error("not used");
    },
    deleteStoppedProfile: async () => undefined,
    getProfile: () => profile as unknown as ReturnType<ProfileService["getProfile"]>,
    listProfiles: () => [profile as unknown as ReturnType<ProfileService["listProfiles"]>[number]],
    updateProfile: () => {
      throw new Error("not used");
    }
  };
}

function fakeBrowserHttp(responses: Record<string, unknown>): CdpBrowserHttpClient & {
  requests: Array<{ cdpPort: number; path: string }>;
} {
  const requests: Array<{ cdpPort: number; path: string }> = [];

  return {
    requests,
    getJson: async (cdpPort, path) => {
      requests.push({ cdpPort, path });
      return responses[path] ?? {};
    }
  };
}
