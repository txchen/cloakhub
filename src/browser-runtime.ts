import { join } from "node:path";
import { connect as connectTcp } from "node:net";

import {
  DEFAULT_MAX_RUNNING_INSTANCES,
  INTERNAL_CDP_PORT_RANGE,
  INTERNAL_DISPLAY_NUMBER_RANGE,
  INTERNAL_VNC_PORT_RANGE
} from "./config";
import { validateCustomLaunchArgs, type BrowserProfile, type StopReason } from "./profile";
import type { ProfileRepository } from "./profile-repository";

export interface BrowserLaunchCommand {
  browserBin: string;
  cdpPort: number;
  customLaunchArgs: string[];
  display?: string;
  fingerprintSeed: string;
  gpuRenderer: string;
  gpuVendor: string;
  hardwareConcurrency: number;
  headless: boolean;
  platform: string;
  profileId: string;
  screenHeight: number;
  screenWidth: number;
  userAgent: string;
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

export interface BrowserDisplayRuntimeCommand {
  displayNumber: number;
  profileId: string;
  screenHeight: number;
  screenWidth: number;
  vncPort: number;
}

export interface BrowserDisplayRuntime {
  cleanupOwnedProcesses(profileIds: string[]): Promise<void>;
  start(command: BrowserDisplayRuntimeCommand): Promise<BrowserProcessHandle>;
}

export interface BrowserClientConnections {
  disconnect(profileId: string, reason: StopReason): Promise<void>;
}

export interface BrowserReadinessProbe {
  waitUntilReady(state: BrowserRuntimeState): Promise<void>;
}

export interface BrowserManualReadinessProbe {
  waitUntilReady(state: BrowserRuntimeState): Promise<void>;
}

export interface BrowserRuntimeOptions {
  browserBin: string;
  clipboardWriter?: BrowserClipboardWriter;
  cdpPortStart?: number;
  clientConnections?: BrowserClientConnections;
  dataRoot: string;
  displayNumberStart?: number;
  displayRuntime?: BrowserDisplayRuntime;
  launcher: BrowserProcessLauncher;
  manualReadinessProbe?: BrowserManualReadinessProbe;
  maxRunningInstances?: number;
  monotonicNow?: () => number;
  now?: () => Date;
  readinessProbe?: BrowserReadinessProbe;
  repository: ProfileRepository;
  stopGraceMs?: number;
  vncPortStart?: number;
  wait?: (milliseconds: number) => Promise<void>;
}

export interface BrowserRuntimeState {
  cdp_port: number;
  display?: string;
  profile_id: string;
  status: BrowserProfile["instance_status"];
  vnc_port?: number;
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

export interface BrowserRuntimeManualViewer {
  close(): void;
  recordInput(): void;
}

export interface BrowserRuntimeManualViewerState {
  display: string;
  profile_id: string;
  vnc_port: number;
  vnc_ws_path: string;
}

export interface BrowserClipboardWriter {
  writeText(display: string, text: string): Promise<void>;
}

export interface IdleSpinDownResult {
  profile_id: string;
  reason: "idle timeout";
}

export interface BrowserRuntime {
  cleanupOwnedProcessesOnStartup(): Promise<void>;
  activeCdpSessionCount(profileId: string): number;
  activeManualViewerCount(profileId: string): number;
  cdpSessionObservations(profileId: string): BrowserRuntimeCdpSessionObservation[];
  lastManualInputAt(profileId: string): string | null;
  openCdpSession(
    profileId: string,
    metadata?: BrowserRuntimeCdpSessionMetadata
  ): BrowserRuntimeCdpSession;
  openManualViewer(profileId: string): Promise<BrowserRuntimeManualViewerState>;
  openManualViewerSession(profileId: string): BrowserRuntimeManualViewer;
  recordCdpDiscovery(profileId: string): void;
  restart(profileId: string): Promise<BrowserRuntimeState>;
  spinDownIdleInstances(): Promise<IdleSpinDownResult[]>;
  start(profileId: string): Promise<BrowserRuntimeState>;
  stop(profileId: string, reason?: StopReason): Promise<BrowserRuntimeState>;
  writeManualClipboard(profileId: string, text: string): Promise<void>;
}

interface RunningInstance {
  cdpPort: number;
  display?: string;
  displayNumber?: number;
  displayHandle?: BrowserProcessHandle;
  handle: BrowserProcessHandle;
  vncPort?: number;
}

interface ReservedInstanceResources {
  cdpPort: number;
  display?: string;
  displayNumber?: number;
  vncPort?: number;
}

interface ActiveCdpSession extends BrowserRuntimeCdpSessionMetadata {
  id: number;
  startedAtMs: number;
  startedAtWallClock: string;
}

interface ActiveManualViewer {
  id: number;
}

const DEFAULT_STOP_GRACE_MS = 1500;
const DEFAULT_READY_TIMEOUT_MS = 5000;
const DEFAULT_READY_POLL_MS = 100;
const MANUAL_INPUT_ACTIVITY_THROTTLE_MS = 5000;
const CAPACITY_MANUAL_INPUT_PROTECTION_MS = 60_000;
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
const vncReadinessProbe: BrowserManualReadinessProbe = {
  async waitUntilReady(state: BrowserRuntimeState): Promise<void> {
    if (state.vnc_port === undefined) {
      throw new Error("Browser Instance VNC endpoint was not allocated");
    }

    const deadline = Date.now() + DEFAULT_READY_TIMEOUT_MS;
    let lastError = "not ready";

    while (Date.now() <= deadline) {
      try {
        await waitForTcpPort(state.vnc_port);
        return;
      } catch (error) {
        lastError = errorMessage(error);
      }

      await Bun.sleep(DEFAULT_READY_POLL_MS);
    }

    throw new Error(`Browser Instance VNC endpoint was not ready: ${lastError}`);
  }
};

export function createBrowserRuntime(options: BrowserRuntimeOptions): BrowserRuntime {
  const activeCdpSessions = new Map<string, ActiveCdpSession[]>();
  const activeManualViewers = new Map<string, ActiveManualViewer[]>();
  const lastActivityMs = new Map<string, number>();
  const lastManualInputActivityMs = new Map<string, number>();
  const lastManualInputObservedMs = new Map<string, number>();
  let capacityReservationQueue = Promise.resolve();
  const launchAttempts = new Map<string, Promise<BrowserRuntimeState>>();
  const launchReservations = new Map<string, ReservedInstanceResources>();
  const runningInstances = new Map<string, RunningInstance>();
  const clientConnections = options.clientConnections ?? noopClientConnections;
  const now = options.now ?? (() => new Date());
  const manualReadinessProbe = options.manualReadinessProbe ?? vncReadinessProbe;
  const maxRunningInstances = options.maxRunningInstances ?? DEFAULT_MAX_RUNNING_INSTANCES;
  const readinessProbe = options.readinessProbe ?? cdpReadinessProbe;
  const stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
  const wait = options.wait ?? Bun.sleep;
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  let nextCdpPort = options.cdpPortStart ?? INTERNAL_CDP_PORT_RANGE.start;
  let nextCdpSessionId = 1;
  let nextDisplayNumber = options.displayNumberStart ?? INTERNAL_DISPLAY_NUMBER_RANGE.start;
  let nextManualViewerId = 1;
  let nextVncPort = options.vncPortStart ?? INTERNAL_VNC_PORT_RANGE.start;

  return {
    activeCdpSessionCount(profileId: string): number {
      return activeCdpSessions.get(profileId)?.length ?? 0;
    },

    activeManualViewerCount(profileId: string): number {
      return activeManualViewers.get(profileId)?.length ?? 0;
    },

    cdpSessionObservations(profileId: string): BrowserRuntimeCdpSessionObservation[] {
      return (activeCdpSessions.get(profileId) ?? []).map((session) => ({
        duration_ms: monotonicNow() - session.startedAtMs,
        remote_address: session.remoteAddress ?? null,
        started_at: session.startedAtWallClock,
        user_agent: session.userAgent ?? null
      }));
    },

    lastManualInputAt(profileId: string): string | null {
      return options.repository.get(profileId)?.last_manual_input_at ?? null;
    },

    async cleanupOwnedProcessesOnStartup(): Promise<void> {
      const ownedProfileIds = await options.launcher.ownedProfileIds();
      await options.launcher.cleanupOwnedProcesses(ownedProfileIds);
      await options.displayRuntime?.cleanupOwnedProcesses(ownedProfileIds);
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

    async openManualViewer(profileId: string): Promise<BrowserRuntimeManualViewerState> {
      const profile = requireProfile(options.repository, profileId);
      if (profile.headless) {
        throw new UnsupportedManualViewerProfileError(profile.profile_id);
      }

      const state = await this.start(profileId);
      if (state.display === undefined || state.vnc_port === undefined) {
        throw new Error(`Browser Profile "${profileId}" did not expose a manual viewer endpoint`);
      }

      await manualReadinessProbe.waitUntilReady(state);

      return {
        display: state.display,
        profile_id: profile.profile_id,
        vnc_port: state.vnc_port,
        vnc_ws_path: `/ui/profiles/${encodeURIComponent(profile.profile_id)}/vnc`
      };
    },

    openManualViewerSession(profileId: string): BrowserRuntimeManualViewer {
      const profile = requireProfile(options.repository, profileId);
      if (profile.headless) {
        throw new UnsupportedManualViewerProfileError(profile.profile_id);
      }

      const viewer: ActiveManualViewer = { id: nextManualViewerId++ };
      activeManualViewers.set(profileId, [...(activeManualViewers.get(profileId) ?? []), viewer]);
      let closed = false;

      return {
        close(): void {
          if (closed) {
            return;
          }

          closed = true;
          const nextViewers = (activeManualViewers.get(profileId) ?? []).filter(
            (entry) => entry.id !== viewer.id
          );
          if (nextViewers.length === 0) {
            activeManualViewers.delete(profileId);
            return;
          }

          activeManualViewers.set(profileId, nextViewers);
        },
        recordInput(): void {
          recordManualInput(profileId);
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
      const running = runningInstances.get(profile.profile_id);
      if (running) {
        return runningState(profile.profile_id, running);
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

    async writeManualClipboard(profileId: string, text: string): Promise<void> {
      const profile = requireProfile(options.repository, profileId);
      if (profile.headless) {
        throw new UnsupportedManualViewerProfileError(profile.profile_id);
      }

      const running = runningInstances.get(profile.profile_id);
      if (!running?.display) {
        throw new Error(`Browser Profile "${profile.profile_id}" does not have a running manual viewer display`);
      }

      if (!options.clipboardWriter) {
        throw new Error("Manual clipboard writer is unavailable");
      }

      await options.clipboardWriter.writeText(running.display, text);
    },

    async spinDownIdleInstances(): Promise<IdleSpinDownResult[]> {
      const results: IdleSpinDownResult[] = [];

      for (const profileId of runningInstances.keys()) {
        const profile = options.repository.get(profileId);
        if (!profile || profile.sleep_policy_status.blocks_sleep) {
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
    const reservation =
      reservedInstanceCount() >= maxRunningInstances
        ? await reserveCapacityWithPreemption(profile)
        : reserveCapacity(profile);
    const { cdpPort, display, displayNumber, vncPort } = reservation;
    options.repository.markStarting(profile.profile_id);

    try {
      let handle: BrowserProcessHandle | undefined;
      let displayHandle: BrowserProcessHandle | undefined;
      validateCustomLaunchArgs(profile.custom_launch_args);

      if (!profile.headless) {
        if (!options.displayRuntime || displayNumber === undefined || vncPort === undefined) {
          throw new MissingDisplayRuntimeError();
        }

        displayHandle = await options.displayRuntime.start({
          displayNumber,
          profileId: profile.profile_id,
          screenHeight: profile.screen_height,
          screenWidth: profile.screen_width,
          vncPort
        });
      }

      handle = await options.launcher.launch({
        browserBin: options.browserBin,
        cdpPort,
        customLaunchArgs: profile.custom_launch_args,
        display,
        fingerprintSeed: profile.fingerprint_seed,
        gpuRenderer: profile.gpu_renderer,
        gpuVendor: profile.gpu_vendor,
        hardwareConcurrency: profile.hardware_concurrency,
        headless: profile.headless,
        platform: profile.platform,
        profileId: profile.profile_id,
        screenHeight: profile.screen_height,
        screenWidth: profile.screen_width,
        userAgent: profile.user_agent,
        userDataDir: join(options.dataRoot, "profiles", profile.profile_id)
      });

      runningInstances.set(profile.profile_id, {
        cdpPort,
        display,
        displayNumber,
        displayHandle,
        handle,
        vncPort
      });
      superviseUnexpectedExit(profile.profile_id, handle);
      const state = runningState(profile.profile_id, {
        cdpPort,
        display,
        displayNumber,
        displayHandle,
        handle,
        vncPort
      });
      try {
        await readinessProbe.waitUntilReady(state);
      } catch (error) {
        await stopLaunchedProcess(profile.profile_id, handle, displayHandle);
        throw error;
      }

      const occurredAt = nowIso(now);
      options.repository.markRunning(profile.profile_id, occurredAt);
      recordActivity(profile.profile_id, occurredAt);

      return state;
    } catch (error) {
      launchReservations.delete(profile.profile_id);
      runningInstances.delete(profile.profile_id);
      options.repository.markLaunchFailed(profile.profile_id, errorMessage(error), nowIso(now));
      throw error;
    }
  }

  function reserveCapacity(profile: BrowserProfile): ReservedInstanceResources {
    const reservation = reserveResourcesFor(profile);
    launchReservations.set(profile.profile_id, reservation);
    return reservation;
  }

  async function reserveCapacityWithPreemption(profile: BrowserProfile): Promise<ReservedInstanceResources> {
    const reservationAttempt = capacityReservationQueue.then(async () => {
      if (reservedInstanceCount() >= maxRunningInstances) {
        await ensureCapacityFor(profile.profile_id);
      }

      if (reservedInstanceCount() >= maxRunningInstances) {
        throw new CapacityUnavailableError();
      }

      return reserveCapacity(profile);
    });
    capacityReservationQueue = reservationAttempt.then(
      () => undefined,
      () => undefined
    );
    return reservationAttempt;
  }

  async function ensureCapacityFor(requestedProfileId: string): Promise<void> {
    const candidate = capacityPreemptionCandidate(requestedProfileId);
    if (!candidate) {
      throw new CapacityUnavailableError();
    }

    await stopProfile(candidate, "capacity preemption", { recordActivity: false });
  }

  function capacityPreemptionCandidate(requestedProfileId: string): BrowserProfile | undefined {
    return Array.from(runningInstances.keys())
      .filter((profileId) => profileId !== requestedProfileId)
      .map((profileId) => options.repository.get(profileId))
      .filter((profile): profile is BrowserProfile => Boolean(profile))
      .filter((profile) => isCapacityPreemptionEligible(profile))
      .sort((left, right) => capacityActivityTimestamp(left) - capacityActivityTimestamp(right))[0];
  }

  function isCapacityPreemptionEligible(profile: BrowserProfile): boolean {
    if (activeCdpSessions.get(profile.profile_id)?.length) {
      return false;
    }

    const lastManualInput = lastManualInputObservedMs.get(profile.profile_id);
    if (lastManualInput !== undefined) {
      return monotonicNow() - lastManualInput >= CAPACITY_MANUAL_INPUT_PROTECTION_MS;
    }

    const persistedLastManualInput = timestampMs(profile.last_manual_input_at);
    return (
      persistedLastManualInput === undefined ||
      now().getTime() - persistedLastManualInput >= CAPACITY_MANUAL_INPUT_PROTECTION_MS
    );
  }

  function capacityActivityTimestamp(profile: BrowserProfile): number {
    const observed = Math.max(
      lastActivityMs.get(profile.profile_id) ?? Number.NEGATIVE_INFINITY,
      lastManualInputObservedMs.get(profile.profile_id) ?? Number.NEGATIVE_INFINITY
    );
    if (Number.isFinite(observed)) {
      return observed;
    }

    return Math.max(activityTimestamp(profile), timestampMs(profile.last_manual_input_at) ?? 0);
  }

  async function stopLaunchedProcess(
    profileId: string,
    handle: BrowserProcessHandle,
    displayHandle: BrowserProcessHandle | undefined
  ): Promise<void> {
    runningInstances.delete(profileId);
    await handle.close();
    await displayHandle?.close();
    await wait(stopGraceMs);

    if (!(await handle.hasExited())) {
      await handle.kill();
    }

    if (displayHandle && !(await displayHandle.hasExited())) {
      await displayHandle.kill();
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
      launchReservations.delete(profile.profile_id);
      activeManualViewers.delete(profile.profile_id);
      await running.handle.close();
      await running.displayHandle?.close();
      await wait(stopGraceMs);

      if (!(await running.handle.hasExited())) {
        await running.handle.kill();
      }

      if (running.displayHandle && !(await running.displayHandle.hasExited())) {
        await running.displayHandle.kill();
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
        launchReservations.delete(profileId);
        options.repository.markStopped(profileId, "crash", nowIso(now));
      })
      .catch(() => undefined);
  }

  function recordActivity(profileId: string, occurredAt = nowIso(now)): void {
    lastActivityMs.set(profileId, monotonicNow());
    options.repository.recordActivity(profileId, occurredAt);
  }

  function recordManualInput(profileId: string): void {
    const current = monotonicNow();
    lastManualInputObservedMs.set(profileId, current);
    const lastRecorded = lastManualInputActivityMs.get(profileId);
    if (lastRecorded !== undefined && current - lastRecorded < MANUAL_INPUT_ACTIVITY_THROTTLE_MS) {
      return;
    }

    lastManualInputActivityMs.set(profileId, current);
    const occurredAt = nowIso(now);
    lastActivityMs.set(profileId, current);
    options.repository.recordManualInput(profileId, occurredAt);
  }

  function reservedInstanceCount(): number {
    return new Set([...runningInstances.keys(), ...launchReservations.keys()]).size;
  }

  function reserveResourcesFor(profile: BrowserProfile): ReservedInstanceResources {
    const cdpPort = nextAvailableNumber(
      INTERNAL_CDP_PORT_RANGE,
      usedCdpPorts(),
      nextCdpPort
    );
    nextCdpPort = nextNumberAfter(cdpPort, INTERNAL_CDP_PORT_RANGE);

    if (profile.headless) {
      return { cdpPort };
    }

    const displayNumber = nextAvailableNumber(
      INTERNAL_DISPLAY_NUMBER_RANGE,
      usedDisplayNumbers(),
      nextDisplayNumber
    );
    const vncPort = nextAvailableNumber(INTERNAL_VNC_PORT_RANGE, usedVncPorts(), nextVncPort);
    nextDisplayNumber = nextNumberAfter(displayNumber, INTERNAL_DISPLAY_NUMBER_RANGE);
    nextVncPort = nextNumberAfter(vncPort, INTERNAL_VNC_PORT_RANGE);

    return { cdpPort, display: `:${displayNumber}`, displayNumber, vncPort };
  }

  function usedCdpPorts(): Set<number> {
    return new Set([
      ...Array.from(runningInstances.values()).map((running) => running.cdpPort),
      ...Array.from(launchReservations.values()).map((reservation) => reservation.cdpPort)
    ]);
  }

  function usedDisplayNumbers(): Set<number> {
    return new Set(
      [
        ...Array.from(runningInstances.values()).map((running) => running.displayNumber),
        ...Array.from(launchReservations.values()).map((reservation) => reservation.displayNumber)
      ].filter((value): value is number => value !== undefined)
    );
  }

  function usedVncPorts(): Set<number> {
    return new Set(
      [
        ...Array.from(runningInstances.values()).map((running) => running.vncPort),
        ...Array.from(launchReservations.values()).map((reservation) => reservation.vncPort)
      ].filter((value): value is number => value !== undefined)
    );
  }

  function runningState(profileId: string, running: RunningInstance): BrowserRuntimeState {
    return {
      cdp_port: running.cdpPort,
      ...(running.display ? { display: running.display } : {}),
      profile_id: profileId,
      status: "running",
      ...(running.vncPort ? { vnc_port: running.vncPort } : {})
    };
  }
}

export class CapacityUnavailableError extends Error {
  retryable = true;

  constructor() {
    super("Running Instance capacity is full; retry after another Browser Instance stops");
    this.name = "CapacityUnavailableError";
  }
}

function waitForTcpPort(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connectTcp({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.end();
      resolve();
    });
    socket.once("error", reject);
    socket.setTimeout(1000, () => {
      socket.destroy();
      reject(new Error("connection timed out"));
    });
  });
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

export class UnsupportedManualViewerProfileError extends Error {
  constructor(profileId: string) {
    super(`Manual viewer is unavailable for headless Browser Profiles. Edit the profile to disable headless mode before opening the viewer for "${profileId}".`);
    this.name = "UnsupportedManualViewerProfileError";
  }
}

export class MissingDisplayRuntimeError extends Error {
  constructor() {
    super("Missing KasmVNC Xvnc display runtime");
    this.name = "MissingDisplayRuntimeError";
  }
}

function nowIso(now: () => Date): string {
  return now().toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function activityTimestamp(profile: BrowserProfile): number {
  return timestampMs(profile.last_activity_at) ?? 0;
}

function timestampMs(value: string | null | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function nextAvailableNumber(
  range: { endInclusive: number; start: number },
  used: Set<number>,
  preferred: number
): number {
  let candidate = preferred >= range.start && preferred <= range.endInclusive ? preferred : range.start;
  for (let checked = 0; checked < range.endInclusive - range.start + 1; checked += 1) {
    if (!used.has(candidate)) {
      return candidate;
    }

    candidate = nextNumberAfter(candidate, range);
  }

  throw new CapacityUnavailableError();
}

function nextNumberAfter(value: number, range: { endInclusive: number; start: number }): number {
  return value >= range.endInclusive ? range.start : value + 1;
}
