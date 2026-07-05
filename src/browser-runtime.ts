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
  monotonicNow?: () => number;
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

export interface BrowserRuntimeCdpSessionMetadata {
  remoteAddress?: string;
  userAgent?: string;
}

export interface BrowserRuntimeCdpSessionObservation {
  duration_ms: number;
  remote_address: string | null;
  started_at: string;
  user_agent: string | null;
}

export interface IdleSpinDownResult {
  profile_id: string;
  reason: "idle timeout";
}

export interface BrowserRuntime {
  cleanupOwnedProcessesOnStartup(): Promise<void>;
  activeCdpSessionCount(profileId: string): number;
  cdpSessionObservations(profileId: string): BrowserRuntimeCdpSessionObservation[];
  openCdpSession(
    profileId: string,
    metadata?: BrowserRuntimeCdpSessionMetadata
  ): BrowserRuntimeCdpSession;
  recordCdpDiscovery(profileId: string): void;
  restart(profileId: string): Promise<BrowserRuntimeState>;
  spinDownIdleHeadlessInstances(): Promise<IdleSpinDownResult[]>;
  start(profileId: string): Promise<BrowserRuntimeState>;
  stop(profileId: string, reason?: StopReason): Promise<BrowserRuntimeState>;
}

interface RunningInstance {
  cdpPort: number;
  handle: BrowserProcessHandle;
}

interface ActiveCdpSession extends BrowserRuntimeCdpSessionMetadata {
  id: number;
  startedAtMs: number;
  startedAtWallClock: string;
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
  const activeCdpSessions = new Map<string, ActiveCdpSession[]>();
  const lastActivityMs = new Map<string, number>();
  const launchAttempts = new Map<string, Promise<BrowserRuntimeState>>();
  const runningInstances = new Map<string, RunningInstance>();
  const clientConnections = options.clientConnections ?? noopClientConnections;
  const now = options.now ?? (() => new Date());
  const readinessProbe = options.readinessProbe ?? cdpReadinessProbe;
  const stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
  const wait = options.wait ?? Bun.sleep;
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  let nextCdpPort = options.cdpPortStart ?? 5100;
  let nextCdpSessionId = 1;

  return {
    activeCdpSessionCount(profileId: string): number {
      return activeCdpSessions.get(profileId)?.length ?? 0;
    },

    cdpSessionObservations(profileId: string): BrowserRuntimeCdpSessionObservation[] {
      return (activeCdpSessions.get(profileId) ?? []).map((session) => ({
        duration_ms: monotonicNow() - session.startedAtMs,
        remote_address: session.remoteAddress ?? null,
        started_at: session.startedAtWallClock,
        user_agent: session.userAgent ?? null
      }));
    },

    async cleanupOwnedProcessesOnStartup(): Promise<void> {
      const ownedProfileIds = await options.launcher.ownedProfileIds();
      await options.launcher.cleanupOwnedProcesses(ownedProfileIds);
      options.repository.markAllStopped("restart", nowIso(now));
    },

    openCdpSession(
      profileId: string,
      metadata: BrowserRuntimeCdpSessionMetadata = {}
    ): BrowserRuntimeCdpSession {
      requireProfile(options.repository, profileId);
      const session: ActiveCdpSession = {
        ...metadata,
        id: nextCdpSessionId++,
        startedAtMs: monotonicNow(),
        startedAtWallClock: nowIso(now)
      };
      activeCdpSessions.set(profileId, [...(activeCdpSessions.get(profileId) ?? []), session]);
      recordActivity(profileId);
      let closed = false;

      return {
        close(): void {
          if (closed) {
            return;
          }

          closed = true;
          const nextSessions = (activeCdpSessions.get(profileId) ?? []).filter(
            (entry) => entry.id !== session.id
          );
          if (nextSessions.length === 0) {
            activeCdpSessions.delete(profileId);
            return;
          }

          activeCdpSessions.set(profileId, nextSessions);
        },
        recordMessage(): void {
          recordActivity(profileId);
        }
      };
    },

    recordCdpDiscovery(profileId: string): void {
      requireProfile(options.repository, profileId);
      recordActivity(profileId);
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
      return stopProfile(profile, reason, { recordActivity: true });
    },

    async spinDownIdleHeadlessInstances(): Promise<IdleSpinDownResult[]> {
      const results: IdleSpinDownResult[] = [];

      for (const profileId of runningInstances.keys()) {
        const profile = options.repository.get(profileId);
        if (!profile || !profile.headless || profile.sleep_policy_status.blocks_sleep) {
          continue;
        }

        const idleWindowMinutes = profile.sleep_policy_status.effective_minutes;
        if (idleWindowMinutes === null || this.activeCdpSessionCount(profileId) > 0) {
          continue;
        }

        const lastActivity = lastActivityMs.get(profileId);
        if (lastActivity === undefined || monotonicNow() - lastActivity < idleWindowMinutes * 60 * 1000) {
          continue;
        }

        await stopProfile(profile, "idle timeout", { recordActivity: false });
        results.push({ profile_id: profileId, reason: "idle timeout" });
      }

      return results;
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
      recordActivity(profile.profile_id, occurredAt);

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

  async function stopProfile(
    profile: BrowserProfile,
    reason: StopReason,
    options_: { recordActivity: boolean }
  ): Promise<BrowserRuntimeState> {
    const running = runningInstances.get(profile.profile_id);

    options.repository.markStopping(profile.profile_id);
    if (options_.recordActivity) {
      recordActivity(profile.profile_id);
    }

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

  function recordActivity(profileId: string, occurredAt = nowIso(now)): void {
    lastActivityMs.set(profileId, monotonicNow());
    options.repository.recordActivity(profileId, occurredAt);
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
