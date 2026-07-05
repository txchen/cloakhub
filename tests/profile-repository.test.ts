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
});

async function tempDataRoot(): Promise<string> {
  const dataRoot = await mkdtemp(join(tmpdir(), "cloakhub-profiles-"));
  cleanupPaths.push(dataRoot);
  return dataRoot;
}
