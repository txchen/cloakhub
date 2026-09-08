import {
  dashboardProfiles,
  profileResponseProfiles,
  profileResponseProfile
} from "./profile-presentation";
import { renderShell } from "./ui/shell";
import {
  renderLoginShell,
  renderManualViewer,
  renderManualViewerUnavailable
} from "./ui/pages";
import { uiAssetResponse } from "./ui/assets";

import type { CloakHubConfig } from "./config";
import {
  CdpUnauthorizedError,
  parseCdpRoute,
  type CdpGateway
} from "./cdp-gateway";
import type { CdpWebSocketData } from "./cdp-websocket-proxy";
import type { VncWebSocketData } from "./vnc-websocket-proxy";
import {
  BrowserProfileNotFoundError,
  CapacityUnavailableError,
  MissingDisplayRuntimeError,
  UnsupportedManualViewerProfileError,
  type BrowserRuntime,
  type BrowserRuntimeState
} from "./browser-runtime";
import {
  adminLoginResponse,
  isAdminApiAuthorized,
  isUiAuthorized,
  unauthorizedResponse
} from "./auth";
import { jsonResponse, textResponse } from "./http";
import { redactProfileSecrets } from "./profile";
import {
  DeleteProfileDataError,
  DuplicateProfileError,
  ProfileNotFoundError,
  ProfileValidationError,
  type ProfileService
} from "./profile-service";

export interface CloakHubApp {
  fetch: {
    (request: Request): Response | Promise<Response>;
    (
      request: Request,
      server: CloakHubUpgradeServer
    ): Response | Promise<Response | undefined> | undefined;
  };
}

export interface CloakHubUpgradeServer {
  upgrade(request: Request, options: { data: CloakHubWebSocketData }): boolean;
}

export type CloakHubWebSocketData = CdpWebSocketData | VncWebSocketData;

export interface CloakHubServices {
  browserRuntime?: BrowserRuntime;
  cdpGateway?: CdpGateway;
  profileService?: ProfileService;
}

export function createApp(
  config: CloakHubConfig,
  services: CloakHubServices = {}
): CloakHubApp {
  async function fetch(
    request: Request,
    server?: CloakHubUpgradeServer
  ): Promise<Response | undefined> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return healthResponse(request);
    }

    if (url.pathname === "/api/auth/login") {
      return adminLoginResponse(request, config.authToken);
    }

    if (url.pathname === "/favicon.svg") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return textResponse("Method not allowed", 405, { Allow: "GET, HEAD" });
      }
      return new Response(
        request.method === "HEAD"
          ? null
          : Bun.file(new URL("./favicon.svg", import.meta.url)),
        {
          headers: {
            "cache-control": "public, max-age=86400",
            "content-type": "image/svg+xml; charset=utf-8"
          }
        }
      );
    }

    const uiAsset = await uiAssetResponse(request, url);
    if (uiAsset) return uiAsset;

    const noVncAssetResponse = await noVncAssetResponseForRequest(request, url);
    if (noVncAssetResponse) {
      return noVncAssetResponse;
    }

    if (
      isAdminApiRoute(url) &&
      !isAdminApiAuthorized(request, config.authToken)
    ) {
      return unauthorizedResponse();
    }

    if (
      isUiProfileActionRoute(url) &&
      !isUiAuthorized(request, config.authToken)
    ) {
      return unauthorizedResponse();
    }

    const cdpResponse = await cdpApiResponse(
      request,
      url,
      services.cdpGateway,
      server
    );
    if (cdpResponse !== undefined || isCdpRoute(url)) {
      return cdpResponse;
    }

    const cdpTokenResponse = await cdpTokenApiResponse(
      request,
      url,
      services.profileService
    );
    if (cdpTokenResponse) {
      return cdpTokenResponse;
    }

    const vncWebSocketResponse = await vncWebSocketResponseForRequest(
      request,
      url,
      services.browserRuntime,
      server
    );
    if (vncWebSocketResponse !== undefined || isVncRoute(url)) {
      return vncWebSocketResponse;
    }

    const clipboardResponse = await manualClipboardResponse(
      request,
      url,
      services.browserRuntime
    );
    if (clipboardResponse) {
      return clipboardResponse;
    }

    const manualViewerResponse = await manualViewerUiResponse(
      request,
      url,
      services.browserRuntime
    );
    if (manualViewerResponse) {
      return manualViewerResponse;
    }

    const lifecycleResponse = await lifecycleApiResponse(
      request,
      url,
      services.browserRuntime
    );
    if (lifecycleResponse) {
      return lifecycleResponse;
    }

    const profileResponse = await profileApiResponse(
      request,
      url,
      config,
      services.profileService,
      services.browserRuntime
    );
    if (profileResponse) {
      return profileResponse;
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      if (!isUiAuthorized(request, config.authToken)) {
        return unauthorizedHtmlResponse(renderLoginShell());
      }

      const profiles = services.profileService
        ? await dashboardProfiles(
            services.profileService.listProfiles(),
            url,
            config,
            services.browserRuntime
          )
        : [];
      return htmlResponse(renderShell(config, profiles));
    }

    return textResponse("Not found", 404);
  }

  return {
    fetch: fetch as CloakHubApp["fetch"]
  };
}

