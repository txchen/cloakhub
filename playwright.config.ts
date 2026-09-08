import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";
export default defineConfig({
  testDir: "./tests/ui",
  testMatch: "**/*.browser.ts",
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:17790",
    viewport: { width: 1440, height: 1000 },
    headless: true,
    launchOptions: {
      executablePath:
        process.env.CLOAKHUB_TEST_BROWSER ??
        (existsSync("/opt/google/chrome/chrome")
          ? "/opt/google/chrome/chrome"
          : undefined)
    },
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  webServer: {
    command: "bun tests/ui/server.ts",
    url: "http://127.0.0.1:17790/api/health",
    reuseExistingServer: false
  },
  reporter: "list"
});
