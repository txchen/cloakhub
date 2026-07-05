import { createApp } from "./app";
import { resolveBrowserBin } from "./browser-bin";
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

    const app = createApp({ ...config, browserBin: browserBin.path }, { profileService });
    Bun.serve({
      fetch: app.fetch,
      hostname: config.host,
      port: config.port
    });

    console.log(`CloakHub listening on http://${config.host}:${config.port}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

await main();
