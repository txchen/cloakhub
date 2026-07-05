import { createApp, type CloakHubWebSocketData } from "./app";
import { resolveBrowserBin } from "./browser-bin";
import { createBunBrowserProcessLauncher } from "./browser-process-launcher";
import { createBrowserRuntime } from "./browser-runtime";
import { createCdpGateway, createProfileCdpAccessPolicy } from "./cdp-gateway";
import { createCdpWebSocketHandler, type CdpWebSocketData } from "./cdp-websocket-proxy";
import { createXclipClipboardWriter } from "./clipboard-writer";
import { loadConfigFromEnv } from "./config";
import { ensureDataRoot } from "./data-root";
import { createKasmVncDisplayRuntime, resolveKasmVncBin } from "./display-runtime";
import { openProfileRepository } from "./profile-repository";
import { createProfileService } from "./profile-service";
import { createVncWebSocketHandler, type VncWebSocketData } from "./vnc-websocket-proxy";

async function main(): Promise<void> {
  try {
    const config = loadConfigFromEnv();
    await ensureDataRoot(config.dataRoot);
    const browserBin = await resolveBrowserBin(config.browserBin);
    const kasmVncBin = await resolveKasmVncBin();
    if (kasmVncBin.warning) {
      console.warn(kasmVncBin.warning);
    }
    const profileRepository = openProfileRepository(config.dataRoot);
    profileRepository.migrate();
    const profileService = createProfileService({
      dataRoot: config.dataRoot,
      repository: profileRepository
    });
    const browserRuntime = createBrowserRuntime({
      browserBin: browserBin.path,
      clipboardWriter: createXclipClipboardWriter(),
      dataRoot: config.dataRoot,
      displayRuntime: createKasmVncDisplayRuntime({
        dataRoot: config.dataRoot,
        xvncBin: kasmVncBin.path
      }),
      launcher: createBunBrowserProcessLauncher({ dataRoot: config.dataRoot }),
      repository: profileRepository
    });
    await browserRuntime.cleanupOwnedProcessesOnStartup();
    const cdpGateway = createCdpGateway({
      accessPolicy: createProfileCdpAccessPolicy(profileService),
      browserRuntime,
      cdpTokensForRedaction: () => profileService.cdpTokensForRedaction()
    });
    const idleTimer = setInterval(() => {
      void browserRuntime.spinDownIdleInstances();
    }, 5000);
    idleTimer.unref();

    const app = createApp(
      { ...config, browserBin: browserBin.path },
      { browserRuntime, cdpGateway, profileService }
    );
    const cdpWebSocketHandler = createCdpWebSocketHandler({ cdpSessions: browserRuntime });
    const vncWebSocketHandler = createVncWebSocketHandler({ manualViewers: browserRuntime });

    Bun.serve<CloakHubWebSocketData>({
      fetch: (request, server) => app.fetch(request, server),
      hostname: config.host,
      port: config.port,
      websocket: {
        close(ws, code, reason): void {
          if (isVncWebSocketData(ws.data)) {
            vncWebSocketHandler.close?.(ws as Bun.ServerWebSocket<VncWebSocketData>, code, reason);
            return;
          }

          cdpWebSocketHandler.close?.(ws as Bun.ServerWebSocket<CdpWebSocketData>, code, reason);
        },
        message(ws, message): void {
          if (isVncWebSocketData(ws.data)) {
            vncWebSocketHandler.message?.(ws as Bun.ServerWebSocket<VncWebSocketData>, message);
            return;
          }

          cdpWebSocketHandler.message?.(ws as Bun.ServerWebSocket<CdpWebSocketData>, message);
        },
        open(ws): void {
          if (isVncWebSocketData(ws.data)) {
            vncWebSocketHandler.open?.(ws as Bun.ServerWebSocket<VncWebSocketData>);
            return;
          }

          cdpWebSocketHandler.open?.(ws as Bun.ServerWebSocket<CdpWebSocketData>);
        }
      }
    });

    console.log(`CloakHub listening on http://${config.host}:${config.port}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

await main();

function isVncWebSocketData(data: CloakHubWebSocketData): data is VncWebSocketData {
  return "targetPort" in data;
}
