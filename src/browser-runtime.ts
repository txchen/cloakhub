import { join } from "node:path";

import type { BrowserProfile, StopReason } from "./profile";
import type { ProfileRepository } from "./profile-repository";

export interface BrowserLaunchCommand {
  browserBin: string;
  cdpPort: number;
  customLaunchArgs: string[];
  headless: boolean;
  profileId: string;
  userDataDir: string;
}

export interface BrowserProcessHandle {
  close(): Promise<void>;
  exited(): Promise<void>;
  hasExited(): Promise<boolean>;
  kill(): Promise<void>;
}

export interface BrowserProcessLauncher {
  cleanupOwnedProcesses(profileIds: string[]): Promise<void>;
  launch(command: BrowserLaunchCommand): Promise<BrowserProcessHandle>;
  ownedProfileIds(): Promise<string[]>;
}

export interface BrowserClientConnections {
  disconnect(profileId: string, reason: StopReason): Promise<void>;
}

export interface BrowserReadinessProbe {
  waitUntilReady(state: BrowserRuntimeState): Promise<void>;
}

export interface BrowserRuntimeOptions {
  browserBin: string;
  cdpPortStart?: number;
  clientConnections?: BrowserClientConnections;
  dataRoot: string;
  launcher: BrowserProcessLauncher;
  now?: () => Date;
  readinessProbe?: BrowserReadinessProbe;
  repository: ProfileRepository;
  stopGraceMs?: number;
  wait?: (milliseconds: number) => Promise<void>;
}

export interface BrowserRuntimeState {
  cdp_port: number;
  profile_id: string;
  status: BrowserProfile["instance_status"];
}

export interface BrowserRuntimeCdpSession {
  close(): void;
  recordMessage(): void;
}

export interface BrowserRuntime {
  cleanupOwnedProcessesOnStartup(): Promise<void>;
  activeCdpSessionCount(profileId: string): number;
  openCdpSession(profileId: string): BrowserRuntimeCdpSession;
  recordCdpDiscovery(profileId: string): void;
  restart(profileId: string): Promise<BrowserRuntimeState>;
  start(profileId: string): Promise<BrowserRuntimeState>;
  stop(profileId: string, reason?: StopReason): Promise<BrowserRuntimeState>;
}

interface RunningInstance {
  cdpPort: number;
  handle: BrowserProcessHandle;
}

