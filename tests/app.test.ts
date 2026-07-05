import { describe, expect, test } from "bun:test";

import { createApp } from "../src/app";
import type { CloakHubConfig } from "../src/config";

const config: CloakHubConfig = {
  authToken: undefined,
  browserBin: undefined,
  dataRoot: "/sensitive/data-root",
  host: "127.0.0.1",
  maxRunningInstances: 10,
  port: 7788
};

describe("CloakHub HTTP app", () => {
  test("serves non-sensitive health without auth", async () => {
    const app = createApp({ ...config, authToken: "admin-token" });

    const response = await app.fetch(new Request("http://cloakhub.test/api/health"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({ ok: true });
  });

  test("serves a login shell when admin auth is configured and UI cookie is missing", async () => {
    const app = createApp({ ...config, authToken: "admin-token" });

    const anonymousResponse = await app.fetch(new Request("http://cloakhub.test/"));
    const html = await anonymousResponse.text();

    expect(anonymousResponse.status).toBe(401);
    expect(html).toContain("<title>CloakHub Login</title>");
    expect(html).toContain("/api/auth/login");
  });

  test("UI cookie authentication works independently from admin API bearer auth", async () => {
    const app = createApp({ ...config, authToken: "admin-token" });

    const bearerUiResponse = await app.fetch(
      new Request("http://cloakhub.test/", {
        headers: { authorization: "Bearer admin-token" }
      })
    );
    const cookieUiResponse = await app.fetch(
      new Request("http://cloakhub.test/", {
        headers: { cookie: "cloakhub_auth=admin-token" }
      })
    );
    const cookieApiResponse = await app.fetch(
      new Request("http://cloakhub.test/api/profiles", {
        headers: { cookie: "cloakhub_auth=admin-token" }
      })
    );

    expect(await bearerUiResponse.text()).toContain("<title>CloakHub Login</title>");
    expect(bearerUiResponse.status).toBe(401);
    expect(cookieUiResponse.status).toBe(200);
    expect(cookieApiResponse.status).toBe(401);
  });

  test("rejects invalid UI and admin API credentials", async () => {
    const app = createApp({ ...config, authToken: "admin-token" });

    const wrongBearer = await app.fetch(
      new Request("http://cloakhub.test/api/profiles", {
        headers: { authorization: "Bearer wrong-token" }
      })
    );
    const wrongCookie = await app.fetch(
      new Request("http://cloakhub.test/", {
        headers: { cookie: "cloakhub_auth=wrong-token" }
      })
    );

    expect(wrongBearer.status).toBe(401);
    expect(wrongCookie.status).toBe(401);
    expect(await wrongCookie.text()).toContain("<title>CloakHub Login</title>");
  });

  test("protects admin API routes when admin auth is configured", async () => {
    const app = createApp({ ...config, authToken: "admin-token" });

    const anonymousResponse = await app.fetch(new Request("http://cloakhub.test/api/profiles"));
    const bearerResponse = await app.fetch(
      new Request("http://cloakhub.test/api/profiles", {
        headers: { authorization: "Bearer admin-token" }
      })
    );

    expect(anonymousResponse.status).toBe(401);
    expect(bearerResponse.status).toBe(404);
  });

  test("does not apply admin auth to CDP routes", async () => {
    const app = createApp({ ...config, authToken: "admin-token" });

    const response = await app.fetch(
      new Request("http://cloakhub.test/api/profiles/work/cdp/json/version")
    );

    expect(response.status).toBe(404);
  });

  test("keeps UI and admin API routes open when no admin token is configured", async () => {
    const app = createApp(config);

    const uiResponse = await app.fetch(new Request("http://cloakhub.test/"));
    const apiResponse = await app.fetch(new Request("http://cloakhub.test/api/profiles"));

    expect(uiResponse.status).toBe(200);
    expect(apiResponse.status).toBe(404);
  });

  test("admin login establishes a cookie for UI access", async () => {
    const app = createApp({ ...config, authToken: "admin-token" });

    const loginResponse = await app.fetch(
      new Request("http://cloakhub.test/api/auth/login", {
        body: JSON.stringify({ token: "admin-token" }),
        headers: { "content-type": "application/json" },
        method: "POST"
      })
    );
    const cookie = loginResponse.headers.get("set-cookie");
    const uiResponse = await app.fetch(
      new Request("http://cloakhub.test/", {
        headers: { cookie: cookie ?? "" }
      })
    );

    expect(loginResponse.status).toBe(204);
    expect(cookie).toStartWith("cloakhub_auth=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(uiResponse.status).toBe(200);
  });

  test("admin login rejects invalid credentials without setting a cookie", async () => {
    const app = createApp({ ...config, authToken: "admin-token" });

    const response = await app.fetch(
      new Request("http://cloakhub.test/api/auth/login", {
        body: JSON.stringify({ token: "wrong-token" }),
        headers: { "content-type": "application/json" },
        method: "POST"
      })
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  test("serves the operational UI shell from the root", async () => {
    const app = createApp(config);

    const response = await app.fetch(new Request("http://cloakhub.test/"));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(html).toContain("<title>CloakHub</title>");
    expect(html).toContain("CloakHub");
    expect(html).not.toContain(config.dataRoot);
  });
});
