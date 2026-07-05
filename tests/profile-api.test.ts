import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createApp } from "../src/app";
import type { BrowserRuntime, BrowserRuntimeState } from "../src/browser-runtime";
import type { CloakHubConfig } from "../src/config";
import { createProfileService } from "../src/profile-service";
import { openProfileRepository } from "../src/profile-repository";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("Browser Profile admin API", () => {
  test("renders Browser Profile management in the UI shell", async () => {
    const { app } = await tempApp();
    await app.fetch(
      jsonRequest("http://cloakhub.test/api/profiles", "POST", {
        display_name: "Work",
        profile_id: "work"
      })
    );

    const response = await app.fetch(new Request("http://cloakhub.test/"));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('id="create-profile-form"');
    expect(html).toContain('class="profile-update-form"');
    expect(html).toContain('class="profile-delete-button"');
    expect(html).toContain('class="profile-lifecycle-button" data-action="start"');
    expect(html).toContain('class="profile-lifecycle-button" data-action="stop"');
    expect(html).toContain('class="profile-lifecycle-button" data-action="restart"');
    expect(html).toContain("This may disconnect active CDP sessions or viewers.");
    expect(html).toContain('name="proxy"');
    expect(html).toContain('name="fingerprint_seed"');
    expect(html).toContain('name="timezone"');
    expect(html).toContain('name="locale"');
    expect(html).toContain('name="geoip"');
    expect(html).toContain('name="platform"');
    expect(html).toContain('name="screen_width"');
    expect(html).toContain('name="screen_height"');
    expect(html).toContain('name="gpu_vendor"');
    expect(html).toContain('name="gpu_renderer"');
    expect(html).toContain('name="hardware_concurrency"');
    expect(html).toContain('name="user_agent"');
    expect(html).toContain('name="color_scheme"');
    expect(html).toContain('name="humanize"');
    expect(html).toContain('name="human_preset"');
    expect(html).toContain('name="headless"');
    expect(html).toContain('name="clipboard_sync"');
    expect(html).toContain('name="custom_launch_args"');
    expect(html).toContain('name="tags_json"');
    expect(html).toContain("work");
    expect(html).toContain("Work");
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
    expect(await created.json()).toMatchObject({ display_name: "Work", profile_id: "work" });
    expect(await readdir(join(dataRoot, "profiles"))).toEqual(["work"]);

    const list = await app.fetch(new Request("http://cloakhub.test/api/profiles"));
    expect(await list.json()).toEqual([
      expect.objectContaining({ display_name: "Work", profile_id: "work" })
    ]);

    const read = await app.fetch(new Request("http://cloakhub.test/api/profiles/work"));
    expect(await read.json()).toMatchObject({ notes: "daily", profile_id: "work" });

    const updated = await app.fetch(
      jsonRequest("http://cloakhub.test/api/profiles/work", "PATCH", {
        display_name: "Work 2",
        notes: "updated"
      })
    );
    expect(await updated.json()).toMatchObject({ display_name: "Work 2", notes: "updated" });

    const deleted = await app.fetch(
      new Request("http://cloakhub.test/api/profiles/work", { method: "DELETE" })
    );
    expect(deleted.status).toBe(204);
    await expect(readdir(join(dataRoot, "profiles"))).resolves.toEqual([]);
  });

  test("cookie-authenticated UI actions manage Browser Profiles without bearer auth", async () => {
    const { app } = await tempApp({ authToken: "admin-token" });
    const cookie = "cloakhub_auth=admin-token";

    const created = await app.fetch(
      jsonRequest("http://cloakhub.test/ui/profiles", "POST", {
        display_name: "Work",
        profile_id: "work"
      }, cookie)
    );
    expect(created.status).toBe(201);

    const updated = await app.fetch(
      jsonRequest("http://cloakhub.test/ui/profiles/work", "PATCH", {
        display_name: "Work 2"
      }, cookie)
    );
    expect(await updated.json()).toMatchObject({ display_name: "Work 2", profile_id: "work" });

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
      jsonRequest("http://cloakhub.test/api/profiles", "POST", { profile_id: "Work" })
    );
    expect(invalid.status).toBe(400);

    await app.fetch(jsonRequest("http://cloakhub.test/api/profiles", "POST", { profile_id: "work" }));
    const duplicate = await app.fetch(
      jsonRequest("http://cloakhub.test/api/profiles", "POST", { profile_id: "work" })
    );
    expect(duplicate.status).toBe(409);

    const mutable = await app.fetch(
      jsonRequest("http://cloakhub.test/api/profiles/work", "PATCH", { profile_id: "other" })
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
        tags: [{ color: "#1f6feb", name: "client" }],
        notes: "private notes"
      })
    );
    const body = await created.json();
    const htmlResponse = await app.fetch(new Request("http://cloakhub.test/"));
    const html = await htmlResponse.text();

    expect(body.proxy).toBe("http://user:secret@proxy.example:8080");
    expect(repository.get("work")?.proxy).toBe("http://user:secret@proxy.example:8080");
    expect(html).toContain("client");
    expect(html).toContain("private notes");
    expect(html).toContain("http://user:***@proxy.example:8080");
    expect(html).not.toContain("secret");
  });

  test("UI edit preserves stored proxy when the proxy field is left blank", async () => {
    const { app, repository } = await tempApp();
    await app.fetch(
      jsonRequest("http://cloakhub.test/api/profiles", "POST", {
        profile_id: "work",
        proxy: "http://user:secret@proxy.example:8080"
      })
    );

    const updated = await app.fetch(
      jsonRequest("http://cloakhub.test/ui/profiles/work", "PATCH", {
        _include_empty: "true",
        display_name: "Work 2",
        proxy: ""
      })
    );

    expect(updated.status).toBe(200);
    expect(repository.get("work")?.proxy).toBe("http://user:secret@proxy.example:8080");
  });

  test("shows stopped Instance Status and never-sleep Sleep Policy in API and UI", async () => {
    const { app } = await tempApp();
    await app.fetch(
      jsonRequest("http://cloakhub.test/api/profiles", "POST", {
        profile_id: "work",
        sleep_policy: { mode: "never" }
      })
    );

    const apiResponse = await app.fetch(new Request("http://cloakhub.test/api/profiles/work"));
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
    expect(html).toContain("Sleep Policy");
    expect(html).toContain("sleep-policy-badge never-sleep");
  });

  test("profile list polling does not count as Instance Activity", async () => {
    const { app, repository } = await tempApp();
    await app.fetch(jsonRequest("http://cloakhub.test/api/profiles", "POST", { profile_id: "work" }));
    repository.recordActivity("work", "2026-01-01T00:00:00.000Z");
    const before = repository.get("work")?.last_activity_at;

    await app.fetch(new Request("http://cloakhub.test/api/profiles"));

    expect(repository.get("work")?.last_activity_at).toBe(before);
  });

  test("updates Sleep Policy through the admin API", async () => {
    const { app } = await tempApp();
    await app.fetch(jsonRequest("http://cloakhub.test/api/profiles", "POST", { profile_id: "work" }));

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
      new Request("http://cloakhub.test/api/profiles/work/start", { method: "POST" })
    );
    const stopped = await app.fetch(
      new Request("http://cloakhub.test/api/profiles/work/stop", { method: "POST" })
    );
    const restarted = await app.fetch(
      new Request("http://cloakhub.test/api/profiles/work/restart", { method: "POST" })
    );

    expect(await started.json()).toEqual({ profile_id: "work", status: "running" });
    expect(await stopped.json()).toEqual({ profile_id: "work", status: "stopped" });
    expect(await restarted.json()).toEqual({ profile_id: "work", status: "running" });
    expect(browserRuntime.calls).toEqual(["start:work", "stop:work:manual stop", "restart:work"]);
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

  test("shows active CDP Session observations in API and UI status", async () => {
    const browserRuntime = fakeBrowserRuntime({ activeCdpSessionCount: 1 });
    const { app } = await tempApp({}, browserRuntime);
    await app.fetch(jsonRequest("http://cloakhub.test/api/profiles", "POST", { profile_id: "work" }));

    const apiResponse = await app.fetch(new Request("http://cloakhub.test/api/profiles/work"));
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
    expect(html).toContain("CDP Sessions: 1");
    expect(html).toContain("Playwright");
    expect(html).toContain("1s");
  });
});

