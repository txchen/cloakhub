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

  test("protects the UI shell when admin auth is configured", async () => {
    const app = createApp({ ...config, authToken: "admin-token" });

    const anonymousResponse = await app.fetch(new Request("http://cloakhub.test/"));
    const authorizedResponse = await app.fetch(
      new Request("http://cloakhub.test/", {
        headers: { authorization: "Bearer admin-token" }
      })
    );

    expect(anonymousResponse.status).toBe(401);
    expect(authorizedResponse.status).toBe(200);
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
