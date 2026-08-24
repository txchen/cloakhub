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
import {
  createBrowserProxyRuntime,
  type BrowserProxyRuntime,
  type BrowserProxySession
} from "./proxy-runtime";

export interface BunBrowserProcessLauncherOptions {
  dataRoot: string;
  ownedProcesses?: OwnedProcessRegistry;
  proxyRuntime?: BrowserProxyRuntime;
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
  const proxyRuntime = options.proxyRuntime ?? createBrowserProxyRuntime();

  return {
    async launch(command: BrowserLaunchCommand): Promise<BrowserProcessHandle> {
      await mkdir(command.userDataDir, { recursive: true });
      await ownedProcesses.cleanupOwnedProcesses([command.profileId], { kinds: ["browser"] });
      await removeStaleChromiumSingletonLocks(command.userDataDir);

      const proxySession = await proxyRuntime.prepare(command.proxy);
      let subprocess: BrowserSubprocess;
      try {
        subprocess = spawn(browserCommand(command, proxySession.browserUrl), {
          detached: true,
          env: ownedProcesses.env(command.profileId, {
            ...process.env,
            ...(command.display ? { DISPLAY: command.display } : {})
          }),
          stderr: "inherit",
          stdin: "ignore",
          stdout: "ignore"
        }) as BrowserSubprocess;
      } catch (error) {
        await proxySession.close();
        throw error;
      }

      subprocess.unref();

      try {
        await ownedProcesses.writePid(command.profileId, "browser", subprocess.pid);
        await ownedProcesses.writeJson(command.profileId, "launch.json", {
          profile_id: command.profileId,
          user_data_dir: command.userDataDir
        });
      } catch (error) {
        await new OwnedSubprocessHandle(subprocess).kill();
        await proxySession.close();
        throw error;
      }

      void subprocess.exited
        .then(async () => {
          try {
            await proxySession.close();
          } finally {
            await ownedProcesses.removeRuntimeProfile(command.profileId);
          }
        })
        .catch(() => undefined);

      return new ProxyBoundBrowserProcessHandle(subprocess, proxySession);
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

function browserCommand(command: BrowserLaunchCommand, proxyUrl: string): string[] {
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
    ...(proxyUrl ? [`--proxy-server=${proxyUrl}`] : []),
    ...(!command.headless ? ["--disable-gpu", "--disable-dev-shm-usage", "--use-gl=swiftshader"] : []),
    ...(command.headless ? ["--headless=new"] : []),
    ...command.customLaunchArgs
  ];
}

class ProxyBoundBrowserProcessHandle extends OwnedSubprocessHandle {
  constructor(
    subprocess: BrowserSubprocess,
    private readonly proxySession: BrowserProxySession
  ) {
    super(subprocess);
  }

  override async exited(): Promise<void> {
    try {
      await super.exited();
    } finally {
      await this.proxySession.close();
    }
  }

  override async hasExited(): Promise<boolean> {
    const exited = await super.hasExited();
    if (exited) {
      await this.proxySession.close();
    }
    return exited;
  }

  override async kill(): Promise<void> {
    try {
      await super.kill();
    } finally {
      await this.proxySession.close();
    }
  }
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
