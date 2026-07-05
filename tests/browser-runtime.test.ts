import { describe, expect, test } from "bun:test";

import type { BrowserProfile } from "../src/profile";
import type { ProfileRepository } from "../src/profile-repository";
import {
  createBrowserRuntime,
  UnsupportedBrowserProfileError,
  type BrowserClientConnections,
  type BrowserProcessLauncher,
  type BrowserReadinessProbe,
  type BrowserRuntimeState
} from "../src/browser-runtime";

describe("BrowserRuntime", () => {
  test("starts a headless Browser Instance with persistent user-data and private CDP endpoint", async () => {
    const repository = fakeRepository(profile({ profile_id: "work" }));
    const launcher = fakeLauncher();
    const runtime = runtimeFixture({ launcher, repository });

    const result = await runtime.start("work");

    expect(result.status).toBe("running");
    expect(result.cdp_port).toBe(5100);
    expect(launcher.launches[0]).toMatchObject({
      browserBin: "/opt/cloakbrowser/cloakbrowser",
      cdpPort: 5100,
      headless: true,
      profileId: "work",
      customLaunchArgs: [],
      userDataDir: "/data/profiles/work"
    });
    expect(repository.get("work")?.instance_status).toBe("running");
    expect(repository.get("work")?.last_started_at).toBeTruthy();
    expect(repository.get("work")?.last_activity_at).toBeTruthy();
  });

  test("rejects headed Browser Profiles until headed runtime support exists", async () => {
    const repository = fakeRepository(profile({ headless: false, profile_id: "work" }));
    const runtime = runtimeFixture({ repository });

    await expect(runtime.start("work")).rejects.toThrow(UnsupportedBrowserProfileError);
    expect(repository.get("work")?.instance_status).toBe("stopped");
  });

  test("stop gracefully closes, waits, then hard-kills remaining Owned Processes", async () => {
    const repository = fakeRepository(profile({ profile_id: "work" }));
    const launcher = fakeLauncher({ exitsAfterGracefulClose: false });
    const nowValues = [
      new Date("2026-01-01T00:00:00.000Z"),
      new Date("2026-01-01T00:01:00.000Z"),
      new Date("2026-01-01T00:02:00.000Z")
    ];
    const waits: number[] = [];
    const runtime = runtimeFixture({
      launcher,
      now: () => nowValues.shift() ?? new Date("2026-01-01T00:02:00.000Z"),
      repository,
      wait: async (milliseconds) => {
        waits.push(milliseconds);
      }
    });
    await runtime.start("work");

    const result = await runtime.stop("work", "manual stop");

    expect(result.status).toBe("stopped");
    expect(launcher.handles[0]?.closed).toBe(true);
    expect(waits).toEqual([1500]);
    expect(launcher.handles[0]?.killed).toBe(true);
    expect(repository.get("work")).toMatchObject({
      instance_status: "stopped",
      last_activity_at: "2026-01-01T00:01:00.000Z",
      last_stop_reason: "manual stop"
    });
  });

  test("explicit stop overrides active clients before closing the Browser Instance", async () => {
    const repository = fakeRepository(profile({ profile_id: "work" }));
    const clientConnections = fakeClientConnections();
    const runtime = runtimeFixture({ clientConnections, repository });
    await runtime.start("work");

    await runtime.stop("work", "manual stop");

    expect(clientConnections.disconnects).toEqual([{ profileId: "work", reason: "manual stop" }]);
  });

  test("CDP discovery and websocket sessions record Instance Activity", async () => {
    const repository = fakeRepository(profile({ profile_id: "work" }));
    const nowValues = [
      new Date("2026-01-01T00:00:00.000Z"),
      new Date("2026-01-01T00:01:00.000Z")
    ];
    const runtime = runtimeFixture({
      now: () => nowValues.shift() ?? new Date("2026-01-01T00:01:00.000Z"),
      repository
    });

    runtime.recordCdpDiscovery("work");
    const session = runtime.openCdpSession("work");
    session.recordMessage();
    session.close();

    expect(runtime.activeCdpSessionCount("work")).toBe(0);
    expect(repository.get("work")?.last_activity_at).toBe("2026-01-01T00:01:00.000Z");
  });

  test("restart records stop then starts a new Browser Instance", async () => {
    const repository = fakeRepository(profile({ profile_id: "work" }));
    const launcher = fakeLauncher();
    const runtime = runtimeFixture({ launcher, repository });
    await runtime.start("work");

    const result = await runtime.restart("work");

    expect(result.status).toBe("running");
    expect(launcher.launches).toHaveLength(2);
    expect(repository.stopReasons).toContain("restart");
  });

  test("restart records Lifecycle History even when the Browser Instance is already stopped", async () => {
    const repository = fakeRepository(profile({ profile_id: "work" }));
    const runtime = runtimeFixture({ repository });

    await runtime.restart("work");

    expect(repository.stopReasons).toContain("restart");
    expect(repository.get("work")).toMatchObject({
      instance_status: "running",
      last_stop_reason: "restart"
    });
  });

  test("start waits for the private CDP endpoint before marking the Browser Instance running", async () => {
    const repository = fakeRepository(profile({ profile_id: "work" }));
    const readinessProbe = fakeReadinessProbe();
    const runtime = runtimeFixture({ readinessProbe, repository });

    await runtime.start("work");

    expect(readinessProbe.readyStates).toEqual([{ cdp_port: 5100, profile_id: "work", status: "running" }]);
    expect(repository.get("work")?.instance_status).toBe("running");
  });

  test("readiness failure stops the launched Owned Process and records launch failure", async () => {
    const repository = fakeRepository(profile({ profile_id: "work" }));
    const launcher = fakeLauncher({ exitsAfterGracefulClose: false });
    const runtime = runtimeFixture({
      launcher,
      readinessProbe: {
        waitUntilReady: async () => {
          throw new Error("not ready");
        }
      },
      repository
    });

    await expect(runtime.start("work")).rejects.toThrow("not ready");

    expect(launcher.handles[0]).toMatchObject({ closed: true, killed: true });
    expect(repository.get("work")).toMatchObject({
      instance_status: "failed",
      last_launch_error: "not ready",
      last_stop_reason: "launch failure"
    });
  });

  test("concurrent starts for a stopped Browser Profile share one launch attempt", async () => {
    const repository = fakeRepository(profile({ profile_id: "work" }));
    let releaseLaunch!: () => void;
    const launcher = fakeLauncher({
      beforeLaunchResolves: () =>
        new Promise<void>((resolve) => {
          releaseLaunch = resolve;
        })
    });
    const runtime = runtimeFixture({ launcher, repository });

    const first = runtime.start("work");
    const second = runtime.start("work");
    releaseLaunch();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { cdp_port: 5100, profile_id: "work", status: "running" },
      { cdp_port: 5100, profile_id: "work", status: "running" }
    ]);
    expect(launcher.launches).toHaveLength(1);
  });

  test("unexpected process exit records a crash stop reason", async () => {
    const repository = fakeRepository(profile({ profile_id: "work" }));
    const launcher = fakeLauncher();
    const runtime = runtimeFixture({ launcher, repository });

    await runtime.start("work");
    launcher.handles[0]?.exit();
    await launcher.handles[0]?.exited();
    await Promise.resolve();

    expect(repository.get("work")).toMatchObject({
      instance_status: "stopped",
      last_stop_reason: "crash"
    });
  });

  test("launch failure marks Browser Instance failed and persists launch error", async () => {
    const repository = fakeRepository(profile({ profile_id: "work" }));
    const runtime = runtimeFixture({
      launcher: fakeLauncher({ launchError: new Error("boom") }),
      repository
    });

    await expect(runtime.start("work")).rejects.toThrow("boom");
    expect(repository.get("work")).toMatchObject({
      instance_status: "failed",
      last_launch_error: "boom",
      last_stop_reason: "launch failure"
    });
  });

  test("successful start preserves prior launch error Lifecycle History", async () => {
    const repository = fakeRepository(
      profile({
        instance_status: "failed",
        last_launch_error: "previous boom",
        last_launch_failed_at: "2026-01-01T00:00:00.000Z",
        profile_id: "work"
      })
    );
    const runtime = runtimeFixture({ repository });

    await runtime.start("work");

    expect(repository.get("work")).toMatchObject({
      instance_status: "running",
      last_launch_error: "previous boom",
      last_launch_failed_at: "2026-01-01T00:00:00.000Z"
    });
  });

  test("startup cleanup targets only Owned Processes and marks instances stopped", async () => {
    const repository = fakeRepository(
      profile({ instance_status: "running", profile_id: "work" }),
      profile({ instance_status: "running", profile_id: "stray" })
    );
    const launcher = fakeLauncher({ ownedProfileIds: ["work"] });
    const runtime = runtimeFixture({ launcher, repository });

    await runtime.cleanupOwnedProcessesOnStartup();

    expect(launcher.cleanedProfileIds).toEqual(["work"]);
    expect(repository.get("work")).toMatchObject({
      instance_status: "stopped",
      last_stop_reason: "restart"
    });
    expect(repository.get("stray")).toMatchObject({
      instance_status: "stopped",
      last_stop_reason: "restart"
    });
  });
});

