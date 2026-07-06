import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import type {
  BrowserLaunchCommand,
  BrowserProcessHandle,
  BrowserProcessLauncher
} from "./browser-runtime";
import {
  createOwnedProcessRegistry,
  OwnedSubprocessHandle,
  type OwnedProcessRegistry
} from "./owned-process";

export interface BunBrowserProcessLauncherOptions {
  dataRoot: string;
  ownedProcesses?: OwnedProcessRegistry;
  spawn?: typeof Bun.spawn;
}

type BrowserSubprocess = Pick<
  Bun.NullSubprocess,
  "exitCode" | "exited" | "kill" | "pid" | "unref"
>;

export function createBunBrowserProcessLauncher(
  options: BunBrowserProcessLauncherOptions
): BrowserProcessLauncher {
  const ownedProcesses =
    options.ownedProcesses ?? createOwnedProcessRegistry({ dataRoot: options.dataRoot });
  const spawn = options.spawn ?? Bun.spawn;

  return {
    async launch(command: BrowserLaunchCommand): Promise<BrowserProcessHandle> {
      await mkdir(command.userDataDir, { recursive: true });
      await ownedProcesses.cleanupOwnedProcesses([command.profileId], { kinds: ["browser"] });
      await removeStaleChromiumSingletonLocks(command.userDataDir);

      const subprocess = spawn(browserCommand(command), {
        detached: true,
        env: ownedProcesses.env(command.profileId, {
          ...process.env,
          ...(command.display ? { DISPLAY: command.display } : {})
        }),
        stderr: "inherit",
        stdin: "ignore",
        stdout: "ignore"
      }) as BrowserSubprocess;
      subprocess.unref();

      try {
        await ownedProcesses.writePid(command.profileId, "browser", subprocess.pid);
        await ownedProcesses.writeJson(command.profileId, "launch.json", {
          profile_id: command.profileId,
          user_data_dir: command.userDataDir
        });
      } catch (error) {
        await new OwnedSubprocessHandle(subprocess).kill();
        throw error;
      }

      void subprocess.exited
        .then(async () => {
          await ownedProcesses.removeRuntimeProfile(command.profileId);
        })
        .catch(() => undefined);

      return new OwnedSubprocessHandle(subprocess);
    }
  };
}

async function removeStaleChromiumSingletonLocks(userDataDir: string): Promise<void> {
  await Promise.all(
    ["SingletonLock", "SingletonSocket", "SingletonCookie"].map((entry) =>
      rm(join(userDataDir, entry), { force: true, recursive: true })
    )
  );
}

function browserCommand(command: BrowserLaunchCommand): string[] {
  return [
    command.browserBin,
    `--user-data-dir=${command.userDataDir}`,
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${command.cdpPort}`,
    "--no-sandbox",
    "--no-first-run",
    "--no-default-browser-check",
    "--window-position=0,0",
    `--window-size=${command.screenWidth},${command.screenHeight}`,
    ...fingerprintArgs(command),
    ...(!command.headless ? ["--disable-gpu", "--disable-dev-shm-usage", "--use-gl=swiftshader"] : []),
    ...(command.headless ? ["--headless=new"] : []),
    ...command.customLaunchArgs
  ];
}

function fingerprintArgs(command: BrowserLaunchCommand): string[] {
  return [
    "--disable-infobars",
    "--test-type",
    command.fingerprintSeed ? `--fingerprint=${command.fingerprintSeed}` : undefined,
    command.platform ? `--fingerprint-platform=${command.platform}` : undefined,
    command.gpuVendor ? `--fingerprint-gpu-vendor=${command.gpuVendor}` : undefined,
    command.gpuRenderer ? `--fingerprint-gpu-renderer=${command.gpuRenderer}` : undefined,
    Number.isInteger(command.hardwareConcurrency)
      ? `--fingerprint-hardware-concurrency=${command.hardwareConcurrency}`
      : undefined,
    `--fingerprint-screen-width=${command.screenWidth}`,
    `--fingerprint-screen-height=${command.screenHeight}`,
    command.userAgent ? `--user-agent=${command.userAgent}` : undefined
  ].filter((arg): arg is string => arg !== undefined);
}
