import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  createOwnedProcessRegistry,
  hasOwnedProcessEnvMarker,
  ownedProcessEnv
} from "../src/owned-process";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("OwnedProcessRegistry", () => {
  test("marks Owned Processes with Data Root and Browser Profile identity", async () => {
    const dataRoot = await tempDataRoot();
    const env = ownedProcessEnv(dataRoot, "work", { PATH: "/usr/bin" });

    expect(env).toMatchObject({
      CLOAKHUB_DATA_ROOT: dataRoot,
      CLOAKHUB_PROFILE_ID: "work",
      PATH: "/usr/bin"
    });
    expect(
      hasOwnedProcessEnvMarker(
        `PATH=/usr/bin\0CLOAKHUB_DATA_ROOT=${dataRoot}\0CLOAKHUB_PROFILE_ID=work`,
        dataRoot,
        "work"
      )
    ).toBe(true);
  });

  test("discovers and cleans up browser and display pidfile profiles through one module", async () => {
    const dataRoot = await tempDataRoot();
    const waits: number[] = [];
    const registry = createOwnedProcessRegistry({
      dataRoot,
      wait: async (milliseconds) => {
        waits.push(milliseconds);
      }
    });

    await registry.writePid("headless", "browser", 999991);
    await registry.writePid("headed", "display", 999992);

    expect(await registry.ownedProfileIds()).toEqual(["headed", "headless"]);
    expect(await registry.ownedProfileIds({ kinds: ["browser"] })).toEqual(["headless"]);
    expect(await registry.ownedProfileIds({ kinds: ["display"] })).toEqual(["headed"]);

    await expect(registry.cleanupOwnedProcesses()).resolves.toEqual(["headed", "headless"]);

    expect(waits).toEqual([1500, 1500]);
    await expect(readdir(join(dataRoot, "runtime"))).resolves.toEqual([]);
  });
});

async function tempDataRoot(): Promise<string> {
  const dataRoot = await mkdtemp(join(tmpdir(), "cloakhub-owned-process-"));
  cleanupPaths.push(dataRoot);
  return dataRoot;
}