function runtimeFixture(options: {
  clientConnections?: BrowserClientConnections;
  launcher?: BrowserProcessLauncher;
  now?: () => Date;
  readinessProbe?: BrowserReadinessProbe;
  repository: ProfileRepository;
  wait?: (milliseconds: number) => Promise<void>;
}) {
  return createBrowserRuntime({
    browserBin: "/opt/cloakbrowser/cloakbrowser",
    clientConnections: options.clientConnections,
    dataRoot: "/data",
    launcher: options.launcher ?? fakeLauncher(),
    now: options.now,
    readinessProbe: options.readinessProbe ?? fakeReadinessProbe(),
    repository: options.repository,
    wait: options.wait ?? (async () => undefined)
  });
}

function fakeLauncher(options: {
  beforeLaunchResolves?: () => Promise<void>;
  exitsAfterGracefulClose?: boolean;
  launchError?: Error;
  ownedProfileIds?: string[];
} = {}): BrowserProcessLauncher & {
  cleanedProfileIds: string[];
  handles: FakeBrowserHandle[];
  launches: unknown[];
} {
  const handles: FakeBrowserHandle[] = [];
  const cleanedProfileIds: string[] = [];
  const launches: unknown[] = [];

  return {
    cleanedProfileIds,
    handles,
    launches,
    cleanupOwnedProcesses: async (profileIds) => {
      cleanedProfileIds.push(...profileIds);
    },
    launch: async (command) => {
      await options.beforeLaunchResolves?.();

      if (options.launchError) {
        throw options.launchError;
      }

      launches.push(command);
      const handle = new FakeBrowserHandle(options.exitsAfterGracefulClose ?? true);
      handles.push(handle);
      return handle;
    },
    ownedProfileIds: async () => options.ownedProfileIds ?? []
  };
}

