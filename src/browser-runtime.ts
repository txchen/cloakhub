import type { EventLog, EventInput } from "./event-log";
import { join } from "node:path";
import { connect as connectTcp } from "node:net";

import type { CdpClipboardReader } from "./cdp-clipboard-reader";
import {
  CapacityUnavailableError,
  createRuntimeCapacity,
  type RuntimeCapacityRunningInstance
} from "./runtime-capacity";
import {
  createOwnedProcessRegistry,
  type OwnedProcessRegistry
} from "./owned-process";
import {
  validateSupportedSettings,
  validateCustomLaunchArgs,
  type BrowserProfile,
  type StopReason
} from "./profile";
import type { ProfileRepository } from "./profile-repository";

export { CapacityUnavailableError };

export interface BrowserLaunchCommand {
  browserBin: string;
  cdpPort: number;
  customLaunchArgs: string[];
  timezone?: string;
  locale?: string;
  colorScheme?: "light" | "dark" | "system";
  display?: string;
  fingerprintSeed: string;
  gpuRenderer: string;
  gpuVendor: string;
  hardwareConcurrency: number;
  headless: boolean;
  platform: string;
  profileId: string;
  proxy: string;
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
  launch(command: BrowserLaunchCommand): Promise<BrowserProcessHandle>;
}

export interface BrowserDisplayRuntimeCommand {
  clipboardSync?: boolean;
  displayNumber: number;
  profileId: string;
  screenHeight: number;
  screenWidth: number;
  vncPort: number;
}

