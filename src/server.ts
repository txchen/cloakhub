import { openEventLog } from "./event-log";
import { createApp, type CloakHubWebSocketData } from "./app";
import { prepareBrowserBinary } from "./browser-install";
import { createBrowserLicensePool, loadBrowserLicenseKeys } from "./browser-license";
import { createBunBrowserProcessLauncher } from "./browser-process-launcher";
import { createBrowserRuntime, type BrowserRuntime } from "./browser-runtime";
import { createCdpGateway, createProfileCdpAccessPolicy } from "./cdp-gateway";
import { createCdpClipboardReader } from "./cdp-clipboard-reader";
import {
  createCdpWebSocketHandler,
  type CdpWebSocketData
} from "./cdp-websocket-proxy";
import { createXclipClipboardWriter } from "./clipboard-writer";
import { loadConfigFromEnv } from "./config";
import { ensureDataRoot } from "./data-root";
import {
  createKasmVncDisplayRuntime,
  resolveKasmVncBin
} from "./display-runtime";
import { openProfileRepository } from "./profile-repository";
import { createProfileService } from "./profile-service";
import {
  createVncWebSocketHandler,
  type VncWebSocketData
} from "./vnc-websocket-proxy";

export interface CloakHubServerHandle {
  shutdown(signal?: NodeJS.Signals): Promise<void>;
}

export async function startCloakHubServer(): Promise<CloakHubServerHandle> {
  const config = loadConfigFromEnv();
  await ensureDataRoot(config.dataRoot);
  const licenseKeys = await loadBrowserLicenseKeys();
  const browserBin = await prepareBrowserBinary({
    browserBin: config.browserBin,
    dataRoot: config.dataRoot,
    licenseKeys,
    installer: process.env.CLOAKHUB_BROWSER_INSTALLER,
    version: process.env.CLOAKHUB_BROWSER_VERSION
  });
  const licensePool = licenseKeys.length ? await createBrowserLicensePool(licenseKeys) : undefined;
  const maxRunningInstances = Math.min(config.maxRunningInstances, licensePool?.capacity ?? Infinity);
  if (licensePool) console.log(`CloakBrowser: ${licenseKeys.length} configured key(s), ${licensePool.capacity} licensed slots; Hub limit ${maxRunningInstances}`);
  const kasmVncBin = await resolveKasmVncBin();
  if (kasmVncBin.warning) {
    console.warn(kasmVncBin.warning);
  }
  const events = openEventLog(config.dataRoot);
  const profileRepository = openProfileRepository(config.dataRoot);
  profileRepository.migrate();
  const profileService = createProfileService({
    creationRegion: config.creationRegion,
    dataRoot: config.dataRoot,
    repository: profileRepository
  });
  const browserRuntime = createBrowserRuntime({
    browserBin: browserBin.path,
    events,
    clipboardReader: createCdpClipboardReader(),
    clipboardWriter: createXclipClipboardWriter(),
    dataRoot: config.dataRoot,
    displayRuntime: createKasmVncDisplayRuntime({
      dataRoot: config.dataRoot,
      xvncBin: kasmVncBin.path
    }),
    launcher: createBunBrowserProcessLauncher({ dataRoot: config.dataRoot, licensePool }),
    maxRunningInstances,
    repository: profileRepository
  });
  await browserRuntime.cleanupOwnedProcessesOnStartup();
  const cdpGateway = createCdpGateway({
    accessPolicy: createProfileCdpAccessPolicy(profileService),
    browserRuntime,
    cdpTokensForRedaction: () => profileService.cdpTokensForRedaction()
  });
  const idleTimer = setInterval(() => {
    void browserRuntime.spinDownIdleInstances().catch(() => {
      events.record({
        profile_id: null,
        type: "sleep.check_failed",
        level: "error",
        message: "Idle check failed."
      });
    });
  }, 5000);
  idleTimer.unref();

  const app = createApp(
    { ...config, browserBin: browserBin.path },
    { browserRuntime, cdpGateway, profileService, events }
  );
  const cdpWebSocketHandler = createCdpWebSocketHandler({
    cdpSessions: browserRuntime,
    onBlankTab: (profileId) =>
      events.record({
        profile_id: profileId,
        type: "tab.protected",
        message: "Created an empty tab before closing the last tab."
      })
  });
  const vncWebSocketHandler = createVncWebSocketHandler({
    manualViewers: browserRuntime,
    clipboardSyncEnabled: (id) =>
      profileService.getProfile(id)?.clipboard_sync ?? false
  });

  const server = Bun.serve<CloakHubWebSocketData>({
    fetch: (request, server_) => app.fetch(request, server_),
    hostname: config.host,
    port: config.port,
    websocket: {
      close(ws, code, reason): void {
        if (isVncWebSocketData(ws.data)) {
          vncWebSocketHandler.close?.(
            ws as Bun.ServerWebSocket<VncWebSocketData>,
            code,
            reason
          );
          return;
        }

        cdpWebSocketHandler.close?.(
          ws as Bun.ServerWebSocket<CdpWebSocketData>,
          code,
          reason
        );
      },
      message(ws, message): void {
        if (isVncWebSocketData(ws.data)) {
          vncWebSocketHandler.message?.(
            ws as Bun.ServerWebSocket<VncWebSocketData>,
            message
          );
          return;
        }

        cdpWebSocketHandler.message?.(
          ws as Bun.ServerWebSocket<CdpWebSocketData>,
          message
        );
      },
      open(ws): void {
        if (isVncWebSocketData(ws.data)) {
          vncWebSocketHandler.open?.(
            ws as Bun.ServerWebSocket<VncWebSocketData>
          );
          return;
        }

        cdpWebSocketHandler.open?.(ws as Bun.ServerWebSocket<CdpWebSocketData>);
      }
    }
  });

  events.record({
    profile_id: null,
    type: "hub.started",
    message: "CloakHub started; idle checks run every 5 seconds."
  });

  console.log(`CloakHub listening on http://${config.host}:${config.port}`);

  return createShutdownHandle({
    browserRuntime,
    closeRepository: () => {
      profileRepository.close();
      events.close();
    },
    idleTimer,
    stopServer: () => server.stop(true)
  });
}

