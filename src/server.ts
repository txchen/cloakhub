import { createApp } from "./app";
import { resolveBrowserBin } from "./browser-bin";
import { createBunBrowserProcessLauncher } from "./browser-process-launcher";
import { createBrowserRuntime } from "./browser-runtime";
import { createCdpGateway, createProfileCdpAccessPolicy } from "./cdp-gateway";
import { createCdpWebSocketHandler, type CdpWebSocketData } from "./cdp-websocket-proxy";
import { loadConfigFromEnv } from "./config";
import { ensureDataRoot } from "./data-root";
import { openProfileRepository } from "./profile-repository";
import { createProfileService } from "./profile-service";

async function main(): Promise<void> {
  try {
    const config = loadConfigFromEnv();
    await ensureDataRoot(config.dataRoot);
    const browserBin = await resolveBrowserBin(config.browserBin);
    const profileRepository = openProfileRepository(config.dataRoot);
    profileRepository.migrate();
    const profileService = createProfileService({
      dataRoot: config.dataRoot,
      repository: profileRepository
    });
    const browserRuntime = createBrowserRuntime({
      browserBin: browserBin.path,
      dataRoot: config.dataRoot,
      launcher: createBunBrowserProcessLauncher({ dataRoot: config.dataRoot }),
      repository: profileRepository
    });
    await browserRuntime.cleanupOwnedProcessesOnStartup();
    const cdpGateway = createCdpGateway({
      accessPolicy: createProfileCdpAccessPolicy(profileService),
      browserRuntime
    });
    const idleTimer = setInterval(() => {
      void browserRuntime.spinDownIdleHeadlessInstances();
    }, 5000);
    idleTimer.unref();

    const app = createApp(
      { ...config, browserBin: browserBin.path },
      { browserRuntime, cdpGateway, profileService }
    );
    Bun.serve<CdpWebSocketData>({
      fetch: (request, server) => app.fetch(request, server),
      hostname: config.host,
      port: config.port,
      websocket: createCdpWebSocketHandler({ cdpSessions: browserRuntime })
    });

    console.log(`CloakHub listening on http://${config.host}:${config.port}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

await main();
