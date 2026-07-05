import type { CloakHubConfig } from "./config";
import {
  adminLoginResponse,
  isAdminApiAuthorized,
  isUiAuthorized,
  unauthorizedResponse
} from "./auth";
import { jsonResponse, textResponse } from "./http";
import type { BrowserProfile } from "./profile";
import {
  DeleteProfileDataError,
  DuplicateProfileError,
  ProfileNotFoundError,
  ProfileValidationError,
  type ProfileService
} from "./profile-service";

export interface CloakHubApp {
  fetch(request: Request): Response | Promise<Response>;
}

export interface CloakHubServices {
  profileService?: ProfileService;
}

export function createApp(config: CloakHubConfig, services: CloakHubServices = {}): CloakHubApp {
  return {
    async fetch(request: Request): Promise<Response> {
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

      const profileResponse = await profileApiResponse(request, url, services.profileService);
      if (profileResponse) {
        return profileResponse;
      }

      if (url.pathname === "/" || url.pathname === "/index.html") {
        if (!isUiAuthorized(request, config.authToken)) {
          return unauthorizedHtmlResponse(renderLoginShell());
        }

        const profiles = services.profileService?.listProfiles() ?? [];
        return htmlResponse(renderShell(config, profiles));
      }

      return textResponse("Not found", 404);
    }
  };
}

async function profileApiResponse(
  request: Request,
  url: URL,
  profileService: ProfileService | undefined
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
    if (!profileId && request.method === "GET") {
      return jsonResponse(profileService.listProfiles());
    }

    if (!profileId && request.method === "POST") {
      const profile = await profileService.createProfile(await jsonBody(request));
      return jsonResponse(profile, 201);
    }

    if (profileId && request.method === "GET") {
      const profile = profileService.getProfile(profileId);
      return profile ? jsonResponse(profile) : errorResponse("Browser Profile was not found", 404);
    }

    if (profileId && request.method === "PATCH") {
      return jsonResponse(await profileService.updateProfile(profileId, await jsonBody(request)));
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

async function jsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ProfileValidationError("Request body must be valid JSON");
  }
}

function profileErrorResponse(error: unknown): Response {
  if (error instanceof ProfileValidationError) {
    return errorResponse(error.message, 400);
  }

  if (error instanceof DuplicateProfileError) {
    return errorResponse(error.message, 409);
  }

  if (error instanceof ProfileNotFoundError) {
    return errorResponse(error.message, 404);
  }

  if (error instanceof DeleteProfileDataError) {
    return errorResponse(error.message, 500);
  }

  throw error;
}

function errorResponse(error: string, status: number): Response {
  return jsonResponse({ error }, status);
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
  return /^\/ui\/profiles(?:\/[^/]+)?$/.test(url.pathname);
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

function renderShell(config: CloakHubConfig, profiles: BrowserProfile[] = []): string {
  const profileRows =
    profiles.length === 0
      ? `<tr>
              <td class="empty" colspan="4">No Browser Profiles registered</td>
            </tr>`
      : profiles
          .map(
            (profile) => `<tr>
              <td>${escapeHtml(profile.profile_id)}</td>
              <td>
                <form class="profile-update-form" data-profile-id="${escapeHtml(profile.profile_id)}">
                  <input name="display_name" value="${escapeHtml(profile.display_name)}">
                  <input name="notes" value="${escapeHtml(profile.notes)}">
                  <button type="submit">Save</button>
                </form>
              </td>
              <td>${escapeHtml(profile.instance_status)}</td>
              <td>
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
        grid-template-columns: minmax(120px, 1fr) minmax(120px, 1fr) auto;
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

      function compactFormValues(formData) {
        return Object.fromEntries(
          Array.from(formData.entries()).filter((entry) => entry[1] !== "")
        );
      }
    </script>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