async function noVncAssetResponseForRequest(
  request: Request,
  url: URL
): Promise<Response | undefined> {
  const prefix = "/assets/novnc/";
  if (!url.pathname.startsWith(prefix)) {
    return undefined;
  }

  if (request.method !== "GET") {
    return textResponse("Method not allowed", 405, { Allow: "GET" });
  }

  const assetPath = url.pathname.slice(prefix.length);
  if (
    !/^(?:core|vendor)\/[A-Za-z0-9_./-]+\.js$/.test(assetPath) ||
    assetPath.includes("..")
  ) {
    return textResponse("Not found", 404);
  }

  const asset = await noVncAsset(assetPath);
  if (!(await asset.exists())) {
    return textResponse("Not found", 404);
  }

  return new Response(asset, {
    headers: {
      "cache-control": "no-store",
      "content-type": "text/javascript; charset=utf-8"
    }
  });
}

async function noVncAsset(
  assetPath: string
): Promise<ReturnType<typeof Bun.file>> {
  const candidates = [
    process.env.CLOAKHUB_NOVNC_WEB_ROOT
      ? Bun.file(
          `${process.env.CLOAKHUB_NOVNC_WEB_ROOT.replace(/\/$/, "")}/${assetPath}`
        )
      : undefined,
    Bun.file(
      new URL(`../node_modules/@novnc/novnc/${assetPath}`, import.meta.url)
    )
  ].filter(
    (candidate): candidate is ReturnType<typeof Bun.file> =>
      candidate !== undefined
  );

  for (const candidate of candidates) {
    if (await candidate.exists()) {
      return candidate;
    }
  }

  return candidates[candidates.length - 1]!;
}

async function manualClipboardResponse(
  request: Request,
  url: URL,
  browserRuntime: BrowserRuntime | undefined
): Promise<Response | undefined> {
  const match = /^\/ui\/profiles\/([^/]+)\/clipboard$/.exec(url.pathname);
  if (!match) {
    return undefined;
  }

  if (!browserRuntime) {
    return textResponse("Not found", 404);
  }

  if (request.method === "GET") {
    try {
      const text = await browserRuntime.readManualClipboard(match[1]!);
      return jsonResponse({ text: text.slice(0, 1_048_576) });
    } catch (error) {
      return manualViewerJsonErrorResponse(error);
    }
  }

  if (request.method !== "POST") {
    return textResponse("Method not allowed", 405, { Allow: "GET, POST" });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Request body must be valid JSON", 400);
  }
  if (!isRecord(body) || typeof body.text !== "string") {
    return errorResponse("clipboard text is required", 400);
  }

  try {
    await browserRuntime.writeManualClipboard(match[1]!, body.text);
    return jsonResponse({ ok: true });
  } catch (error) {
    return manualViewerJsonErrorResponse(error);
  }
}

