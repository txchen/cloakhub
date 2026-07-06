import { join } from "node:path";

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
  profile_data_dir: string;
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

async function noVncAsset(assetPath: string): Promise<ReturnType<typeof Bun.file>> {
  const candidates = [
    process.env.CLOAKHUB_NOVNC_WEB_ROOT
      ? Bun.file(`${process.env.CLOAKHUB_NOVNC_WEB_ROOT.replace(/\/$/, "")}/${assetPath}`)
      : undefined,
    Bun.file(new URL(`../node_modules/@novnc/novnc/${assetPath}`, import.meta.url))
  ].filter((candidate): candidate is ReturnType<typeof Bun.file> => candidate !== undefined);

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
      config.dataRoot,
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
    config.dataRoot,
    resourceUsageByProfileId.get(profile.profile_id),
    browserRuntime,
    isUiProfileActionRoute(url)
  );
}

function presentProfile(
  profile: BrowserProfile,
  dataRoot: string,
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
    profile_data_dir: profileDataDir(dataRoot, profile.profile_id),
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
  dataRoot: string,
  resourceUsage: OwnedProcessResourceUsage | undefined,
  browserRuntime: BrowserRuntime | undefined,
  redactSecrets = false
): PresentedBrowserProfile {
  const presented = presentProfile(profile, dataRoot, browserRuntime, redactSecrets);
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
      config.dataRoot,
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

function profileDataDir(dataRoot: string, profileId: string): string {
  return join(dataRoot, "profiles", profileId);
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
        --bg: #efe5d8;
        --border: #d7dbdf;
        --ink: #1d252c;
        --muted: #60707d;
        --panel: #faf3ea;
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
        background: var(--panel);
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
      html,
      body {
        background: #111418;
        color: #f4f7fb;
        font-family:
          Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        height: 100%;
        margin: 0;
        overflow: hidden;
      }

      main {
        height: 100%;
        margin: 0;
        overflow: hidden;
      }

      #manual-viewer {
        background: #050607;
        border: 0;
        height: 100vh;
        inset: 0;
        overflow: hidden;
        position: fixed;
        width: 100vw;
      }

      #manual-viewer > div {
        height: 100%;
        width: 100%;
      }

      #viewer-status {
        background: rgb(5 6 7 / 0.68);
        border: 1px solid rgb(255 255 255 / 0.14);
        border-radius: 999px;
        bottom: 10px;
        color: #d7e0ea;
        font-size: 0.7rem;
        font-weight: 650;
        left: 10px;
        letter-spacing: 0;
        line-height: 1;
        padding: 5px 8px;
        pointer-events: none;
        position: absolute;
        z-index: 2;
      }

      #paste-button {
        background: rgb(245 247 250 / 0.92);
        border: 1px solid rgb(5 6 7 / 0.18);
        border-radius: 5px;
        color: #101418;
        cursor: pointer;
        font-size: 0.72rem;
        font-weight: 700;
        line-height: 1;
        padding: 6px 9px;
        position: absolute;
        right: 10px;
        top: 10px;
        z-index: 2;
      }

      #paste-button:focus-visible {
        outline: 2px solid #4f8cff;
        outline-offset: 2px;
      }
    </style>
  </head>
  <body>
    <main>
      <div id="manual-viewer" data-vnc-websocket-url="${escapeHtml(viewer.vnc_ws_path)}">
        <button id="paste-button" type="button">Paste</button>
        <span id="viewer-status">Connecting</span>
      </div>
    </main>
    <script type="module">
      import RFB from "/assets/novnc/core/rfb.js?v=stock-1";

      const viewer = document.getElementById("manual-viewer");
      const pasteButton = document.getElementById("paste-button");
      const status = document.getElementById("viewer-status");
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      let rfb;
      async function pasteText(text) {
        if (!text) {
          return;
        }

        rfb.clipboardPasteFrom(text);
        await fetch("/ui/profiles/${encodeURIComponent(viewer.profile_id)}/clipboard", {
          body: JSON.stringify({ text }),
          headers: { "content-type": "application/json" },
          method: "POST"
        }).catch(() => undefined);
        rfb.focus();
        rfb.sendKey(0xffe3, "ControlLeft", true);
        rfb.sendKey(0x0076, "KeyV", true);
        rfb.sendKey(0x0076, "KeyV", false);
        rfb.sendKey(0xffe3, "ControlLeft", false);
      }

      pasteButton.addEventListener("click", async () => {
        const clipboardText = await navigator.clipboard?.readText().catch(() => "");
        const text = clipboardText || window.prompt("Paste text to send to the browser") || "";
        await pasteText(text);
      });

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

        await pasteText(text);
      }, true);
      rfb = new RFB(viewer, protocol + "//" + location.host + viewer.dataset.vncWebsocketUrl, { wsProtocols: [] });
      rfb.scaleViewport = true;
      rfb.resizeSession = false;
      rfb.addEventListener("connect", () => {
        status.textContent = "Connected";
        window.setTimeout(() => {
          status.hidden = true;
        }, 1200);
        const connectedMessage = {
          profile_id: "${escapeHtml(viewer.profile_id)}",
          type: "cloakhub-viewer-connected"
        };
        if (window.parent && window.parent !== window) {
          window.parent.postMessage(connectedMessage, location.origin);
        }
        window.opener?.postMessage(connectedMessage, location.origin);
      });
      rfb.addEventListener("disconnect", () => {
        status.hidden = false;
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
      : profiles.map((profile) => renderProfileListItem(profile)).join("");
  const profileEditDialogs = profiles.map((profile) => renderEditProfileDialog(profile)).join("");

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
        --bg: #efe5d8;
        --border: #cfd7df;
        --ink: #17202a;
        --muted: #657584;
        --panel: #faf3ea;
        --panel-strong: #f3e7d8;
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
        gap: 12px;
        min-height: 44px;
        padding: 0 12px;
      }

      .header-meta {
        align-items: center;
        display: flex;
        gap: 8px;
        margin-left: auto;
      }

      .mark {
        align-items: center;
        background: var(--ink);
        border-radius: 6px;
        color: white;
        display: inline-flex;
        font-size: 0.7rem;
        font-weight: 700;
        height: 26px;
        justify-content: center;
        width: 26px;
      }

      h1 {
        font-size: 0.94rem;
        line-height: 1.2;
        margin: 0;
      }

      .manager-shell {
        display: grid;
        grid-template-columns: minmax(220px, var(--sidebar-width)) 3px minmax(0, 1fr);
        height: calc(100vh - 44px);
        min-height: 0;
      }

      .manager-shell.sidebar-collapsed {
        grid-template-columns: 0 3px minmax(0, 1fr);
      }

      .profile-sidebar {
        background: var(--panel);
        border-right: 1px solid var(--border);
        container-type: inline-size;
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
        min-height: 24px;
      }

      #show-sidebar[hidden] {
        display: none;
      }

      .sidebar-head {
        border-bottom: 1px solid var(--border);
        min-width: 220px;
        padding: 6px 8px;
      }

      .sidebar-actions {
        align-items: center;
        display: flex;
        gap: 4px;
      }

      .sidebar-head button,
      #show-sidebar {
        font-size: 0.72rem;
        min-height: 24px;
        padding: 0 7px;
      }

      h2 {
        font-size: 0.8rem;
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
        background: var(--panel);
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
        min-height: 52px;
        padding: 7px;
        position: relative;
      }

      .profile-item.selected {
        background: #eef6ff;
        border-color: var(--accent);
        box-shadow: inset 3px 0 0 var(--accent);
      }

      .profile-summary,
      .form-actions {
        align-items: center;
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }

      .profile-summary {
        justify-content: space-between;
      }

      .profile-row {
        align-items: start;
        display: grid;
        gap: 6px;
        grid-template-columns: minmax(0, 1fr);
      }

      .profile-main {
        display: grid;
        gap: 4px;
        min-width: 0;
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

      .profile-meta {
        color: var(--muted);
        display: flex;
        flex-wrap: wrap;
        font-size: 0.72rem;
        gap: 4px 8px;
        line-height: 1.25;
      }

      .profile-meta span:not(:last-child)::after {
        color: #9aa7b2;
        content: "|";
        margin-left: 8px;
      }

      .profile-row-actions {
        align-items: center;
        display: flex;
        gap: 3px;
        justify-content: flex-start;
      }

      .profile-primary-action {
        align-items: center;
        display: inline-flex;
        font-size: 0.72rem;
        height: 26px;
        justify-content: center;
        line-height: 1;
        min-height: 26px;
        min-width: 26px;
        padding: 0;
        width: 26px;
      }

      .manual-viewer-button.profile-primary-action {
        background: #e8edf3;
        border: 1px solid var(--border);
        color: var(--ink);
      }

      .profile-item.selected .manual-viewer-button.profile-primary-action {
        background: var(--accent);
        border-color: var(--accent);
        color: white;
      }

      .icon-button {
        align-items: center;
        background: #e8edf3;
        border: 1px solid var(--border);
        color: var(--ink);
        display: inline-flex;
        font-size: 0.72rem;
        height: 26px;
        justify-content: center;
        line-height: 1;
        min-height: 26px;
        min-width: 26px;
        padding: 0;
        text-align: center;
        width: 26px;
      }

      .profile-popover {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 8px;
        box-shadow: 0 18px 48px rgb(15 23 42 / 0.18);
        color: var(--ink);
        gap: 10px;
        left: min(calc(var(--sidebar-width) + 18px), calc(100vw - 372px));
        margin: 0;
        max-height: calc(100vh - 96px);
        overflow: auto;
        padding: 12px;
        position: fixed;
        top: 74px;
        width: min(340px, calc(100vw - 24px));
      }

      .profile-popover:not(:popover-open) {
        display: none;
      }

      .profile-popover:popover-open {
        display: grid;
      }

      .profile-detail-section {
        display: grid;
        gap: 10px;
      }

      .profile-detail-section h3 {
        font-size: 0.88rem;
        margin: 0;
      }

      .profile-detail-list {
        display: grid;
        gap: 8px;
        margin: 0;
      }

      .profile-detail-list div {
        display: grid;
        gap: 2px;
      }

      .profile-detail-list dt {
        color: var(--muted);
        font-size: 0.68rem;
        font-weight: 800;
        text-transform: uppercase;
      }

      .profile-detail-list dd {
        font-size: 0.78rem;
        margin: 0;
        overflow-wrap: anywhere;
      }

      .profile-menu-popover {
        min-width: 240px;
      }

      .profile-menu-section {
        border-bottom: 1px solid var(--border);
        display: grid;
        gap: 6px;
        padding-bottom: 10px;
      }

      .profile-menu-section:last-child {
        border-bottom: 0;
        padding-bottom: 0;
      }

      .menu-item {
        background: #e8edf3;
        color: var(--ink);
        justify-content: flex-start;
        text-align: left;
        width: 100%;
      }

      code {
        color: var(--muted);
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 0.72rem;
      }

      .sleep-policy-badge,
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

      .cdp-token-button.copied {
        background: #e5f7ed;
        border-color: #a8dfbf;
        color: #12613f;
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

      .profile-update-form {
        margin-top: 8px;
      }

      @container (max-width: 260px) {
        .profile-summary {
          align-items: flex-start;
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          width: 100%;
        }

        .profile-meta {
          gap: 3px 6px;
        }

        .profile-meta span:not(:last-child)::after {
          margin-left: 6px;
        }
      }

      .sidebar-resizer {
        background: #dde3ea;
        cursor: col-resize;
        min-width: 3px;
        position: relative;
      }

      .sidebar-resizer::after {
        background: #a9b5c1;
        border-radius: 999px;
        content: "";
        inset: 42% 1px;
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
        grid-template-rows: auto minmax(0, 1fr);
        min-width: 0;
      }

      .viewer-status {
        align-items: center;
        background: var(--panel);
        border-bottom: 1px solid var(--border);
        color: var(--ink);
        display: flex;
        gap: 10px;
        min-height: 44px;
        min-width: 0;
        padding: 8px 12px;
      }

      .viewer-status-label {
        color: var(--muted);
        font-size: 0.72rem;
        font-weight: 800;
        text-transform: uppercase;
      }

      .viewer-status-name {
        font-size: 0.9rem;
        font-weight: 800;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .viewer-status-id {
        margin-left: auto;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
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

        .profile-popover {
          left: 12px;
          right: 12px;
          top: 74px;
          width: auto;
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
        <div class="viewer-status" aria-live="polite">
          <span class="viewer-status-label">Viewer</span>
          <h2 class="viewer-status-name" id="viewer-heading">No profile selected</h2>
          <code class="viewer-status-id" id="viewer-profile-id">Choose a profile</code>
        </div>
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
      ${profileEditDialogs}
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
      const profileForms = Array.from(document.querySelectorAll(".profile-form"));
      const createTimezoneInput = document.getElementById("create-timezone");
      const managerShell = document.querySelector(".manager-shell");
      const resizer = document.getElementById("sidebar-resizer");
      const showSidebarButton = document.getElementById("show-sidebar");
      const toggleSidebarButton = document.getElementById("toggle-sidebar");
      const viewerFrame = document.getElementById("viewer-frame");
      const viewerHeading = document.getElementById("viewer-heading");
      const viewerProfileId = document.getElementById("viewer-profile-id");
      const savedSidebarWidth = Number(localStorage.getItem("cloakhub.sidebarWidth"));
      const savedSidebarCollapsed = localStorage.getItem("cloakhub.sidebarCollapsed") === "true";

      if (savedSidebarWidth >= 220 && savedSidebarWidth <= 520) {
        managerShell.style.setProperty("--sidebar-width", savedSidebarWidth + "px");
      }
      setSidebarCollapsed(savedSidebarCollapsed);

      function reloadDashboard() {
        location.reload();
      }

      async function copyTextToClipboard(text) {
        if (navigator.clipboard?.writeText) {
          try {
            await navigator.clipboard.writeText(text);
            return true;
          } catch (_) {
            // Use the selection-based fallback below when clipboard permission is blocked.
          }
        }

        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.top = "-1000px";
        textarea.style.left = "-1000px";
        document.body.appendChild(textarea);
        textarea.select();
        try {
          return document.execCommand("copy");
        } catch (_) {
          return false;
        } finally {
          textarea.remove();
        }
      }

      function showCopyFeedback(button) {
        if (!button) {
          return;
        }

        const originalLabel = button.dataset.copyOriginalLabel || button.textContent;
        button.dataset.copyOriginalLabel = originalLabel;
        button.textContent = "Copied";
        button.classList.add("copied");
        window.clearTimeout?.(button.copyFeedbackTimeout);
        button.copyFeedbackTimeout = window.setTimeout?.(() => {
          button.textContent = button.dataset.copyOriginalLabel || originalLabel;
          button.classList.remove("copied");
        }, 1400);
      }

      async function copyCdpUrl(cdpUrl, button) {
        if (!(await copyTextToClipboard(cdpUrl))) {
          window.alert?.("Unable to copy CDP URL. Open profile info and copy it manually.");
          return;
        }

        showCopyFeedback(button);
      }

      function clientStatusLabel(cdpSessionCount, manualViewerCount) {
        const parts = [];
        if (cdpSessionCount > 0) {
          parts.push(cdpSessionCount + " CDP");
        }
        if (manualViewerCount > 0) {
          parts.push(manualViewerCount + " viewer");
        }
        return parts.join(" / ");
      }

      function updateProfileViewerPresence(profileId, minimumManualViewerCount) {
        let manualViewerCount = minimumManualViewerCount;
        document.querySelectorAll("[data-profile-manual-viewer-count]").forEach((countNode) => {
          if (countNode.dataset.profileId === profileId) {
            manualViewerCount = Math.max(Number(countNode.textContent ?? 0), minimumManualViewerCount);
            countNode.textContent = String(manualViewerCount);
          }
        });

        document.querySelectorAll("[data-profile-client-status]").forEach((statusNode) => {
          if (statusNode.dataset.profileId !== profileId) {
            return;
          }

          statusNode.dataset.manualViewerCount = String(manualViewerCount);
          const label = clientStatusLabel(
            Number(statusNode.dataset.cdpSessionCount ?? 0),
            manualViewerCount
          );
          statusNode.textContent = label;
          if (statusNode.parentElement) {
            statusNode.parentElement.hidden = label === "";
          }
        });

        document.querySelectorAll("[data-manual-viewer-count]").forEach((actionNode) => {
          if (actionNode.dataset.profileId === profileId) {
            actionNode.dataset.manualViewerCount = String(manualViewerCount);
          }
        });
      }

      function closeProfilePopovers() {
        document.querySelectorAll(".profile-popover:popover-open").forEach((popover) => {
          popover.hidePopover?.();
        });
      }

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

      profileForms.forEach((form) => {
        const tabButtons = Array.from(form.querySelectorAll(".profile-tab-button"));
        const tabPanels = Array.from(form.querySelectorAll(".profile-tab-panel"));
        tabButtons.forEach((button) => {
          button.addEventListener("click", (event) => {
            const tab = event.currentTarget.dataset.profileTab;
            tabButtons.forEach((tabButton) => {
              tabButton.classList.toggle("active", tabButton.dataset.profileTab === tab);
            });
            tabPanels.forEach((panel) => {
              panel.hidden = panel.dataset.profilePanel !== tab;
            });
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
          createHeadlessSelect?.value === "true" ? "Automation only" : "Browser viewer";
        createSummaryProxy.textContent = createProxyInput?.value || "No proxy";
        createSummaryRegion.textContent = timezone + " / " + locale;
        createSummaryScreen.textContent =
          (createScreenWidthInput?.value || "1366") + " x " + (createScreenHeightInput?.value || "768");
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

      document.querySelectorAll(".profile-edit-button").forEach((button) => {
        button.addEventListener("click", (event) => {
          closeProfilePopovers();
          const profileId = event.currentTarget.dataset.profileId;
          const editProfileModal = document.getElementById("edit-profile-" + profileId + "-modal");
          if (typeof editProfileModal?.showModal === "function") {
            editProfileModal.showModal();
            return;
          }

          editProfileModal?.setAttribute("open", "");
        });
      });

      document.querySelectorAll(".profile-edit-close").forEach((button) => {
        button.addEventListener("click", (event) => {
          const profileId = event.currentTarget.dataset.profileId;
          const editProfileModal = document.getElementById("edit-profile-" + profileId + "-modal");
          if (typeof editProfileModal?.close === "function") {
            editProfileModal.close();
            return;
          }

          editProfileModal?.removeAttribute("open");
        });
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
          const profileName = event.currentTarget.dataset.profileName || profileId;
          viewerFrame.src = "/ui/profiles/" + encodeURIComponent(profileId) + "/viewer";
          viewerFrame.title = "CloakHub viewer for " + profileName;
          viewerHeading.textContent = profileName;
          viewerProfileId.textContent = profileId;
          document.querySelectorAll(".profile-item").forEach((profileItem) => {
            const selected = profileItem.dataset.profileId === profileId;
            profileItem.classList.toggle("selected", selected);
            if (selected) {
              profileItem.setAttribute("aria-current", "true");
            } else {
              profileItem.removeAttribute("aria-current");
            }
          });
        });
      });

      window.addEventListener("message", (event) => {
        if (
          event.origin !== location.origin ||
          event.data?.type !== "cloakhub-viewer-connected" ||
          typeof event.data.profile_id !== "string"
        ) {
          return;
        }

        updateProfileViewerPresence(event.data.profile_id, 1);
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
            await copyCdpUrl(cdpUrl, event.currentTarget);
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
            await copyCdpUrl(cdpUrl, event.currentTarget);
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

        if (values.sleep_policy_mode) {
          values.sleep_policy = { mode: values.sleep_policy_mode };
          if (values.sleep_policy_mode === "minutes") {
            values.sleep_policy.minutes = Number(values.sleep_policy_minutes);
          }
        }

        delete values.sleep_policy_mode;
        delete values.sleep_policy_minutes;
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

function renderProfileListItem(profile: PresentedBrowserProfile): string {
  const profileId = escapeHtml(profile.profile_id);
  const profileInfoPopoverId = `${profileId}-profile-info`;
  const profileMenuPopoverId = `${profileId}-profile-menu`;
  const activeClients = compactClientStatus(profile);

  return `<article class="profile-item" data-profile-id="${profileId}">
              <div class="profile-row">
                <div class="profile-main">
                  <div class="profile-summary">
                    <div class="profile-title">
                      <strong>${escapeHtml(profile.display_name)}</strong>
                      <code>${profileId}</code>
                    </div>
                    <span class="instance-pill ${escapeHtml(profile.instance_status)}">${escapeHtml(profile.instance_status)}</span>
                  </div>
                  <div class="profile-meta" aria-label="Profile quick facts"${activeClients ? "" : " hidden"}><span data-profile-client-status data-profile-id="${profileId}" data-cdp-session-count="${profile.cdp_session_count}" data-manual-viewer-count="${profile.manual_viewer_count}">${escapeHtml(activeClients)}</span></div>
                </div>
                <div class="profile-row-actions">
                  ${renderPrimaryProfileAction(profile)}
                  <button class="profile-info icon-button" popovertarget="${profileInfoPopoverId}" title="Profile info" aria-label="Profile details for ${profileId}" type="button">ℹ️</button>
                  <button class="profile-menu icon-button" popovertarget="${profileMenuPopoverId}" title="Profile actions" aria-label="Profile actions for ${profileId}" type="button">...</button>
                  <div class="profile-popover profile-info-popover" id="${profileInfoPopoverId}" popover>
                    ${renderProfileDetails(profile)}
                  </div>
                  <div class="profile-popover profile-menu-popover" id="${profileMenuPopoverId}" popover>
                    ${renderProfileActionMenu(profile)}
                  </div>
                </div>
              </div>
            </article>`;
}

function compactClientStatus(profile: PresentedBrowserProfile): string {
  const clients = [
    profile.cdp_session_count > 0 ? `${profile.cdp_session_count} CDP` : "",
    profile.manual_viewer_count > 0 ? `${profile.manual_viewer_count} viewer` : ""
  ].filter(Boolean);

  return clients.join(" / ");
}

function renderPrimaryProfileAction(profile: PresentedBrowserProfile): string {
  if (!profile.headless) {
    return `<button class="manual-viewer-button profile-primary-action" data-profile-id="${escapeHtml(profile.profile_id)}" data-profile-name="${escapeHtml(profile.display_name)}" title="View profile" aria-label="View profile ${escapeHtml(profile.profile_id)}" type="button">🖥️</button>`;
  }

  return `<button class="profile-lifecycle-button profile-primary-action" data-action="start" data-cdp-session-count="${profile.cdp_session_count}" data-manual-viewer-count="${profile.manual_viewer_count}" data-profile-id="${escapeHtml(profile.profile_id)}" title="Start profile" aria-label="Start profile ${escapeHtml(profile.profile_id)}" type="button">▶</button>`;
}

function renderProfileDetails(profile: PresentedBrowserProfile): string {
  return `<section class="profile-detail-section" aria-label="Profile details">
                <h3>${escapeHtml(profile.display_name)}</h3>
                <dl class="profile-detail-list">
                  <div>
                    <dt>Instance Status</dt>
                    <dd>${escapeHtml(profile.instance_status)}</dd>
                  </div>
                  <div>
                    <dt>CDP Sessions</dt>
                    <dd>${profile.cdp_session_count}</dd>
                  </div>
                  <div>
                    <dt>Viewers</dt>
                    <dd data-profile-manual-viewer-count data-profile-id="${escapeHtml(profile.profile_id)}">${profile.manual_viewer_count}</dd>
                  </div>
                  <div>
                    <dt>Last Manual Input</dt>
                    <dd>${escapeHtml(profile.last_manual_input_at ?? "none")}</dd>
                  </div>
                  <div>
                    <dt>Last Activity</dt>
                    <dd>${escapeHtml(profile.last_activity_at ?? "none")}</dd>
                  </div>
                  <div>
                    <dt>Sleep</dt>
                    <dd>${escapeHtml(profile.sleep_status)}</dd>
                  </div>
                  <div>
                    <dt>Resource Usage</dt>
                    <dd>${escapeHtml(resourceUsageLabel(profile.resource_usage))}</dd>
                  </div>
                  <div>
                    <dt>Owned Processes</dt>
                    <dd>${profile.resource_usage.owned_process_count}</dd>
                  </div>
                  <div>
                    <dt>Last Stop Reason</dt>
                    <dd>${escapeHtml(profile.last_stop_reason ?? "none")}</dd>
                  </div>
                  <div>
                    <dt>Last Launch Error</dt>
                    <dd>${escapeHtml(profile.last_launch_error ?? "none")}</dd>
                  </div>
                  <div>
                    <dt>Proxy</dt>
                    <dd>${escapeHtml(profile.proxy || "none")}</dd>
                  </div>
                  <div>
                    <dt>Notes</dt>
                    <dd>${escapeHtml(profile.notes || "none")}</dd>
                  </div>
                  <div>
                    <dt>Sleep Policy</dt>
                    <dd>${sleepPolicyBadge(profile)}</dd>
                  </div>
                  <div>
                    <dt>Data Directory</dt>
                    <dd><code>${escapeHtml(profile.profile_data_dir)}</code></dd>
                  </div>
                </dl>
                ${renderCdpSessions(profile)}
              </section>`;
}

function renderProfileActionMenu(profile: PresentedBrowserProfile): string {
  const profileId = escapeHtml(profile.profile_id);
  const clientCounts = `data-cdp-session-count="${profile.cdp_session_count}" data-manual-viewer-count="${profile.manual_viewer_count}"`;

  return `<div class="profile-menu-section">
                <button class="menu-item profile-lifecycle-button" data-action="start" ${clientCounts} data-profile-id="${profileId}" type="button">Start</button>
                <button class="menu-item profile-lifecycle-button" data-action="stop" ${clientCounts} data-profile-id="${profileId}" type="button">Stop</button>
                <button class="menu-item profile-lifecycle-button" data-action="restart" ${clientCounts} data-profile-id="${profileId}" type="button">Restart</button>
                <button class="menu-item profile-edit-button" data-profile-id="${profileId}" type="button">Edit</button>
              </div>
              <div class="profile-menu-section profile-security">
                ${renderCdpTokenControls(profile)}
              </div>`;
}

function renderEditProfileDialog(profile: PresentedBrowserProfile): string {
  const profileId = escapeHtml(profile.profile_id);

  return `<dialog class="profile-edit-modal" id="edit-profile-${profileId}-modal">
        <div class="modal-head">
          <h2>Edit Profile</h2>
          <button class="secondary profile-edit-close" data-profile-id="${profileId}" type="button">Close</button>
        </div>
        ${renderProfileForm({ mode: "edit", profile })}
      </dialog>`;
}

function renderCreateProfileForm(): string {
  return renderProfileForm({ mode: "create" });
}

function renderProfileForm(options: {
  mode: "create";
  profile?: undefined;
} | {
  mode: "edit";
  profile: PresentedBrowserProfile;
}): string {
  const profile = options.profile;
  const isEdit = options.mode === "edit";
  const editProfile = options.mode === "edit" ? options.profile : undefined;
  const prefix = editProfile ? `edit-${editProfile.profile_id}` : "create";
  const formId = editProfile ? `edit-profile-${editProfile.profile_id}-form` : "create-profile-form";
  const formClasses = `profile-form create-profile-form${isEdit ? " profile-update-form" : ""}`;
  const dataProfile = editProfile ? ` data-profile-id="${escapeHtml(editProfile.profile_id)}"` : "";
  const submitLabel = isEdit ? "Save Changes" : "Create Profile";
  const cancelButton = editProfile
    ? `<button class="secondary profile-edit-close" data-profile-id="${escapeHtml(editProfile.profile_id)}" type="button">Cancel</button>`
    : `<button class="secondary" id="cancel-create-profile" type="button">Cancel</button>`;
  const deleteButton = editProfile
    ? `<button class="profile-delete-button" data-profile-id="${escapeHtml(editProfile.profile_id)}" type="button">Delete</button>`
    : "";
  const displayName = profile?.display_name ?? "";
  const profileId = profile?.profile_id ?? "";
  const notes = profile?.notes ?? "";
  const proxyPlaceholder = editProfile?.proxy ? ` placeholder="${escapeHtml(editProfile.proxy)}"` : ` placeholder="http://user:pass@host:port"`;
  const launchArgs = profile?.custom_launch_args.join("\n") ?? "";
  const sleepPolicyMode = profile?.sleep_policy.mode ?? "default";
  const sleepPolicyMinutes = profile?.sleep_policy.mode === "minutes" ? profile.sleep_policy.minutes : "";

  return `<form class="${formClasses}" id="${escapeHtml(formId)}"${dataProfile}>
          ${isEdit ? `<input name="_include_empty" type="hidden" value="true">` : ""}
          <div class="create-profile-body create-profile-grid">
            <nav class="create-profile-tabs" aria-label="Create profile sections">
              <button class="create-tab-button profile-tab-button active" data-profile-tab="basic" type="button">Basic</button>
              <button class="create-tab-button profile-tab-button" data-profile-tab="browser" type="button">Browser</button>
              <button class="create-tab-button profile-tab-button" data-profile-tab="fingerprint" type="button">Fingerprint</button>
              <button class="create-tab-button profile-tab-button" data-profile-tab="advanced" type="button">Advanced</button>
            </nav>
            <div class="create-profile-panels">
              <section class="form-section create-tab-panel profile-tab-panel" data-profile-panel="basic" aria-labelledby="${escapeHtml(prefix)}-profile-basic">
                <div class="form-section-head">
                  <h3 id="${escapeHtml(prefix)}-profile-basic">Basic information</h3>
                  <p>Profile identity, network route, and operator notes.</p>
                </div>
                <div class="form-fields">
                  <label class="form-field">
                    <span class="field-title">Profile Name</span>
                    <input ${isEdit ? "" : `id="create-display-name"`} name="display_name" value="${escapeHtml(displayName)}" placeholder="Client A - US desktop" autocomplete="off">
                    <span class="field-hint">Shown in the profile list.</span>
                  </label>
                  <label class="form-field">
                    <span class="field-title">Profile ID</span>
                    <input ${isEdit ? `value="${escapeHtml(profileId)}" disabled` : `id="create-profile-id"`} name="profile_id" pattern="^[a-z][a-z0-9_]*$" placeholder="client_a_us" ${isEdit ? "" : "required"} autocomplete="off">
                    <span class="field-hint">Lower-case letters, numbers, and underscores. This becomes the immutable URL and directory name.</span>
                  </label>
                  <label class="form-field">
                    <span class="field-title">Proxy</span>
                    <input ${isEdit ? "" : `id="create-proxy"`} name="proxy"${proxyPlaceholder}>
                    <span class="field-hint">Supports scheme URLs, host:port, or host:port:user:pass.</span>
                  </label>
                  <label class="form-field">
                    <span class="field-title">Notes</span>
                    <input name="notes" value="${escapeHtml(notes)}" placeholder="Owner, purpose, login context, or reminders">
                    <span class="field-hint">Private operator context; not sent to CloakBrowser.</span>
                  </label>
                </div>
              </section>

              <section class="form-section create-tab-panel profile-tab-panel" data-profile-panel="browser" aria-labelledby="${escapeHtml(prefix)}-profile-browser" hidden>
                <div class="form-section-head">
                  <h3 id="${escapeHtml(prefix)}-profile-browser">Browser settings</h3>
                  <p>Choose whether this profile is manual-viewer first or CDP-only.</p>
                </div>
                <div class="form-fields">
                  <label class="form-field">
                    <span class="field-title">Mode</span>
                    <select ${isEdit ? "" : `id="create-headless"`} name="headless">
                      ${selectOption("false", String(profile?.headless ?? false), "false", "Browser viewer")}
                      ${selectOption("true", String(profile?.headless ?? false), "", "Automation only")}
                    </select>
                    <span class="field-hint">Manual browser exposes the right-side VNC viewer.</span>
                  </label>
                  <label class="form-field">
                    <span class="field-title">Clipboard Sync</span>
                    <select name="clipboard_sync">
                      ${selectOption("true", String(profile?.clipboard_sync ?? true), "true", "Enabled")}
                      ${selectOption("false", String(profile?.clipboard_sync ?? true), "", "Disabled")}
                    </select>
                    <span class="field-hint">Allows manual paste and VNC clipboard transfer.</span>
                  </label>
                  <label class="form-field">
                    <span class="field-title">Humanize</span>
                    <select name="humanize">
                      ${selectOption("false", String(profile?.humanize ?? false), "false", "Disabled")}
                      ${selectOption("true", String(profile?.humanize ?? false), "", "Enabled")}
                    </select>
                    <span class="field-hint">Enables CloakBrowser humanization behavior when supported.</span>
                  </label>
                  <label class="form-field">
                    <span class="field-title">Human Preset</span>
                    <input name="human_preset" value="${escapeHtml(profile?.human_preset ?? "")}" placeholder="Optional preset name">
                    <span class="field-hint">Leave blank unless you maintain named presets.</span>
                  </label>
                  <label class="form-field">
                    <span class="field-title">Sleep Policy</span>
                    <select name="sleep_policy_mode">
                      ${selectOption("default", sleepPolicyMode, "default", "Global default")}
                      ${selectOption("minutes", sleepPolicyMode, "", "Custom minutes")}
                      ${selectOption("never", sleepPolicyMode, "", "Never sleep")}
                    </select>
                    <span class="field-hint">Automatic spin-down for idle Browser Instances.</span>
                  </label>
                  <label class="form-field">
                    <span class="field-title">Sleep Minutes</span>
                    <input name="sleep_policy_minutes" type="number" min="1" max="1440" value="${sleepPolicyMinutes}" placeholder="30">
                    <span class="field-hint">Used only with Custom minutes.</span>
                  </label>
                </div>
              </section>

              <section class="form-section create-tab-panel profile-tab-panel" data-profile-panel="fingerprint" aria-labelledby="${escapeHtml(prefix)}-profile-fingerprint" hidden>
                <div class="form-section-head">
                  <h3 id="${escapeHtml(prefix)}-profile-fingerprint">Fingerprint</h3>
                  <p>Set regional, platform, display, and CPU signals.</p>
                </div>
                <div class="form-fields">
                  <label class="form-field">
                    <span class="field-title">Timezone</span>
                    <input ${isEdit ? "" : `id="create-timezone"`} name="timezone" value="${escapeHtml(profile?.timezone ?? "")}" placeholder="America/Los_Angeles" autocomplete="off">
                    <span class="field-hint">Blank keeps CloakBrowser defaults.</span>
                  </label>
                  <label class="form-field">
                    <span class="field-title">Locale</span>
                    <input ${isEdit ? "" : `id="create-locale"`} name="locale" value="${escapeHtml(profile?.locale ?? "")}" placeholder="en-US" autocomplete="off">
                    <span class="field-hint">Browser language and locale signal.</span>
                  </label>
                  <label class="form-field">
                    <span class="field-title">GeoIP</span>
                    <input name="geoip" value="${escapeHtml(profile?.geoip ?? "")}" placeholder="Optional CloakBrowser GeoIP hint">
                    <span class="field-hint">Use only when overriding automatic proxy-based behavior.</span>
                  </label>
                  <label class="form-field">
                    <span class="field-title">Platform</span>
                    <select ${isEdit ? "" : `id="create-platform"`} name="platform">
                      ${selectOption("linux", profile?.platform ?? "")}
                      ${selectOption("macos", profile?.platform ?? "", "macos")}
                      ${selectOption("windows", profile?.platform ?? "")}
                    </select>
                    <span class="field-hint">Fingerprint platform value.</span>
                  </label>
                  <label class="form-field">
                    <span class="field-title">Screen</span>
                    <span class="inline-fields">
                      <input ${isEdit ? "" : `id="create-screen-width"`} name="screen_width" type="number" min="100" max="10000" value="${profile?.screen_width ?? 1366}" aria-label="Screen width">
                      <input ${isEdit ? "" : `id="create-screen-height"`} name="screen_height" type="number" min="100" max="10000" value="${profile?.screen_height ?? 768}" aria-label="Screen height">
                    </span>
                    <span class="field-hint">Virtual display width and height in pixels.</span>
                  </label>
                  <label class="form-field">
                    <span class="field-title">CPU Threads</span>
                    <input name="hardware_concurrency" type="number" min="1" max="256" value="${profile?.hardware_concurrency ?? 4}">
                    <span class="field-hint">Hardware concurrency exposed to pages.</span>
                  </label>
                  <label class="form-field">
                    <span class="field-title">Color Scheme</span>
                    <select name="color_scheme">
                      ${selectOption("system", profile?.color_scheme ?? "", "system", "System")}
                      ${selectOption("light", profile?.color_scheme ?? "", "", "Light")}
                      ${selectOption("dark", profile?.color_scheme ?? "", "", "Dark")}
                    </select>
                    <span class="field-hint">Preferred color scheme exposed to websites.</span>
                  </label>
                </div>
              </section>

              <section class="form-section create-tab-panel profile-tab-panel" data-profile-panel="advanced" aria-labelledby="${escapeHtml(prefix)}-profile-advanced" hidden>
                <div class="form-section-head">
                  <h3 id="${escapeHtml(prefix)}-profile-advanced">Advanced fingerprint and launch settings</h3>
                  <p>Only set these when a profile needs exact fingerprint or launch overrides.</p>
                </div>
                <div class="form-fields">
                  <label class="form-field">
                    <span class="field-title">Fingerprint Seed</span>
                    <input name="fingerprint_seed" value="${escapeHtml(profile?.fingerprint_seed ?? "")}" placeholder="Auto-generated if blank">
                    <span class="field-hint">Stable random seed generated by default.</span>
                  </label>
                  <label class="form-field">
                    <span class="field-title">User Agent</span>
                    <input name="user_agent" value="${escapeHtml(profile?.user_agent ?? "")}" placeholder="Optional full user agent override">
                    <span class="field-hint">Blank keeps CloakBrowser defaults.</span>
                  </label>
                  <label class="form-field">
                    <span class="field-title">GPU Vendor</span>
                    <input name="gpu_vendor" value="${escapeHtml(profile?.gpu_vendor ?? "")}" placeholder="Optional vendor override">
                    <span class="field-hint">Advanced fingerprint override.</span>
                  </label>
                  <label class="form-field">
                    <span class="field-title">GPU Renderer</span>
                    <input name="gpu_renderer" value="${escapeHtml(profile?.gpu_renderer ?? "")}" placeholder="Optional renderer override">
                    <span class="field-hint">Advanced fingerprint override.</span>
                  </label>
                  <label class="form-field">
                    <span class="field-title">Launch Args</span>
                    <textarea name="custom_launch_args" placeholder="--flag=value">${escapeHtml(launchArgs)}</textarea>
                    <span class="field-hint">One browser flag per line. CloakHub-owned data-dir and CDP flags are rejected.</span>
                  </label>
                </div>
              </section>
            </div>
            <aside class="create-profile-summary" aria-label="Browser information">
              <h3>Browser information</h3>
              <dl class="summary-list">
                <div>
                  <dt>Name</dt>
                  <dd ${isEdit ? "" : `id="create-summary-name"`}>${escapeHtml(displayName || "Untitled profile")}</dd>
                </div>
                <div>
                  <dt>Profile ID</dt>
                  <dd ${isEdit ? "" : `id="create-summary-id"`}>${escapeHtml(profileId || "Required")}</dd>
                </div>
                <div>
                  <dt>Mode</dt>
                  <dd ${isEdit ? "" : `id="create-summary-mode"`}>${profile?.headless ? "Automation only" : "Browser viewer"}</dd>
                </div>
                <div>
                  <dt>Proxy</dt>
                  <dd ${isEdit ? "" : `id="create-summary-proxy"`}>${escapeHtml(profile?.proxy || "No proxy")}</dd>
                </div>
                <div>
                  <dt>Region</dt>
                  <dd ${isEdit ? "" : `id="create-summary-region"`}>${escapeHtml(profile ? `${profile.timezone || "Default timezone"} / ${profile.locale || "default locale"}` : "Default timezone / locale")}</dd>
                </div>
                <div>
                  <dt>Screen</dt>
                  <dd ${isEdit ? "" : `id="create-summary-screen"`}>${profile?.screen_width ?? 1366} x ${profile?.screen_height ?? 768}</dd>
                </div>
              </dl>
            </aside>
          </div>
          <div class="modal-actions">
            ${deleteButton}
            ${cancelButton}
            <button type="submit">${submitLabel}</button>
          </div>
        </form>`;
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

function selectOption(value: string, selectedValue: string, defaultValue = "", label = value): string {
  const selected = selectedValue === value || (!selectedValue && defaultValue === value) ? " selected" : "";
  return `<option value="${escapeHtml(value)}"${selected}>${escapeHtml(label)}</option>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
