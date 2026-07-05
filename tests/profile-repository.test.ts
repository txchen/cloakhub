import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { openProfileRepository } from "../src/profile-repository";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("ProfileRepository", () => {
  test("runs SQLite migrations idempotently and persists Browser Profiles", async () => {
    const dataRoot = await tempDataRoot();
    const first = openProfileRepository(dataRoot);
    first.migrate();
    first.migrate();
    first.create({ display_name: "Work", notes: "daily", profile_id: "work" });
    first.close();

    const second = openProfileRepository(dataRoot);
    second.migrate();

    expect(second.list()).toEqual([
      expect.objectContaining({
        display_name: "Work",
        instance_status: "stopped",
        notes: "daily",
        profile_id: "work"
      })
    ]);

    second.close();
  });

  test("keeps Profile IDs immutable on update", async () => {
    const repository = openProfileRepository(await tempDataRoot());
    repository.migrate();
    repository.create({ display_name: "Work", notes: "", profile_id: "work" });

    expect(() =>
      repository.update("work", { display_name: "Personal", profile_id: "personal" })
    ).toThrow("Profile ID is immutable");

    repository.close();
  });

  test("round-trips the supported launch/profile field set", async () => {
    const repository = openProfileRepository(await tempDataRoot());
    repository.migrate();

    repository.create({
      clipboard_sync: false,
      color_scheme: "dark",
      custom_launch_args: ["--disable-webgl"],
      fingerprint_seed: "seed-1",
      geoip: "US",
      gpu_renderer: "Mesa",
      gpu_vendor: "Intel",
      hardware_concurrency: 8,
      headless: true,
      human_preset: "balanced",
      humanize: true,
      locale: "en-US",
      platform: "linux",
      profile_id: "work",
      proxy: "http://user:secret@proxy.example:8080",
      screen_height: 1080,
      screen_width: 1920,
      tags: [{ color: "#1f6feb", name: "client" }],
      timezone: "America/Los_Angeles",
      user_agent: "Mozilla/5.0"
    });

    expect(repository.get("work")).toMatchObject({
      clipboard_sync: false,
      color_scheme: "dark",
      custom_launch_args: ["--disable-webgl"],
      fingerprint_seed: "seed-1",
      proxy: "http://user:secret@proxy.example:8080",
      tags: [{ color: "#1f6feb", name: "client" }]
    });

    repository.close();
  });
});

async function tempDataRoot(): Promise<string> {
  const dataRoot = await mkdtemp(join(tmpdir(), "cloakhub-profiles-"));
  cleanupPaths.push(dataRoot);
  return dataRoot;
}
