import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_DISK_CACHE_SIZE_MB } from "./config";
import { LicenseCapacityError, withoutLicenseSecrets, type BrowserLicensePool, type LicenseLease } from "./browser-license";

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
  diskCacheSizeMb?: number;
  macosFontconfigFile?: string;
  licensePool?: BrowserLicensePool;
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
    options.ownedProcesses ??
    createOwnedProcessRegistry({ dataRoot: options.dataRoot });
  const spawn = options.spawn ?? Bun.spawn;
  const proxyRuntime = options.proxyRuntime ?? createBrowserProxyRuntime();

  return {
    async launch(command: BrowserLaunchCommand): Promise<BrowserProcessHandle> {
      await mkdir(command.userDataDir, { recursive: true });
      await ownedProcesses.cleanupOwnedProcesses([command.profileId], {
        kinds: ["browser"]
      });
      await removeStaleChromiumSingletonLocks(command.userDataDir);

      const proxySession = await proxyRuntime.prepare(command.proxy);
      let lease: LicenseLease | undefined;
      let subprocess: BrowserSubprocess;
      try {
        lease = await options.licensePool?.acquire();
        subprocess = spawn(browserCommand(command, proxySession.browserUrl, options.diskCacheSizeMb ?? DEFAULT_DISK_CACHE_SIZE_MB), {
          detached: true,
          env: {
            ...ownedProcesses.env(command.profileId, withoutLicenseSecrets(process.env)),
            ...(command.platform === "macos" && options.macosFontconfigFile
              ? { FONTCONFIG_FILE: options.macosFontconfigFile } : {}),
            ...(lease ? { CLOAKBROWSER_LICENSE_KEY: lease.key } : {}),
            ...(command.display ? { DISPLAY: command.display } : {})
          },
          stderr: "inherit",
          stdin: "ignore",
          stdout: "ignore"
        }) as BrowserSubprocess;
      } catch (error) {
        lease?.release();
        await proxySession.close();
        throw error;
      }

      // Releasing on kill()/close() would allow another launch before actual exit.
      void subprocess.exited.then(() => lease?.release()).catch(() => undefined);

      try {
        subprocess.unref();
        await ownedProcesses.writePid(
          command.profileId,
          "browser",
          subprocess.pid
        );
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
          await proxySession.close();
        })
        .catch(() => undefined);

      return new ProxyBoundBrowserProcessHandle(
        subprocess,
        proxySession,
        command.cdpPort
      );
    }
  };
}

async function removeStaleChromiumSingletonLocks(
  userDataDir: string
): Promise<void> {
  await Promise.all(
    ["SingletonLock", "SingletonSocket", "SingletonCookie"].map((entry) =>
      rm(join(userDataDir, entry), { force: true, recursive: true })
    )
  );
}

function browserCommand(
  command: BrowserLaunchCommand,
  proxyUrl: string,
  diskCacheSizeMb: number
): string[] {
  return [
    command.browserBin,
    `--user-data-dir=${command.userDataDir}`,
    `--disk-cache-size=${diskCacheSizeMb * 1024 * 1024}`,
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${command.cdpPort}`,
    "--no-sandbox",
    "--no-first-run",
    "--restore-last-session",
    "--no-default-browser-check",
    "--window-position=0,0",
    `--window-size=${command.screenWidth},${command.screenHeight}`,
    ...fingerprintArgs(command),
    ...(command.timezone ? [`--fingerprint-timezone=${command.timezone}`] : []),
    ...(command.locale
      ? [
          `--lang=${command.locale}`,
          `--accept-lang=${command.locale}`,
          `--fingerprint-locale=${command.locale}`
        ]
      : []),
    ...(command.colorScheme && command.colorScheme !== "system"
      ? [
          `--blink-settings=preferredColorScheme=${command.colorScheme === "dark" ? 0 : 1}`
        ]
      : []),
    ...(proxyUrl ? [`--proxy-server=${proxyUrl}`] : []),
    // ANGLE's software backend works with the virtual display without a host GPU.
    // Native headless uses a separate display path; do not silently change its mode.
    ...(!command.headless
      ? ["--disable-gpu", "--disable-dev-shm-usage", "--use-gl=angle", "--use-angle=swiftshader"]
      : []),
    ...(command.headless ? ["--headless=new"] : []),
    ...command.customLaunchArgs
  ];
}

class ProxyBoundBrowserProcessHandle extends OwnedSubprocessHandle {
  constructor(
    private readonly browserProcess: BrowserSubprocess,
    private readonly proxySession: BrowserProxySession,
    private readonly cdpPort: number
  ) {
    super(browserProcess);
  }

  exitError(): Error | undefined {
    const messages: Record<number, string> = {
      76: "CloakBrowser rejected the session: license concurrency limit reached",
      77: "CloakBrowser rejected the license: missing, invalid, or expired key",
      78: "CloakBrowser license validation unavailable; retry later"
    };
    const code = this.browserProcess.exitCode;
    const message = messages[code ?? -1];
    if (!message) return undefined;
    return code === 76 || code === 78 ? new LicenseCapacityError(message) : new Error(message);
  }

  override async close(): Promise<void> {
    if (await this.hasExited()) return;
    try {
      await closeBrowserOverCdp(this.cdpPort);
    } catch {
      await super.close();
    }
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
    command.fingerprintSeed
      ? `--fingerprint=${command.fingerprintSeed}`
      : undefined,
    command.platform ? `--fingerprint-platform=${command.platform}` : undefined,
    command.gpuVendor
      ? `--fingerprint-gpu-vendor=${command.gpuVendor}`
      : undefined,
    command.gpuRenderer
      ? `--fingerprint-gpu-renderer=${command.gpuRenderer}`
      : undefined,
    Number.isInteger(command.hardwareConcurrency)
      ? `--fingerprint-hardware-concurrency=${command.hardwareConcurrency}`
      : undefined,
    `--fingerprint-screen-width=${command.screenWidth}`,
    `--fingerprint-screen-height=${command.screenHeight}`,
    command.userAgent ? `--user-agent=${command.userAgent}` : undefined
  ].filter((arg): arg is string => arg !== undefined);
}

// Browser.close lets Chromium flush cookies and local storage; SIGTERM is only a fallback.
async function closeBrowserOverCdp(port: number): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
    signal: AbortSignal.timeout(1000)
  });
  if (!response.ok)
    throw new Error("Browser CDP discovery unavailable during stop");
  const version = (await response.json()) as { webSocketDebuggerUrl: string };
  const target = new URL(version.webSocketDebuggerUrl);
  target.hostname = "127.0.0.1";
  target.port = String(port);
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(target);
    let sent = false;
    const timeout = setTimeout(
      () => finish(new Error("Browser close timed out")),
      1000
    );
    function finish(error?: Error) {
      clearTimeout(timeout);
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      socket.close();
      error ? reject(error) : resolve();
    }
    socket.onopen = () => {
      sent = true;
      socket.send(JSON.stringify({ id: 1, method: "Browser.close" }));
    };
    socket.onmessage = (event) => {
      try {
        const result = JSON.parse(String(event.data));
        if (result.id === 1)
          finish(
            result.error ? new Error("Browser rejected close") : undefined
          );
      } catch {
        finish(new Error("Invalid browser close response"));
      }
    };
    socket.onclose = () =>
      finish(sent ? undefined : new Error("Browser close connection failed"));
    socket.onerror = () => finish(new Error("Browser close connection failed"));
  });
}
