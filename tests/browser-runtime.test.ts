import { describe, expect, test } from "bun:test";

import type { BrowserProfile } from "../src/profile";
import type { ProfileRepository } from "../src/profile-repository";
import {
  CapacityUnavailableError,
  createBrowserRuntime,
  MissingDisplayRuntimeError,
  type BrowserClientConnections,
  type BrowserDisplayRuntime,
  type BrowserManualReadinessProbe,
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
      screenHeight: 1080,
      screenWidth: 1920,
      userDataDir: "/data/profiles/work"
    });
    expect(repository.get("work")?.instance_status).toBe("running");
    expect(repository.get("work")?.last_started_at).toBeTruthy();
    expect(repository.get("work")?.last_activity_at).toBeTruthy();
  });

  test("passes macOS fingerprint settings to CloakBrowser launch", async () => {
    const repository = fakeRepository(
      profile({
        fingerprint_seed: "54321",
        gpu_renderer: "ANGLE Metal Renderer",
        gpu_vendor: "Apple Inc.",
        hardware_concurrency: 8,
        platform: "macos",
        profile_id: "work",
        screen_height: 768,
        screen_width: 1366,
        user_agent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"
      })
    );
    const launcher = fakeLauncher();
    const runtime = runtimeFixture({ launcher, repository });

    await runtime.start("work");

    expect(launcher.launches[0]).toMatchObject({
      fingerprintSeed: "54321",
      gpuRenderer: "ANGLE Metal Renderer",
      gpuVendor: "Apple Inc.",
      hardwareConcurrency: 8,
      platform: "macos",
      screenHeight: 768,
      screenWidth: 1366,
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"
    });
  });

  test("starts a headed Browser Instance with a private display runtime and VNC endpoint", async () => {
    const repository = fakeRepository(profile({ headless: false, profile_id: "work" }));
    const displayRuntime = fakeDisplayRuntime();
    const launcher = fakeLauncher();
    const runtime = runtimeFixture({ displayRuntime, launcher, repository });

    const result = await runtime.start("work");

    expect(result).toMatchObject({
      cdp_port: 5100,
      display: ":100",
      profile_id: "work",
      status: "running",
      vnc_port: 5900
    });
    expect(displayRuntime.starts).toEqual([
      {
        displayNumber: 100,
        profileId: "work",
        screenHeight: 1080,
        screenWidth: 1920,
        vncPort: 5900
      }
    ]);
    expect(launcher.launches[0]).toMatchObject({
      display: ":100",
      headless: false,
      profileId: "work",
      screenHeight: 1080,
      screenWidth: 1920
    });
  });

  test("headed launch fails clearly when KasmVNC display runtime is unavailable", async () => {
    const repository = fakeRepository(profile({ headless: false, profile_id: "work" }));
    const runtime = runtimeFixture({ repository });

    await expect(runtime.start("work")).rejects.toThrow(MissingDisplayRuntimeError);
    expect(repository.get("work")).toMatchObject({
      instance_status: "failed",
      last_launch_error: "Missing KasmVNC Xvnc display runtime"
    });
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

  test("CDP Session observations include count, duration, remote address, and user agent", async () => {
    const repository = fakeRepository(profile({ profile_id: "work" }));
    const monotonic = fakeMonotonicClock();
    const runtime = runtimeFixture({
      monotonicNow: monotonic.now,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      repository
    });

    const session = runtime.openCdpSession("work", {
      remoteAddress: "203.0.113.10",
      userAgent: "Playwright"
    });
    monotonic.advance(1250);

    expect(runtime.cdpSessionObservations("work")).toEqual([
      {
        duration_ms: 1250,
        remote_address: "203.0.113.10",
        started_at: "2026-01-01T00:00:00.000Z",
        user_agent: "Playwright"
      }
    ]);

    session.close();
    expect(runtime.cdpSessionObservations("work")).toEqual([]);
  });

  test("manual viewer recovery starts headed profile and exposes viewer state", async () => {
    const repository = fakeRepository(profile({ headless: false, profile_id: "work" }));
    const manualReadinessProbe = fakeManualReadinessProbe();
    const runtime = runtimeFixture({ displayRuntime: fakeDisplayRuntime(), manualReadinessProbe, repository });

    const viewer = await runtime.openManualViewer("work");

    expect(viewer).toEqual({
      display: ":100",
      profile_id: "work",
      vnc_port: 5900,
      vnc_ws_path: "/ui/profiles/work/vnc"
    });
    expect(manualReadinessProbe.readyStates).toEqual([
      { cdp_port: 5100, display: ":100", profile_id: "work", status: "running", vnc_port: 5900 }
    ]);
    expect(repository.get("work")?.instance_status).toBe("running");
  });

  test("manual viewer presence is tracked separately from Instance Activity", async () => {
    const repository = fakeRepository(
      profile({
        headless: false,
        last_activity_at: "2026-01-01T00:00:00.000Z",
        profile_id: "work"
      })
    );
    const runtime = runtimeFixture({ displayRuntime: fakeDisplayRuntime(), repository });
    await runtime.start("work");
    repository.recordActivity("work", "2026-01-01T00:00:00.000Z");

    const viewer = runtime.openManualViewerSession("work");

    expect(runtime.activeManualViewerCount("work")).toBe(1);
    expect(repository.get("work")?.last_activity_at).toBe("2026-01-01T00:00:00.000Z");
    viewer.close();
    expect(runtime.activeManualViewerCount("work")).toBe(0);
  });

  test("multiple manual viewers are tracked independently", async () => {
    const repository = fakeRepository(profile({ headless: false, profile_id: "work" }));
    const runtime = runtimeFixture({ displayRuntime: fakeDisplayRuntime(), repository });
    await runtime.start("work");

    const first = runtime.openManualViewerSession("work");
    const second = runtime.openManualViewerSession("work");

    expect(runtime.activeManualViewerCount("work")).toBe(2);
    first.close();
    expect(runtime.activeManualViewerCount("work")).toBe(1);
    second.close();
    expect(runtime.activeManualViewerCount("work")).toBe(0);
  });

  test("manual input records Instance Activity at most once every five seconds", async () => {
    const repository = fakeRepository(profile({ headless: false, profile_id: "work" }));
    const monotonic = fakeMonotonicClock();
    const nowValues = [
      new Date("2026-01-01T00:00:00.000Z"),
      new Date("2026-01-01T00:00:01.000Z"),
      new Date("2026-01-01T00:00:06.000Z")
    ];
    const runtime = runtimeFixture({
      displayRuntime: fakeDisplayRuntime(),
      monotonicNow: monotonic.now,
      now: () => nowValues.shift() ?? new Date("2026-01-01T00:00:06.000Z"),
      repository
    });
    await runtime.start("work");
    const viewer = runtime.openManualViewerSession("work");

    viewer.recordInput();
    monotonic.advance(1000);
    viewer.recordInput();
    monotonic.advance(5000);
    viewer.recordInput();

    expect(repository.get("work")?.last_activity_at).toBe("2026-01-01T00:00:06.000Z");
    expect(runtime.lastManualInputAt("work")).toBe("2026-01-01T00:00:06.000Z");
  });

  test("manual clipboard writes through the running display without recording Manual Input", async () => {
    const repository = fakeRepository(profile({ headless: false, profile_id: "work" }));
    const clipboardWriter = fakeClipboardWriter();
    const runtime = runtimeFixture({ clipboardWriter, displayRuntime: fakeDisplayRuntime(), repository });
    await runtime.start("work");

    await runtime.writeManualClipboard("work", "pasted text");

    expect(clipboardWriter.writes).toEqual([{ display: ":100", text: "pasted text" }]);
    expect(runtime.lastManualInputAt("work")).toBeNull();
  });

  test("open CDP Sessions block idle Spin-down indefinitely", async () => {
    const repository = fakeRepository(profile({ profile_id: "work" }));
    const launcher = fakeLauncher();
    const monotonic = fakeMonotonicClock();
    const runtime = runtimeFixture({ launcher, monotonicNow: monotonic.now, repository });
    await runtime.start("work");
    const session = runtime.openCdpSession("work");
    monotonic.advance(31 * 60 * 1000);

    const result = await runtime.spinDownIdleInstances();

    expect(result).toEqual([]);
    expect(repository.get("work")?.instance_status).toBe("running");
    expect(launcher.handles[0]?.closed).toBe(false);
    session.close();
  });

  test("idle headless Browser Instances spin down when Sleep Policy allows it", async () => {
    const repository = fakeRepository(profile({ profile_id: "work" }));
    const launcher = fakeLauncher();
    const monotonic = fakeMonotonicClock();
    const runtime = runtimeFixture({ launcher, monotonicNow: monotonic.now, repository });
    await runtime.start("work");

    monotonic.advance(30 * 60 * 1000 + 1);
    const result = await runtime.spinDownIdleInstances();

    expect(result).toEqual([{ profile_id: "work", reason: "idle timeout" }]);
    expect(launcher.handles[0]?.closed).toBe(true);
    expect(repository.get("work")).toMatchObject({
      instance_status: "stopped",
      last_stop_reason: "idle timeout"
    });
  });

  test("idle headed Browser Instances spin down even with viewer presence only", async () => {
    const repository = fakeRepository(profile({ headless: false, profile_id: "work" }));
    const displayRuntime = fakeDisplayRuntime();
    const launcher = fakeLauncher();
    const monotonic = fakeMonotonicClock();
    const runtime = runtimeFixture({ displayRuntime, launcher, monotonicNow: monotonic.now, repository });
    await runtime.start("work");
    runtime.openManualViewerSession("work");

    monotonic.advance(30 * 60 * 1000 + 1);
    const result = await runtime.spinDownIdleInstances();

    expect(result).toEqual([{ profile_id: "work", reason: "idle timeout" }]);
    expect(launcher.handles[0]?.closed).toBe(true);
    expect(displayRuntime.handles[0]?.closed).toBe(true);
    expect(runtime.activeManualViewerCount("work")).toBe(0);
  });

  test("never-sleep policy blocks idle Spin-down", async () => {
    const repository = fakeRepository(
      profile({
        profile_id: "work",
        sleep_policy: { mode: "never" },
        sleep_policy_status: { blocks_sleep: true, effective_minutes: null, mode: "never" }
      })
    );
    const launcher = fakeLauncher();
    const monotonic = fakeMonotonicClock();
    const runtime = runtimeFixture({ launcher, monotonicNow: monotonic.now, repository });
    await runtime.start("work");
    monotonic.advance(24 * 60 * 60 * 1000);

    expect(await runtime.spinDownIdleInstances()).toEqual([]);
    expect(repository.get("work")?.instance_status).toBe("running");
  });

  test("passive profile polling does not affect idle Spin-down decisions", async () => {
    const repository = fakeRepository(profile({ profile_id: "work" }));
    const monotonic = fakeMonotonicClock();
    const runtime = runtimeFixture({ monotonicNow: monotonic.now, repository });
    await runtime.start("work");

    monotonic.advance(30 * 60 * 1000 + 1);
    repository.list();

    expect(await runtime.spinDownIdleInstances()).toEqual([
      { profile_id: "work", reason: "idle timeout" }
    ]);
  });

  test("capacity preemption stops the least-recently-active eligible Browser Instance", async () => {
    const repository = fakeRepository(
      profile({ profile_id: "old" }),
      profile({ headless: false, profile_id: "headed" }),
      profile({ profile_id: "next" })
    );
    const displayRuntime = fakeDisplayRuntime();
    const launcher = fakeLauncher();
    const nowValues = [
      new Date("2026-01-01T00:00:00.000Z"),
      new Date("2026-01-01T00:01:00.000Z"),
      new Date("2026-01-01T00:02:00.000Z")
    ];
    const runtime = runtimeFixture({
      displayRuntime,
      launcher,
      maxRunningInstances: 2,
      now: () => nowValues.shift() ?? new Date("2026-01-01T00:02:00.000Z"),
      repository
    });

    await runtime.start("old");
    await runtime.start("headed");
    await runtime.start("next");

    expect(repository.get("old")).toMatchObject({
      instance_status: "stopped",
      last_stop_reason: "capacity preemption"
    });
    expect(repository.get("headed")?.instance_status).toBe("running");
    expect(repository.get("next")?.instance_status).toBe("running");
    expect(launcher.handles[0]?.closed).toBe(true);
    expect(launcher.launches).toHaveLength(3);
  });

  test("capacity preemption can stop viewer-only never-sleep Browser Instances", async () => {
    const repository = fakeRepository(
      profile({
        headless: false,
        profile_id: "viewer",
        sleep_policy: { mode: "never" },
        sleep_policy_status: { blocks_sleep: true, effective_minutes: null, mode: "never" }
      }),
      profile({ profile_id: "next" })
    );
    const displayRuntime = fakeDisplayRuntime();
    const runtime = runtimeFixture({ displayRuntime, maxRunningInstances: 1, repository });
    await runtime.start("viewer");
    runtime.openManualViewerSession("viewer");

    await runtime.start("next");

    expect(repository.get("viewer")).toMatchObject({
      instance_status: "stopped",
      last_stop_reason: "capacity preemption"
    });
    expect(runtime.activeManualViewerCount("viewer")).toBe(0);
    expect(repository.get("next")?.instance_status).toBe("running");
  });

  test("capacity preemption protects active CDP Sessions and recent Manual Input", async () => {
    const repository = fakeRepository(
      profile({ profile_id: "cdp" }),
      profile({ headless: false, profile_id: "manual" }),
      profile({ profile_id: "next" })
    );
    const displayRuntime = fakeDisplayRuntime();
    const runtime = runtimeFixture({
      displayRuntime,
      maxRunningInstances: 2,
      now: () => new Date("2026-01-01T00:00:10.000Z"),
      repository
    });
    await runtime.start("cdp");
    await runtime.start("manual");
    const session = runtime.openCdpSession("cdp");
    runtime.openManualViewerSession("manual").recordInput();

    await expect(runtime.start("next")).rejects.toThrow(CapacityUnavailableError);

    expect(repository.get("cdp")?.instance_status).toBe("running");
    expect(repository.get("manual")?.instance_status).toBe("running");
    expect(repository.get("next")?.instance_status).toBe("stopped");
    session.close();
  });

  test("capacity preemption protects throttled Manual Input from the last 60 seconds", async () => {
    const repository = fakeRepository(
      profile({ headless: false, profile_id: "manual" }),
      profile({ profile_id: "next" })
    );
    let currentTime = new Date("2026-01-01T00:00:00.000Z");
    const monotonic = fakeMonotonicClock();
    const runtime = runtimeFixture({
      displayRuntime: fakeDisplayRuntime(),
      maxRunningInstances: 1,
      monotonicNow: monotonic.now,
      now: () => currentTime,
      repository
    });
    await runtime.start("manual");
    const viewer = runtime.openManualViewerSession("manual");
    viewer.recordInput();
    monotonic.advance(4000);
    currentTime = new Date("2026-01-01T00:00:04.000Z");
    viewer.recordInput();
    monotonic.advance(57_000);
    currentTime = new Date("2026-01-01T00:01:01.000Z");

    await expect(runtime.start("next")).rejects.toThrow(CapacityUnavailableError);

    expect(repository.get("manual")?.instance_status).toBe("running");
  });

  test("capacity preemption uses throttled Manual Input for least-recently-active selection", async () => {
    const repository = fakeRepository(
      profile({ headless: false, profile_id: "manual" }),
      profile({ profile_id: "other" }),
      profile({ profile_id: "next" })
    );
    let currentTime = new Date("2026-01-01T00:00:00.000Z");
    const monotonic = fakeMonotonicClock();
    const runtime = runtimeFixture({
      displayRuntime: fakeDisplayRuntime(),
      maxRunningInstances: 2,
      monotonicNow: monotonic.now,
      now: () => currentTime,
      repository
    });
    await runtime.start("manual");
    await runtime.start("other");
    const viewer = runtime.openManualViewerSession("manual");
    viewer.recordInput();
    monotonic.advance(4000);
    currentTime = new Date("2026-01-01T00:00:04.000Z");
    viewer.recordInput();
    monotonic.advance(61_000);
    currentTime = new Date("2026-01-01T00:01:05.000Z");

    await runtime.start("next");

    expect(repository.get("manual")?.instance_status).toBe("running");
    expect(repository.get("other")).toMatchObject({
      instance_status: "stopped",
      last_stop_reason: "capacity preemption"
    });
  });

  test("concurrent starts for different profiles respect the Running Instance Limit", async () => {
    const repository = fakeRepository(profile({ profile_id: "first" }), profile({ profile_id: "second" }));
    let releaseLaunch!: () => void;
    const launcher = fakeLauncher({
      beforeLaunchResolves: () =>
        new Promise<void>((resolve) => {
          releaseLaunch = resolve;
        })
    });
    const runtime = runtimeFixture({ launcher, maxRunningInstances: 1, repository });

    const first = runtime.start("first");
    const second = runtime.start("second");
    releaseLaunch();

    await expect(Promise.allSettled([first, second])).resolves.toEqual([
      expect.objectContaining({ status: "fulfilled" }),
      expect.objectContaining({
        reason: expect.any(CapacityUnavailableError),
        status: "rejected"
      })
    ]);
    expect(launcher.launches).toHaveLength(1);
    expect(repository.get("first")?.instance_status).toBe("running");
    expect(repository.get("second")?.instance_status).toBe("stopped");
  });

  test("concurrent starts that need preemption still reserve only one new Browser Instance", async () => {
    const repository = fakeRepository(
      profile({ profile_id: "victim" }),
      profile({ profile_id: "first" }),
      profile({ profile_id: "second" })
    );
    let releaseStop!: () => void;
    const clientConnections = {
      disconnect: async () =>
        new Promise<void>((resolve) => {
          releaseStop = resolve;
        })
    };
    const runtime = runtimeFixture({ clientConnections, maxRunningInstances: 1, repository });
    await runtime.start("victim");

    const first = runtime.start("first");
    const second = runtime.start("second");
    await Promise.resolve();
    releaseStop();

    await expect(Promise.allSettled([first, second])).resolves.toEqual([
      expect.objectContaining({ status: "fulfilled" }),
      expect.objectContaining({
        reason: expect.any(CapacityUnavailableError),
        status: "rejected"
      })
    ]);
    expect(repository.get("victim")).toMatchObject({
      instance_status: "stopped",
      last_stop_reason: "capacity preemption"
    });
    expect(repository.get("first")?.instance_status).toBe("running");
    expect(repository.get("second")?.instance_status).toBe("stopped");
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

  test("start rejects stored CloakHub-owned CDP launch flags before launching a process", async () => {
    const repository = fakeRepository(
      profile({ custom_launch_args: ["--remote-debugging-pipe"], profile_id: "work" })
    );
    const launcher = fakeLauncher();
    const readinessProbe = fakeReadinessProbe();
    const runtime = runtimeFixture({ launcher, readinessProbe, repository });

    await expect(runtime.start("work")).rejects.toThrow(
      "custom_launch_args cannot include CloakHub-owned flag --remote-debugging-pipe"
    );

    expect(launcher.launches).toEqual([]);
    expect(readinessProbe.readyStates).toEqual([]);
    expect(repository.get("work")).toMatchObject({
      instance_status: "failed",
      last_launch_error: "custom_launch_args cannot include CloakHub-owned flag --remote-debugging-pipe",
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
  clipboardWriter?: Parameters<typeof createBrowserRuntime>[0]["clipboardWriter"];
  displayRuntime?: BrowserDisplayRuntime;
  launcher?: BrowserProcessLauncher;
  manualReadinessProbe?: BrowserManualReadinessProbe;
  maxRunningInstances?: number;
  monotonicNow?: () => number;
  now?: () => Date;
  readinessProbe?: BrowserReadinessProbe;
  repository: ProfileRepository;
  wait?: (milliseconds: number) => Promise<void>;
}) {
  return createBrowserRuntime({
    browserBin: "/opt/cloakbrowser/cloakbrowser",
    clipboardWriter: options.clipboardWriter,
    clientConnections: options.clientConnections,
    dataRoot: "/data",
    displayRuntime: options.displayRuntime,
    launcher: options.launcher ?? fakeLauncher(),
    manualReadinessProbe: options.manualReadinessProbe ?? fakeManualReadinessProbe(),
    maxRunningInstances: options.maxRunningInstances,
    monotonicNow: options.monotonicNow,
    now: options.now,
    readinessProbe: options.readinessProbe ?? fakeReadinessProbe(),
    repository: options.repository,
    wait: options.wait ?? (async () => undefined)
  });
}

function fakeClipboardWriter(): {
  writes: Array<{ display: string; text: string }>;
  writeText(display: string, text: string): Promise<void>;
} {
  const writes: Array<{ display: string; text: string }> = [];

  return {
    writes,
    writeText: async (display, text) => {
      writes.push({ display, text });
    }
  };
}

function fakeManualReadinessProbe(): BrowserManualReadinessProbe & { readyStates: BrowserRuntimeState[] } {
  const readyStates: BrowserRuntimeState[] = [];

  return {
    readyStates,
    waitUntilReady: async (state) => {
      readyStates.push(state);
    }
  };
}

function fakeDisplayRuntime(): BrowserDisplayRuntime & {
  handles: FakeBrowserHandle[];
  starts: unknown[];
} {
  const handles: FakeBrowserHandle[] = [];
  const starts: unknown[] = [];

  return {
    handles,
    starts,
    cleanupOwnedProcesses: async () => undefined,
    start: async (command) => {
      starts.push(command);
      const handle = new FakeBrowserHandle(true);
      handles.push(handle);
      return handle;
    }
  };
}

function fakeMonotonicClock(): { advance(milliseconds: number): void; now(): number } {
  let current = 0;

  return {
    advance(milliseconds: number): void {
      current += milliseconds;
    },
    now(): number {
      return current;
    }
  };
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
    recordManualInput: (profileId, occurredAt) => {
      update(profileId, { last_activity_at: occurredAt, last_manual_input_at: occurredAt });
    },
    recordDeleteError: () => undefined,
    setCdpToken: (profileId, token) => update(profileId, { cdp_token: token }),
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
    cdp_token: null,
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
    last_manual_input_at: null,
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
    timezone: "",
    updated_at: "2026-01-01T00:00:00.000Z",
    user_agent: "",
    ...overrides
  };
}