export function createShutdownHandle(options: {
  browserRuntime: Pick<BrowserRuntime, "shutdown">;
  closeRepository: () => void;
  idleTimer: Timer;
  stopServer: () => void;
}): CloakHubServerHandle {
  let shutdownPromise: Promise<void> | undefined;

  return {
    async shutdown(signal?: NodeJS.Signals): Promise<void> {
      shutdownPromise ??= (async () => {
        if (signal) {
          console.log(
            `CloakHub received ${signal}; shutting down Browser Instances`
          );
        }

        let shutdownError: unknown;
        clearInterval(options.idleTimer);
        try {
          options.stopServer();
        } catch (error) {
          shutdownError = error;
        }

        try {
          await options.browserRuntime.shutdown();
        } catch (error) {
          shutdownError ??= error;
        }

        try {
          options.closeRepository();
        } catch (error) {
          shutdownError ??= error;
        }

        if (shutdownError) {
          throw shutdownError;
        }
      })();

      await shutdownPromise;
    }
  };
}

async function main(): Promise<void> {
  try {
    const server = await startCloakHubServer();
    installShutdownSignalHandlers(server);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

function installShutdownSignalHandlers(server: CloakHubServerHandle): void {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      void server.shutdown(signal).then(
        () => process.exit(0),
        (error) => {
          console.error(error instanceof Error ? error.message : String(error));
          process.exit(1);
        }
      );
    });
  }
}

if (import.meta.main) {
  await main();
}

function isVncWebSocketData(
  data: CloakHubWebSocketData
): data is VncWebSocketData {
  return "targetPort" in data;
}