async function tempApp(overrides: Partial<CloakHubConfig> = {}, browserRuntime?: BrowserRuntime) {
  const dataRoot = await mkdtemp(join(tmpdir(), "cloakhub-profile-api-"));
  cleanupPaths.push(dataRoot);
  const repository = openProfileRepository(dataRoot);
  repository.migrate();
  const profileService = createProfileService({ dataRoot, repository });
  const config: CloakHubConfig = {
    authToken: undefined,
    browserBin: undefined,
    dataRoot,
    host: "127.0.0.1",
    maxRunningInstances: 10,
    port: 7788,
    ...overrides
  };

  return { app: createApp(config, { browserRuntime, profileService }), dataRoot, repository };
}

function fakeBrowserRuntime(options: { activeCdpSessionCount?: number } = {}): BrowserRuntime & { calls: string[] } {
  const calls: string[] = [];
  const state = (profileId: string, status: BrowserRuntimeState["status"]): BrowserRuntimeState => ({
    cdp_port: status === "running" ? 5100 : -1,
    profile_id: profileId,
    status
  });

  return {
    calls,
    activeCdpSessionCount: () => options.activeCdpSessionCount ?? 0,
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
    cleanupOwnedProcessesOnStartup: async () => undefined,
    openCdpSession: () => ({
      close: () => undefined,
      recordMessage: () => undefined
    }),
    recordCdpDiscovery: () => undefined,
    restart: async (profileId) => {
      calls.push(`restart:${profileId}`);
      return state(profileId, "running");
    },
    start: async (profileId) => {
      calls.push(`start:${profileId}`);
      return state(profileId, "running");
    },
    stop: async (profileId, reason = "manual stop") => {
      calls.push(`stop:${profileId}:${reason}`);
      return state(profileId, "stopped");
    },
    spinDownIdleHeadlessInstances: async () => []
  };
}

function jsonRequest(url: string, method: string, body: unknown, cookie?: string): Request {
  return new Request(url, {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {})
    },
    method
  });
}
