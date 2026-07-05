import type { CloakHubConfig } from "./config";

export interface CloakHubApp {
  fetch(request: Request): Response | Promise<Response>;
}

export function createApp(config: CloakHubConfig): CloakHubApp {
  return {
    fetch(request: Request): Response {
      const url = new URL(request.url);

      if (url.pathname === "/api/health") {
        return healthResponse(request);
      }

      if (url.pathname === "/" || url.pathname === "/index.html") {
        if (!isAdminAuthorized(request, config.authToken)) {
          return textResponse("Unauthorized", 401, { "WWW-Authenticate": "Bearer" });
        }

        return htmlResponse(renderShell(config));
      }

      return textResponse("Not found", 404);
    }
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
  return new Response(body, {
    headers: {
      "content-type": "text/html; charset=utf-8"
    },
    status: 200
  });
}

function textResponse(body: string, status: number, headers: HeadersInit = {}): Response {
  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      ...headers
    },
    status
  });
}

function isAdminAuthorized(request: Request, authToken: string | undefined): boolean {
  if (!authToken) {
    return true;
  }

  const authorization = request.headers.get("authorization");
  if (authorization === `Bearer ${authToken}`) {
    return true;
  }

  return request.headers
    .get("cookie")
    ?.split(";")
    .map((cookie) => cookie.trim())
    .some((cookie) => {
      const separatorIndex = cookie.indexOf("=");
      const name = separatorIndex === -1 ? cookie : cookie.slice(0, separatorIndex);
      const value = separatorIndex === -1 ? "" : cookie.slice(separatorIndex + 1);

      return name === "cloakhub_auth" && safeDecodeURIComponent(value) === authToken;
    }) ?? false;
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function renderShell(config: CloakHubConfig): string {
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
      <section aria-labelledby="profiles-heading">
        <div class="section-head">
          <h2 id="profiles-heading">Browser Profiles</h2>
        </div>
        <table>
          <thead>
            <tr>
              <th scope="col">Profile ID</th>
              <th scope="col">Instance Status</th>
              <th scope="col">Last Activity</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td class="empty" colspan="3">No Browser Profiles registered</td>
            </tr>
          </tbody>
        </table>
      </section>
    </main>
  </body>
</html>`;
}
