import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createProfileService } from "../src/profile-service";
import { openProfileRepository } from "../src/profile-repository";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("ProfileService", () => {
  test("creates Browser Profile metadata and persistent user-data directory", async () => {
    const { dataRoot, service } = await tempService();

    const profile = await service.createProfile({ profile_id: "work" });

    expect(profile).toMatchObject({
      display_name: "work",
      instance_status: "stopped",
      profile_id: "work"
    });
    expect(await readdir(join(dataRoot, "profiles"))).toEqual(["work"]);
  });

  test("deletes user-data before metadata", async () => {
    const { dataRoot, service } = await tempService();
    await service.createProfile({ profile_id: "work" });

    await service.deleteStoppedProfile("work");

    expect(service.getProfile("work")).toBeUndefined();
    await expect(readdir(join(dataRoot, "profiles"))).resolves.toEqual([]);
  });

  test("keeps Browser Profile visible when filesystem cleanup fails", async () => {
    const { service } = await tempService({
      fileStore: {
        removeProfileData: async () => {
          throw new Error("permission denied");
        }
      }
    });
    await service.createProfile({ profile_id: "work" });

    await expect(service.deleteStoppedProfile("work")).rejects.toThrow(
      "Failed to delete Browser Profile data"
    );

    expect(service.getProfile("work")).toMatchObject({
      last_delete_error: "permission denied",
      profile_id: "work"
    });
  });
});

async function tempService(overrides = {}) {
  const dataRoot = await mkdtemp(join(tmpdir(), "cloakhub-profiles-"));
  cleanupPaths.push(dataRoot);
  const repository = openProfileRepository(dataRoot);
  repository.migrate();
  const service = createProfileService({ dataRoot, repository, ...overrides });

  return { dataRoot, service };
}