async function vncWebSocketResponseForRequest(
  request: Request,
  url: URL,
  browserRuntime: BrowserRuntime | undefined,
  server: CloakHubUpgradeServer | undefined
): Promise<Response | undefined> {
  const match = /^\/ui\/profiles\/([^/]+)\/vnc$/.exec(url.pathname);
  if (!match) {
    return undefined;
  }

  if (!browserRuntime) {
    return textResponse("Not found", 404);
  }

  if (!isWebSocketUpgrade(request)) {
    return textResponse("VNC websocket upgrade is required", 426);
  }

  if (!server) {
    return errorResponse("VNC websocket upgrade is unavailable", 400);
  }

  try {
    const viewer = await browserRuntime.openManualViewer(match[1]!);
    const upgraded = server.upgrade(request, {
      data: {
        profileId: viewer.profile_id,
        targetHost: "127.0.0.1",
        targetPort: viewer.vnc_port
      }
    });

    return upgraded
      ? undefined
      : errorResponse("VNC websocket upgrade failed", 400);
  } catch (error) {
    return manualViewerJsonErrorResponse(error);
  }
}

async function manualViewerUiResponse(
  request: Request,
  url: URL,
  browserRuntime: BrowserRuntime | undefined
): Promise<Response | undefined> {
  const match = /^\/ui\/profiles\/([^/]+)\/viewer$/.exec(url.pathname);
  if (!match) {
    return undefined;
  }

  if (!browserRuntime) {
    return textResponse("Not found", 404);
  }

  if (request.method !== "GET") {
    return textResponse("Method not allowed", 405, { Allow: "GET" });
  }

  try {
    return htmlResponse(
      renderManualViewer(await browserRuntime.openManualViewer(match[1]!))
    );
  } catch (error) {
    return manualViewerErrorResponse(error);
  }
}

async function cdpApiResponse(
  request: Request,
  url: URL,
  cdpGateway: CdpGateway | undefined,
  server: CloakHubUpgradeServer | undefined
): Promise<Response | undefined> {
  const route = parseCdpRoute(url.pathname);
  if (!route) {
    return undefined;
  }

  if (!cdpGateway) {
    return textResponse("Not found", 404);
  }

  try {
    if (isWebSocketUpgrade(request)) {
      if (!server) {
        return errorResponse("CDP websocket upgrade is unavailable", 400);
      }

      const upgraded = server.upgrade(request, {
        data: {
          ...(await cdpGateway.websocketData(
            request,
            route.profileId,
            route.cdpPath
          )),
          requestUserAgent: request.headers.get("user-agent") ?? undefined
        }
      });

      return upgraded
        ? undefined
        : errorResponse("CDP websocket upgrade failed", 400);
    }

    if (request.method !== "GET") {
      return textResponse("Method not allowed", 405, { Allow: "GET" });
    }

    return await cdpGateway.discoveryResponse(
      request,
      route.profileId,
      route.cdpPath
    );
  } catch (error) {
    if (error instanceof CdpUnauthorizedError) {
      return unauthorizedResponse();
    }

    if (error instanceof CapacityUnavailableError) {
      return retryableErrorResponse(error.message, 503);
    }

    return errorResponse(
      redactProfileSecrets(
        error instanceof Error ? error.message : String(error),
        cdpTokensFromRequest(request)
      ),
      503
    );
  }
}

function cdpTokensFromRequest(request: Request): string[] {
  const token = new URL(request.url).searchParams.get("token");
  return token ? [token] : [];
}

async function cdpTokenApiResponse(
  request: Request,
  url: URL,
  profileService: ProfileService | undefined
): Promise<Response | undefined> {
  const match =
    /^\/(?:api|ui)\/profiles\/([^/]+)\/cdp-token(?:\/(regenerate))?$/.exec(
      url.pathname
    );
  if (!match) {
    return undefined;
  }

  if (!profileService) {
    return textResponse("Not found", 404);
  }

  const profileId = match[1]!;
  const action = match[2];

  try {
    if (!action && request.method === "GET") {
      return jsonResponse(profileService.getCdpToken(profileId));
    }

    if (!action && request.method === "POST") {
      return jsonResponse(profileService.createCdpToken(profileId), 201);
    }

    if (action === "regenerate" && request.method === "POST") {
      return jsonResponse(profileService.regenerateCdpToken(profileId));
    }

    if (!action && request.method === "DELETE") {
      profileService.revokeCdpToken(profileId);
      return new Response(null, { status: 204 });
    }

    return textResponse("Method not allowed", 405, {
      Allow: action === "regenerate" ? "POST" : "GET, POST, DELETE"
    });
  } catch (error) {
    return cdpTokenErrorResponse(error);
  }
}

