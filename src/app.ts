import type { CloakHubConfig } from "./config";
import { CdpUnauthorizedError, parseCdpRoute, type CdpGateway } from "./cdp-gateway";
import type { CdpWebSocketData } from "./cdp-websocket-proxy";
import {
  BrowserProfileNotFoundError,
  UnsupportedBrowserProfileError,
  type BrowserRuntime,
  type BrowserRuntimeCdpSessionObservation,
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

type PresentedBrowserProfile = Omit<BrowserProfile, "cdp_token"> & {
  cdp_token_configured: boolean;
  cdp_session_count: number;
  cdp_sessions: BrowserRuntimeCdpSessionObservation[];
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
  upgrade(request: Request, options: { data: CdpWebSocketData }): boolean;
}

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

    const lifecycleResponse = await lifecycleApiResponse(request, url, services.browserRuntime);
    if (lifecycleResponse) {
      return lifecycleResponse;
    }

    const profileResponse = await profileApiResponse(
      request,
      url,
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

      const profiles =
        services.profileService?.listProfiles().map((profile) =>
          presentProfile(profile, services.browserRuntime, true)
        ) ?? [];
      return htmlResponse(renderShell(config, profiles));
    }

    return textResponse("Not found", 404);
  }

  return {
    fetch: fetch as CloakHubApp["fetch"]
  };
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
      return jsonResponse(profileResponseProfiles(profileService.listProfiles(), url, browserRuntime));
    }

    if (!profileId && request.method === "POST") {
      const profile = await profileService.createProfile(body);
      return jsonResponse(profileResponseProfile(profile, url, browserRuntime), 201);
    }

    if (profileId && request.method === "GET") {
      const profile = profileService.getProfile(profileId);
      return profile
        ? jsonResponse(profileResponseProfile(profile, url, browserRuntime))
        : errorResponse("Browser Profile was not found", 404);
    }

    if (profileId && request.method === "PATCH") {
      return jsonResponse(
        profileResponseProfile(
          await profileService.updateProfile(profileId, uiPatchBody(body, url)),
          url,
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

  if (error instanceof UnsupportedBrowserProfileError) {
    return errorResponse(error.message, 400);
  }

  return errorResponse(error instanceof Error ? error.message : String(error), 500);
}

function errorResponse(error: string, status: number): Response {
  return jsonResponse({ error }, status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function profileResponseProfiles(
  profiles: BrowserProfile[],
  url: URL,
  browserRuntime: BrowserRuntime | undefined
): PresentedBrowserProfile[] {
  return profiles.map((profile) =>
    presentProfile(profile, browserRuntime, isUiProfileActionRoute(url))
  );
}

function profileResponseProfile(
  profile: BrowserProfile,
  url: URL,
  browserRuntime: BrowserRuntime | undefined
): PresentedBrowserProfile {
  return presentProfile(profile, browserRuntime, isUiProfileActionRoute(url));
}

function presentProfile(
  profile: BrowserProfile,
  browserRuntime: BrowserRuntime | undefined,
  redactSecrets = false
): PresentedBrowserProfile {
  const { cdp_token: _cdpToken, ...profileWithoutToken } = redactSecrets
    ? redactProfileSecretsFromProfile(profile)
    : profile;
  return {
    ...profileWithoutToken,
    cdp_token_configured: Boolean(profile.cdp_token),
    cdp_session_count: browserRuntime?.activeCdpSessionCount(profile.profile_id) ?? 0,
    cdp_sessions: browserRuntime?.cdpSessionObservations(profile.profile_id) ?? []
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

function htmlResponse(body: string): Response {
  return new Response(body, htmlResponseInit());
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

function isUiProfileActionRoute(url: URL): boolean {
  return /^\/ui\/profiles(?:\/[^/]+(?:\/(?:start|stop|restart|cdp-token(?:\/regenerate)?))?)?$/.test(
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

function renderShell(config: CloakHubConfig, profiles: PresentedBrowserProfile[] = []): string {
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
                <span>${escapeHtml(profile.instance_status)}</span>
                <span>CDP Sessions: ${profile.cdp_session_count}</span>
                ${renderCdpSessions(profile)}
              </td>
              <td>${sleepPolicyBadge(profile)}</td>
              <td>
                <span>${escapeHtml(profile.notes)}</span>
                <span>${escapeHtml(profile.tags.map((tag) => tag.name).join(", "))}</span>
                <span>${escapeHtml(profile.proxy)}</span>
                ${renderCdpTokenControls(profile)}
                <button class="profile-lifecycle-button" data-action="start" data-profile-id="${escapeHtml(profile.profile_id)}" type="button">
                  Start
                </button>
                <button class="profile-lifecycle-button" data-action="stop" data-profile-id="${escapeHtml(profile.profile_id)}" type="button">
                  Stop
                </button>
                <button class="profile-lifecycle-button" data-action="restart" data-profile-id="${escapeHtml(profile.profile_id)}" type="button">
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
      document.getElementById("create-profile-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const values = compactFormValues(new FormData(event.currentTarget));
        const response = await fetch("/ui/profiles", {
          body: JSON.stringify(values),
          headers: { "content-type": "application/json" },
          method: "POST"
        });

        if (response.ok) {
          location.reload();
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
            location.reload();
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
            location.reload();
          }
        });
      });

      document.querySelectorAll(".profile-lifecycle-button").forEach((button) => {
        button.addEventListener("click", async (event) => {
          const profileId = event.currentTarget.dataset.profileId;
          const action = event.currentTarget.dataset.action;
          if (
            (action === "stop" || action === "restart") &&
            !confirm("This may disconnect active CDP sessions or viewers. Continue?")
          ) {
            return;
          }

          const response = await fetch(
            "/ui/profiles/" + encodeURIComponent(profileId) + "/" + encodeURIComponent(action),
            { method: "POST" }
          );

          if (response.ok) {
            location.reload();
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
            return;
          }

          location.reload();
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
