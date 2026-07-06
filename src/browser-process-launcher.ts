import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  BrowserLaunchCommand,
  BrowserProcessHandle,
  BrowserProcessLauncher
} from "./browser-runtime";
import { ownedProcessEnv } from "./owned-process";

export interface BunBrowserProcessLauncherOptions {
  dataRoot: string;
  spawn?: typeof Bun.spawn;
  stopGraceMs?: number;
  wait?: (milliseconds: number) => Promise<void>;
}

type BrowserSubprocess = Pick<
  Bun.NullSubprocess,
  "exitCode" | "exited" | "kill" | "pid" | "unref"
>;

export function createBunBrowserProcessLauncher(
  options: BunBrowserProcessLauncherOptions
): BrowserProcessLauncher {
  const spawn = options.spawn ?? Bun.spawn;
  const stopGraceMs = options.stopGraceMs ?? 1500;
  const wait = options.wait ?? Bun.sleep;

  return {
    async cleanupOwnedProcesses(profileIds: string[]): Promise<void> {
      await Promise.all(
        profileIds.map(async (profileId) => {
          const pid = await readOwnedPid(options.dataRoot, profileId);
          if (pid !== undefined) {
            signalProcessGroup(pid, "SIGTERM");
            await wait(stopGraceMs);
            signalProcessGroup(pid, "SIGKILL");
          }

          await rm(runtimeProfilePath(options.dataRoot, profileId), { force: true, recursive: true });
        })
      );
    },

    async launch(command: BrowserLaunchCommand): Promise<BrowserProcessHandle> {
      await mkdir(command.userDataDir, { recursive: true });
      await mkdir(runtimeProfilePath(options.dataRoot, command.profileId), { recursive: true });

      const subprocess = spawn(browserCommand(command), {
        detached: true,
        env: ownedProcessEnv(options.dataRoot, command.profileId, {
          ...process.env,
          ...(command.display ? { DISPLAY: command.display } : {})
        }),
        stderr: "ignore",
        stdin: "ignore",
        stdout: "ignore"
      }) as BrowserSubprocess;
      subprocess.unref();

      try {
        await writeOwnershipFiles(options.dataRoot, command, subprocess.pid);
      } catch (error) {
        signalProcessGroup(subprocess.pid, "SIGKILL");
        throw error;
      }

      void subprocess.exited
        .then(async () => {
          await rm(runtimeProfilePath(options.dataRoot, command.profileId), { force: true, recursive: true });
        })
        .catch(() => undefined);

      return new BunBrowserProcessHandle(subprocess);
    },

    async ownedProfileIds(): Promise<string[]> {
      try {
        const entries = await readdir(runtimeRootPath(options.dataRoot), { withFileTypes: true });
        const profileIds = await Promise.all(
          entries
            .filter((entry) => entry.isDirectory())
            .map(async (entry) =>
              (await readOwnedPid(options.dataRoot, entry.name)) === undefined ? undefined : entry.name
            )
        );

        return profileIds.filter((profileId): profileId is string => profileId !== undefined).sort();
      } catch (error) {
        if (isMissingPathError(error)) {
          return [];
        }

        throw error;
      }
    }
  };
}

class BunBrowserProcessHandle implements BrowserProcessHandle {
  constructor(private readonly subprocess: BrowserSubprocess) {}

  async close(): Promise<void> {
    signalProcessGroup(this.subprocess.pid, "SIGTERM");
  }

  async exited(): Promise<void> {
    await this.subprocess.exited;
  }

  async hasExited(): Promise<boolean> {
    return this.subprocess.exitCode !== null;
  }

  async kill(): Promise<void> {
    signalProcessGroup(this.subprocess.pid, "SIGKILL");
  }
}

function browserCommand(command: BrowserLaunchCommand): string[] {
  return [
    command.browserBin,
    `--user-data-dir=${command.userDataDir}`,
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${command.cdpPort}`,
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

async function writeOwnershipFiles(
  dataRoot: string,
  command: BrowserLaunchCommand,
  pid: number
): Promise<void> {
  const runtimePath = runtimeProfilePath(dataRoot, command.profileId);
  await writeFile(join(runtimePath, "browser.pid"), `${pid}\n`);
  await writeFile(
    join(runtimePath, "launch.json"),
    JSON.stringify(
      {
        profile_id: command.profileId,
        user_data_dir: command.userDataDir
      },
      null,
      2
    )
  );
}

async function readOwnedPid(dataRoot: string, profileId: string): Promise<number | undefined> {
  try {
    const pid = Number((await readFile(join(runtimeProfilePath(dataRoot, profileId), "browser.pid"), "utf8")).trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined;
    }

    throw error;
  }
}

function runtimeRootPath(dataRoot: string): string {
  return join(dataRoot, "runtime");
}

function runtimeProfilePath(dataRoot: string, profileId: string): string {
  return join(runtimeRootPath(dataRoot), profileId);
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // The Owned Process may already have exited between discovery and cleanup.
    }
  }
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
