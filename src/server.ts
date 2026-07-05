import { createApp } from "./app";
import { resolveBrowserBin } from "./browser-bin";
import { loadConfigFromEnv } from "./config";
import { ensureDataRoot } from "./data-root";

async function main(): Promise<void> {
  try {
    const config = loadConfigFromEnv();
    await ensureDataRoot(config.dataRoot);
    const browserBin = await resolveBrowserBin(config.browserBin);

    const app = createApp({ ...config, browserBin: browserBin.path });
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
