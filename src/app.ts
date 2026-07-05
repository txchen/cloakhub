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

type DashboardSort = "last_activity" | "status";

interface DashboardControls {
  query: string;
  sort: DashboardSort;
}

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
      return htmlResponse(renderShell(config, profiles, dashboardControls(url)));
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
  const controls = dashboardControls(url);
  const filtered = profiles.filter((profile) => dashboardProfileMatches(profile, controls.query));
  const sorted = sortDashboardProfiles(filtered, controls.sort);
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

function dashboardControls(url: URL): DashboardControls {
  const sort = url.searchParams.get("sort");
  return {
    query: url.searchParams.get("q")?.trim() ?? "",
    sort: sort === "last_activity" ? "last_activity" : "status"
  };
}

function dashboardProfileMatches(profile: BrowserProfile, query: string): boolean {
  if (!query) {
    return true;
  }

  const normalized = query.toLowerCase();
  return [profile.display_name, ...profile.tags.map((tag) => tag.name)].some((value) =>
    value.toLowerCase().includes(normalized)
  );
}

function sortDashboardProfiles(profiles: BrowserProfile[], sort: DashboardSort): BrowserProfile[] {
  return [...profiles].sort((left, right) => {
    if (sort === "last_activity") {
      return timestampMs(right.last_activity_at) - timestampMs(left.last_activity_at);
    }

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
  profiles: PresentedBrowserProfile[] = [],
  controls: DashboardControls = { query: "", sort: "status" }
): string {
  const profileRows =
    profiles.length === 0
      ? `<tr>
              <td class="empty" colspan="5">No Browser Profiles registered</td>
            </tr>`
      : profiles
          .map(
            (profile) => `<tr>
              <td>${escapeHtml(profile.profile_id)}</td>
              <td>
                <form class="profile-update-form" data-profile-id="${escapeHtml(profile.profile_id)}">
                  <input name="display_name" value="${escapeHtml(profile.display_name)}">
                  <input name="notes" value="${escapeHtml(profile.notes)}">
                  ${renderLaunchProfileInputs(profile)}
                  <button type="submit">Save</button>
                </form>
              </td>
              <td>
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
              </td>
              <td>${sleepPolicyBadge(profile)}</td>
              <td>
                <span>${escapeHtml(profile.notes)}</span>
                <span>${escapeHtml(profile.tags.map((tag) => tag.name).join(", "))}</span>
                <span>${escapeHtml(profile.proxy)}</span>
                ${renderCdpTokenControls(profile)}
                ${renderManualViewerControls(profile)}
                <button class="profile-lifecycle-button" data-action="start" data-cdp-session-count="${profile.cdp_session_count}" data-manual-viewer-count="${profile.manual_viewer_count}" data-profile-id="${escapeHtml(profile.profile_id)}" type="button">
                  Start
                </button>
                <button class="profile-lifecycle-button" data-action="stop" data-cdp-session-count="${profile.cdp_session_count}" data-manual-viewer-count="${profile.manual_viewer_count}" data-profile-id="${escapeHtml(profile.profile_id)}" type="button">
                  Stop
                </button>
                <button class="profile-lifecycle-button" data-action="restart" data-cdp-session-count="${profile.cdp_session_count}" data-manual-viewer-count="${profile.manual_viewer_count}" data-profile-id="${escapeHtml(profile.profile_id)}" type="button">
                  Restart
                </button>
                <button class="profile-delete-button" data-profile-id="${escapeHtml(profile.profile_id)}" type="button">
                  Delete
                </button>
                ${profile.last_delete_error ? `<span>${escapeHtml(profile.last_delete_error)}</span>` : ""}
              </td>
            </tr>`
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
        --bg: #f6f7f8;
        --border: #d7dbdf;
        --ink: #1d252c;
        --muted: #60707d;
        --panel: #ffffff;
        --status: #0f8f5f;
        --accent: #1f6feb;
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

      header {
        align-items: center;
        background: var(--panel);
        border-bottom: 1px solid var(--border);
        display: flex;
        gap: 18px;
        min-height: 64px;
        padding: 0 28px;
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
        font-size: 1.15rem;
        line-height: 1.2;
        margin: 0;
      }

      main {
        margin: 0 auto;
        max-width: 1180px;
        padding: 28px;
      }

      .toolbar {
        align-items: center;
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        justify-content: space-between;
        margin-bottom: 18px;
      }

      form {
        align-items: end;
        display: grid;
        gap: 10px;
        grid-template-columns: minmax(160px, 1fr) minmax(180px, 1fr) auto;
        margin-bottom: 18px;
      }

      .profile-update-form {
        align-items: center;
        display: grid;
        grid-template-columns: repeat(5, minmax(90px, 1fr)) auto;
        margin: 0;
      }

      label {
        color: var(--muted);
        display: grid;
        font-size: 0.78rem;
        font-weight: 700;
        gap: 6px;
        text-transform: uppercase;
      }

      input,
      button {
        border-radius: 6px;
        font: inherit;
        min-height: 38px;
      }

      input {
        border: 1px solid var(--border);
        padding: 7px 9px;
      }

      button {
        background: var(--accent);
        border: 0;
        color: white;
        cursor: pointer;
        font-weight: 700;
        padding: 0 13px;
      }

      .status {
        align-items: center;
        color: var(--muted);
        display: inline-flex;
        font-size: 0.92rem;
        gap: 8px;
      }

      .status::before {
        background: var(--status);
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

      .sleep-policy-badge {
        border-radius: 999px;
        display: inline-block;
        font-size: 0.78rem;
        font-weight: 800;
        padding: 4px 8px;
      }

      .sleep-policy-badge.default,
      .sleep-policy-badge.minutes {
        background: #e8f1ff;
        color: #174ea6;
      }

      .sleep-policy-badge.never-sleep {
        background: #fff1d6;
        border: 1px solid #d99a00;
        color: #7a4b00;
      }

      .cdp-token-status {
        display: block;
        margin-bottom: 8px;
      }

      .cdp-token-status.open {
        color: #b42318;
        font-weight: 700;
      }

      .cdp-token-status.protected {
        color: #0f8f5f;
        font-weight: 700;
      }

      .cdp-token-actions {
        align-items: center;
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin: 8px 0;
      }

      .cdp-token-warning {
        color: #7a4b00;
        display: block;
        font-size: 0.8rem;
        margin-bottom: 8px;
      }

      section {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 8px;
        overflow: hidden;
      }

      .section-head {
        align-items: center;
        border-bottom: 1px solid var(--border);
        display: flex;
        justify-content: space-between;
        padding: 14px 16px;
      }

      h2 {
        font-size: 0.96rem;
        margin: 0;
      }

      table {
        border-collapse: collapse;
        table-layout: fixed;
        width: 100%;
      }

      th,
      td {
        border-bottom: 1px solid var(--border);
        font-size: 0.9rem;
        padding: 13px 16px;
        text-align: left;
      }

      th {
        color: var(--muted);
        font-size: 0.78rem;
        font-weight: 700;
        text-transform: uppercase;
      }

      tr:last-child td {
        border-bottom: 0;
      }

      .empty {
        color: var(--muted);
      }

      @media (max-width: 640px) {
        header,
        main {
          padding-left: 16px;
          padding-right: 16px;
        }

        .section-head,
        th,
        td {
          padding-left: 12px;
          padding-right: 12px;
        }

        form {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <header>
      <span class="mark" aria-hidden="true">CH</span>
      <h1>CloakHub</h1>
    </header>
    <main>
      <div class="toolbar">
        <span class="status">Service online</span>
        <span class="limit">Running Instance Limit: ${config.maxRunningInstances}</span>
      </div>
      <form id="dashboard-filter-form" method="GET">
        <label>
          Search
          <input name="q" value="${escapeHtml(controls.query)}">
        </label>
        <label>
          Sort
          <select name="sort">
            ${selectOption("status", controls.sort)}
            ${selectOption("last_activity", controls.sort)}
          </select>
        </label>
        <button type="submit">Apply</button>
      </form>
      <p class="dashboard-copy">Automatic Spin-down is different from Explicit Stop.</p>
      <form id="create-profile-form">
        <label>
          Profile ID
          <input name="profile_id" pattern="^[a-z][a-z0-9_]*$" required>
        </label>
        <label>
          Display Name
          <input name="display_name">
        </label>
        <label>
          Notes
          <input name="notes">
        </label>
        ${renderLaunchProfileInputs()}
        <button type="submit">Create</button>
      </form>
      <section aria-labelledby="profiles-heading">
        <div class="section-head">
          <h2 id="profiles-heading">Browser Profiles</h2>
        </div>
        <table>
          <thead>
            <tr>
              <th scope="col">Profile ID</th>
              <th scope="col">Display Name</th>
              <th scope="col">Instance Status</th>
              <th scope="col">Sleep Policy</th>
              <th scope="col">Notes</th>
            </tr>
          </thead>
          <tbody>
            ${profileRows}
          </tbody>
        </table>
      </section>
    </main>
      <script>
      function refreshDashboard() {
        location.reload();
      }

      setInterval(refreshDashboard, 2500);

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
          refreshDashboard();
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
            refreshDashboard();
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
            refreshDashboard();
          }
        });
      });

      document.querySelectorAll(".manual-viewer-link").forEach((link) => {
        link.addEventListener("click", (event) => {
          event.preventDefault();
          window.open(event.currentTarget.href, "_blank");
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
            refreshDashboard();
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
            refreshDashboard();
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
            refreshDashboard();
            return;
          }

          refreshDashboard();
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
    </script>
  </body>
</html>`;
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
        </label>
        <label>
          Proxy
          <input name="proxy" ${profile ? `placeholder="${escapeHtml(profile.proxy)}"` : ""}>
        </label>
        <label>
          Timezone
          <input name="timezone" value="${escapeHtml(profile?.timezone ?? "")}">
        </label>
        <label>
          Locale
          <input name="locale" value="${escapeHtml(profile?.locale ?? "")}">
        </label>
        <label>
          GeoIP
          <input name="geoip" value="${escapeHtml(profile?.geoip ?? "")}">
        </label>
        <label>
          Platform
          <input name="platform" value="${escapeHtml(profile?.platform ?? "")}">
        </label>
        <label>
          Screen Width
          <input name="screen_width" type="number" min="100" max="10000" value="${profile?.screen_width ?? ""}">
        </label>
        <label>
          Screen Height
          <input name="screen_height" type="number" min="100" max="10000" value="${profile?.screen_height ?? ""}">
        </label>
        <label>
          GPU Vendor
          <input name="gpu_vendor" value="${escapeHtml(profile?.gpu_vendor ?? "")}">
        </label>
        <label>
          GPU Renderer
          <input name="gpu_renderer" value="${escapeHtml(profile?.gpu_renderer ?? "")}">
        </label>
        <label>
          Hardware Concurrency
          <input name="hardware_concurrency" type="number" min="1" max="256" value="${profile?.hardware_concurrency ?? ""}">
        </label>
        <label>
          User Agent
          <input name="user_agent" value="${escapeHtml(profile?.user_agent ?? "")}">
        </label>
        <label>
          Color Scheme
          <select name="color_scheme">
            ${selectOption("system", profile?.color_scheme ?? "", "system")}
            ${selectOption("light", profile?.color_scheme ?? "")}
            ${selectOption("dark", profile?.color_scheme ?? "")}
          </select>
        </label>
        <label>
          Humanize
          <select name="humanize">
            ${selectOption("false", String(profile?.humanize ?? false))}
            ${selectOption("true", String(profile?.humanize ?? false))}
          </select>
        </label>
        <label>
          Human Preset
          <input name="human_preset" value="${escapeHtml(profile?.human_preset ?? "")}">
        </label>
        <label>
          Headless
          <select name="headless">
            ${selectOption("false", String(profile?.headless ?? false))}
            ${selectOption("true", String(profile?.headless ?? false))}
          </select>
        </label>
        <label>
          Clipboard Sync
          <select name="clipboard_sync">
            ${selectOption("true", String(profile?.clipboard_sync ?? true))}
            ${selectOption("false", String(profile?.clipboard_sync ?? true))}
          </select>
        </label>
        <label>
          Sleep Policy
          <select name="sleep_policy_mode">
            ${selectOption("default", sleepPolicyMode)}
            ${selectOption("minutes", sleepPolicyMode)}
            ${selectOption("never", sleepPolicyMode)}
          </select>
        </label>
        <label>
          Sleep Policy Minutes
          <input name="sleep_policy_minutes" type="number" min="1" max="1440" value="${sleepPolicyMinutes}">
        </label>
        <label>
          Launch Args
          <textarea name="custom_launch_args">${escapeHtml(launchArgs)}</textarea>
        </label>
        <label>
          Tags JSON
          <textarea name="tags_json">${escapeHtml(tagsJson)}</textarea>
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

  return `<a class="manual-viewer-link" href="/ui/profiles/${encodeURIComponent(profile.profile_id)}/viewer" target="_blank" rel="noreferrer">Open Viewer</a>`;
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
