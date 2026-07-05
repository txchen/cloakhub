import type { CloakHubConfig } from "./config";
import { CdpUnauthorizedError, parseCdpRoute, type CdpGateway } from "./cdp-gateway";
import type { CdpWebSocketData } from "./cdp-websocket-proxy";
import type { VncWebSocketData } from "./vnc-websocket-proxy";
import {
  BrowserProfileNotFoundError,
  CapacityUnavailableError,
  MissingDisplayRuntimeError,
  UnsupportedManualViewerProfileError,
  type BrowserRuntime,
  type BrowserRuntimeCdpSessionObservation,
  type BrowserRuntimeManualViewerState,
  type BrowserRuntimeState
} from "./browser-runtime";
import {
  adminLoginResponse,
  isAdminApiAuthorized,
  isUiAuthorized,
  unauthorizedResponse
} from "./auth";
import { jsonResponse, textResponse } from "./http";
import { redactProfileSecrets, redactProfileSecretsFromProfile, type BrowserProfile } from "./profile";
import {
  DeleteProfileDataError,
  DuplicateProfileError,
  ProfileNotFoundError,
  ProfileValidationError,
  type ProfileService
} from "./profile-service";
import { ownedProcessResourceUsageByProfile, type OwnedProcessResourceUsage } from "./owned-process";

type PresentedBrowserProfile = Omit<BrowserProfile, "cdp_token"> & {
  cdp_token_configured: boolean;
  cdp_session_count: number;
  cdp_sessions: BrowserRuntimeCdpSessionObservation[];
  last_manual_input_at: string | null;
  manual_viewer_count: number;
  resource_usage: OwnedProcessResourceUsage;
  sleep_status: string;
};

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

export function createApp(config: CloakHubConfig, services: CloakHubServices = {}): CloakHubApp {
  async function fetch(request: Request, server?: CloakHubUpgradeServer): Promise<Response | undefined> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return healthResponse(request);
    }

    if (url.pathname === "/api/auth/login") {
      return adminLoginResponse(request, config.authToken);
    }

    const noVncAssetResponse = await noVncAssetResponseForRequest(request, url);
    if (noVncAssetResponse) {
      return noVncAssetResponse;
    }

    if (isAdminApiRoute(url) && !isAdminApiAuthorized(request, config.authToken)) {
      return unauthorizedResponse();
    }

    if (isUiProfileActionRoute(url) && !isUiAuthorized(request, config.authToken)) {
      return unauthorizedResponse();
    }

    const cdpResponse = await cdpApiResponse(request, url, services.cdpGateway, server);
    if (cdpResponse !== undefined || isCdpRoute(url)) {
      return cdpResponse;
    }

    const cdpTokenResponse = await cdpTokenApiResponse(request, url, services.profileService);
    if (cdpTokenResponse) {
      return cdpTokenResponse;
    }

    const vncWebSocketResponse = await vncWebSocketResponseForRequest(request, url, services.browserRuntime, server);
    if (vncWebSocketResponse !== undefined || isVncRoute(url)) {
      return vncWebSocketResponse;
    }

    const clipboardResponse = await manualClipboardResponse(request, url, services.browserRuntime);
    if (clipboardResponse) {
      return clipboardResponse;
    }

    const manualViewerResponse = await manualViewerUiResponse(request, url, services.browserRuntime);
    if (manualViewerResponse) {
      return manualViewerResponse;
    }

    const lifecycleResponse = await lifecycleApiResponse(request, url, services.browserRuntime);
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
        ? await dashboardProfiles(services.profileService.listProfiles(), url, config, services.browserRuntime)
        : [];
      return htmlResponse(renderShell(config, profiles));
    }

    return textResponse("Not found", 404);
  }

  return {
    fetch: fetch as CloakHubApp["fetch"]
  };
}

async function noVncAssetResponseForRequest(request: Request, url: URL): Promise<Response | undefined> {
  const prefix = "/assets/novnc/";
  if (!url.pathname.startsWith(prefix)) {
    return undefined;
  }

  if (request.method !== "GET") {
    return textResponse("Method not allowed", 405, { Allow: "GET" });
  }

  const assetPath = url.pathname.slice(prefix.length);
  if (!/^(?:core|vendor)\/[A-Za-z0-9_./-]+\.js$/.test(assetPath) || assetPath.includes("..")) {
    return textResponse("Not found", 404);
  }

  const asset = Bun.file(new URL(`../node_modules/@novnc/novnc/${assetPath}`, import.meta.url));
  if (!(await asset.exists())) {
    return textResponse("Not found", 404);
  }

  return new Response(asset, {
    headers: { "content-type": "text/javascript; charset=utf-8" }
  });
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

  if (request.method !== "POST") {
    return textResponse("Method not allowed", 405, { Allow: "POST" });
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

    return upgraded ? undefined : errorResponse("VNC websocket upgrade failed", 400);
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
    return htmlResponse(renderManualViewer(await browserRuntime.openManualViewer(match[1]!)));
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
          ...(await cdpGateway.websocketData(request, route.profileId, route.cdpPath)),
          requestUserAgent: request.headers.get("user-agent") ?? undefined
        }
      });

      return upgraded ? undefined : errorResponse("CDP websocket upgrade failed", 400);
    }

    if (request.method !== "GET") {
      return textResponse("Method not allowed", 405, { Allow: "GET" });
    }

    return await cdpGateway.discoveryResponse(request, route.profileId, route.cdpPath);
  } catch (error) {
    if (error instanceof CdpUnauthorizedError) {
      return unauthorizedResponse();
    }

    if (error instanceof CapacityUnavailableError) {
      return retryableErrorResponse(error.message, 503);
    }

    return errorResponse(
      redactProfileSecrets(error instanceof Error ? error.message : String(error), cdpTokensFromRequest(request)),
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
  const match = /^\/(?:api|ui)\/profiles\/([^/]+)\/cdp-token(?:\/(regenerate))?$/.exec(url.pathname);
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
  const match = /^\/(?:api|ui)\/profiles\/([^/]+)\/(start|stop|restart)$/.exec(url.pathname);
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
      return jsonResponse(lifecycleResponseState(await browserRuntime.start(profileId)));
    }

    if (action === "stop") {
      return jsonResponse(lifecycleResponseState(await browserRuntime.stop(profileId, "manual stop")));
    }

    return jsonResponse(lifecycleResponseState(await browserRuntime.restart(profileId)));
  } catch (error) {
    return lifecycleErrorResponse(error);
  }
}

function lifecycleResponseState(state: BrowserRuntimeState): Omit<BrowserRuntimeState, "cdp_port"> {
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
    const body = request.method === "POST" || request.method === "PATCH" ? await jsonBody(request) : undefined;

    if (!profileId && request.method === "GET") {
      return jsonResponse(await profileResponseProfiles(profileService.listProfiles(), url, config, browserRuntime));
    }

    if (!profileId && request.method === "POST") {
      const profile = await profileService.createProfile(body);
      return jsonResponse(await profileResponseProfile(profile, url, config, browserRuntime), 201);
    }

    if (profileId && request.method === "GET") {
      const profile = profileService.getProfile(profileId);
      return profile
        ? jsonResponse(await profileResponseProfile(profile, url, config, browserRuntime))
        : errorResponse("Browser Profile was not found", 404);
    }

    if (profileId && request.method === "PATCH") {
      return jsonResponse(
        await profileResponseProfile(
          await profileService.updateProfile(profileId, uiPatchBody(body, url)),
          url,
          config,
          browserRuntime
        )
      );
    }

    if (profileId && request.method === "DELETE") {
      await profileService.deleteStoppedProfile(profileId);
      return new Response(null, { status: 204 });
    }

    return textResponse("Method not allowed", 405, {
      Allow: profileId ? "GET, PATCH, DELETE" : "GET, POST"
    });
  } catch (error) {
    return profileErrorResponse(error);
  }
}

function uiPatchBody(body: unknown, url: URL): unknown {
  if (!isUiProfileActionRoute(url) || !isRecord(body) || body.proxy !== "") {
    return body;
  }

  const { proxy: _proxy, ...rest } = body;
  return rest;
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

  if (error instanceof ProfileNotFoundError) {
    return errorResponse(redactProfileSecrets(error.message), 404);
  }

  if (error instanceof DeleteProfileDataError) {
    return errorResponse(redactProfileSecrets(error.message), 500);
  }

  throw error;
}