function isWebSocketUpgrade(request: Request): boolean {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

async function lifecycleApiResponse(
  request: Request,
  url: URL,
  browserRuntime: BrowserRuntime | undefined
): Promise<Response | undefined> {
  const match = /^\/(?:api|ui)\/profiles\/([^/]+)\/(start|stop|restart)$/.exec(
    url.pathname
  );
  if (!match) {
    return undefined;
  }

  if (!browserRuntime) {
    return textResponse("Not found", 404);
  }

  if (request.method !== "POST") {
    return textResponse("Method not allowed", 405, { Allow: "POST" });
  }

  const profileId = match[1]!;
  const action = match[2]!;

  try {
    if (action === "start") {
      return jsonResponse(
        lifecycleResponseState(await browserRuntime.start(profileId))
      );
    }

    if (action === "stop") {
      return jsonResponse(
        lifecycleResponseState(
          await browserRuntime.stop(profileId, "manual stop")
        )
      );
    }

    return jsonResponse(
      lifecycleResponseState(await browserRuntime.restart(profileId))
    );
  } catch (error) {
    return lifecycleErrorResponse(error);
  }
}

function lifecycleResponseState(
  state: BrowserRuntimeState
): Omit<BrowserRuntimeState, "cdp_port"> {
  return {
    profile_id: state.profile_id,
    status: state.status
  };
}

async function profileApiResponse(
  request: Request,
  url: URL,
  config: CloakHubConfig,
  profileService: ProfileService | undefined,
  browserRuntime: BrowserRuntime | undefined
): Promise<Response | undefined> {
  const match = /^\/(?:api|ui)\/profiles(?:\/([^/]+))?$/.exec(url.pathname);
  if (!match) {
    return undefined;
  }

  if (!profileService) {
    return textResponse("Not found", 404);
  }

  const profileId = match[1];

  try {
    const body =
      request.method === "POST" || request.method === "PATCH"
        ? await jsonBody(request)
        : undefined;

    if (!profileId && request.method === "GET") {
      return jsonResponse(
        await profileResponseProfiles(
          profileService.listProfiles(),
          url,
          config,
          browserRuntime
        )
      );
    }

    if (!profileId && request.method === "POST") {
      const profile = await profileService.createProfile(body);
      return jsonResponse(
        await profileResponseProfile(profile, url, config, browserRuntime),
        201
      );
    }

    if (profileId && request.method === "GET") {
      const profile = profileService.getProfile(profileId);
      return profile
        ? jsonResponse(
            await profileResponseProfile(profile, url, config, browserRuntime)
          )
        : errorResponse("Browser Profile was not found", 404);
    }

    if (profileId && request.method === "PATCH") {
      return jsonResponse(
        await profileResponseProfile(
          await profileService.updateProfile(profileId, body),
          url,
          config,
          browserRuntime
        )
      );
    }

    if (profileId && request.method === "DELETE") {
      if (browserRuntime) {
        await browserRuntime.deleteProfile(profileId, () =>
          profileService.deleteStoppedProfile(profileId)
        );
      } else {
        await profileService.deleteStoppedProfile(profileId);
      }
      return new Response(null, { status: 204 });
    }

    return textResponse("Method not allowed", 405, {
      Allow: profileId ? "GET, PATCH, DELETE" : "GET, POST"
    });
  } catch (error) {
    return profileErrorResponse(error);
  }
}

async function jsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ProfileValidationError("Request body must be valid JSON");
  }
}

