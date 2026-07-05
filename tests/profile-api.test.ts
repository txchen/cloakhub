import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createApp } from "../src/app";
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
});

async function tempApp(overrides: Partial<CloakHubConfig> = {}) {
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

  return { app: createApp(config, { profileService }), dataRoot };
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
