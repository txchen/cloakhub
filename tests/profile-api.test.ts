import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  createApp,
  type CloakHubUpgradeServer,
  type CloakHubWebSocketData
} from "../src/app";
import {
  CapacityUnavailableError,
  UnsupportedManualViewerProfileError,
  type BrowserRuntime,
  type BrowserRuntimeState
} from "../src/browser-runtime";
import type { CloakHubConfig } from "../src/config";
import { ownedProcessEnv } from "../src/owned-process";
import { createProfileService } from "../src/profile-service";
import { openProfileRepository } from "../src/profile-repository";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true }))
  );
});

describe("Browser Profile admin API", () => {
  test("agents discover profiles and connection metadata without secrets or UI fields", async () => {
    const runtime = fakeBrowserRuntime();
    const { app, repository } = await tempApp({}, runtime);
    await app.fetch(jsonRequest("http://cloakhub.test/api/profiles", "POST", {
      profile_id: "work", display_name: "Work", notes: "Research account",
      proxy: "http://user:secret@proxy.test:8080", headless: true
    }));
    await app.fetch(new Request("http://cloakhub.test/api/profiles/work/cdp-token", { method: "POST" }));
    const token = repository.get("work")!.cdp_token!;
    const headers = { "x-forwarded-host": "hub.example:8443", "x-forwarded-proto": "https" };
    const response = await app.fetch(new Request("http://internal/api/profiles?view=summary", { headers }));
    const profiles = await response.json();
    const connection = {
      cdp_url: "https://hub.example:8443/api/profiles/work/cdp",
      cdp_ws_url: "wss://hub.example:8443/api/profiles/work/cdp",
      cdp_discovery_url: "https://hub.example:8443/api/profiles/work/cdp/json/version",
      cdp_token_url: "https://hub.example:8443/api/profiles/work/cdp-token",
      auth: "cdp_token"
    };
    expect(profiles).toEqual([{
      profile_id: "work", display_name: "Work", notes: "Research account", headless: true,
      instance_status: "stopped", cdp_session_count: 0, manual_viewer_count: 0,
      last_launch_error: null, connection
    }]);
    expect(JSON.stringify(profiles)).not.toContain(token);
    expect(JSON.stringify(profiles)).not.toContain("secret");
    expect(runtime.calls).toEqual([]);
    const read = await app.fetch(new Request("http://internal/api/profiles/work?view=summary", { headers }));
    expect(await read.json()).toEqual(profiles[0]);
    const started = await app.fetch(new Request("http://internal/api/profiles/work/start", { method: "POST", headers }));
    expect(await started.json()).toEqual({
      profile_id: "work", status: "running", instance_status: "running", connection
    });
    const full = await app.fetch(new Request("http://internal/api/profiles/work", { headers }));
    expect(await full.json()).toMatchObject({ connection, sleep_policy: { mode: "default" } });
    await app.fetch(new Request("http://internal/api/profiles/work/cdp-token", { method: "DELETE" }));
    const open = await app.fetch(new Request("http://internal/api/profiles/work?view=summary", { headers }));
    expect((await open.json()).connection.auth).toBe("none");
  });

  test("creates, lists, reads, updates, and deletes stopped Browser Profiles", async () => {
    const { app, dataRoot } = await tempApp();

    const created = await app.fetch(
      jsonRequest("http://cloakhub.test/api/profiles", "POST", {
        display_name: "Work",
        notes: "daily",
        profile_id: "work"
      })
    );
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      display_name: "Work",
      profile_id: "work"
    });
    expect(await readdir(join(dataRoot, "profiles"))).toEqual(["work"]);

    const list = await app.fetch(
      new Request("http://cloakhub.test/api/profiles")
    );
    expect(await list.json()).toEqual([
      expect.objectContaining({ display_name: "Work", profile_id: "work" })
    ]);

    const read = await app.fetch(
      new Request("http://cloakhub.test/api/profiles/work")
    );
    expect(await read.json()).toMatchObject({
      notes: "daily",
      profile_id: "work"
    });

    const updated = await app.fetch(
      jsonRequest("http://cloakhub.test/api/profiles/work", "PATCH", {
        display_name: "Work 2",
        notes: "updated"
      })
    );
    expect(await updated.json()).toMatchObject({
      display_name: "Work 2",
      notes: "updated"
    });

    const deleted = await app.fetch(
      new Request("http://cloakhub.test/api/profiles/work", {
        method: "DELETE"
      })
    );
    expect(deleted.status).toBe(204);
    await expect(readdir(join(dataRoot, "profiles"))).resolves.toEqual([]);
  });

  test("cookie-authenticated UI actions manage Browser Profiles without bearer auth", async () => {
    const { app } = await tempApp({ authToken: "admin-token" });
    const cookie = "cloakhub_auth=admin-token";

    const created = await app.fetch(
      jsonRequest(
        "http://cloakhub.test/ui/profiles",
        "POST",
        {
          display_name: "Work",
          profile_id: "work"
        },
        cookie
      )
    );
    expect(created.status).toBe(201);

    const updated = await app.fetch(
      jsonRequest(
        "http://cloakhub.test/ui/profiles/work",
        "PATCH",
        {
          display_name: "Work 2"
        },
        cookie
      )
    );
    expect(await updated.json()).toMatchObject({
      display_name: "Work 2",
      profile_id: "work"
    });

    const deleted = await app.fetch(
      new Request("http://cloakhub.test/ui/profiles/work", {
        headers: { cookie },
        method: "DELETE"
      })
    );
    expect(deleted.status).toBe(204);
  });

  test("rejects invalid, duplicate, and mutable Profile IDs", async () => {
    const { app } = await tempApp();

    const invalid = await app.fetch(
      jsonRequest("http://cloakhub.test/api/profiles", "POST", {
        profile_id: "Work"
      })
    );
    expect(invalid.status).toBe(400);

    await app.fetch(
      jsonRequest("http://cloakhub.test/api/profiles", "POST", {
        profile_id: "work"
      })
    );
    const duplicate = await app.fetch(
      jsonRequest("http://cloakhub.test/api/profiles", "POST", {
        profile_id: "work"
      })
    );
    expect(duplicate.status).toBe(409);

    const mutable = await app.fetch(
      jsonRequest("http://cloakhub.test/api/profiles/work", "PATCH", {
        profile_id: "other"
      })
    );
    expect(mutable.status).toBe(400);
  });

  test("redacts proxy credentials in API and UI responses while preserving stored metadata", async () => {
    const { app, repository } = await tempApp();

    const created = await app.fetch(
      jsonRequest("http://cloakhub.test/api/profiles", "POST", {
        profile_id: "work",
        proxy: "http://user:secret@proxy.example:8080",
        sleep_policy: { mode: "minutes", minutes: 30 },
        notes: "private notes"
      })
    );
    const body = await created.json();
    const htmlResponse = await app.fetch(new Request("http://cloakhub.test/"));
    const html = await htmlResponse.text();

    expect(body.proxy).toBe("http://user:secret@proxy.example:8080");
    expect(repository.get("work")?.proxy).toBe(
      "http://user:secret@proxy.example:8080"
    );
    expect(html).toContain("private notes");
    expect(html).toContain("http://user:***@proxy.example:8080");
    expect(html).not.toContain("secret");
  });

  test("UI edit preserves an omitted proxy and allows explicit removal", async () => {
    const { app, repository } = await tempApp();
    await app.fetch(
      jsonRequest("http://cloakhub.test/api/profiles", "POST", {
        profile_id: "work",
        proxy: "http://user:secret@proxy.example:8080"
      })
    );

    const updated = await app.fetch(
      jsonRequest("http://cloakhub.test/ui/profiles/work", "PATCH", {
        display_name: "Work 2"
      })
    );

    expect(updated.status).toBe(200);
    expect(repository.get("work")?.proxy).toBe(
      "http://user:secret@proxy.example:8080"
    );
    await app.fetch(
      jsonRequest("http://cloakhub.test/ui/profiles/work", "PATCH", {
        proxy: ""
      })
    );
    expect(repository.get("work")?.proxy).toBe("");
  });

  test("shows stopped Instance Status and never-sleep Sleep Policy in API and UI", async () => {
    const { app } = await tempApp();
    await app.fetch(
      jsonRequest("http://cloakhub.test/api/profiles", "POST", {
        profile_id: "work",
        sleep_policy: { mode: "never" }
      })
    );

    const apiResponse = await app.fetch(
      new Request("http://cloakhub.test/api/profiles/work")
    );
    const apiBody = await apiResponse.json();
    const uiResponse = await app.fetch(new Request("http://cloakhub.test/"));
    const html = await uiResponse.text();

    expect(apiBody).toMatchObject({
      instance_status: "stopped",
      sleep_policy: { mode: "never" },
      sleep_policy_status: {
        blocks_sleep: true,
        effective_minutes: null,
        mode: "never"
      }
    });
    expect(html).toContain("stopped");

    expect(bootstrap(html).profiles[0].sleep_policy.mode).toBe("never");
  });

  test("profile list polling does not count as Instance Activity", async () => {
    const { app, repository } = await tempApp();
    await app.fetch(
      jsonRequest("http://cloakhub.test/api/profiles", "POST", {
        profile_id: "work"
      })
    );
    repository.recordActivity("work", "2026-01-01T00:00:00.000Z");
    const before = repository.get("work")?.last_activity_at;

    await app.fetch(new Request("http://cloakhub.test/api/profiles"));
    await app.fetch(new Request("http://cloakhub.test/"));

    expect(repository.get("work")?.last_activity_at).toBe(before);
  });

  test("updates Sleep Policy through the admin API", async () => {
    const { app } = await tempApp();
    await app.fetch(
      jsonRequest("http://cloakhub.test/api/profiles", "POST", {
        profile_id: "work"
      })
    );

    const updated = await app.fetch(
      jsonRequest("http://cloakhub.test/api/profiles/work", "PATCH", {
        sleep_policy: { mode: "minutes", minutes: 45 }
      })
    );

    expect(await updated.json()).toMatchObject({
      sleep_policy: { mode: "minutes", minutes: 45 },
      sleep_policy_status: {
        blocks_sleep: false,
        effective_minutes: 45,
        mode: "minutes"
      }
    });
  });

  test("starts, stops, and restarts Browser Instances through the admin API", async () => {
    const browserRuntime = fakeBrowserRuntime();
    const { app } = await tempApp({}, browserRuntime);
    await app.fetch(
      jsonRequest("http://cloakhub.test/api/profiles", "POST", {
        headless: true,
        profile_id: "work"
      })
    );

    const started = await app.fetch(
      new Request("http://cloakhub.test/api/profiles/work/start", {
        method: "POST"
      })
    );
    const stopped = await app.fetch(
      new Request("http://cloakhub.test/api/profiles/work/stop", {
        method: "POST"
      })
    );
    const restarted = await app.fetch(
      new Request("http://cloakhub.test/api/profiles/work/restart", {
        method: "POST"
      })
    );

    expect(await started.json()).toMatchObject({
      profile_id: "work",
      status: "running"
    });
    expect(await stopped.json()).toMatchObject({
      profile_id: "work",
      status: "stopped"
    });
    expect(await restarted.json()).toMatchObject({
      profile_id: "work",
      status: "running"
    });
    expect(browserRuntime.calls).toEqual([
      "start:work",
      "stop:work:manual stop",
      "restart:work"
    ]);
  });

  test("cookie-authenticated UI actions start Browser Instances without bearer auth", async () => {
    const browserRuntime = fakeBrowserRuntime();
    const { app } = await tempApp({ authToken: "admin-token" }, browserRuntime);
    const cookie = "cloakhub_auth=admin-token";

    const response = await app.fetch(
      new Request("http://cloakhub.test/ui/profiles/work/start", {
        headers: { cookie },
        method: "POST"
      })
    );

    expect(response.status).toBe(200);
    expect(browserRuntime.calls).toEqual(["start:work"]);
  });

  test("capacity failures from lifecycle actions are retryable", async () => {
    const browserRuntime = fakeBrowserRuntime({
      startError: new CapacityUnavailableError()
    });
    const { app } = await tempApp({}, browserRuntime);

    const response = await app.fetch(
      new Request("http://cloakhub.test/api/profiles/work/start", {
        method: "POST"
      })
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error:
        "Running Instance capacity is full; retry after another Browser Instance stops",
      message: "Running Instance capacity is full; retry after another Browser Instance stops",
      code: "CAPACITY_UNAVAILABLE",
      retryable: true
    });
  });

  test("shows active CDP Session observations in API and UI status", async () => {
    const browserRuntime = fakeBrowserRuntime({ activeCdpSessionCount: 1 });
    const { app } = await tempApp({}, browserRuntime);
    await app.fetch(
      jsonRequest("http://cloakhub.test/api/profiles", "POST", {
        profile_id: "work"
      })
    );

    const apiResponse = await app.fetch(
      new Request("http://cloakhub.test/api/profiles/work")
    );
    const uiResponse = await app.fetch(new Request("http://cloakhub.test/"));
    const html = await uiResponse.text();

    expect(await apiResponse.json()).toMatchObject({
      cdp_session_count: 1,
      cdp_sessions: [
        {
          duration_ms: 1250,
          remote_address: "203.0.113.10",
          started_at: "2026-01-01T00:00:00.000Z",
          user_agent: "Playwright"
        }
      ]
    });

    expect(html).toContain("Playwright");
    expect(html).toContain("1s");
  });

  test("opens manual viewer with admin auth and triggers headed Transparent Recovery", async () => {
    const browserRuntime = fakeBrowserRuntime();
    const { app } = await tempApp({ authToken: "admin-token" }, browserRuntime);
    const cookie = "cloakhub_auth=admin-token";
    await app.fetch(
      jsonRequest(
        "http://cloakhub.test/ui/profiles",
        "POST",
        {
          headless: false,
          profile_id: "work"
        },
        cookie
      )
    );

    const anonymous = await app.fetch(
      new Request("http://cloakhub.test/ui/profiles/work/viewer")
    );
    expect(anonymous.status).toBe(401);

    const response = await app.fetch(
      new Request("http://cloakhub.test/ui/profiles/work/viewer", {
        headers: { cookie }
      })
    );
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(browserRuntime.calls).toEqual(["viewer:work"]);
    expect(html).toContain('id="manual-viewer"');
    expect(html).not.toContain('id="viewer-copy-button"');
    expect(html).not.toContain('id="viewer-paste-button"');
    expect(html).not.toMatch(
      /<div id="manual-viewer"[^>]*>\s*<div[^>]*id="clipboard-controls"/
    );
    expect(html).toContain('data-vnc-websocket-url="/ui/profiles/work/vnc"');
    expect(html).toContain('src="/assets/viewer.js"');
    const viewerScript = await app.fetch(
      new Request("http://cloakhub.test/assets/viewer.js")
    );
    expect(viewerScript.status).toBe(200);
    expect(viewerScript.headers.get("content-type")).toContain("javascript");
  });

  test("serves noVNC browser modules for the manual viewer", async () => {
    const { app } = await tempApp({ authToken: "admin-token" });

    const response = await app.fetch(
      new Request("http://cloakhub.test/assets/novnc/core/rfb.js")
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/javascript");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toContain("class RFB");
  });

  test("manual viewer capacity failures are retryable", async () => {
    const browserRuntime = fakeBrowserRuntime({
      viewerError: new CapacityUnavailableError()
    });
    const { app } = await tempApp({}, browserRuntime);

    const response = await app.fetch(
      new Request("http://cloakhub.test/ui/profiles/work/viewer")
    );
    const html = await response.text();

    expect(response.status).toBe(503);
    expect(html).toContain("Running Instance capacity is full");
    expect(html).toContain("Retryable");
  });

  test("upgrades manual viewer websocket after headed Transparent Recovery", async () => {
    const browserRuntime = fakeBrowserRuntime();
    const server = fakeUpgradeServer();
    const { app } = await tempApp({ authToken: "admin-token" }, browserRuntime);
    const cookie = "cloakhub_auth=admin-token";
    await app.fetch(
      jsonRequest(
        "http://cloakhub.test/ui/profiles",
        "POST",
        {
          headless: false,
          profile_id: "work"
        },
        cookie
      )
    );

    const response = await app.fetch(
      new Request("http://cloakhub.test/ui/profiles/work/vnc", {
        headers: { cookie, upgrade: "websocket" }
      }),
      server
    );

    expect(response).toBeUndefined();
    expect(browserRuntime.calls).toEqual(["viewer:work"]);
    expect(server.upgrades).toEqual([
      { profileId: "work", targetHost: "127.0.0.1", targetPort: 5900 }
    ]);
  });

  test("manual viewer websocket capacity failures are retryable JSON", async () => {
    const browserRuntime = fakeBrowserRuntime({
      viewerError: new CapacityUnavailableError()
    });
    const server = fakeUpgradeServer();
    const { app } = await tempApp({ authToken: "admin-token" }, browserRuntime);
    const cookie = "cloakhub_auth=admin-token";

    const response = await app.fetch(
      new Request("http://cloakhub.test/ui/profiles/work/vnc", {
        headers: { cookie, upgrade: "websocket" }
      }),
      server
    );

    expect(response?.status).toBe(503);
    expect(await response?.json()).toEqual({
      error:
        "Running Instance capacity is full; retry after another Browser Instance stops",
      message: "Running Instance capacity is full; retry after another Browser Instance stops",
      code: "CAPACITY_UNAVAILABLE",
      retryable: true
    });
    expect(server.upgrades).toEqual([]);
  });

  test("status responses include active manual viewer count", async () => {
    const browserRuntime = fakeBrowserRuntime({
      activeManualViewerCount: 2,
      lastManualInputAt: "2026-01-01T00:00:05.000Z"
    });
    const { app } = await tempApp({}, browserRuntime);
    await app.fetch(
      jsonRequest("http://cloakhub.test/api/profiles", "POST", {
        profile_id: "work"
      })
    );

    const apiResponse = await app.fetch(
      new Request("http://cloakhub.test/api/profiles/work")
    );
    const uiResponse = await app.fetch(new Request("http://cloakhub.test/"));
    const html = await uiResponse.text();

    expect(await apiResponse.json()).toMatchObject({
      last_manual_input_at: "2026-01-01T00:00:05.000Z",
      manual_viewer_count: 2
    });

    expect(html).toContain("2026-01-01T00:00:05.000Z");
  });

  test("dashboard bootstrap includes redacted runtime observations and approximate Resource Usage", async () => {
    const browserRuntime = fakeBrowserRuntime({
      activeCdpSessionCount: 1,
      activeManualViewerCount: 2,
      lastManualInputAt: "2026-01-01T00:00:05.000Z"
    });
    const { app, dataRoot, repository } = await tempApp({}, browserRuntime);
    await app.fetch(
      jsonRequest("http://cloakhub.test/api/profiles", "POST", {
        display_name: "Work",
        profile_id: "work",
        proxy: "http://user:secret@proxy.example:8080"
      })
    );
    repository.markRunning("work", "2026-01-01T00:00:00.000Z");
    repository.recordActivity("work", "2026-01-01T00:02:00.000Z");
    repository.markStopped(
      "work",
      "capacity preemption",
      "2026-01-01T00:03:00.000Z"
    );
    repository.setCdpToken("work", "profile-token");
    repository.markLaunchFailed(
      "work",
      "launch failed for profile-token",
      "2026-01-01T00:04:00.000Z"
    );
    await mkdir(join(dataRoot, "runtime", "work"), { recursive: true });
    await Bun.write(
      join(dataRoot, "runtime", "work", "browser.pid"),
      "999999\n"
    );
    const ownedProcess = Bun.spawn(["/bin/sleep", "30"], {
      detached: true,
      env: ownedProcessEnv(dataRoot, "work"),
      stderr: "ignore",
      stdin: "ignore",
      stdout: "ignore"
    });
    ownedProcess.unref();

    try {
      await Bun.write(
        join(dataRoot, "runtime", "work", "display.pid"),
        `${ownedProcess.pid}\n`
      );

      const response = await app.fetch(new Request("http://cloakhub.test/"));
      const html = await response.text();

      expect(response.status).toBe(200);
      const profile = bootstrap(html).profiles[0];
      expect(profile).toMatchObject({
        cdp_session_count: 1,
        manual_viewer_count: 2,
        last_launch_error: "launch failed for ***"
      });
      expect(html).not.toContain("secret");
      expect(html).not.toContain("profile-token");
      expect(html).toContain('src="/assets/app.js"');

      const apiProfile = await (
        await app.fetch(new Request("http://cloakhub.test/api/profiles/work"))
      ).json();
      expect(apiProfile.resource_usage.owned_process_count).toBe(1);
      expect(apiProfile.resource_usage.rss_bytes).toBeGreaterThan(0);
      expect(apiProfile.sleep_status).toBe("Sleep Blocker: active CDP Session");
      const polled = await (
        await app.fetch(new Request("http://cloakhub.test/ui/profiles/work"))
      ).json();
      expect(polled.last_launch_error).toBe("launch failed for ***");
      expect(JSON.stringify(polled)).not.toContain("profile-token");
    } finally {
      killProcessGroup(ownedProcess.pid);
      await ownedProcess.exited.catch(() => undefined);
    }
  });

  test("dashboard ignores obsolete search query params and renders all profiles", async () => {
    const { app } = await tempApp();
    await app.fetch(
      jsonRequest("http://cloakhub.test/api/profiles", "POST", {
        display_name: "Client Work",
        profile_id: "work"
      })
    );
    await app.fetch(
      jsonRequest("http://cloakhub.test/api/profiles", "POST", {
        display_name: "Personal",
        profile_id: "personal"
      })
    );
    await app.fetch(
      jsonRequest("http://cloakhub.test/api/profiles", "POST", {
        display_name: "Archive",
        profile_id: "ops"
      })
    );

    const byName = await (
      await app.fetch(new Request("http://cloakhub.test/?q=client"))
    ).text();
    const ignoredQuery = await (
      await app.fetch(new Request("http://cloakhub.test/?q=home"))
    ).text();
    const byProfileId = await (
      await app.fetch(new Request("http://cloakhub.test/?q=ops"))
    ).text();

    expect(byName).toContain("Client Work");
    expect(byName).toContain("Personal");
    expect(ignoredQuery).toContain("Personal");
    expect(ignoredQuery).toContain("Client Work");
    expect(byProfileId).toContain("Archive");
  });

  test("manual clipboard endpoint writes text through the Browser Runtime", async () => {
    const browserRuntime = fakeBrowserRuntime();
    const { app } = await tempApp({ authToken: "admin-token" }, browserRuntime);
    const cookie = "cloakhub_auth=admin-token";

    const response = await app.fetch(
      jsonRequest(
        "http://cloakhub.test/ui/profiles/work/clipboard",
        "POST",
        { text: "pasted" },
        cookie
      )
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(browserRuntime.calls).toEqual(["clipboard:work:pasted"]);
  });

  test("manual clipboard endpoint reads copied browser text through the Browser Runtime", async () => {
    const browserRuntime = fakeBrowserRuntime({
      manualClipboardText: "copied from browser"
    });
    const { app } = await tempApp({ authToken: "admin-token" }, browserRuntime);

    const response = await app.fetch(
      new Request("http://cloakhub.test/ui/profiles/work/clipboard", {
        headers: { cookie: "cloakhub_auth=admin-token" }
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: "copied from browser" });
    expect(browserRuntime.calls).toEqual(["read-clipboard:work"]);
  });

  test("headless profiles show viewer unavailable without changing headless mode", async () => {
    const browserRuntime = fakeBrowserRuntime({
      viewerError: new UnsupportedManualViewerProfileError("work")
    });
    const { app, repository } = await tempApp({}, browserRuntime);
    await app.fetch(
      jsonRequest("http://cloakhub.test/api/profiles", "POST", {
        headless: true,
        profile_id: "work"
      })
    );

    const response = await app.fetch(
      new Request("http://cloakhub.test/ui/profiles/work/viewer")
    );
    const html = await response.text();

    expect(response.status).toBe(400);
    expect(html).toContain(
      "Manual viewer is unavailable for headless Browser Profiles"
    );
    expect(html).toContain("Edit the profile to disable headless mode");
    expect(repository.get("work")?.headless).toBe(true);
  });

  test("manages one plaintext CDP Token through explicit admin actions", async () => {
    const { app, repository } = await tempApp({}, undefined, {
      cdpTokenGenerator: sequenceTokens("first-token", "second-token")
    });
    await app.fetch(
      jsonRequest("http://cloakhub.test/api/profiles", "POST", {
        profile_id: "work"
      })
    );

    const initialView = await app.fetch(
      new Request("http://cloakhub.test/api/profiles/work/cdp-token")
    );
    expect(await initialView.json()).toEqual({
      cdp_token: null,
      cdp_token_configured: false,
      profile_id: "work"
    });

    const created = await app.fetch(
      new Request("http://cloakhub.test/api/profiles/work/cdp-token", {
        method: "POST"
      })
    );
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({
      cdp_token: "first-token",
      cdp_token_configured: true,
      profile_id: "work"
    });
    expect(repository.get("work")?.cdp_token).toBe("first-token");

    const profile = await app.fetch(
      new Request("http://cloakhub.test/api/profiles/work")
    );
    const profileBody = await profile.json();
    expect(profileBody.cdp_token_configured).toBe(true);
    expect(profileBody.cdp_token).toBeUndefined();

    const viewed = await app.fetch(
      new Request("http://cloakhub.test/api/profiles/work/cdp-token")
    );
    expect(await viewed.json()).toEqual({
      cdp_token: "first-token",
      cdp_token_configured: true,
      profile_id: "work"
    });

    const regenerated = await app.fetch(
      new Request(
        "http://cloakhub.test/api/profiles/work/cdp-token/regenerate",
        { method: "POST" }
      )
    );
    expect(await regenerated.json()).toEqual({
      cdp_token: "second-token",
      cdp_token_configured: true,
      profile_id: "work"
    });
    expect(repository.get("work")?.cdp_token).toBe("second-token");

    const revoked = await app.fetch(
      new Request("http://cloakhub.test/api/profiles/work/cdp-token", {
        method: "DELETE"
      })
    );
    expect(revoked.status).toBe(204);
    expect(repository.get("work")?.cdp_token).toBeNull();
  });

  test("requires admin auth for CDP Token management and keeps CDP Tokens out of admin auth", async () => {
    const { app } = await tempApp({ authToken: "admin-token" }, undefined, {
      cdpTokenGenerator: sequenceTokens("profile-token")
    });
    const adminCookie = "cloakhub_auth=admin-token";
    await app.fetch(
      jsonRequest(
        "http://cloakhub.test/ui/profiles",
        "POST",
        { profile_id: "work" },
        adminCookie
      )
    );

    const anonymousCreate = await app.fetch(
      new Request("http://cloakhub.test/api/profiles/work/cdp-token", {
        method: "POST"
      })
    );
    expect(anonymousCreate.status).toBe(401);

    const created = await app.fetch(
      new Request("http://cloakhub.test/ui/profiles/work/cdp-token", {
        headers: { cookie: adminCookie },
        method: "POST"
      })
    );
    expect(created.status).toBe(201);

    const cdpTokenAsAdminAuth = await app.fetch(
      new Request("http://cloakhub.test/api/profiles", {
        headers: { authorization: "Bearer profile-token" }
      })
    );
    expect(cdpTokenAsAdminAuth.status).toBe(401);
  });
});

async function tempApp(
  overrides: Partial<CloakHubConfig> = {},
  browserRuntime?: BrowserRuntime,
  serviceOptions: { cdpTokenGenerator?: () => string } = {}
) {
  const dataRoot = await mkdtemp(join(tmpdir(), "cloakhub-profile-api-"));
  cleanupPaths.push(dataRoot);
  const repository = openProfileRepository(dataRoot);
  repository.migrate();
  const profileService = createProfileService({
    dataRoot,
    repository,
    ...serviceOptions
  });
  const config: CloakHubConfig = {
    authToken: undefined,
    browserBin: undefined,
    dataRoot,
    host: "127.0.0.1",
    maxRunningInstances: 10,
    port: 7788,
    ...overrides
  };

  return {
    app: createApp(config, { browserRuntime, profileService }),
    dataRoot,
    repository
  };
}

function fakeBrowserRuntime(
  options: {
    activeCdpSessionCount?: number;
    activeManualViewerCount?: number;
    lastManualInputAt?: string | null;
    manualClipboardText?: string;
    startError?: Error;
    viewerError?: Error;
  } = {}
): BrowserRuntime & {
  calls: string[];
  readManualClipboard(profileId: string): Promise<string>;
} {
  const calls: string[] = [];
  const state = (
    profileId: string,
    status: BrowserRuntimeState["status"]
  ): BrowserRuntimeState => ({
    cdp_port: status === "running" ? 5100 : -1,
    profile_id: profileId,
    status
  });

  return {
    calls,
    activeCdpSessionCount: () => options.activeCdpSessionCount ?? 0,
    activeManualViewerCount: () => options.activeManualViewerCount ?? 0,
    cdpSessionObservations: () =>
      options.activeCdpSessionCount
        ? [
            {
              duration_ms: 1250,
              remote_address: "203.0.113.10",
              started_at: "2026-01-01T00:00:00.000Z",
              user_agent: "Playwright"
            }
          ]
        : [],
    lastManualInputAt: () => options.lastManualInputAt ?? null,
    deleteProfile: async (_id, removeData) => {
      await removeData();
    },
    cleanupOwnedProcessesOnStartup: async () => undefined,
    openCdpSession: () => ({
      close: () => undefined,
      recordMessage: () => undefined
    }),
    openManualViewer: async (profileId) => {
      calls.push(`viewer:${profileId}`);
      if (options.viewerError) {
        throw options.viewerError;
      }

      return {
        display: ":100",
        profile_id: profileId,
        vnc_port: 5900,
        vnc_ws_path: `/ui/profiles/${profileId}/vnc`
      };
    },
    openManualViewerSession: () => ({
      close: () => undefined,
      recordInput: () => undefined
    }),
    recordCdpDiscovery: () => undefined,
    readManualClipboard: async (profileId) => {
      calls.push(`read-clipboard:${profileId}`);
      return options.manualClipboardText ?? "";
    },
    restart: async (profileId) => {
      calls.push(`restart:${profileId}`);
      return state(profileId, "running");
    },
    shutdown: async () => undefined,
    start: async (profileId) => {
      calls.push(`start:${profileId}`);
      if (options.startError) {
        throw options.startError;
      }

      return state(profileId, "running");
    },
    stop: async (profileId, reason = "manual stop") => {
      calls.push(`stop:${profileId}:${reason}`);
      return state(profileId, "stopped");
    },
    spinDownIdleInstances: async () => [],
    writeManualClipboard: async (profileId, text) => {
      calls.push(`clipboard:${profileId}:${text}`);
    }
  };
}

function fakeUpgradeServer(): CloakHubUpgradeServer & {
  upgrades: CloakHubWebSocketData[];
} {
  const upgrades: CloakHubWebSocketData[] = [];

  return {
    upgrades,
    upgrade: (_request, options) => {
      upgrades.push(options.data);
      return true;
    }
  };
}

function jsonRequest(
  url: string,
  method: string,
  body: unknown,
  cookie?: string
): Request {
  return new Request(url, {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {})
    },
    method
  });
}

function sequenceTokens(...tokens: string[]): () => string {
  let index = 0;
  return () => tokens[index++] ?? tokens.at(-1) ?? "profile-token";
}

function killProcessGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The test process may have already exited.
    }
  }
}

function bootstrap(html: string): { profiles: Array<Record<string, any>> } {
  return JSON.parse(
    /<script id="bootstrap" type="application\/json">([\s\S]*?)<\/script>/.exec(
      html
    )![1]!
  );
}