function fakeClientConnections(): BrowserClientConnections & {
  disconnects: Array<{ profileId: string; reason: string }>;
} {
  const disconnects: Array<{ profileId: string; reason: string }> = [];

  return {
    disconnects,
    disconnect: async (profileId, reason) => {
      disconnects.push({ profileId, reason });
    }
  };
}

function fakeReadinessProbe(): BrowserReadinessProbe & { readyStates: BrowserRuntimeState[] } {
  const readyStates: BrowserRuntimeState[] = [];

  return {
    readyStates,
    waitUntilReady: async (state) => {
      readyStates.push(state);
    }
  };
}

class FakeBrowserHandle {
  closed = false;
  killed = false;
  private resolveExit!: () => void;
  private readonly exitedPromise = new Promise<void>((resolve) => {
    this.resolveExit = resolve;
  });

  constructor(private readonly exitsAfterGracefulClose: boolean) {}

  async close(): Promise<void> {
    this.closed = true;
  }

  exit(): void {
    this.resolveExit();
  }

  async exited(): Promise<void> {
    await this.exitedPromise;
  }

  async hasExited(): Promise<boolean> {
    return this.exitsAfterGracefulClose;
  }

  async kill(): Promise<void> {
    this.killed = true;
  }
}

function fakeRepository(...initialProfiles: BrowserProfile[]): ProfileRepository & { stopReasons: string[] } {
  const profiles = new Map(initialProfiles.map((initialProfile) => [initialProfile.profile_id, initialProfile]));
  const stopReasons: string[] = [];

  return {
    stopReasons,
    close: () => undefined,
    create: () => {
      throw new Error("not used");
    },
    delete: (profileId) => {
      profiles.delete(profileId);
    },
    get: (profileId) => profiles.get(profileId),
    list: () => Array.from(profiles.values()),
    markAllStopped: (reason, occurredAt) => {
      for (const existing of profiles.values()) {
        if (existing.instance_status !== "stopped") {
          stopReasons.push(reason);
          update(existing.profile_id, {
            instance_status: "stopped",
            last_stopped_at: occurredAt,
            last_stop_reason: reason
          });
        }
      }
    },
    markFailed: (profileId, error, occurredAt) => {
      update(profileId, {
        instance_status: "failed",
        last_launch_error: error,
        last_launch_failed_at: occurredAt
      });
    },
    markLaunchFailed: (profileId, error, occurredAt) => {
      update(profileId, {
        instance_status: "failed",
        last_launch_error: error,
        last_launch_failed_at: occurredAt,
        last_stopped_at: occurredAt,
        last_stop_reason: "launch failure"
      });
    },
    markRunning: (profileId, occurredAt) => {
      update(profileId, {
        instance_status: "running",
        last_started_at: occurredAt
      });
    },
    markStarting: (profileId) => {
      update(profileId, { instance_status: "starting" });
    },
    markStopped: (profileId, reason, occurredAt) => {
      stopReasons.push(reason);
      update(profileId, {
        instance_status: "stopped",
        last_stopped_at: occurredAt,
        last_stop_reason: reason
      });
    },
    markStopping: (profileId) => {
      update(profileId, { instance_status: "stopping" });
    },
    migrate: () => undefined,
    recordActivity: (profileId, occurredAt) => {
      update(profileId, { last_activity_at: occurredAt });
    },
    recordDeleteError: () => undefined,
    update: (profileId, input) => update(profileId, input)
  };

  function update(profileId: string, changes: Partial<BrowserProfile>): BrowserProfile | undefined {
    const existing = profiles.get(profileId);
    if (!existing) {
      return undefined;
    }

    const next = { ...existing, ...changes };
    profiles.set(profileId, next);
    return next;
  }
}

function profile(overrides: Partial<BrowserProfile>): BrowserProfile {
  return {
    clipboard_sync: true,
    color_scheme: "system",
    created_at: "2026-01-01T00:00:00.000Z",
    custom_launch_args: [],
    display_name: "work",
    fingerprint_seed: "12345",
    geoip: "",
    gpu_renderer: "",
    gpu_vendor: "",
    hardware_concurrency: 4,
    headless: true,
    human_preset: "",
    humanize: false,
    instance_status: "stopped",
    last_activity_at: null,
    last_delete_error: null,
    last_launch_error: null,
    last_launch_failed_at: null,
    last_started_at: null,
    last_stop_reason: null,
    last_stopped_at: null,
    locale: "",
    notes: "",
    platform: "linux",
    profile_id: "work",
    proxy: "",
    screen_height: 1080,
    screen_width: 1920,
    sleep_policy: { mode: "default" },
    sleep_policy_status: { blocks_sleep: false, effective_minutes: 30, mode: "default" },
    tags: [],
    timezone: "",
    updated_at: "2026-01-01T00:00:00.000Z",
    user_agent: "",
    ...overrides
  };
}