function cdpTokenErrorResponse(error: unknown): Response {
  if (error instanceof ProfileNotFoundError) {
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

  return errorResponse(error instanceof Error ? error.message : String(error), 500);
}

function manualViewerErrorResponse(error: unknown): Response {
  if (error instanceof BrowserProfileNotFoundError) {
    return htmlResponse(renderManualViewerUnavailable(error.message), 404);
  }

  if (error instanceof UnsupportedManualViewerProfileError || error instanceof MissingDisplayRuntimeError) {
    return htmlResponse(renderManualViewerUnavailable(error.message), 400);
  }

  if (error instanceof CapacityUnavailableError) {
    return htmlResponse(renderManualViewerUnavailable(`${error.message}. Retryable.`), 503);
  }

  return htmlResponse(
    renderManualViewerUnavailable(error instanceof Error ? error.message : String(error)),
    503
  );
}

function manualViewerJsonErrorResponse(error: unknown): Response {
  if (error instanceof BrowserProfileNotFoundError) {
    return errorResponse(error.message, 404);
  }

  if (error instanceof UnsupportedManualViewerProfileError || error instanceof MissingDisplayRuntimeError) {
    return errorResponse(error.message, 400);
  }

  if (error instanceof CapacityUnavailableError) {
    return retryableErrorResponse(error.message, 503);
  }

  return errorResponse(error instanceof Error ? error.message : String(error), 503);
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

function timestampMs(value: string | null | undefined): number {
  if (!value) {
    return 0;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

async function profileResponseProfiles(
  profiles: BrowserProfile[],
  url: URL,
  config: CloakHubConfig,
  browserRuntime: BrowserRuntime | undefined
): Promise<PresentedBrowserProfile[]> {
  const resourceUsageByProfileId = await ownedProcessResourceUsageByProfile(
    config.dataRoot,
    profiles.map((profile) => profile.profile_id)
  );
  return profiles.map((profile) =>
    presentProfileWithResourceUsage(
      profile,
      resourceUsageByProfileId.get(profile.profile_id),
      browserRuntime,
      isUiProfileActionRoute(url)
    )
  );
}

async function profileResponseProfile(
  profile: BrowserProfile,
  url: URL,
  config: CloakHubConfig,
  browserRuntime: BrowserRuntime | undefined
): Promise<PresentedBrowserProfile> {
  const resourceUsageByProfileId = await ownedProcessResourceUsageByProfile(config.dataRoot, [
    profile.profile_id
  ]);
  return presentProfileWithResourceUsage(
    profile,
    resourceUsageByProfileId.get(profile.profile_id),
    browserRuntime,
    isUiProfileActionRoute(url)
  );
}

function presentProfile(
  profile: BrowserProfile,
  browserRuntime: BrowserRuntime | undefined,
  redactSecrets = false
): PresentedBrowserProfile {
  const { cdp_token: _cdpToken, ...profileWithoutToken } = redactSecrets
    ? redactProfileSecretsFromProfile(profile)
    : profile;
  const presented = {
    ...profileWithoutToken,
    cdp_token_configured: Boolean(profile.cdp_token),
    cdp_session_count: browserRuntime?.activeCdpSessionCount(profile.profile_id) ?? 0,
    cdp_sessions: browserRuntime?.cdpSessionObservations(profile.profile_id) ?? [],
    last_manual_input_at: browserRuntime?.lastManualInputAt(profile.profile_id) ?? null,
    manual_viewer_count: browserRuntime?.activeManualViewerCount(profile.profile_id) ?? 0,
    resource_usage: { owned_process_count: 0, rss_bytes: null },
    sleep_status: ""
  };
  return {
    ...presented,
    sleep_status: sleepStatusLabel(presented)
  };
}

function presentProfileWithResourceUsage(
  profile: BrowserProfile,
  resourceUsage: OwnedProcessResourceUsage | undefined,
  browserRuntime: BrowserRuntime | undefined,
  redactSecrets = false
): PresentedBrowserProfile {
  const presented = presentProfile(profile, browserRuntime, redactSecrets);
  const withResourceUsage = {
    ...presented,
    resource_usage: resourceUsage ?? { owned_process_count: 0, rss_bytes: null }
  };
  return {
    ...withResourceUsage,
    sleep_status: sleepStatusLabel(withResourceUsage)
  };
}

async function dashboardProfiles(
  profiles: BrowserProfile[],
  url: URL,
  config: CloakHubConfig,
  browserRuntime: BrowserRuntime | undefined
): Promise<PresentedBrowserProfile[]> {
  const sorted = sortDashboardProfiles(profiles);
  const resourceUsageByProfileId = await ownedProcessResourceUsageByProfile(
    config.dataRoot,
    sorted.map((profile) => profile.profile_id)
  );
  return sorted.map((profile) =>
    presentProfileWithResourceUsage(
      redactDashboardProfile(profile),
      resourceUsageByProfileId.get(profile.profile_id),
      browserRuntime,
      true
    )
  );
}

function sortDashboardProfiles(profiles: BrowserProfile[]): BrowserProfile[] {
  return [...profiles].sort((left, right) => {
    return (
      left.instance_status.localeCompare(right.instance_status) ||
      timestampMs(right.last_activity_at) - timestampMs(left.last_activity_at) ||
      left.profile_id.localeCompare(right.profile_id)
    );
  });
}

function redactDashboardProfile(profile: BrowserProfile): BrowserProfile {
  return {
    ...profile,
    last_launch_error: profile.last_launch_error
      ? redactProfileSecrets(profile.last_launch_error, profile.cdp_token ? [profile.cdp_token] : [])
      : null
  };
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
  return new Response(body, htmlResponseInit({ "WWW-Authenticate": "Bearer" }, 401));
}

function htmlResponseInit(headers: HeadersInit = {}, status = 200): ResponseInit {
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

function renderLoginShell(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>CloakHub Login</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f6f7f8;
        --border: #d7dbdf;
        --ink: #1d252c;
        --muted: #60707d;
        --panel: #ffffff;
        --accent: #1f6feb;
      }

      * {
        box-sizing: border-box;
      }

      body {
        align-items: center;
        background: var(--bg);
        color: var(--ink);
        display: flex;
        font-family:
          Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        justify-content: center;
        margin: 0;
        min-height: 100vh;
        padding: 20px;
      }

      main {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 8px;
        max-width: 380px;
        padding: 22px;
        width: 100%;
      }

      h1 {
        font-size: 1.15rem;
        margin: 0 0 18px;
      }

      label {
        color: var(--muted);
        display: block;
        font-size: 0.84rem;
        font-weight: 700;
        margin-bottom: 8px;
      }

      input,
      button {
        border-radius: 6px;
        font: inherit;
        min-height: 40px;
        width: 100%;
      }

      input {
        border: 1px solid var(--border);
        margin-bottom: 12px;
        padding: 8px 10px;
      }

      button {
        background: var(--accent);
        border: 0;
        color: white;
        cursor: pointer;
        font-weight: 700;
      }

      .error {
        color: #b42318;
        display: none;
        font-size: 0.86rem;
        margin-top: 12px;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>CloakHub</h1>
      <form id="login-form">
        <label for="token">Admin Token</label>
        <input id="token" name="token" type="password" autocomplete="current-password" required>
        <button type="submit">Sign in</button>
        <p class="error" id="login-error">Invalid admin token</p>
      </form>
    </main>
    <script>
      document.getElementById("login-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const token = new FormData(event.currentTarget).get("token");
        const response = await fetch("/api/auth/login", {
          body: JSON.stringify({ token }),
          headers: { "content-type": "application/json" },
          method: "POST"
        });

        if (response.ok) {
          location.href = "/";
          return;
        }

        document.getElementById("login-error").style.display = "block";
      });
    </script>
  </body>
</html>`;
}

function renderManualViewer(viewer: BrowserRuntimeManualViewerState): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>CloakHub Viewer - ${escapeHtml(viewer.profile_id)}</title>
    <style>
      body {
        background: #111418;
        color: #f4f7fb;
        font-family:
          Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        margin: 0;
      }

      header {
        align-items: center;
        background: #1d252c;
        border-bottom: 1px solid #303a44;
        display: flex;
        min-height: 52px;
        padding: 0 18px;
      }

      h1 {
        font-size: 1rem;
        margin: 0;
      }

      main {
        align-items: center;
        display: grid;
        min-height: calc(100vh - 52px);
        place-items: center;
      }

      #manual-viewer {
        background: #050607;
        border: 1px solid #303a44;
        height: min(72vh, 720px);
        position: relative;
        width: min(96vw, 1280px);
      }

      #manual-viewer canvas {
        display: block;
        height: 100%;
        width: 100%;
      }

      #viewer-status {
        bottom: 12px;
        color: #9fb0c2;
        font-size: 0.9rem;
        left: 12px;
        position: absolute;
      }
    </style>
  </head>
  <body>
    <header>
      <h1>${escapeHtml(viewer.profile_id)}</h1>
    </header>
    <main>
      <div id="manual-viewer" data-vnc-websocket-url="${escapeHtml(viewer.vnc_ws_path)}">
        <canvas aria-hidden="true"></canvas>
        <span id="viewer-status">Connecting</span>
      </div>
    </main>
    <script type="module">
      import RFB from "/assets/novnc/core/rfb.js";

      const viewer = document.getElementById("manual-viewer");
      const status = document.getElementById("viewer-status");
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      let rfb;
      document.addEventListener("keydown", async (event) => {
        if (!viewer.contains(event.target)) {
          return;
        }

        if (event.key !== "v" || (!event.ctrlKey && !event.metaKey) || event.altKey || event.shiftKey) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        const text = await navigator.clipboard?.readText().catch(() => "");
        if (!text) {
          return;
        }

        await fetch("/ui/profiles/${encodeURIComponent(viewer.profile_id)}/clipboard", {
          body: JSON.stringify({ text }),
          headers: { "content-type": "application/json" },
          method: "POST"
        });
        rfb.sendKey(0xffe3, "ControlLeft", true);
        rfb.sendKey(0x0076, "KeyV", true);
        rfb.sendKey(0x0076, "KeyV", false);
        rfb.sendKey(0xffe3, "ControlLeft", false);
      }, true);
      rfb = new RFB(viewer, protocol + "//" + location.host + viewer.dataset.vncWebsocketUrl);
      rfb.scaleViewport = true;
      rfb.resizeSession = false;
      rfb.addEventListener("connect", () => {
        status.textContent = "Connected";
        window.opener?.postMessage(
          {
            profile_id: "${escapeHtml(viewer.profile_id)}",
            type: "cloakhub-viewer-connected"
          },
          location.origin
        );
      });
      rfb.addEventListener("disconnect", () => {
        status.textContent = "Disconnected";
      });
      rfb.addEventListener("clipboard", (event) => {
        if (event.detail?.text) {
          navigator.clipboard?.writeText(event.detail.text).catch(() => undefined);
        }
      });
    </script>
  </body>
</html>`;
}

function renderManualViewerUnavailable(message: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>CloakHub Viewer Unavailable</title>
  </head>
  <body>
    <main>
      <h1>Viewer unavailable</h1>
      <p>${escapeHtml(message)}</p>
      <p>Edit the profile to disable headless mode or use Start for CDP-only operation.</p>
    </main>
  </body>
</html>`;
}

function renderShell(
  config: CloakHubConfig,
  profiles: PresentedBrowserProfile[] = []
): string {
  const profileItems =
    profiles.length === 0
      ? `<div class="empty">No Browser Profiles registered</div>`
      : profiles
          .map(
            (profile) => `<article class="profile-item" data-profile-id="${escapeHtml(profile.profile_id)}">
              <div class="profile-summary">
                <div class="profile-title">
                  <strong>${escapeHtml(profile.display_name)}</strong>
                  <code>${escapeHtml(profile.profile_id)}</code>
                </div>
                <span class="instance-pill ${escapeHtml(profile.instance_status)}">${escapeHtml(profile.instance_status)}</span>
              </div>
              <div class="profile-facts">
                <span>Instance Status: ${escapeHtml(profile.instance_status)}</span>
                <span>CDP Sessions: ${profile.cdp_session_count}</span>
                <span>Viewers: ${profile.manual_viewer_count}</span>
                <span>Last Manual Input: ${escapeHtml(profile.last_manual_input_at ?? "none")}</span>
                <span>Last Activity: ${escapeHtml(profile.last_activity_at ?? "none")}</span>
                <span>${escapeHtml(profile.sleep_status)}</span>
                <span>${escapeHtml(resourceUsageLabel(profile.resource_usage))}</span>
                <span>Owned Processes: ${profile.resource_usage.owned_process_count}</span>
                <span>Last Stop Reason: ${escapeHtml(profile.last_stop_reason ?? "none")}</span>
                <span>Last Launch Error: ${escapeHtml(profile.last_launch_error ?? "none")}</span>
                ${renderCdpSessions(profile)}
              </div>
              <div class="profile-tags">
                ${sleepPolicyBadge(profile)}
                ${profile.tags.map((tag) => `<span class="tag">${escapeHtml(tag.name)}</span>`).join("")}
                ${profile.proxy ? `<span class="proxy">${escapeHtml(profile.proxy)}</span>` : ""}
                ${profile.notes ? `<span>${escapeHtml(profile.notes)}</span>` : ""}
              </div>
              <div class="profile-actions">
                ${renderManualViewerControls(profile)}
                <button class="profile-lifecycle-button" data-action="start" data-cdp-session-count="${profile.cdp_session_count}" data-manual-viewer-count="${profile.manual_viewer_count}" data-profile-id="${escapeHtml(profile.profile_id)}" type="button">Start</button>
                <button class="profile-lifecycle-button" data-action="stop" data-cdp-session-count="${profile.cdp_session_count}" data-manual-viewer-count="${profile.manual_viewer_count}" data-profile-id="${escapeHtml(profile.profile_id)}" type="button">Stop</button>
                <button class="profile-lifecycle-button" data-action="restart" data-cdp-session-count="${profile.cdp_session_count}" data-manual-viewer-count="${profile.manual_viewer_count}" data-profile-id="${escapeHtml(profile.profile_id)}" type="button">Restart</button>
              </div>
              <div class="profile-security">
                ${renderCdpTokenControls(profile)}
              </div>
              <details class="profile-edit">
                <summary>Edit profile</summary>
                <form class="profile-update-form" data-profile-id="${escapeHtml(profile.profile_id)}">
                  <label>
                    Display Name
                    <input name="display_name" value="${escapeHtml(profile.display_name)}">
                    <span class="field-hint">Shown in the profile list; changing it does not alter automation URLs.</span>
                  </label>
                  <label>
                    Notes
                    <input name="notes" value="${escapeHtml(profile.notes)}">
                    <span class="field-hint">Private operator notes for this Browser Profile.</span>
                  </label>
                  ${renderLaunchProfileInputs(profile)}
                  <div class="form-actions">
                    <button type="submit">Save</button>
                    <button class="profile-delete-button" data-profile-id="${escapeHtml(profile.profile_id)}" type="button">Delete</button>
                  </div>
                  ${profile.last_delete_error ? `<span class="form-error">${escapeHtml(profile.last_delete_error)}</span>` : ""}
                </form>
              </details>
            </article>`
          )
          .join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>CloakHub</title>
    <style>
      :root {
        color-scheme: light;
        --sidebar-width: 292px;
        --bg: #eef1f4;
        --border: #cfd7df;
        --ink: #17202a;
        --muted: #657584;
        --panel: #ffffff;
        --panel-strong: #f8fafb;
        --success: #0f8f5f;
        --accent: #2463eb;
        --warning: #b7791f;
        --danger: #b42318;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        background: var(--bg);
        color: var(--ink);
        font-family:
          Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      body {
        min-height: 100vh;
        overflow: hidden;
      }

      .app-header {
        align-items: center;
        background: var(--panel);
        border-bottom: 1px solid var(--border);
        display: flex;
        gap: 18px;
        min-height: 58px;
        padding: 0 18px;
      }

      .header-meta {
        align-items: center;
        display: flex;
        gap: 10px;
        margin-left: auto;
      }

      .mark {
        align-items: center;
        background: var(--ink);
        border-radius: 6px;
        color: white;
        display: inline-flex;
        font-size: 0.78rem;
        font-weight: 700;
        height: 32px;
        justify-content: center;
        width: 32px;
      }

      h1 {
        font-size: 1.05rem;
        line-height: 1.2;
        margin: 0;
      }

      .manager-shell {
        display: grid;
        grid-template-columns: minmax(220px, var(--sidebar-width)) 6px minmax(0, 1fr);
        height: calc(100vh - 58px);
        min-height: 0;
      }

      .manager-shell.sidebar-collapsed {
        grid-template-columns: 0 6px minmax(0, 1fr);
      }

      .profile-sidebar {
        background: var(--panel);
        border-right: 1px solid var(--border);
        display: grid;
        grid-template-rows: auto minmax(0, 1fr);
        min-height: 0;
        min-width: 0;
        overflow: hidden;
      }

      .manager-shell.sidebar-collapsed .profile-sidebar {
        border-right: 0;
      }

      .sidebar-head {
        align-items: center;
        display: flex;
        gap: 12px;
        justify-content: space-between;
      }

      #show-sidebar {
        align-items: center;
        display: inline-flex;
        min-height: 28px;
      }

      #show-sidebar[hidden] {
        display: none;
      }

      .sidebar-head {
        border-bottom: 1px solid var(--border);
        min-width: 220px;
        padding: 10px 12px;
      }

      .sidebar-actions {
        align-items: center;
        display: flex;
        gap: 6px;
      }

      h2 {
        font-size: 0.88rem;
        margin: 0;
      }

      form,
      .profile-update-form {
        display: grid;
        gap: 10px;
      }

      label {
        color: var(--muted);
        display: grid;
        font-size: 0.78rem;
        font-weight: 700;
        gap: 6px;
        text-transform: uppercase;
      }

      .field-hint {
        color: var(--muted);
        font-size: 0.78rem;
        font-weight: 500;
        line-height: 1.35;
        text-transform: none;
      }

      input,
      button,
      select,
      textarea {
        border-radius: 6px;
        font: inherit;
        min-height: 34px;
      }

      input,
      select,
      textarea {
        background: #ffffff;
        border: 1px solid var(--border);
        color: var(--ink);
        padding: 7px 9px;
        width: 100%;
      }

      textarea {
        min-height: 72px;
        resize: vertical;
      }

      button {
        background: var(--accent);
        border: 0;
        color: white;
        cursor: pointer;
        font-size: 0.78rem;
        font-weight: 700;
        padding: 0 10px;
      }

      button.secondary {
        background: #e8edf3;
        color: var(--ink);
      }

      .profile-delete-button {
        background: var(--danger);
      }

      .profile-lifecycle-button[data-action="stop"],
      .profile-lifecycle-button[data-action="restart"] {
        background: #e8edf3;
        color: var(--ink);
      }

      button:disabled {
        cursor: not-allowed;
        opacity: 0.6;
      }

      .status {
        align-items: center;
        color: var(--muted);
        display: inline-flex;
        font-size: 0.92rem;
        gap: 8px;
      }

      .status::before {
        background: var(--success);
        border-radius: 50%;
        content: "";
        height: 9px;
        width: 9px;
      }

      .limit {
        border: 1px solid var(--border);
        border-radius: 6px;
        color: var(--muted);
        font-size: 0.88rem;
        padding: 8px 10px;
      }

      .profile-list {
        display: grid;
        align-content: start;
        gap: 8px;
        min-height: 0;
        overflow: auto;
        padding: 8px;
      }

      .profile-item {
        background: var(--panel-strong);
        border: 1px solid var(--border);
        border-radius: 8px;
        display: grid;
        gap: 8px;
        padding: 9px;
      }

      .profile-summary,
      .profile-actions,
      .profile-tags,
      .form-actions {
        align-items: center;
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }

      .profile-summary {
        justify-content: space-between;
      }

      .profile-title {
        display: grid;
        gap: 2px;
        min-width: 0;
      }

      .profile-title strong {
        font-size: 0.86rem;
      }

      .profile-title strong,
      .profile-title code {
        overflow-wrap: anywhere;
      }

      code {
        color: var(--muted);
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 0.72rem;
      }

      .profile-facts {
        color: var(--muted);
        display: grid;
        font-size: 0.75rem;
        gap: 3px;
      }

      .profile-facts ul {
        margin: 4px 0 0;
        padding-left: 18px;
      }

      .sleep-policy-badge,
      .tag,
      .proxy,
      .instance-pill {
        border-radius: 999px;
        display: inline-block;
        font-size: 0.7rem;
        font-weight: 800;
        padding: 3px 7px;
      }

      .sleep-policy-badge.default,
      .sleep-policy-badge.minutes {
        background: #e8f1ff;
        color: #174ea6;
      }

      .sleep-policy-badge.never-sleep {
        background: #fff1d6;
        border: 1px solid var(--warning);
        color: #754c0b;
      }

      .tag {
        background: #e8f5ee;
        color: #12613f;
      }

      .proxy {
        background: #eceff3;
        color: #3d4a57;
        max-width: 100%;
        overflow-wrap: anywhere;
      }

      .instance-pill.running {
        background: #dff7ea;
        color: #12613f;
      }

      .instance-pill.failed {
        background: #fee4e2;
        color: var(--danger);
      }

      .instance-pill.starting,
      .instance-pill.stopping {
        background: #fff1d6;
        color: #754c0b;
      }

      .instance-pill.stopped {
        background: #eceff3;
        color: #3d4a57;
      }

      .cdp-token-status {
        display: block;
        margin-bottom: 8px;
      }

      .cdp-token-status.open {
        color: var(--danger);
        font-weight: 700;
      }

      .cdp-token-status.protected {
        color: var(--success);
        font-weight: 700;
      }

      .cdp-token-actions {
        align-items: center;
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin: 6px 0;
      }

      .cdp-token-warning {
        color: #754c0b;
        display: block;
        font-size: 0.8rem;
        margin-bottom: 8px;
      }

      .profile-security {
        font-size: 0.75rem;
      }

      .profile-edit {
        border-top: 1px solid var(--border);
        padding-top: 8px;
      }

      .profile-edit summary {
        color: var(--muted);
        cursor: pointer;
        font-size: 0.76rem;
        font-weight: 700;
      }

      .profile-update-form {
        margin-top: 8px;
      }

      .sidebar-resizer {
        background: #dde3ea;
        cursor: col-resize;
        min-width: 6px;
        position: relative;
      }

      .sidebar-resizer::after {
        background: #a9b5c1;
        border-radius: 999px;
        content: "";
        inset: 42% 2px;
        opacity: 0;
        position: absolute;
        transition: opacity 120ms ease;
      }

      .sidebar-resizer:hover::after,
      .sidebar-resizer.resizing::after {
        opacity: 1;
      }

      .manager-shell.sidebar-collapsed .sidebar-resizer {
        cursor: default;
      }

      .viewer-pane {
        background: #11161d;
        display: grid;
        grid-template-rows: minmax(0, 1fr);
        min-width: 0;
      }

      .sr-only {
        clip: rect(0 0 0 0);
        clip-path: inset(50%);
        height: 1px;
        overflow: hidden;
        position: absolute;
        white-space: nowrap;
        width: 1px;
      }

      .viewer-frame-wrap {
        min-height: 0;
        position: relative;
      }

      #viewer-frame {
        background: #050607;
        border: 0;
        display: block;
        height: 100%;
        width: 100%;
      }

      .viewer-placeholder {
        align-items: center;
        color: #b6c2ce;
        display: grid;
        inset: 0;
        justify-items: center;
        position: absolute;
      }

      #viewer-frame[src] + .viewer-placeholder {
        display: none;
      }

      dialog {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 8px;
        box-shadow: 0 24px 80px rgb(15 23 42 / 0.24);
        max-height: min(860px, calc(100vh - 32px));
        max-width: min(1100px, calc(100vw - 32px));
        overflow: auto;
        padding: 0;
        width: 100%;
      }

      dialog::backdrop {
        background: rgb(15 23 42 / 0.48);
      }

      .modal-head {
        align-items: center;
        border-bottom: 1px solid var(--border);
        display: flex;
        justify-content: space-between;
        padding: 14px 16px;
      }

      #create-profile-form {
        padding: 0;
      }

      .create-profile-form {
        display: grid;
        gap: 0;
      }

      .create-profile-body {
        display: grid;
        grid-template-columns: 148px minmax(0, 1fr) 240px;
        min-height: min(640px, calc(100vh - 132px));
        padding: 0;
      }

      .create-profile-tabs {
        background: #f4f7fa;
        border-right: 1px solid var(--border);
        display: grid;
        gap: 4px;
        align-content: start;
        padding: 12px 8px;
      }

      .create-tab-button {
        background: transparent;
        border-radius: 6px;
        color: var(--muted);
        justify-content: flex-start;
        min-height: 34px;
        text-align: left;
        width: 100%;
      }

      .create-tab-button.active {
        background: #dceafe;
        color: #174ea6;
      }

      .create-profile-panels {
        min-height: 0;
        overflow: auto;
        padding: 14px;
      }

      .create-tab-panel {
        display: grid;
        gap: 12px;
      }

      .create-tab-panel[hidden] {
        display: none;
      }

      .create-profile-summary {
        background: #f7f9fb;
        border-left: 1px solid var(--border);
        color: var(--muted);
        display: grid;
        gap: 10px;
        align-content: start;
        padding: 14px;
      }

      .create-profile-summary h3 {
        color: var(--ink);
        font-size: 0.86rem;
        margin: 0;
      }

      .summary-list {
        display: grid;
        gap: 7px;
        margin: 0;
      }

      .summary-list div {
        display: grid;
        gap: 2px;
      }

      .summary-list dt {
        font-size: 0.68rem;
        font-weight: 800;
        text-transform: uppercase;
      }

      .summary-list dd {
        color: var(--ink);
        font-size: 0.78rem;
        margin: 0;
        overflow-wrap: anywhere;
      }

      .form-section {
        background: transparent;
        border: 0;
        border-radius: 0;
        display: grid;
        gap: 12px;
        padding: 0;
      }

      .form-section.full {
        grid-column: 1 / -1;
      }

      .form-section-head {
        display: grid;
        gap: 3px;
      }

      .form-section-head h3 {
        font-size: 0.88rem;
        line-height: 1.2;
        margin: 0;
      }

      .form-section-head p {
        color: var(--muted);
        font-size: 0.78rem;
        line-height: 1.35;
        margin: 0;
      }

      .form-fields {
        display: grid;
        gap: 10px;
        grid-template-columns: minmax(118px, 160px) minmax(0, 1fr);
      }

      .form-field {
        align-items: start;
        display: contents;
        min-width: 0;
      }

      .form-field.full {
        grid-column: 1 / -1;
      }

      .form-field.full .field-title,
      .form-field.full input,
      .form-field.full select,
      .form-field.full textarea,
      .form-field.full .field-hint {
        grid-column: 1 / -1;
      }

      .field-title {
        color: var(--ink);
        font-size: 0.78rem;
        font-weight: 800;
        line-height: 1.2;
        padding-top: 8px;
        text-transform: none;
      }

      .create-profile-form .field-hint {
        grid-column: 2;
        margin-top: -6px;
      }

      .create-profile-form label {
        font-size: 0.78rem;
        gap: 5px;
        text-transform: none;
      }

      .create-profile-form input,
      .create-profile-form select,
      .create-profile-form textarea {
        font-size: 0.84rem;
        min-height: 32px;
      }

      .create-profile-form textarea {
        min-height: 64px;
      }

      .inline-fields {
        display: grid;
        gap: 8px;
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }

      .advanced-section summary {
        cursor: pointer;
        font-size: 0.86rem;
        font-weight: 800;
      }

      .advanced-section .form-section-head {
        margin-top: 10px;
      }

      .modal-actions {
        align-items: center;
        background: var(--panel);
        border-top: 1px solid var(--border);
        display: flex;
        gap: 8px;
        justify-content: flex-end;
        padding: 10px 14px;
        position: sticky;
        bottom: 0;
      }

      .empty {
        color: var(--muted);
        padding: 12px;
      }

      .form-error {
        color: var(--danger);
        font-size: 0.84rem;
      }

      @media (max-width: 860px) {
        body {
          overflow: auto;
        }

        .manager-shell {
          grid-template-columns: 1fr;
          height: auto;
        }

        .manager-shell.sidebar-collapsed {
          grid-template-columns: 1fr;
        }

        .profile-sidebar {
          border-right: 0;
          min-height: 48vh;
        }

        .manager-shell.sidebar-collapsed .profile-sidebar {
          display: none;
        }

        .sidebar-resizer {
          display: none;
        }

        .viewer-pane {
          min-height: 60vh;
        }

        .create-profile-body {
          grid-template-columns: 1fr;
        }

        .create-profile-tabs {
          border-bottom: 1px solid var(--border);
          border-right: 0;
          display: flex;
          overflow-x: auto;
        }

        .create-tab-button {
          flex: 0 0 auto;
          width: auto;
        }

        .create-profile-summary {
          border-left: 0;
          border-top: 1px solid var(--border);
        }

        .form-fields {
          grid-template-columns: 1fr;
        }

        .create-profile-form .field-hint {
          grid-column: auto;
          margin-top: 0;
        }
      }
    </style>
  </head>
  <body>
    <header class="app-header">
      <span class="mark" aria-hidden="true">CH</span>
      <h1>CloakHub</h1>
      <div class="header-meta">
        <span class="status">Service online</span>
        <span class="limit">Running Instance Limit: ${config.maxRunningInstances}</span>
        <button class="secondary" id="show-sidebar" type="button" hidden>Profiles</button>
      </div>
    </header>
    <main class="manager-shell">
      <aside class="profile-sidebar" aria-labelledby="profiles-heading">
        <div class="sidebar-head">
          <h2 id="profiles-heading">Browser Profiles</h2>
          <div class="sidebar-actions">
            <button id="open-create-profile" type="button">Create</button>
            <button class="secondary" id="toggle-sidebar" type="button">Hide</button>
          </div>
        </div>
        <div class="profile-list">
          ${profileItems}
        </div>
      </aside>
      <div class="sidebar-resizer" id="sidebar-resizer" role="separator" aria-orientation="vertical" aria-label="Resize profile sidebar"></div>
      <section class="viewer-pane" aria-labelledby="viewer-heading">
        <h2 class="sr-only" id="viewer-heading">Manual VNC viewer</h2>
        <div class="viewer-frame-wrap">
          <iframe id="viewer-frame" title="CloakHub VNC Viewer"></iframe>
          <div class="viewer-placeholder">No active viewer</div>
        </div>
      </section>
      <dialog id="create-profile-modal">
        <div class="modal-head">
          <h2>Create Profile</h2>
          <button class="secondary" id="close-create-profile" type="button">Close</button>
        </div>
        ${renderCreateProfileForm()}
      </dialog>
    </main>
      <script>
      const createProfileModal = document.getElementById("create-profile-modal");
      const createDisplayNameInput = document.getElementById("create-display-name");
      const createHeadlessSelect = document.getElementById("create-headless");
      const createLocaleInput = document.getElementById("create-locale");
      const createProxyInput = document.getElementById("create-proxy");
      const createProfileIdInput = document.getElementById("create-profile-id");
      const createScreenHeightInput = document.getElementById("create-screen-height");
      const createScreenWidthInput = document.getElementById("create-screen-width");
      const createSummaryId = document.getElementById("create-summary-id");
      const createSummaryMode = document.getElementById("create-summary-mode");
      const createSummaryName = document.getElementById("create-summary-name");
      const createSummaryProxy = document.getElementById("create-summary-proxy");
      const createSummaryRegion = document.getElementById("create-summary-region");
      const createSummaryScreen = document.getElementById("create-summary-screen");
      const createTabButtons = Array.from(document.querySelectorAll(".create-tab-button"));
      const createTabPanels = Array.from(document.querySelectorAll(".create-tab-panel"));
      const createTimezoneInput = document.getElementById("create-timezone");
      const managerShell = document.querySelector(".manager-shell");
      const resizer = document.getElementById("sidebar-resizer");
      const showSidebarButton = document.getElementById("show-sidebar");
      const toggleSidebarButton = document.getElementById("toggle-sidebar");
      const viewerFrame = document.getElementById("viewer-frame");
      const savedSidebarWidth = Number(localStorage.getItem("cloakhub.sidebarWidth"));
      const savedSidebarCollapsed = localStorage.getItem("cloakhub.sidebarCollapsed") === "true";

      if (savedSidebarWidth >= 220 && savedSidebarWidth <= 520) {
        managerShell.style.setProperty("--sidebar-width", savedSidebarWidth + "px");
      }
      setSidebarCollapsed(savedSidebarCollapsed);

      function reloadDashboard() {
        location.reload();
      }

      async function refreshDashboard() {
        await fetch("/ui/profiles").catch(() => undefined);
      }

      setInterval(refreshDashboard, 2500);

      let createProfileIdEdited = false;

      createProfileIdInput?.addEventListener("input", () => {
        createProfileIdEdited = true;
        updateCreateProfileSummary();
      });

      createDisplayNameInput?.addEventListener("input", () => {
        if (createProfileIdEdited) {
          return;
        }

        createProfileIdInput.value = slugifyProfileId(createDisplayNameInput.value);
        updateCreateProfileSummary();
      });

      createTabButtons.forEach((button) => {
        button.addEventListener("click", (event) => {
          const tab = event.currentTarget.dataset.createTab;
          createTabButtons.forEach((tabButton) => {
            tabButton.classList.toggle("active", tabButton.dataset.createTab === tab);
          });
          createTabPanels.forEach((panel) => {
            panel.hidden = panel.dataset.createPanel !== tab;
          });
        });
      });

      for (const input of [
        createDisplayNameInput,
        createHeadlessSelect,
        createLocaleInput,
        createProfileIdInput,
        createProxyInput,
        createScreenHeightInput,
        createScreenWidthInput,
        createTimezoneInput
      ]) {
        input?.addEventListener("input", updateCreateProfileSummary);
        input?.addEventListener("change", updateCreateProfileSummary);
      }

      updateCreateProfileSummary();

      function updateCreateProfileSummary() {
        const timezone = createTimezoneInput?.value || "Default timezone";
        const locale = createLocaleInput?.value || "default locale";
        createSummaryName.textContent = createDisplayNameInput?.value || "Untitled profile";
        createSummaryId.textContent = createProfileIdInput?.value || "Required";
        createSummaryMode.textContent =
          createHeadlessSelect?.value === "true" ? "Headless CDP only" : "VNC/manual browser";
        createSummaryProxy.textContent = createProxyInput?.value || "No proxy";
        createSummaryRegion.textContent = timezone + " / " + locale;
        createSummaryScreen.textContent =
          (createScreenWidthInput?.value || "1920") + " x " + (createScreenHeightInput?.value || "1080");
      }

      function setSidebarCollapsed(collapsed) {
        managerShell.classList.toggle("sidebar-collapsed", collapsed);
        toggleSidebarButton.textContent = collapsed ? "Show" : "Hide";
        showSidebarButton.hidden = !collapsed;
        localStorage.setItem("cloakhub.sidebarCollapsed", String(collapsed));
      }

      toggleSidebarButton?.addEventListener("click", () => {
        setSidebarCollapsed(!managerShell.classList.contains("sidebar-collapsed"));
      });

      showSidebarButton?.addEventListener("click", () => {
        setSidebarCollapsed(false);
      });

      resizer?.addEventListener("pointerdown", (event) => {
        if (managerShell.classList.contains("sidebar-collapsed")) {
          return;
        }

        event.preventDefault();
        resizer.setPointerCapture(event.pointerId);
        resizer.classList.add("resizing");

        const onPointerMove = (moveEvent) => {
          const width = Math.min(520, Math.max(220, moveEvent.clientX));
          managerShell.style.setProperty("--sidebar-width", width + "px");
          localStorage.setItem("cloakhub.sidebarWidth", String(width));
        };
        const onPointerUp = (upEvent) => {
          resizer.releasePointerCapture(upEvent.pointerId);
          resizer.classList.remove("resizing");
          window.removeEventListener("pointermove", onPointerMove);
          window.removeEventListener("pointerup", onPointerUp);
        };

        window.addEventListener("pointermove", onPointerMove);
        window.addEventListener("pointerup", onPointerUp);
      });

      document.getElementById("open-create-profile")?.addEventListener("click", () => {
        if (typeof createProfileModal.showModal === "function") {
          createProfileModal.showModal();
          return;
        }

        createProfileModal.setAttribute("open", "");
      });

      for (const closeButtonId of ["close-create-profile", "cancel-create-profile"]) {
        document.getElementById(closeButtonId)?.addEventListener("click", () => {
          if (typeof createProfileModal.close === "function") {
            createProfileModal.close();
            return;
          }

          createProfileModal.removeAttribute("open");
        });
      }

      window.addEventListener("message", (event) => {
        if (
          event.origin === location.origin &&
          event.data?.type === "cloakhub-viewer-connected"
        ) {
          refreshDashboard();
        }
      });

      document.getElementById("create-profile-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const values = compactFormValues(new FormData(event.currentTarget));
        const response = await fetch("/ui/profiles", {
          body: JSON.stringify(values),
          headers: { "content-type": "application/json" },
          method: "POST"
        });

        if (response.ok) {
          reloadDashboard();
        }
      });

      document.querySelectorAll(".profile-update-form").forEach((form) => {
        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          const profileId = event.currentTarget.dataset.profileId;
          const response = await fetch("/ui/profiles/" + encodeURIComponent(profileId), {
            body: JSON.stringify(compactFormValues(new FormData(event.currentTarget))),
            headers: { "content-type": "application/json" },
            method: "PATCH"
          });

          if (response.ok) {
            reloadDashboard();
          }
        });
      });

      document.querySelectorAll(".profile-delete-button").forEach((button) => {
        button.addEventListener("click", async (event) => {
          const profileId = event.currentTarget.dataset.profileId;
          const response = await fetch("/ui/profiles/" + encodeURIComponent(profileId), {
            method: "DELETE"
          });

          if (response.ok) {
            reloadDashboard();
          }
        });
      });

      document.querySelectorAll(".manual-viewer-button").forEach((button) => {
        button.addEventListener("click", (event) => {
          event.preventDefault();
          const profileId = event.currentTarget.dataset.profileId;
          viewerFrame.src = "/ui/profiles/" + encodeURIComponent(profileId) + "/viewer";
        });
      });

      document.querySelectorAll(".profile-lifecycle-button").forEach((button) => {
        button.addEventListener("click", async (event) => {
          const profileId = event.currentTarget.dataset.profileId;
          const action = event.currentTarget.dataset.action;
          const activeClientCount =
            Number(event.currentTarget.dataset.cdpSessionCount ?? 0) +
            Number(event.currentTarget.dataset.manualViewerCount ?? 0);
          if (
            action === "stop" &&
            activeClientCount > 0 &&
            !confirm("This may disconnect active CDP sessions or viewers. Continue?")
          ) {
            return;
          }

          const response = await fetch(
            "/ui/profiles/" + encodeURIComponent(profileId) + "/" + encodeURIComponent(action),
            { method: "POST" }
          );

          if (response.ok) {
            reloadDashboard();
          }
        });
      });

      document.querySelectorAll(".cdp-token-button").forEach((button) => {
        button.addEventListener("click", async (event) => {
          const profileId = event.currentTarget.dataset.profileId;
          const action = event.currentTarget.dataset.action;
          let path = "/ui/profiles/" + encodeURIComponent(profileId) + "/cdp-token";
          let method = "POST";

          if (action === "copy-url") {
            method = "GET";
          } else if (action === "regenerate") {
            path += "/regenerate";
          } else if (action === "revoke") {
            method = "DELETE";
          }

          if (action === "copy-open-url") {
            const cdpUrl =
              location.origin +
              "/api/profiles/" +
              encodeURIComponent(profileId) +
              "/cdp/json/version";
            await navigator.clipboard.writeText(cdpUrl);
            reloadDashboard();
            return;
          }

          if (action === "copy-url" && !confirm("Token-bearing CDP URLs can leak access. Continue?")) {
            return;
          }

          const response = await fetch(path, { method });
          if (!response.ok) {
            return;
          }

          if (action === "copy-url") {
            const body = await response.json();
            const cdpUrl =
              location.origin +
              "/api/profiles/" +
              encodeURIComponent(profileId) +
              "/cdp/json/version?token=" +
              encodeURIComponent(body.cdp_token);
            await navigator.clipboard.writeText(cdpUrl);
            reloadDashboard();
            return;
          }

          reloadDashboard();
        });
      });

      function compactFormValues(formData) {
        const includeEmpty = formData.get("_include_empty") === "true";
        const values = Object.fromEntries(
          Array.from(formData.entries()).filter((entry) => includeEmpty || entry[1] !== "")
        );
        delete values._include_empty;

        for (const field of [
          "hardware_concurrency",
          "screen_height",
          "screen_width"
        ]) {
          if (values[field] !== undefined) {
            if (values[field] === "") {
              delete values[field];
              continue;
            }
            values[field] = Number(values[field]);
          }
        }

        for (const field of ["clipboard_sync", "headless", "humanize"]) {
          if (values[field] !== undefined) {
            values[field] = values[field] === "true";
          }
        }

        if (values.custom_launch_args !== undefined) {
          values.custom_launch_args = values.custom_launch_args
            .split(/[\\n,]/)
            .map((entry) => entry.trim())
            .filter(Boolean);
        }

        if (values.tags_json !== undefined) {
          values.tags = values.tags_json === "" ? [] : JSON.parse(values.tags_json);
        }

        if (values.sleep_policy_mode) {
          values.sleep_policy = { mode: values.sleep_policy_mode };
          if (values.sleep_policy_mode === "minutes") {
            values.sleep_policy.minutes = Number(values.sleep_policy_minutes);
          }
        }

        delete values.sleep_policy_mode;
        delete values.sleep_policy_minutes;
        delete values.tags_json;
        return values;
      }

      function slugifyProfileId(value) {
        return value
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_+|_+$/g, "")
          .replace(/^[^a-z]+/, "");
      }
    </script>
  </body>
</html>`;
}

function renderCreateProfileForm(): string {
  return `<form class="create-profile-form" id="create-profile-form">
          <div class="create-profile-body create-profile-grid">
            <nav class="create-profile-tabs" aria-label="Create profile sections">
              <button class="create-tab-button active" data-create-tab="basic" type="button">Basic</button>
              <button class="create-tab-button" data-create-tab="browser" type="button">Browser</button>
              <button class="create-tab-button" data-create-tab="fingerprint" type="button">Fingerprint</button>
              <button class="create-tab-button" data-create-tab="advanced" type="button">Advanced</button>
            </nav>
            <div class="create-profile-panels">
              <section class="form-section create-tab-panel" data-create-panel="basic" aria-labelledby="create-profile-basic">
                <div class="form-section-head">
                  <h3 id="create-profile-basic">Basic information</h3>
                  <p>Create the profile identity, network route, and operator notes.</p>
                </div>
                <div class="form-fields">
                  <label class="form-field">
                    <span class="field-title">Profile Name</span>
                    <input id="create-display-name" name="display_name" placeholder="Client A - US desktop" autocomplete="off">
                    <span class="field-hint">Shown in the profile list.</span>
                  </label>
                  <label class="form-field">
                    <span class="field-title">Profile ID</span>
                    <input id="create-profile-id" name="profile_id" pattern="^[a-z][a-z0-9_]*$" placeholder="client_a_us" required autocomplete="off">
                    <span class="field-hint">Lower-case letters, numbers, and underscores. This becomes the immutable URL and directory name.</span>
                  </label>
                  <label class="form-field">
                    <span class="field-title">Proxy</span>
                    <input id="create-proxy" name="proxy" placeholder="http://user:pass@host:port">
                    <span class="field-hint">Supports scheme URLs, host:port, or host:port:user:pass.</span>
                  </label>
                  <label class="form-field">
                    <span class="field-title">Notes</span>
                    <input name="notes" placeholder="Owner, purpose, login context, or reminders">
                    <span class="field-hint">Private operator context; not sent to CloakBrowser.</span>
                  </label>
                </div>
              </section>

              <section class="form-section create-tab-panel" data-create-panel="browser" aria-labelledby="create-profile-browser" hidden>
                <div class="form-section-head">
                  <h3 id="create-profile-browser">Browser settings</h3>
                  <p>Choose whether this profile is manual-viewer first or CDP-only.</p>
                </div>
                <div class="form-fields">
                  <label class="form-field">
                    <span class="field-title">Mode</span>
                    <select id="create-headless" name="headless">
                      <option value="false" selected>VNC/manual browser</option>
                      <option value="true">Headless CDP only</option>
                    </select>
                    <span class="field-hint">Manual browser exposes the right-side VNC viewer.</span>
                  </label>
                  <label class="form-field">
                    <span class="field-title">Clipboard Sync</span>
                    <select name="clipboard_sync">
                      <option value="true" selected>Enabled</option>
                      <option value="false">Disabled</option>
                    </select>
                    <span class="field-hint">Allows manual paste and VNC clipboard transfer.</span>
                  </label>
                  <label class="form-field">
                    <span class="field-title">Humanize</span>
                    <select name="humanize">
                      <option value="false" selected>Disabled</option>
                      <option value="true">Enabled</option>
                    </select>
                    <span class="field-hint">Enables CloakBrowser humanization behavior when supported.</span>
                  </label>
                  <label class="form-field">
                    <span class="field-title">Human Preset</span>
                    <input name="human_preset" placeholder="Optional preset name">
                    <span class="field-hint">Leave blank unless you maintain named presets.</span>
                  </label>
                  <label class="form-field">
                    <span class="field-title">Sleep Policy</span>
                    <select name="sleep_policy_mode">
                      <option value="default" selected>Global default</option>
                      <option value="minutes">Custom minutes</option>
                      <option value="never">Never sleep</option>
                    </select>
                    <span class="field-hint">Automatic spin-down for idle Browser Instances.</span>
                  </label>
                  <label class="form-field">
                    <span class="field-title">Sleep Minutes</span>
                    <input name="sleep_policy_minutes" type="number" min="1" max="1440" placeholder="30">
                    <span class="field-hint">Used only with Custom minutes.</span>
                  </label>
                </div>
              </section>

              <section class="form-section create-tab-panel" data-create-panel="fingerprint" aria-labelledby="create-profile-fingerprint" hidden>
                <div class="form-section-head">
                  <h3 id="create-profile-fingerprint">Fingerprint</h3>
                  <p>Set regional, platform, display, and CPU signals.</p>
                </div>
                <div class="form-fields">
                  <label class="form-field">
                    <span class="field-title">Timezone</span>
                    <input id="create-timezone" name="timezone" placeholder="America/Los_Angeles" autocomplete="off">
                    <span class="field-hint">Blank keeps CloakBrowser defaults.</span>
                  </label>
                  <label class="form-field">
                    <span class="field-title">Locale</span>
                    <input id="create-locale" name="locale" placeholder="en-US" autocomplete="off">
                    <span class="field-hint">Browser language and locale signal.</span>
                  </label>
                  <label class="form-field">
                    <span class="field-title">GeoIP</span>
                    <input name="geoip" placeholder="Optional CloakBrowser GeoIP hint">
                    <span class="field-hint">Use only when overriding automatic proxy-based behavior.</span>
                  </label>
                  <label class="form-field">
                    <span class="field-title">Platform</span>
                    <input id="create-platform" name="platform" value="linux" autocomplete="off">
                    <span class="field-hint">Fingerprint platform value.</span>
                  </label>
                  <label class="form-field">
                    <span class="field-title">Screen</span>
                    <span class="inline-fields">
                      <input id="create-screen-width" name="screen_width" type="number" min="100" max="10000" value="1920" aria-label="Screen width">
                      <input id="create-screen-height" name="screen_height" type="number" min="100" max="10000" value="1080" aria-label="Screen height">
                    </span>
                    <span class="field-hint">Virtual display width and height in pixels.</span>
                  </label>
                  <label class="form-field">
                    <span class="field-title">CPU Threads</span>
                    <input name="hardware_concurrency" type="number" min="1" max="256" value="4">
                    <span class="field-hint">Hardware concurrency exposed to pages.</span>
                  </label>
                  <label class="form-field">
                    <span class="field-title">Color Scheme</span>
                    <select name="color_scheme">
                      <option value="system" selected>System</option>
                      <option value="light">Light</option>
                      <option value="dark">Dark</option>
                    </select>
                    <span class="field-hint">Preferred color scheme exposed to websites.</span>
                  </label>
                </div>
              </section>

              <section class="form-section create-tab-panel" data-create-panel="advanced" aria-labelledby="create-profile-advanced" hidden>
                <div class="form-section-head">
                  <h3 id="create-profile-advanced">Advanced fingerprint and launch settings</h3>
                  <p>Only set these when a profile needs exact fingerprint or launch overrides.</p>
                </div>
                <div class="form-fields">
                  <label class="form-field">
                    <span class="field-title">Fingerprint Seed</span>
                    <input name="fingerprint_seed" placeholder="Auto-generated if blank">
                    <span class="field-hint">Stable random seed generated by default.</span>
                  </label>
                  <label class="form-field">
                    <span class="field-title">User Agent</span>
                    <input name="user_agent" placeholder="Optional full user agent override">
                    <span class="field-hint">Blank keeps CloakBrowser defaults.</span>
                  </label>
                  <label class="form-field">
                    <span class="field-title">GPU Vendor</span>
                    <input name="gpu_vendor" placeholder="Optional vendor override">
                    <span class="field-hint">Advanced fingerprint override.</span>
                  </label>
                  <label class="form-field">
                    <span class="field-title">GPU Renderer</span>
                    <input name="gpu_renderer" placeholder="Optional renderer override">
                    <span class="field-hint">Advanced fingerprint override.</span>
                  </label>
                  <label class="form-field">
                    <span class="field-title">Launch Args</span>
                    <textarea name="custom_launch_args" placeholder="--flag=value"></textarea>
                    <span class="field-hint">One browser flag per line. CloakHub-owned data-dir and CDP flags are rejected.</span>
                  </label>
                  <label class="form-field">
                    <span class="field-title">Tags JSON</span>
                    <textarea name="tags_json" placeholder='[{"name":"client","color":"#2463eb"}]'></textarea>
                    <span class="field-hint">Optional JSON array for grouping profiles.</span>
                  </label>
                </div>
              </section>
            </div>
            <aside class="create-profile-summary" aria-label="Browser information">
              <h3>Browser information</h3>
              <dl class="summary-list">
                <div>
                  <dt>Name</dt>
                  <dd id="create-summary-name">Untitled profile</dd>
                </div>
                <div>
                  <dt>Profile ID</dt>
                  <dd id="create-summary-id">Required</dd>
                </div>
                <div>
                  <dt>Mode</dt>
                  <dd id="create-summary-mode">VNC/manual browser</dd>
                </div>
                <div>
                  <dt>Proxy</dt>
                  <dd id="create-summary-proxy">No proxy</dd>
                </div>
                <div>
                  <dt>Region</dt>
                  <dd id="create-summary-region">Default timezone / locale</dd>
                </div>
                <div>
                  <dt>Screen</dt>
                  <dd id="create-summary-screen">1920 x 1080</dd>
                </div>
              </dl>
            </aside>
          </div>
          <div class="modal-actions">
            <button class="secondary" id="cancel-create-profile" type="button">Cancel</button>
            <button type="submit">Create Profile</button>
          </div>
        </form>`;
}

function renderLaunchProfileInputs(profile?: BrowserProfile | PresentedBrowserProfile): string {
  const tagsJson = profile ? JSON.stringify(profile.tags) : "";
  const launchArgs = profile?.custom_launch_args.join("\n") ?? "";
  const sleepPolicyMode = profile?.sleep_policy.mode ?? "default";
  const sleepPolicyMinutes = profile?.sleep_policy.mode === "minutes" ? profile.sleep_policy.minutes : "";

  return `
        ${profile ? `<input name="_include_empty" type="hidden" value="true">` : ""}
        <label>
          Fingerprint Seed
          <input name="fingerprint_seed" value="${escapeHtml(profile?.fingerprint_seed ?? "")}">
          <span class="field-hint">Leave blank to generate a stable random fingerprint seed.</span>
        </label>
        <label>
          Proxy
          <input name="proxy" ${profile ? `placeholder="${escapeHtml(profile.proxy)}"` : ""}>
          <span class="field-hint">Optional proxy as scheme://user:pass@host:port, host:port, or host:port:user:pass.</span>
        </label>
        <label>
          Timezone
          <input name="timezone" value="${escapeHtml(profile?.timezone ?? "")}">
          <span class="field-hint">IANA timezone such as America/Los_Angeles; blank keeps CloakBrowser defaults.</span>
        </label>
        <label>
          Locale
          <input name="locale" value="${escapeHtml(profile?.locale ?? "")}">
          <span class="field-hint">Browser locale such as en-US or fr-FR.</span>
        </label>
        <label>
          GeoIP
          <input name="geoip" value="${escapeHtml(profile?.geoip ?? "")}">
          <span class="field-hint">Optional GeoIP hint supported by CloakBrowser.</span>
        </label>
        <label>
          Platform
          <input name="platform" value="${escapeHtml(profile?.platform ?? "")}">
          <span class="field-hint">Fingerprint platform value; linux is the default.</span>
        </label>
        <label>
          Screen Width
          <input name="screen_width" type="number" min="100" max="10000" value="${profile?.screen_width ?? ""}">
          <span class="field-hint">Virtual display width in pixels.</span>
        </label>
        <label>
          Screen Height
          <input name="screen_height" type="number" min="100" max="10000" value="${profile?.screen_height ?? ""}">
          <span class="field-hint">Virtual display height in pixels.</span>
        </label>
        <label>
          GPU Vendor
          <input name="gpu_vendor" value="${escapeHtml(profile?.gpu_vendor ?? "")}">
          <span class="field-hint">Optional fingerprint GPU vendor override.</span>
        </label>
        <label>
          GPU Renderer
          <input name="gpu_renderer" value="${escapeHtml(profile?.gpu_renderer ?? "")}">
          <span class="field-hint">Optional fingerprint GPU renderer override.</span>
        </label>
        <label>
          Hardware Concurrency
          <input name="hardware_concurrency" type="number" min="1" max="256" value="${profile?.hardware_concurrency ?? ""}">
          <span class="field-hint">CPU thread count exposed to pages.</span>
        </label>
        <label>
          User Agent
          <input name="user_agent" value="${escapeHtml(profile?.user_agent ?? "")}">
          <span class="field-hint">Optional full user agent override; blank keeps CloakBrowser defaults.</span>
        </label>
        <label>
          Color Scheme
          <select name="color_scheme">
            ${selectOption("system", profile?.color_scheme ?? "", "system")}
            ${selectOption("light", profile?.color_scheme ?? "")}
            ${selectOption("dark", profile?.color_scheme ?? "")}
          </select>
          <span class="field-hint">Preferred color scheme exposed to websites.</span>
        </label>
        <label>
          Humanize
          <select name="humanize">
            ${selectOption("false", String(profile?.humanize ?? false))}
            ${selectOption("true", String(profile?.humanize ?? false))}
          </select>
          <span class="field-hint">Enables CloakBrowser humanization behavior when supported.</span>
        </label>
        <label>
          Human Preset
          <input name="human_preset" value="${escapeHtml(profile?.human_preset ?? "")}">
          <span class="field-hint">Optional named humanization preset.</span>
        </label>
        <label>
          Headless
          <select name="headless">
            ${selectOption("false", String(profile?.headless ?? false))}
            ${selectOption("true", String(profile?.headless ?? false))}
          </select>
          <span class="field-hint">Headless profiles support CDP but do not expose a manual VNC viewer.</span>
        </label>
        <label>
          Clipboard Sync
          <select name="clipboard_sync">
            ${selectOption("true", String(profile?.clipboard_sync ?? true))}
            ${selectOption("false", String(profile?.clipboard_sync ?? true))}
          </select>
          <span class="field-hint">Allows manual paste and VNC clipboard transfer for this profile.</span>
        </label>
        <label>
          Sleep Policy
          <select name="sleep_policy_mode">
            ${selectOption("default", sleepPolicyMode)}
            ${selectOption("minutes", sleepPolicyMode)}
            ${selectOption("never", sleepPolicyMode)}
          </select>
          <span class="field-hint">Controls automatic spin-down for idle Browser Instances.</span>
        </label>
        <label>
          Sleep Policy Minutes
          <input name="sleep_policy_minutes" type="number" min="1" max="1440" value="${sleepPolicyMinutes}">
          <span class="field-hint">Used only when Sleep Policy is minutes.</span>
        </label>
        <label>
          Launch Args
          <textarea name="custom_launch_args">${escapeHtml(launchArgs)}</textarea>
          <span class="field-hint">One browser flag per line. CloakHub-owned data-dir and CDP flags are rejected.</span>
        </label>
        <label>
          Tags JSON
          <textarea name="tags_json">${escapeHtml(tagsJson)}</textarea>
          <span class="field-hint">JSON array like [{"name":"client","color":"#2463eb"}].</span>
        </label>`;
}

function sleepPolicyLabel(profile: BrowserProfile | PresentedBrowserProfile): string {
  if (profile.sleep_policy_status.mode === "never") {
    return "never-sleep";
  }

  return `Sleep Policy: ${profile.sleep_policy_status.effective_minutes} minutes`;
}

function sleepStatusLabel(profile: PresentedBrowserProfile): string {
  if (profile.sleep_policy_status.blocks_sleep) {
    return "Sleep Blocker: never-sleep policy";
  }

  if (profile.cdp_session_count > 0) {
    return "Sleep Blocker: active CDP Session";
  }

  if (profile.instance_status !== "running") {
    return "Sleep Countdown: not running";
  }

  if (!profile.last_activity_at || profile.sleep_policy_status.effective_minutes === null) {
    return "Sleep Countdown: unavailable";
  }

  const remainingMs =
    timestampMs(profile.last_activity_at) +
    profile.sleep_policy_status.effective_minutes * 60 * 1000 -
    Date.now();
  if (remainingMs <= 0) {
    return "Sleep Countdown: due now";
  }

  return `Sleep Countdown: ${formatDuration(remainingMs)}`;
}

function resourceUsageLabel(resourceUsage: OwnedProcessResourceUsage): string {
  if (resourceUsage.rss_bytes === null) {
    return "Approx. Resource Usage: unavailable";
  }

  return `Approx. Resource Usage: ${formatBytes(resourceUsage.rss_bytes)} RSS`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KiB`;
  }

  return `${Math.round(bytes / 1024 / 1024)} MiB`;
}

function renderCdpSessions(profile: PresentedBrowserProfile): string {
  if (profile.cdp_sessions.length === 0) {
    return "";
  }

  return `<ul>${profile.cdp_sessions
    .map(
      (session) => `<li>${escapeHtml(formatDuration(session.duration_ms))} ${escapeHtml(
        session.remote_address ?? "unknown"
      )} ${escapeHtml(session.user_agent ?? "")}</li>`
    )
    .join("")}</ul>`;
}

function renderCdpTokenControls(profile: PresentedBrowserProfile): string {
  const profileId = escapeHtml(profile.profile_id);
  if (!profile.cdp_token_configured) {
    return `
                <span class="cdp-token-status open">CDP access is open because no CDP Token exists.</span>
                <div class="cdp-token-actions">
                  <button class="cdp-token-button" data-action="copy-open-url" data-profile-id="${profileId}" type="button">Copy open CDP URL</button>
                  <button class="cdp-token-button" data-action="create" data-profile-id="${profileId}" type="button">Create CDP Token</button>
                </div>`;
  }

  return `
                <span class="cdp-token-status protected">CDP Token is configured.</span>
                <span class="cdp-token-warning">Token-bearing CDP URLs can leak access. Copy only for trusted CDP Clients.</span>
                <div class="cdp-token-actions">
                  <button class="cdp-token-button" data-action="copy-url" data-profile-id="${profileId}" type="button">Copy token-bearing CDP URL</button>
                  <button class="cdp-token-button" data-action="regenerate" data-profile-id="${profileId}" type="button">Regenerate CDP Token</button>
                  <button class="cdp-token-button" data-action="revoke" data-profile-id="${profileId}" type="button">Revoke CDP Token</button>
                </div>`;
}

function renderManualViewerControls(profile: PresentedBrowserProfile): string {
  if (profile.headless) {
    return `<span>Manual viewer unavailable for headless profiles. Edit the profile to disable headless mode.</span>`;
  }

  return `<button class="manual-viewer-button" data-profile-id="${escapeHtml(profile.profile_id)}" type="button">View</button>`;
}

function formatDuration(durationMs: number): string {
  const seconds = Math.floor(durationMs / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  return `${minutes}m`;
}

function sleepPolicyBadge(profile: BrowserProfile | PresentedBrowserProfile): string {
  const className =
    profile.sleep_policy_status.mode === "never" ? "never-sleep" : profile.sleep_policy_status.mode;

  return `<span class="sleep-policy-badge ${escapeHtml(className)}">${escapeHtml(sleepPolicyLabel(profile))}</span>`;
}

function selectOption(value: string, selectedValue: string, defaultValue = ""): string {
  const selected = selectedValue === value || (!selectedValue && defaultValue === value) ? " selected" : "";
  return `<option value="${escapeHtml(value)}"${selected}>${escapeHtml(value)}</option>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