const DEFAULT_STOP_GRACE_MS = 1500;
const DEFAULT_READY_TIMEOUT_MS = 5000;
const DEFAULT_READY_POLL_MS = 100;
const noopClientConnections: BrowserClientConnections = {
  disconnect: async () => undefined
};
const cdpReadinessProbe: BrowserReadinessProbe = {
  async waitUntilReady(state: BrowserRuntimeState): Promise<void> {
    const deadline = Date.now() + DEFAULT_READY_TIMEOUT_MS;
    let lastError = "not ready";

    while (Date.now() <= deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${state.cdp_port}/json/version`);
        if (response.ok) {
          return;
        }

        lastError = `returned ${response.status}`;
      } catch (error) {
        lastError = errorMessage(error);
      }

      await Bun.sleep(DEFAULT_READY_POLL_MS);
    }

    throw new Error(`Browser Instance CDP endpoint was not ready: ${lastError}`);
  }
};

export function createBrowserRuntime(options: BrowserRuntimeOptions): BrowserRuntime {
  const activeCdpSessions = new Map<string, number>();
  const launchAttempts = new Map<string, Promise<BrowserRuntimeState>>();
  const runningInstances = new Map<string, RunningInstance>();
  const clientConnections = options.clientConnections ?? noopClientConnections;
  const now = options.now ?? (() => new Date());
  const readinessProbe = options.readinessProbe ?? cdpReadinessProbe;
  const stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
  const wait = options.wait ?? Bun.sleep;
  let nextCdpPort = options.cdpPortStart ?? 5100;

  return {
    activeCdpSessionCount(profileId: string): number {
      return activeCdpSessions.get(profileId) ?? 0;
    },

    async cleanupOwnedProcessesOnStartup(): Promise<void> {
      const ownedProfileIds = await options.launcher.ownedProfileIds();
      await options.launcher.cleanupOwnedProcesses(ownedProfileIds);
      options.repository.markAllStopped("restart", nowIso(now));
    },

    openCdpSession(profileId: string): BrowserRuntimeCdpSession {
      requireProfile(options.repository, profileId);
      activeCdpSessions.set(profileId, (activeCdpSessions.get(profileId) ?? 0) + 1);
      options.repository.recordActivity(profileId, nowIso(now));
      let closed = false;

      return {
        close(): void {
          if (closed) {
            return;
          }

          closed = true;
          const count = Math.max((activeCdpSessions.get(profileId) ?? 1) - 1, 0);
          if (count === 0) {
            activeCdpSessions.delete(profileId);
            return;
          }

          activeCdpSessions.set(profileId, count);
        },
        recordMessage(): void {
          options.repository.recordActivity(profileId, nowIso(now));
        }
      };
    },

    recordCdpDiscovery(profileId: string): void {
      requireProfile(options.repository, profileId);
      options.repository.recordActivity(profileId, nowIso(now));
    },

    async restart(profileId: string): Promise<BrowserRuntimeState> {
      await this.stop(profileId, "restart");

      return this.start(profileId);
    },

    async start(profileId: string): Promise<BrowserRuntimeState> {
      const profile = requireProfile(options.repository, profileId);
      if (!profile.headless) {
        throw new UnsupportedBrowserProfileError(profile.profile_id);
      }

      const running = runningInstances.get(profile.profile_id);
      if (running) {
        return { cdp_port: running.cdpPort, profile_id: profile.profile_id, status: "running" };
      }

      const launchAttempt = launchAttempts.get(profile.profile_id);
      if (launchAttempt) {
        return launchAttempt;
      }

      const nextLaunchAttempt = launchProfile(profile);
      launchAttempts.set(profile.profile_id, nextLaunchAttempt);

      try {
        return await nextLaunchAttempt;
      } finally {
        launchAttempts.delete(profile.profile_id);
      }
    },

    async stop(profileId: string, reason: StopReason = "manual stop"): Promise<BrowserRuntimeState> {
      const profile = requireProfile(options.repository, profileId);
      const running = runningInstances.get(profile.profile_id);
      const occurredAt = nowIso(now);

      options.repository.markStopping(profile.profile_id);
      options.repository.recordActivity(profile.profile_id, occurredAt);
      await clientConnections.disconnect(profile.profile_id, reason);

      if (running) {
        runningInstances.delete(profile.profile_id);
        await running.handle.close();
        await wait(stopGraceMs);

        if (!(await running.handle.hasExited())) {
          await running.handle.kill();
        }
      }

      options.repository.markStopped(profile.profile_id, reason, nowIso(now));

      return { cdp_port: running?.cdpPort ?? -1, profile_id: profile.profile_id, status: "stopped" };
    }
  };

  async function launchProfile(profile: BrowserProfile): Promise<BrowserRuntimeState> {
    const cdpPort = nextCdpPort++;

    options.repository.markStarting(profile.profile_id);

    try {
      let handle: BrowserProcessHandle | undefined;

      handle = await options.launcher.launch({
        browserBin: options.browserBin,
        cdpPort,
        customLaunchArgs: profile.custom_launch_args,
        headless: true,
        profileId: profile.profile_id,
        userDataDir: join(options.dataRoot, "profiles", profile.profile_id)
      });

      runningInstances.set(profile.profile_id, { cdpPort, handle });
      superviseUnexpectedExit(profile.profile_id, handle);
      const state = { cdp_port: cdpPort, profile_id: profile.profile_id, status: "running" as const };
      try {
        await readinessProbe.waitUntilReady(state);
      } catch (error) {
        await stopLaunchedProcess(profile.profile_id, handle);
        throw error;
      }

      const occurredAt = nowIso(now);
      options.repository.markRunning(profile.profile_id, occurredAt);
      options.repository.recordActivity(profile.profile_id, occurredAt);

      return state;
    } catch (error) {
      runningInstances.delete(profile.profile_id);
      options.repository.markLaunchFailed(profile.profile_id, errorMessage(error), nowIso(now));
      throw error;
    }
  }

  async function stopLaunchedProcess(profileId: string, handle: BrowserProcessHandle): Promise<void> {
    runningInstances.delete(profileId);
    await handle.close();
    await wait(stopGraceMs);

    if (!(await handle.hasExited())) {
      await handle.kill();
    }
  }

  function superviseUnexpectedExit(profileId: string, handle: BrowserProcessHandle): void {
    void handle
      .exited()
      .then(() => {
        const running = runningInstances.get(profileId);
        if (running?.handle !== handle) {
          return;
        }

        runningInstances.delete(profileId);
        options.repository.markStopped(profileId, "crash", nowIso(now));
      })
      .catch(() => undefined);
  }
}

function requireProfile(repository: ProfileRepository, profileId: string): BrowserProfile {
  const profile = repository.get(profileId);
  if (!profile) {
    throw new BrowserProfileNotFoundError(profileId);
  }

  return profile;
}

export class BrowserProfileNotFoundError extends Error {
  constructor(profileId: string) {
    super(`Browser Profile "${profileId}" was not found`);
    this.name = "BrowserProfileNotFoundError";
  }
}

export class UnsupportedBrowserProfileError extends Error {
  constructor(profileId: string) {
    super(`Browser Profile "${profileId}" is not headless; headed Browser Instances are not supported yet`);
    this.name = "UnsupportedBrowserProfileError";
  }
}

function nowIso(now: () => Date): string {
  return now().toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
