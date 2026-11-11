import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  DEFAULT_VIEWER_STREAM_SETTINGS,
  InvalidViewerSettingsError,
  VIEWER_STREAM_PRESETS,
  openViewerSettingsStore,
  parseViewerSettings,
  viewerPresetFor,
  voxlStreamFlags
} from "../src/viewer-settings";

const cleanupPaths: string[] = [];
afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("viewer stream settings", () => {
  test("persists updates, reloads them, and reports changes once", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "cloakhub-viewer-settings-"));
    cleanupPaths.push(dataRoot);
    const changes: unknown[] = [];
    const store = await openViewerSettingsStore({ dataRoot, onChange: (s) => void changes.push(s) });
    expect(store.get()).toEqual(DEFAULT_VIEWER_STREAM_SETTINGS);

    await store.update({ preset: "data-saver" });
    await store.update({ preset: "data-saver" });
    await store.update({ crf: 30 });

    expect(changes).toEqual([
      VIEWER_STREAM_PRESETS["data-saver"],
      { ...VIEWER_STREAM_PRESETS["data-saver"], crf: 30 }
    ]);
    expect(JSON.parse(await readFile(join(dataRoot, "viewer-settings.json"), "utf8"))).toEqual({
      max_kbps: 2500,
      framerate: 30,
      crf: 30
    });
    const reopened = await openViewerSettingsStore({ dataRoot });
    expect(reopened.get()).toEqual({ max_kbps: 2500, framerate: 30, crf: 30 });
    expect(viewerPresetFor(reopened.get())).toBe("custom");
  });

  test("rejects values outside the supported ranges", () => {
    for (const input of [{ max_kbps: 10 }, { framerate: 120 }, { crf: 24.5 }, { preset: "ultra" }, []]) {
      expect(() => parseViewerSettings(input)).toThrow(InvalidViewerSettingsError);
    }
  });

  test("maps settings to voxl flags with a floor below the ceiling", () => {
    expect(voxlStreamFlags(VIEWER_STREAM_PRESETS["data-saver"])).toEqual([
      "--max-kbps=1250",
      "--min-kbps=625",
      "--framerate=30",
      "--crf=28"
    ]);
    expect(voxlStreamFlags({ max_kbps: 300, framerate: 15, crf: 30 })[1]).toBe("--min-kbps=100");
  });
});

describe("viewer settings API", () => {
  test("reads and updates settings with admin auth", async () => {
    const { createApp } = await import("../src/app");
    const dataRoot = await mkdtemp(join(tmpdir(), "cloakhub-viewer-settings-api-"));
    cleanupPaths.push(dataRoot);
    let restarts = 0;
    const viewerSettings = await openViewerSettingsStore({ dataRoot, onChange: () => void restarts++ });
    const app = createApp(
      { authToken: "admin-token", browserBin: undefined, dataRoot, host: "127.0.0.1", licenseMode: "none", maxRunningInstances: 1, port: 7788 },
      { viewerSettings }
    );
    const call = (method: string, body?: unknown, auth = true) =>
      app.fetch(
        new Request("http://cloakhub.test/api/viewer-settings", {
          method,
          headers: {
            ...(auth ? { authorization: "Bearer admin-token" } : {}),
            ...(body ? { "content-type": "application/json" } : {})
          },
          body: body ? JSON.stringify(body) : undefined
        })
      ) as Promise<Response>;

    expect((await call("GET", undefined, false)).status).toBe(401);
    expect(await (await call("GET")).json()).toMatchObject({ preset: "balanced", settings: { max_kbps: 8000 } });
    const updated = await call("PUT", { preset: "data-saver" });
    expect(await updated.json()).toMatchObject({ preset: "data-saver", settings: { framerate: 30 } });
    expect((await call("PUT", { framerate: 0 })).status).toBe(400);
    expect(restarts).toBe(1);
  });
});
