import { openEventLog } from "../../src/event-log";
import { mkdtemp, rm } from "node:fs/promises";
import { createApp } from "../../src/app";
import { createBrowserRuntime } from "../../src/browser-runtime";
import { openProfileRepository } from "../../src/profile-repository";
import { createProfileService } from "../../src/profile-service";
const dataRoot = await mkdtemp("/tmp/cloakhub-ui-tests-");
const events = openEventLog(dataRoot);
const repository = openProfileRepository(dataRoot);
repository.migrate();
const profileService = createProfileService({ dataRoot, repository });
function handle() {
  const exit = Promise.withResolvers<void>();
  return {
    close: async () => {
      exit.resolve();
    },
    kill: async () => {
      exit.resolve();
    },
    hasExited: async () => true,
    exited: () => exit.promise
  };
}
const runtime = createBrowserRuntime({
  browserBin: "fixture",
  events,
  dataRoot,
  repository,
  launcher: { launch: async () => handle() },
  displayRuntime: { start: async () => handle() },
  readinessProbe: { waitUntilReady: async () => {} },
  manualReadinessProbe: { waitUntilReady: async () => {} },
  wait: async () => {},
  ownedProcesses: {
    cleanupOwnedProcesses: async () => [],
    ownedProfileIds: async () => [],
    removeRuntimeProfile: async () => {},
    env: () => ({}),
    runtimeProfilePath: (id) => `${dataRoot}/${id}`,
    writePid: async () => {},
    writeJson: async () => {}
  }
});
const app = createApp(
  {
    dataRoot,
    host: "127.0.0.1",
    port: 17790,
    maxRunningInstances: 10,
    authToken: undefined,
    browserBin: undefined
  },
  { profileService, browserRuntime: runtime, events }
);
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 17790,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/__test/cdp/work" && request.method === "POST") {
      runtime.openCdpSession("work");
      return new Response(null, { status: 204 });
    }
    return app.fetch(request);
  }
});
process.on("SIGTERM", () => {
  void runtime.shutdown().finally(async () => {
    server.stop(true);
    repository.close();
    events.close();
    await rm(dataRoot, { recursive: true, force: true });
    process.exit(0);
  });
});
