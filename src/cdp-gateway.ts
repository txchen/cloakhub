import type { BrowserRuntime } from "./browser-runtime";
import type { CdpWebSocketData } from "./cdp-websocket-proxy";
import type { ProfileService } from "./profile-service";
import { redactProfileSecrets } from "./profile";

export interface CdpAccessPolicy {
  authorize(request: Request, profileId: string): Promise<boolean> | boolean;
}

export interface CdpBrowserHttpClient {
  getJson(cdpPort: number, path: string): Promise<unknown>;
}

export interface CdpGateway {
  discoveryResponse(request: Request, profileId: string, cdpPath: string): Promise<Response>;
  websocketData(request: Request, profileId: string, cdpPath: string): Promise<CdpWebSocketData>;
}

export class CdpUnauthorizedError extends Error {
  constructor() {
    super("CDP access is unauthorized");
    this.name = "CdpUnauthorizedError";
  }
}

export interface CdpGatewayOptions {
  accessPolicy?: CdpAccessPolicy;
  browserHttp?: CdpBrowserHttpClient;
  browserRuntime: BrowserRuntime;
  cdpTokensForRedaction?: () => string[];
}

const allowAllCdpAccess: CdpAccessPolicy = {
  authorize: () => true
};

const defaultBrowserHttp: CdpBrowserHttpClient = {
  async getJson(cdpPort: number, path: string): Promise<unknown> {
    const response = await fetch(`http://127.0.0.1:${cdpPort}${path}`);
    if (!response.ok) {
      throw new Error(`Browser CDP endpoint returned ${response.status}`);
    }

    return response.json();
  }
};

export function createCdpGateway(options: CdpGatewayOptions): CdpGateway {
  const accessPolicy = options.accessPolicy ?? allowAllCdpAccess;
  const browserHttp = options.browserHttp ?? defaultBrowserHttp;

  return {
    async discoveryResponse(request, profileId, cdpPath): Promise<Response> {
      if (!(await accessPolicy.authorize(request, profileId))) {
        throw new CdpUnauthorizedError();
      }

      try {
        const runtimeState = await options.browserRuntime.start(profileId);
        const discovery = await browserHttp.getJson(runtimeState.cdp_port, discoveryPath(cdpPath));
        options.browserRuntime.recordCdpDiscovery(profileId);

        return Response.json(rewriteDiscoveryUrls(discovery, request, profileId));
      } catch (error) {
        return Response.json(
          { error: redactProfileSecrets(errorMessage(error), options.cdpTokensForRedaction?.() ?? []) },
          { status: 503 }
        );
      }
    },

    async websocketData(request, profileId, cdpPath): Promise<CdpWebSocketData> {
      if (!(await accessPolicy.authorize(request, profileId))) {
        throw new CdpUnauthorizedError();
      }

      const runtimeState = await options.browserRuntime.start(profileId);
      if (cdpPath === "/json/version") {
        const version = await browserHttp.getJson(runtimeState.cdp_port, "/json/version");
        return {
          profileId,
          targetUrl: browserWebSocketTarget(version, runtimeState.cdp_port)
        };
      }

      return {
        profileId,
        targetUrl: `ws://127.0.0.1:${runtimeState.cdp_port}${cdpPath}`
      };
    }
  };
}

export function createProfileCdpAccessPolicy(profileService: ProfileService): CdpAccessPolicy {
  return {
    authorize(request, profileId): boolean {
      const profile = profileService.getProfile(profileId) as Record<string, unknown> | undefined;
      const token = typeof profile?.cdp_token === "string" ? profile.cdp_token : "";
      if (!token) {
        return true;
      }

      return bearerToken(request) === token || new URL(request.url).searchParams.get("token") === token;
    }
  };
}

export function parseCdpRoute(pathname: string): { cdpPath: string; profileId: string } | undefined {
  const match = /^\/api\/profiles\/([^/]+)\/cdp(?:\/(.*))?$/.exec(pathname);
  if (!match) {
    return undefined;
  }

  const suffix = match[2] ?? "";
  return {
    cdpPath: suffix ? `/${suffix}` : "/json/version",
    profileId: decodeURIComponent(match[1]!)
  };
}

function discoveryPath(cdpPath: string): string {
  if (cdpPath === "/json/list") {
    return "/json";
  }

  return cdpPath;
}

function rewriteDiscoveryUrls(value: unknown, request: Request, profileId: string): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => rewriteDiscoveryUrls(entry, request, profileId));
  }

  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (key === "webSocketDebuggerUrl" && typeof entry === "string") {
        return [key, rewriteWebSocketDebuggerUrl(entry, request, profileId)];
      }

      if (key === "devtoolsFrontendUrl" && typeof entry === "string") {
        return [key, rewriteDevtoolsFrontendUrl(entry, request, profileId)];
      }

      return [key, rewriteDiscoveryUrls(entry, request, profileId)];
    })
  );
}

function rewriteWebSocketDebuggerUrl(value: string, request: Request, profileId: string): string {
  const original = new URL(value);
  const publicUrl = publicRequestUrl(request);
  const protocol = publicUrl.protocol === "https:" ? "wss:" : "ws:";
  const token = publicUrl.searchParams.get("token");
  if (token && !original.searchParams.has("token")) {
    original.searchParams.set("token", token);
  }

  return `${protocol}//${publicUrl.host}/api/profiles/${encodeURIComponent(profileId)}/cdp${original.pathname}${original.search}`;
}

function rewriteDevtoolsFrontendUrl(value: string, request: Request, profileId: string): string {
  const frontendUrl = new URL(value, "http://devtools.local");
  const ws = frontendUrl.searchParams.get("ws");
  if (ws) {
    const rewritten = rewriteWebSocketDebuggerUrl(`ws://${ws}`, request, profileId);
    frontendUrl.searchParams.set("ws", rewritten.replace(/^wss?:\/\//, ""));
  }

  return `${frontendUrl.pathname}${frontendUrl.search}`;
}

function browserWebSocketTarget(value: unknown, fallbackPort: number): string {
  if (isRecord(value) && typeof value.webSocketDebuggerUrl === "string") {
    return value.webSocketDebuggerUrl;
  }

  return `ws://127.0.0.1:${fallbackPort}/devtools/browser`;
}

function bearerToken(request: Request): string | undefined {
  const authorization = request.headers.get("authorization");
  const match = /^Bearer\s+(.+)$/i.exec(authorization ?? "");
  return match?.[1];
}

function publicRequestUrl(request: Request): URL {
  const url = new URL(request.url);
  const forwardedHost = request.headers.get("x-forwarded-host");
  const forwardedProto = request.headers.get("x-forwarded-proto");

  if (forwardedHost) {
    url.host = forwardedHost;
  }

  if (forwardedProto === "http" || forwardedProto === "https") {
    url.protocol = `${forwardedProto}:`;
  }

  return url;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