function profileErrorResponse(error: unknown): Response {
  if (error instanceof ProfileValidationError) {
    return errorResponse(redactProfileSecrets(error.message), 400);
  }

  if (error instanceof DuplicateProfileError) {
    return errorResponse(redactProfileSecrets(error.message), 409);
  }

  if (
    error instanceof ProfileNotFoundError ||
    error instanceof BrowserProfileNotFoundError
  ) {
    return errorResponse(redactProfileSecrets(error.message), 404);
  }

  if (error instanceof DeleteProfileDataError) {
    return errorResponse(redactProfileSecrets(error.message), 500);
  }

  throw error;
}

function cdpTokenErrorResponse(error: unknown): Response {
  if (
    error instanceof ProfileNotFoundError ||
    error instanceof BrowserProfileNotFoundError
  ) {
    return errorResponse(redactProfileSecrets(error.message), 404);
  }

  throw error;
}

function lifecycleErrorResponse(error: unknown): Response {
  if (error instanceof BrowserProfileNotFoundError) {
    return errorResponse(error.message, 404);
  }

  if (error instanceof CapacityUnavailableError) {
    return retryableErrorResponse(error.message, 503);
  }

  return errorResponse(
    error instanceof Error ? error.message : String(error),
    500
  );
}

function manualViewerErrorResponse(error: unknown): Response {
  if (error instanceof BrowserProfileNotFoundError) {
    return htmlResponse(renderManualViewerUnavailable(error.message), 404);
  }

  if (
    error instanceof UnsupportedManualViewerProfileError ||
    error instanceof MissingDisplayRuntimeError
  ) {
    return htmlResponse(renderManualViewerUnavailable(error.message), 400);
  }

  if (error instanceof CapacityUnavailableError) {
    return htmlResponse(
      renderManualViewerUnavailable(`${error.message}. Retryable.`),
      503
    );
  }

  return htmlResponse(
    renderManualViewerUnavailable(
      error instanceof Error ? error.message : String(error)
    ),
    503
  );
}

function manualViewerJsonErrorResponse(error: unknown): Response {
  if (error instanceof BrowserProfileNotFoundError) {
    return errorResponse(error.message, 404);
  }

  if (
    error instanceof UnsupportedManualViewerProfileError ||
    error instanceof MissingDisplayRuntimeError
  ) {
    return errorResponse(error.message, 400);
  }

  if (error instanceof CapacityUnavailableError) {
    return retryableErrorResponse(error.message, 503);
  }

  return errorResponse(
    error instanceof Error ? error.message : String(error),
    503
  );
}

function errorResponse(error: string, status: number): Response {
  return jsonResponse({ error }, status);
}

function retryableErrorResponse(error: string, status: number): Response {
  return jsonResponse({ error, retryable: true }, status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function healthResponse(request: Request): Response {
  if (request.method !== "GET") {
    return textResponse("Method not allowed", 405, { Allow: "GET" });
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json"
    },
    status: 200
  });
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, htmlResponseInit({}, status));
}

function unauthorizedHtmlResponse(body: string): Response {
  return new Response(
    body,
    htmlResponseInit({ "WWW-Authenticate": "Bearer" }, 401)
  );
}

function htmlResponseInit(
  headers: HeadersInit = {},
  status = 200
): ResponseInit {
  return {
    headers: {
      "content-type": "text/html; charset=utf-8",
      ...headers
    },
    status
  };
}

function isAdminApiRoute(url: URL): boolean {
  return (
    url.pathname.startsWith("/api/") &&
    url.pathname !== "/api/health" &&
    url.pathname !== "/api/auth/login" &&
    !isCdpRoute(url)
  );
}

function isCdpRoute(url: URL): boolean {
  return /^\/api\/profiles\/[^/]+\/cdp(?:\/|$)/.test(url.pathname);
}

function isVncRoute(url: URL): boolean {
  return /^\/ui\/profiles\/[^/]+\/vnc$/.test(url.pathname);
}

function isUiProfileActionRoute(url: URL): boolean {
  return /^\/ui\/profiles(?:\/[^/]+(?:\/(?:start|stop|restart|viewer|vnc|clipboard|cdp-token(?:\/regenerate)?))?)?$/.test(
    url.pathname
  );
}
