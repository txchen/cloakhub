import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createBunBrowserProcessLauncher } from "../src/browser-process-launcher";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("BunBrowserProcessLauncher", () => {
  test("launches CloakBrowser with private CDP, persistent user-data, and ownership markers", async () => {
    const dataRoot = await tempDataRoot();
    const spawn = fakeSpawn();
    const launcher = createBunBrowserProcessLauncher({ dataRoot, spawn: spawn.fn });

    await launcher.launch({
      browserBin: "/opt/cloakbrowser/cloakbrowser",
      cdpPort: 5100,
      customLaunchArgs: ["--lang=en-US"],
      headless: true,
      profileId: "work",
      screenHeight: 1080,
      screenWidth: 1920,
      userDataDir: join(dataRoot, "profiles", "work")
    });

    expect(spawn.commands[0]).toEqual([
      "/opt/cloakbrowser/cloakbrowser",
      `--user-data-dir=${join(dataRoot, "profiles", "work")}`,
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=5100",
      "--no-first-run",
      "--no-default-browser-check",
      "--window-position=0,0",
      "--window-size=1920,1080",
      "--headless=new",
      "--lang=en-US"
    ]);
    expect(spawn.commands[0]).not.toContain("--disable-gpu");
    expect(spawn.options[0]).toMatchObject({
      detached: true,
      env: {
        CLOAKHUB_DATA_ROOT: dataRoot,
        CLOAKHUB_PROFILE_ID: "work"
      },
      stderr: "ignore",
      stdin: "ignore",
      stdout: "ignore"
    });
    expect(await readFile(join(dataRoot, "runtime", "work", "browser.pid"), "utf8")).toBe("1001\n");
    expect(JSON.parse(await readFile(join(dataRoot, "runtime", "work", "launch.json"), "utf8"))).toEqual({
      profile_id: "work",
      user_data_dir: join(dataRoot, "profiles", "work")
    });
    expect(await launcher.ownedProfileIds()).toEqual(["work"]);
  });

  test("launches headed CloakBrowser with display environment and without headless flag", async () => {
    const dataRoot = await tempDataRoot();
    const spawn = fakeSpawn();
    const launcher = createBunBrowserProcessLauncher({ dataRoot, spawn: spawn.fn });

    await launcher.launch({
      browserBin: "/opt/cloakbrowser/cloakbrowser",
      cdpPort: 5100,
      customLaunchArgs: [],
      display: ":100",
      headless: false,
      profileId: "work",
      screenHeight: 900,
      screenWidth: 1600,
      userDataDir: join(dataRoot, "profiles", "work")
    });

    expect(spawn.commands[0]).not.toContain("--headless=new");
    expect(spawn.commands[0]).toContain("--window-position=0,0");
    expect(spawn.commands[0]).toContain("--window-size=1600,900");
    expect(spawn.commands[0]).toContain("--disable-gpu");
    expect(spawn.commands[0]).toContain("--disable-dev-shm-usage");
    expect(spawn.commands[0]).toContain("--use-gl=swiftshader");
    expect(spawn.options[0]?.env).toMatchObject({ DISPLAY: ":100" });
  });


  test("discovers and cleans up only profiles with ownership markers", async () => {
    const dataRoot = await tempDataRoot();
    const waits: number[] = [];
    const launcher = createBunBrowserProcessLauncher({
      dataRoot,
      spawn: fakeSpawn().fn,
      wait: async (milliseconds) => {
        waits.push(milliseconds);
      }
    });

    await launcher.launch({
      browserBin: "/opt/cloakbrowser/cloakbrowser",
      cdpPort: 5100,
      customLaunchArgs: [],
      headless: true,
      profileId: "work",
      screenHeight: 1080,
      screenWidth: 1920,
      userDataDir: join(dataRoot, "profiles", "work")
    });

    await launcher.cleanupOwnedProcesses(await launcher.ownedProfileIds());

    expect(waits).toEqual([1500]);
    await expect(readdir(join(dataRoot, "runtime"))).resolves.toEqual([]);
  });
});

function fakeSpawn(): {
  commands: string[][];
  fn: typeof Bun.spawn;
  options: Array<Record<string, unknown>>;
} {
  const commands: string[][] = [];
  const options: Array<Record<string, unknown>> = [];
  let nextPid = 1001;

  return {
    commands,
    options,
    fn: ((command: string[], spawnOptions: Record<string, unknown>) => {
      commands.push(command);
      options.push(spawnOptions);
      return {
        exitCode: null,
        exited: new Promise<number>(() => undefined),
        kill: () => undefined,
        pid: nextPid++,
        unref: () => undefined
      };
    }) as typeof Bun.spawn
  };
}

async function tempDataRoot(): Promise<string> {
  const dataRoot = await mkdtemp(join(tmpdir(), "cloakhub-browser-launcher-"));
  cleanupPaths.push(dataRoot);
  return dataRoot;
}