export interface BrowserDisplayRuntime {
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
  events?: Pick<EventLog, "record">;
  clipboardReader?: CdpClipboardReader;
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
  ownedProcesses?: OwnedProcessRegistry;
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
  clipboard_sync?: boolean;
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
  cdpSessionObservations(
    profileId: string
  ): BrowserRuntimeCdpSessionObservation[];
  lastManualInputAt(profileId: string): string | null;
  openCdpSession(
    profileId: string,
    metadata?: BrowserRuntimeCdpSessionMetadata
  ): BrowserRuntimeCdpSession;
  openManualViewer(profileId: string): Promise<BrowserRuntimeManualViewerState>;
  openManualViewerSession(profileId: string): BrowserRuntimeManualViewer;
  recordCdpDiscovery(profileId: string): void;
  readManualClipboard(profileId: string): Promise<string>;
  restart(profileId: string): Promise<BrowserRuntimeState>;
  shutdown(): Promise<void>;
  deleteProfile(
    profileId: string,
    removeData: () => Promise<void>
  ): Promise<void>;
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
  handle?: BrowserProcessHandle;
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
const noopClientConnections: BrowserClientConnections = {
  disconnect: async () => undefined
};
const cdpReadinessProbe: BrowserReadinessProbe = {
  async waitUntilReady(state: BrowserRuntimeState): Promise<void> {
    const deadline = Date.now() + DEFAULT_READY_TIMEOUT_MS;
    let lastError = "not ready";

    while (Date.now() <= deadline) {
      try {
        const response = await fetch(
          `http://127.0.0.1:${state.cdp_port}/json/version`
        );
        if (response.ok) {
          return;
        }

        lastError = `returned ${response.status}`;
      } catch (error) {
        lastError = errorMessage(error);
      }

      await Bun.sleep(DEFAULT_READY_POLL_MS);
    }

    throw new Error(
      `Browser Instance CDP endpoint was not ready: ${lastError}`
    );
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

    throw new Error(
      `Browser Instance VNC endpoint was not ready: ${lastError}`
    );
  }
};

export function createBrowserRuntime(
  options: BrowserRuntimeOptions
): BrowserRuntime {
  const sleepObservations = new Map<string, string>();
  const log = (profileId: string, type: string, message: string, details: EventInput["details"] = {}, level: EventInput["level"] = "info") => {
    options.events?.record({ profile_id: profileId, type, message, details, level, occurred_at: nowIso(now) });
  };
  const activeCdpSessions = new Map<string, ActiveCdpSession[]>();
  const activeManualViewers = new Map<string, ActiveManualViewer[]>();
  const lastActivityMs = new Map<string, number>();
  const lastManualInputActivityMs = new Map<string, number>();
  const lastManualInputObservedMs = new Map<string, number>();
  const operations = new Map<
    string,
    { kind: string; promise: Promise<unknown> }
  >();
  let shuttingDown = false;
  const runningInstances = new Map<string, RunningInstance>();
  const clientConnections = options.clientConnections ?? noopClientConnections;
  const now = options.now ?? (() => new Date());
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const ownedProcesses =
    options.ownedProcesses ??
    createOwnedProcessRegistry({ dataRoot: options.dataRoot });
  const manualReadinessProbe =
    options.manualReadinessProbe ?? vncReadinessProbe;
  const capacity = createRuntimeCapacity({
    cdpPortStart: options.cdpPortStart,
    displayNumberStart: options.displayNumberStart,
    maxRunningInstances: options.maxRunningInstances,
    monotonicNow,
    now,
    vncPortStart: options.vncPortStart
  });
  const readinessProbe = options.readinessProbe ?? cdpReadinessProbe;
  const stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
  const wait = options.wait ?? Bun.sleep;
  let nextCdpSessionId = 1;
  let nextManualViewerId = 1;

  return {
    activeCdpSessionCount(profileId: string): number {
      return activeCdpSessions.get(profileId)?.length ?? 0;
    },

    activeManualViewerCount(profileId: string): number {
      return activeManualViewers.get(profileId)?.length ?? 0;
    },

    cdpSessionObservations(
      profileId: string
    ): BrowserRuntimeCdpSessionObservation[] {
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
      await ownedProcesses.cleanupOwnedProcesses();
      for (const profile of options.repository.list()) {
        if (profile.instance_status !== "stopped") log(profile.profile_id, "browser.stopped", "Stopped during CloakHub startup cleanup.", { reason: "restart" });
      }
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
      activeCdpSessions.set(profileId, [
        ...(activeCdpSessions.get(profileId) ?? []),
        session
      ]);
      recordActivity(profileId);
      log(profileId, "cdp.connected", "CDP client connected; automatic sleep is blocked.", { connections: activeCdpSessions.get(profileId)!.length });
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
          log(profileId, "cdp.disconnected", "CDP client disconnected.", { connections: nextSessions.length });
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

    async openManualViewer(
      profileId: string
    ): Promise<BrowserRuntimeManualViewerState> {
      const profile = requireProfile(options.repository, profileId);
      if (profile.headless) {
        throw new UnsupportedManualViewerProfileError(profile.profile_id);
      }

      const state = await this.start(profileId);
      if (state.display === undefined || state.vnc_port === undefined) {
        throw new Error(
          `Browser Profile "${profileId}" did not expose a manual viewer endpoint`
        );
      }

      await manualReadinessProbe.waitUntilReady(state);

      return {
        display: state.display,
        profile_id: profile.profile_id,
        vnc_port: state.vnc_port,
        clipboard_sync: profile.clipboard_sync,
        vnc_ws_path: `/ui/profiles/${encodeURIComponent(profile.profile_id)}/vnc`
      };
    },

    openManualViewerSession(profileId: string): BrowserRuntimeManualViewer {
      const profile = requireProfile(options.repository, profileId);
      if (profile.headless) {
        throw new UnsupportedManualViewerProfileError(profile.profile_id);
      }

      const viewer: ActiveManualViewer = { id: nextManualViewerId++ };
      activeManualViewers.set(profileId, [
        ...(activeManualViewers.get(profileId) ?? []),
        viewer
      ]);
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

    async readManualClipboard(profileId: string): Promise<string> {
      const profile = requireProfile(options.repository, profileId);
      if (profile.headless) {
        throw new UnsupportedManualViewerProfileError(profile.profile_id);
      }

      if (!profile.clipboard_sync)
        throw new Error("Clipboard sync is disabled for this profile");

      const running = runningInstances.get(profile.profile_id);
      if (!running) {
        throw new Error(
          `Browser Profile "${profile.profile_id}" is not running`
        );
      }
      if (!options.clipboardReader) {
        throw new Error("Manual clipboard reader is unavailable");
      }

      return options.clipboardReader.readText(running.cdpPort);
    },

    async restart(profileId: string): Promise<BrowserRuntimeState> {
      assertAcceptingStarts();
      return serialize(profileId, "restart", async () => {
        await stopProfile(
          requireProfile(options.repository, profileId),
          "restart",
          { recordActivity: true }
        );
        return launchProfile(requireProfile(options.repository, profileId));
      });
    },

    async shutdown(): Promise<void> {
      shuttingDown = true;
      const ids = new Set([...runningInstances.keys(), ...operations.keys()]);
      const results = await Promise.allSettled(
        [...ids].map((profileId) =>
          serialize(profileId, "shutdown", async () => {
            const profile = options.repository.get(profileId);
            if (profile)
              await stopProfile(profile, "shutdown", { recordActivity: false });
          })
        )
      );
      await ownedProcesses.cleanupOwnedProcesses();
      options.repository.markAllStopped("shutdown", nowIso(now));
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    },

    async start(profileId: string): Promise<BrowserRuntimeState> {
      assertAcceptingStarts();
      const pending = operations.get(profileId);
      if (pending?.kind === "start")
        return pending.promise as Promise<BrowserRuntimeState>;
      return serialize(profileId, "start", async () => {
        const profile = requireProfile(options.repository, profileId);
        const running = runningInstances.get(profileId);
        if (running && profile.instance_status === "running")
          return runningState(profileId, running);
        // A previous cleanup failure retains ownership; retry cleanup before reusing its ports.
        if (running)
          await stopProfile(profile, "launch failure", {
            recordActivity: false
          });
        return launchProfile(requireProfile(options.repository, profileId));
      });
    },

    async stop(
      profileId: string,
      reason: StopReason = "manual stop"
    ): Promise<BrowserRuntimeState> {
      return serialize(profileId, "stop", () =>
        stopProfile(requireProfile(options.repository, profileId), reason, {
          recordActivity: true
        })
      );
    },

    async deleteProfile(
      profileId: string,
      removeData: () => Promise<void>
    ): Promise<void> {
      return serialize(profileId, "delete", async () => {
        await stopProfile(
          requireProfile(options.repository, profileId),
          "manual stop",
          { recordActivity: false }
        );
        await removeData();
        lastActivityMs.delete(profileId);
        lastManualInputActivityMs.delete(profileId);
        lastManualInputObservedMs.delete(profileId);
      });
    },

    async writeManualClipboard(profileId: string, text: string): Promise<void> {
      const profile = requireProfile(options.repository, profileId);
      if (profile.headless) {
        throw new UnsupportedManualViewerProfileError(profile.profile_id);
      }

      if (!profile.clipboard_sync)
        throw new Error("Clipboard sync is disabled for this profile");

      const running = runningInstances.get(profile.profile_id);
      if (!running?.display) {
        throw new Error(
          `Browser Profile "${profile.profile_id}" does not have a running manual viewer display`
        );
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
        if (!profile || operations.has(profileId)) continue;
        const minutes = profile.sleep_policy_status.effective_minutes;
        const connections = this.activeCdpSessionCount(profileId);
        const lastActivity = lastActivityMs.get(profileId);
        const idleMs = lastActivity === undefined ? null : Math.max(0, monotonicNow() - lastActivity);
        const blocker = profile.sleep_policy_status.blocks_sleep || minutes === null ? "never-sleep policy"
          : connections > 0 ? "active CDP connections" : null;
        const observation = JSON.stringify([blocker, minutes, connections]);
        if (sleepObservations.get(profileId) !== observation) {
          sleepObservations.set(profileId, observation);
          log(profileId, blocker ? "sleep.blocked" : "sleep.countdown",
            blocker ? `Automatic sleep blocked by ${blocker}.` : "Automatic sleep countdown is active.",
            { idle_minutes: minutes, connections, last_activity_at: profile.last_activity_at, idle_ms: idleMs });
        }
        if (blocker || minutes === null || idleMs === null || idleMs < minutes * 60_000) continue;
        log(profileId, "sleep.timeout", "Idle timeout reached; stopping browser.", {
          idle_minutes: minutes, idle_ms: idleMs, last_activity_at: profile.last_activity_at, connections
        });
        try {
          await serialize(profileId, "idle", () => stopProfile(profile, "idle timeout", { recordActivity: false }));
          results.push({ profile_id: profileId, reason: "idle timeout" });
        } catch {
          // stopProfile records the failure. Keep checking other profiles and retry next sweep.
        }
      }

      return results;
    }
  };

  async function launchProfile(
    profile: BrowserProfile
  ): Promise<BrowserRuntimeState> {
    const reservationResult = capacity.reserve(profile, {
      preempt: async (candidate) => {
        await serialize(candidate.profile_id, "preempt", () =>
          stopProfile(candidate, "capacity preemption", {
            recordActivity: false
          })
        );
      },
      runningInstances: capacityRunningInstances
    });
    const reservation = isPromiseLike(reservationResult)
      ? await reservationResult
      : reservationResult;
    const { cdpPort, display, displayNumber, vncPort } = reservation;
    options.repository.markStarting(profile.profile_id);
    log(profile.profile_id, "browser.starting", "Browser is starting.");

    const resources: RunningInstance = {
      cdpPort,
      display,
      displayNumber,
      vncPort
    };
    runningInstances.set(profile.profile_id, resources);
    try {
      validateSupportedSettings(profile);
      validateCustomLaunchArgs(profile.custom_launch_args);

      if (!profile.headless) {
        if (
          !options.displayRuntime ||
          displayNumber === undefined ||
          vncPort === undefined
        ) {
          throw new MissingDisplayRuntimeError();
        }

        resources.displayHandle = await options.displayRuntime.start({
          displayNumber,
          clipboardSync: profile.clipboard_sync,
          profileId: profile.profile_id,
          screenHeight: profile.screen_height,
          screenWidth: profile.screen_width,
          vncPort
        });
      }

      resources.handle = await options.launcher.launch({
        browserBin: options.browserBin,
        cdpPort,
        customLaunchArgs: profile.custom_launch_args,
        timezone: profile.timezone,
        locale: profile.locale,
        colorScheme: profile.color_scheme,
        display,
        fingerprintSeed: profile.fingerprint_seed,
        gpuRenderer: profile.gpu_renderer,
        gpuVendor: profile.gpu_vendor,
        hardwareConcurrency: profile.hardware_concurrency,
        headless: profile.headless,
        platform: profile.platform,
        profileId: profile.profile_id,
        proxy: profile.proxy,
        screenHeight: profile.screen_height,
        screenWidth: profile.screen_width,
        userAgent: profile.user_agent,
        userDataDir: join(options.dataRoot, "profiles", profile.profile_id)
      });

      const state = runningState(profile.profile_id, resources);
      await readinessProbe.waitUntilReady(state);
      superviseUnexpectedExit(profile.profile_id, resources.handle);
      const occurredAt = nowIso(now);
      options.repository.markRunning(profile.profile_id, occurredAt);
      recordActivity(profile.profile_id, occurredAt);
      sleepObservations.delete(profile.profile_id);
      log(profile.profile_id, "browser.started", "Browser started.", { idle_minutes: profile.sleep_policy_status.effective_minutes });

      return state;
    } catch (error) {
      try {
        await releaseResources(profile.profile_id, resources);
      } catch (cleanupError) {
        error = new AggregateError(
          [error, cleanupError],
          `${errorMessage(error)}; cleanup failed: ${errorMessage(cleanupError)}`
        );
      }
      log(profile.profile_id, "browser.start_failed", "Browser failed to start. Check the profile launch error.", {}, "error");
      options.repository.markLaunchFailed(
        profile.profile_id,
        errorMessage(error),
        nowIso(now)
      );
      throw error;
    }
  }

  // Keep ownership and the capacity reservation until every process has been reaped.
  async function releaseResources(
    profileId: string,
    resources: RunningInstance
  ): Promise<void> {
    const handles = [resources.handle, resources.displayHandle].filter(
      (handle): handle is BrowserProcessHandle => handle !== undefined
    );
    // Give the browser time to flush its profile before stopping its display.
    const errors: unknown[] = [];
    for (const handle of handles) {
      try {
        try {
          await handle.close();
        } catch {
          /* hard-kill fallback below */
        }
        await wait(stopGraceMs);
        if (!(await handle.hasExited())) {
          await handle.kill();
          let timeout: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              handle.exited(),
              new Promise<never>((_resolve, reject) => {
                timeout = setTimeout(
                  () =>
                    reject(new Error("Process did not exit after forced stop")),
                  5000
                );
              })
            ]);
          } finally {
            clearTimeout(timeout);
          }
        }
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length)
      throw new AggregateError(errors, "Could not stop all instance processes");
    runningInstances.delete(profileId);
    capacity.release(profileId);
  }

  async function stopProfile(
    profile: BrowserProfile,
    reason: StopReason,
    options_: { recordActivity: boolean }
  ): Promise<BrowserRuntimeState> {
    const running = runningInstances.get(profile.profile_id);

    options.repository.markStopping(profile.profile_id);
    log(profile.profile_id, "browser.stopping", "Browser is stopping.", { reason });
    if (options_.recordActivity) {
      recordActivity(profile.profile_id);
    }

    try {
      await clientConnections.disconnect(profile.profile_id, reason);

      activeCdpSessions.delete(profile.profile_id);
      activeManualViewers.delete(profile.profile_id);
      if (running) await releaseResources(profile.profile_id, running);

      options.repository.markStopped(profile.profile_id, reason, nowIso(now));
      sleepObservations.delete(profile.profile_id);
      log(profile.profile_id, "browser.stopped", "Browser stopped.", { reason }, reason === "crash" ? "warning" : "info");
    } catch (error) {
      log(profile.profile_id, "browser.stop_failed", "Browser cleanup failed; stop has not completed.", { reason }, "error");
      throw error;
    }

    return {
      cdp_port: running?.cdpPort ?? -1,
      profile_id: profile.profile_id,
      status: "stopped"
    };
  }

  function superviseUnexpectedExit(
    profileId: string,
    handle: BrowserProcessHandle
  ): void {
    void handle
      .exited()
      .then(() =>
        serialize(profileId, "crash", async () => {
          if (runningInstances.get(profileId)?.handle !== handle) return;
          await stopProfile(
            requireProfile(options.repository, profileId),
            "crash",
            { recordActivity: false }
          );
        })
      )
      .catch((error) => {
        if (options.repository.get(profileId))
          options.repository.markFailed(
            profileId,
            errorMessage(error),
            nowIso(now)
          );
      });
  }

  function assertAcceptingStarts(): void {
    if (shuttingDown) throw new Error("CloakHub is shutting down");
  }

  function serialize<T>(
    profileId: string,
    kind: string,
    action: () => Promise<T>
  ): Promise<T> {
    const previous = operations.get(profileId);
    const promise = previous
      ? previous.promise.catch(() => undefined).then(action)
      : action();
    const operation = { kind, promise };
    operations.set(profileId, operation);
    const clear = () => {
      if (operations.get(profileId) === operation) operations.delete(profileId);
    };
    void promise.then(clear, clear);
    return promise;
  }

  function recordActivity(profileId: string, occurredAt = nowIso(now)): void {
    lastActivityMs.set(profileId, monotonicNow());
    options.repository.recordActivity(profileId, occurredAt);
  }

  function recordManualInput(profileId: string): void {
    const current = monotonicNow();
    lastManualInputObservedMs.set(profileId, current);
    const lastRecorded = lastManualInputActivityMs.get(profileId);
    if (
      lastRecorded !== undefined &&
      current - lastRecorded < MANUAL_INPUT_ACTIVITY_THROTTLE_MS
    ) {
      return;
    }

    lastManualInputActivityMs.set(profileId, current);
    const occurredAt = nowIso(now);
    lastActivityMs.set(profileId, current);
    options.repository.recordManualInput(profileId, occurredAt);
    log(profileId, "sleep.activity", "Manual input reset the idle countdown.", { source: "manual input" });
  }

  function capacityRunningInstances(): RuntimeCapacityRunningInstance[] {
    return Array.from(runningInstances.entries()).flatMap(
      ([profileId, running]) => {
        const profile = options.repository.get(profileId);
        if (
          !profile ||
          profile.instance_status !== "running" ||
          operations.has(profileId)
        ) {
          return [];
        }

        const snapshot: RuntimeCapacityRunningInstance = {
          activeCdpSessionCount: activeCdpSessions.get(profileId)?.length ?? 0,
          cdpPort: running.cdpPort,
          profile
        };
        if (running.displayNumber !== undefined) {
          snapshot.displayNumber = running.displayNumber;
        }
        const lastActivity = lastActivityMs.get(profileId);
        if (lastActivity !== undefined) {
          snapshot.lastActivityMs = lastActivity;
        }
        const lastManualInput = lastManualInputObservedMs.get(profileId);
        if (lastManualInput !== undefined) {
          snapshot.lastManualInputObservedMs = lastManualInput;
        }
        if (running.vncPort !== undefined) {
          snapshot.vncPort = running.vncPort;
        }

        return [snapshot];
      }
    );
  }

  function runningState(
    profileId: string,
    running: RunningInstance
  ): BrowserRuntimeState {
    return {
      cdp_port: running.cdpPort,
      ...(running.display ? { display: running.display } : {}),
      profile_id: profileId,
      status: "running",
      ...(running.vncPort ? { vnc_port: running.vncPort } : {})
    };
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

function requireProfile(
  repository: ProfileRepository,
  profileId: string
): BrowserProfile {
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
    super(
      `Manual viewer is unavailable for headless Browser Profiles. Edit the profile to disable headless mode before opening the viewer for "${profileId}".`
    );
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

function isPromiseLike<Value>(
  value: Promise<Value> | Value
): value is Promise<Value> {
  return typeof value === "object" && value !== null && "then" in value;
}
