import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { createKasmVncDisplayRuntime, resolveKasmVncBin } from "../src/display-runtime";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("KasmVncDisplayRuntime", () => {
  test("discovers Xvnc on PATH without making startup fail when missing", async () => {
    const xvncBin = await fakeExecutable("Xvnc");

    await expect(resolveKasmVncBin({ pathEnv: dirname(xvncBin) })).resolves.toEqual({
      path: xvncBin,
      warning: null
    });
    await expect(resolveKasmVncBin({ pathEnv: delimiter })).resolves.toEqual({
      path: undefined,
      warning: "Missing KasmVNC Xvnc display runtime. Headed Browser Instances will fail until Xvnc is installed."
    });
  });

  test("launches one private Xvnc display runtime per headed Browser Instance", async () => {
    const dataRoot = await tempDataRoot();
    const spawn = fakeSpawn();
    const runtime = createKasmVncDisplayRuntime({
      dataRoot,
      spawn: spawn.fn,
      xvncBin: "/usr/bin/Xvnc"
    });

    await runtime.start({
      displayNumber: 100,
      profileId: "work",
      screenHeight: 1080,
      screenWidth: 1920,
      vncPort: 5900
    });

    expect(spawn.commands[0]).toEqual([
      "/usr/bin/Xvnc",
      ":100",
      "-ac",
      "-localhost",
      "-rfbport",
      "5900",
      "-geometry",
      "1920x1080",
      "-SecurityTypes",
      "None",
      "-DisableBasicAuth",
      "1",
      "-noWebsocket",
      "-publicIP",
      "127.0.0.1"
    ]);
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
  });
});

function fakeSpawn(): {
  commands: string[][];
  fn: typeof Bun.spawn;
  options: Array<Record<string, unknown>>;
} {
  const commands: string[][] = [];
  const options: Array<Record<string, unknown>> = [];
  let nextPid = 2001;

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
