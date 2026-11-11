import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { tmpdir } from "node:os";

import {
  createVoxlDisplayRuntime,
  resolveDisplayRuntimeBins,
  streamerCommand,
  xvfbCommand
} from "../src/display-runtime";
import { VIEWER_STREAM_PRESETS, type ViewerStreamSettings } from "../src/viewer-settings";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

const command = {
  displayNumber: 100,
  profileId: "work",
  screenHeight: 1080,
  screenWidth: 1920,
  vncPort: 5900
};

describe("VoxlDisplayRuntime", () => {
  test("discovers Xvfb and voxl without making startup fail when missing", async () => {
    const xvfbBin = await fakeExecutable("Xvfb");
    const voxlBin = join(dirname(xvfbBin), "voxl");
    await writeFile(voxlBin, "#!/bin/sh\nexit 0\n");
    await chmod(voxlBin, 0o755);

    await expect(
      resolveDisplayRuntimeBins({ pathEnv: dirname(xvfbBin), voxlBin: "/missing", xvfbBin: "/missing" })
    ).resolves.toMatchObject({ voxl: expect.any(String), warning: null, xvfb: expect.any(String) });
    await expect(
      resolveDisplayRuntimeBins({ pathEnv: delimiter, voxlBin: "/missing/voxl", xvfbBin })
    ).resolves.toMatchObject({
      warning: "Missing Xvfb or voxl display runtime. Headed Browser Instances will fail until both are installed."
    });
  });

  test("launches a private Xvfb display and a voxl streamer per headed Browser Instance", async () => {
    const dataRoot = await tempDataRoot();
    const spawn = fakeSpawn();
    const runtime = createVoxlDisplayRuntime({
      dataRoot,
      spawn: spawn.fn,
      voxlBin: "/usr/local/bin/voxl",
      waitForDisplay: async () => undefined,
      xRoot: dataRoot,
      xvfbBin: "/usr/bin/Xvfb"
    });

    await runtime.start(command);

    expect(spawn.commands[0]).toEqual([
      "/usr/bin/Xvfb", ":100", "-screen", "0", "1920x1080x24", "-dpi", "96",
      "-nolisten", "tcp", "-ac", "-shmem", "-noreset", "-extension", "GLX"
    ]);
    expect(spawn.commands[1]).toEqual([
      "/usr/local/bin/voxl",
      "--addr=127.0.0.1",
      "--port=5900",
      "--enable-basic-auth=false",
      "--title=CloakHub Viewer",
      "--enable-clipboard=true",
      "--enable-resize=false",
      "--audio-enabled=false",
      "--microphone-enabled=false",
      "--file-transfers=none",
      "--max-kbps=4000",
      "--min-kbps=2000",
      "--framerate=60",
      "--crf=25"
    ]);
    for (const options of spawn.options) {
      expect(options).toMatchObject({
        detached: true,
        env: { CLOAKHUB_DATA_ROOT: dataRoot, CLOAKHUB_PROFILE_ID: "work" }
      });
    }
    expect(spawn.options[1]!.env).toMatchObject({ DISPLAY: ":100" });
    const runtimePath = join(dataRoot, "runtime", "work");
    expect((await readFile(join(runtimePath, "display.pid"), "utf8")).trim()).toBe("2001");
    expect((await readFile(join(runtimePath, "streamer.pid"), "utf8")).trim()).toBe("2002");
  });

  test("restarts running streamers with the current stream settings, keeping the display", async () => {
    const dataRoot = await tempDataRoot();
    const spawn = fakeSpawn();
    let settings: ViewerStreamSettings = VIEWER_STREAM_PRESETS.high;
    const runtime = createVoxlDisplayRuntime({
      dataRoot,
      spawn: spawn.fn,
      streamSettings: () => settings,
      voxlBin: "/usr/local/bin/voxl",
      waitForDisplay: async () => undefined,
      xRoot: dataRoot,
      xvfbBin: "/usr/bin/Xvfb"
    });
    await runtime.start(command);
    expect(spawn.commands[1]).toContain("--max-kbps=15000");

    settings = VIEWER_STREAM_PRESETS["data-saver"];
    const killed: number[] = [];
    const originalKill = process.kill;
    process.kill = ((pid: number) => {
      killed.push(pid);
      spawn.exit(Math.abs(pid));
      return true;
    }) as typeof process.kill;
    try {
      await runtime.restartStreams();
    } finally {
      process.kill = originalKill;
    }
    await Bun.sleep(20);

    expect(killed.map(Math.abs)).toEqual([2002]);
    expect(spawn.commands).toHaveLength(3);
    expect(spawn.commands[2]).toContain("--max-kbps=1250");
    expect(spawn.commands[2]).toContain("--framerate=30");
  });

  test("turns voxl clipboard sync off when the profile disables it", () => {
    expect(
      streamerCommand("/usr/local/bin/voxl", { ...command, clipboardSync: false })
    ).toContain("--enable-clipboard=false");
    expect(xvfbCommand("/usr/bin/Xvfb", { ...command, screenWidth: 1440, screenHeight: 900 })).toContain(
      "1440x900x24"
    );
  });
});

function fakeSpawn(): {
  commands: string[][];
  exit(pid: number): void;
  fn: typeof Bun.spawn;
  options: Array<Record<string, any>>;
} {
  const commands: string[][] = [];
  const options: Array<Record<string, any>> = [];
  const exits = new Map<number, { process: { exitCode: number | null }; resolve: (code: number) => void }>();
  let nextPid = 2001;

  return {
    commands,
    options,
    exit(pid) {
      const entry = exits.get(pid);
      if (!entry || entry.process.exitCode !== null) return;
      entry.process.exitCode = 0;
      entry.resolve(0);
    },
    fn: ((command: string[], spawnOptions: Record<string, unknown>) => {
      commands.push(command);
      options.push(spawnOptions);
      let resolve!: (code: number) => void;
      const exited = new Promise<number>((done) => (resolve = done));
      const pid = nextPid++;
      const process = {
        exitCode: null as number | null,
        exited,
        kill: () => undefined,
        pid,
        unref: () => undefined
      };
      exits.set(pid, { process, resolve });
      return process;
    }) as unknown as typeof Bun.spawn
  };
}

async function fakeExecutable(name: string): Promise<string> {
  const directory = await tempDataRoot();
  const executable = join(directory, name);

  await writeFile(executable, "#!/bin/sh\nexit 0\n");
  await chmod(executable, 0o755);

  return executable;
}

async function tempDataRoot(): Promise<string> {
  const dataRoot = await mkdtemp(join(tmpdir(), "cloakhub-display-runtime-"));
  cleanupPaths.push(dataRoot);
  return dataRoot;
}
